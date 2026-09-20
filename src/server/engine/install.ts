// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  abortPromise,
  DOWNLOAD_DISK_MARGIN,
  DOWNLOAD_STALL_MS,
  describeError,
  fetchRedirected,
  sleepWithSignal,
} from "../download.ts";
import { diskSpace } from "../host/info.ts";
import type { HostProbes } from "../host/types.ts";
import {
  atomicWrite,
  bootout,
  bootstrap,
  kickstart,
  type LaunchdInfo,
  print as launchdPrint,
  type ReloadDeps,
  reload,
} from "../launchd.ts";
import type { ExclusiveLock } from "../lock.ts";
import { LockBusyError } from "../lock.ts";
import type { Log } from "../log.ts";
import { type PlistSpec, plistPath } from "../plist.ts";
import { configToArgs, DEFAULTS, validateConfig } from "./config.ts";
import type {
  ConfigIssue,
  EngineConfig,
  EnginePageState,
  EngineState,
  Failure,
  InstallRecord,
  Operation,
  OperationKind,
  ReleaseCheck,
  ServiceBody,
  ServiceState,
  SpyState,
} from "./manage.ts";
import {
  type CachedReleaseCheck,
  coreVersion,
  ENGINE_ASSET,
  fetchReleases,
  isNewer,
  isSafeTag,
  offered,
  parseVersionOutput,
  type ReleaseDetails,
  SPY_ASSET,
} from "./release.ts";
import type { EngineJournal, EngineStore } from "./store.ts";

export const ENGINE_REPO = "ddalcu/mlx-serve";
export const SPY_REPO = "stefanprodan/mlx-spy";
export const MANAGED_LABEL = "com.stefanprodan.mlx-serve";
const EXPECTED_TOP = "mlx-serve-macos-arm64";
const CHECK_AFTER_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1_000;
const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_STABLE_MS = 5_000;
const VERIFY_POLL_MS = 1_000;
const PROGRESS_EVERY_MS = 500;
const RETRIES = 5;
const RETRY_DELAY_MS = 2_000;
const HASH_CHUNK = 4 * 1024 * 1024;

export class EngineManagerError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: ConfigIssue[],
  ) {
    super(message);
  }
}

export type CpuReading = {
  at: number;
  userMicros: number;
  systemMicros: number;
};

export function cpuPercent(
  previous: CpuReading | null,
  current: CpuReading,
): number {
  if (!previous || current.at <= previous.at) return 0;
  const used =
    current.userMicros +
    current.systemMicros -
    previous.userMicros -
    previous.systemMicros;
  if (used <= 0) return 0;
  return (used / ((current.at - previous.at) * 1_000)) * 100;
}

export type EngineManagerDeps = {
  store: EngineStore;
  lock: ExclusiveLock;
  engineUrl: string;
  pinnedModelDir: string;
  local: boolean;
  engineUp: () => boolean;
  health: () => Promise<boolean>;
  log: Log;
  version: string;
  probes: Pick<HostProbes, "processMemory">;
  token?: string | null;
  home?: string;
  root?: string;
  execPath?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  spawn?: ReloadDeps["spawn"];
  launchd?: {
    reload?: typeof reload;
    bootstrap?: typeof bootstrap;
    bootout?: typeof bootout;
    kickstart?: typeof kickstart;
    print?: typeof launchdPrint;
    atomicWrite?: typeof atomicWrite;
  };
  launchdDeps?: ReloadDeps;
  portProbe?: (host: string, port: number) => Promise<boolean>;
  freeSpace?: (path: string) => number | null;
  publish?: (state: EnginePageState) => void;
  cpuUsage?: () => NodeJS.CpuUsage;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  verifyStableMs?: number;
  verifyTimeoutMs?: number;
  retryDelayMs?: number;
  stallMs?: number;
};

type ActiveDownload = {
  controller: AbortController;
  part: string;
  archive: string;
  temporary: string;
  staged: string;
  startedAt: number;
  publishedAt: number;
};

function publicCheck(check: CachedReleaseCheck | null): ReleaseCheck {
  return {
    releases:
      check?.releases.map(({ asset: _asset, ...release }) => release) ?? [],
    checkedAt: check?.checkedAt ?? null,
    error: check?.error ?? null,
  };
}

const SERVICE_SETTLE_READS = 20;

function serviceState(info: LaunchdInfo | null, readAt: number): ServiceState {
  if (info?.state === "running") {
    return {
      state: "running",
      pid: info.pid,
      lastExitCode: info.lastExitCode,
      readAt,
    };
  }
  return {
    state:
      info && info.lastExitCode !== null && info.lastExitCode !== 0
        ? "crashed"
        : "stopped",
    pid: info?.pid ?? null,
    lastExitCode: info?.lastExitCode ?? null,
    readAt,
  };
}

export async function defaultPortProbe(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void Bun.connect({
      hostname: host === "0.0.0.0" ? "127.0.0.1" : host,
      port,
      socket: {
        open(socket) {
          // answer first: end() runs the close handler synchronously,
          // which would report a port that just accepted us as free
          finish(true);
          socket.end();
        },
        data() {},
        close() {
          finish(false);
        },
        error() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}

async function defaultSpawn(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export class EngineManager {
  private readonly home: string;
  private readonly root: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly spawn: NonNullable<ReloadDeps["spawn"]>;
  private readonly portProbe: (host: string, port: number) => Promise<boolean>;
  private readonly freeSpace: (path: string) => number | null;
  private readonly reloadFn: typeof reload;
  private readonly bootstrapFn: typeof bootstrap;
  private readonly bootoutFn: typeof bootout;
  private readonly kickstartFn: typeof kickstart;
  private readonly printFn: typeof launchdPrint;
  private readonly atomicWriteFn: typeof atomicWrite;
  private readonly startedAt: number;
  private readonly verifyStableMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly stallMs: number;
  private operation: Operation | null = null;
  private failure: Failure | null = null;
  private cachedService: ServiceState | null = null;
  private active: ActiveDownload | null = null;
  private activeTask: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private cpuPrevious: CpuReading | null = null;

  constructor(private readonly deps: EngineManagerDeps) {
    this.home = deps.home ?? homedir();
    this.root = deps.root ?? join(this.home, ".mlx-spy", "engine");
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.spawn = deps.spawn ?? defaultSpawn;
    this.portProbe = deps.portProbe ?? defaultPortProbe;
    this.freeSpace =
      deps.freeSpace ?? ((path) => diskSpace(path)?.free ?? null);
    this.reloadFn = deps.launchd?.reload ?? reload;
    this.bootstrapFn = deps.launchd?.bootstrap ?? bootstrap;
    this.bootoutFn = deps.launchd?.bootout ?? bootout;
    this.kickstartFn = deps.launchd?.kickstart ?? kickstart;
    this.printFn = deps.launchd?.print ?? launchdPrint;
    this.atomicWriteFn = deps.launchd?.atomicWrite ?? atomicWrite;
    this.startedAt = this.now();
    this.verifyStableMs = deps.verifyStableMs ?? VERIFY_STABLE_MS;
    this.verifyTimeoutMs = deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.stallMs = deps.stallMs ?? DOWNLOAD_STALL_MS;
  }

  state(): EngineState {
    const url = new URL(this.deps.engineUrl);
    const defaults = DEFAULTS(this.deps.pinnedModelDir, this.deps.engineUrl);
    const installs = this.deps.store.installs();
    const check = publicCheck(this.deps.store.releaseCheck(ENGINE_REPO));
    const mode = this.mode();
    const refusal =
      mode === "unmanaged"
        ? `Port ${defaults.port} is in use by an mlx-serve that mlx-spy did not install. Stop it first.`
        : null;
    return {
      mode,
      refusal,
      remoteHost: mode === "remote" ? url.hostname : null,
      active: installs.active,
      previous: installs.previous,
      service: this.cachedService,
      config: this.deps.store.config().applied ?? defaults,
      defaults,
      pinnedModelDir: this.deps.pinnedModelDir,
      watchedPort: defaults.port,
      home: this.home,
      preReleases: this.deps.store.preReleases(),
      check,
      offered: offered(
        check.releases,
        this.deps.store.preReleases(),
        installs.active?.tag ?? null,
      ),
      operation: this.operation,
      failure: this.failure,
    };
  }

  running(): string | null {
    return this.deps.lock.running();
  }

  pageState(): EnginePageState {
    return { engine: this.state(), spy: this.spyState() };
  }

  startPolling() {
    if (this.pollTimer !== null || this.stopped) return;
    const set = this.deps.setTimeout ?? setTimeout;
    this.pollTimer = set(() => {
      this.pollTimer = null;
      void this.check().finally(() => this.schedulePoll(CHECK_EVERY_MS));
    }, CHECK_AFTER_MS);
  }

  shutdown() {
    this.stopped = true;
    this.active?.controller.abort();
    if (this.pollTimer !== null) {
      (this.deps.clearTimeout ?? clearTimeout)(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async check(): Promise<EnginePageState> {
    await Promise.all([
      this.checkRepo(ENGINE_REPO, ENGINE_ASSET),
      this.checkRepo(SPY_REPO, SPY_ASSET),
    ]);
    if (this.deps.store.managed()) await this.refreshService();
    return this.publish();
  }

  install(tag: string, config: EngineConfig): EnginePageState {
    this.assertLocal();
    if (this.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is already installed");
    }
    this.assertConfig(config);
    const release = this.release(tag);
    this.accept("install", tag, async () => {
      if (await this.portProbe(config.host, config.port)) {
        throw new EngineManagerError(
          409,
          `Port ${config.port} is in use by an mlx-serve that mlx-spy did not install. Stop it first.`,
        );
      }
      const record = await this.stage(release);
      await this.activate(record, config, "install");
    });
    return this.pageState();
  }

  upgrade(tag: string): EnginePageState {
    this.assertLocal();
    if (!this.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    const config = this.deps.store.config().applied;
    if (!config) throw new EngineManagerError(409, "no applied configuration");
    const release = this.release(tag);
    // The page only offers a newer build; the route must not trust that.
    // The same tag again would replace the running tree in place and
    // leave one build in both slots.
    const running = this.deps.store.installs().active;
    if (running && !isNewer(tag, running.tag)) {
      throw new EngineManagerError(
        409,
        `${tag} is not newer than the running ${running.tag}`,
      );
    }
    this.accept("upgrade", tag, async () => {
      const record = await this.stage(release);
      await this.activate(record, config, "upgrade");
    });
    return this.pageState();
  }

  async cancel(): Promise<EnginePageState> {
    this.assertLocal();
    if (!this.operation || !this.active) {
      throw new EngineManagerError(409, "no install is running");
    }
    if (this.operation.phase === "restarting") {
      throw new EngineManagerError(
        409,
        "cancel is too late; mlx-serve is restarting",
      );
    }
    this.active.controller.abort();
    await this.activeTask;
    return this.pageState();
  }

  async applyConfig(config: EngineConfig): Promise<EnginePageState> {
    this.assertLocal();
    this.assertConfig(config);
    if (!this.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    return this.locked("apply", null, async () => {
      const active = this.deps.store.installs().active;
      const applied = this.deps.store.config().applied;
      if (!active || !applied) {
        throw new EngineManagerError(409, "no active mlx-serve install");
      }
      this.deps.store.setPending(config);
      try {
        await this.reloadConfig(active, config, "apply");
        this.deps.store.commitPending();
        this.deps.store.setJournal(null);
      } catch (error) {
        this.deps.store.setPending(null);
        await this.activationFailure("apply", null, error, active, applied);
        throw new EngineManagerError(502, describeError(error));
      }
    });
  }

  async setPreReleases(value: boolean): Promise<EnginePageState> {
    this.assertLocal();
    if (this.deps.lock.running()) this.busy();
    this.deps.store.setPreReleases(value);
    return this.publish();
  }

  async service(op: ServiceBody["op"]): Promise<EnginePageState> {
    this.assertLocal();
    if (!this.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    return this.locked(op, null, async () => {
      const path = this.plist;
      if (op === "start") {
        await this.bootstrapFn(path, this.launchdDeps());
      } else if (op === "stop") {
        await this.bootoutFn(MANAGED_LABEL, this.launchdDeps());
      } else {
        await this.kickstartFn(MANAGED_LABEL, this.launchdDeps());
      }
      await this.refreshService();
      // bootstrap answers before launchd has spawned the job, so a read
      // right behind it still says "not running" about an engine that
      // is up a moment later
      for (
        let attempt = 0;
        op !== "stop" &&
        this.cachedService?.state !== "running" &&
        attempt < SERVICE_SETTLE_READS;
        attempt++
      ) {
        await this.sleep(VERIFY_POLL_MS);
        await this.refreshService();
      }
    });
  }

  async rollback(): Promise<EnginePageState> {
    this.assertLocal();
    const installs = this.deps.store.installs();
    const config = this.deps.store.config().applied;
    if (!installs.active || !installs.previous || !config) {
      throw new EngineManagerError(409, "no previous mlx-serve install");
    }
    return this.locked("rollback", installs.previous.tag, async () => {
      const old = installs.active!;
      const target = installs.previous!;
      try {
        await this.reloadConfig(target, config!, "rollback");
        this.deps.store.setInstalls(target, null);
        this.deps.store.setJournal(null);
        await rm(this.versionDir(old.tag), { recursive: true, force: true });
      } catch (error) {
        await this.activationFailure(
          "rollback",
          target.tag,
          error,
          old,
          config!,
        );
        throw new EngineManagerError(502, describeError(error));
      }
    });
  }

  async uninstall(): Promise<EnginePageState> {
    this.assertLocal();
    return this.locked("uninstall", null, async () => {
      // every step below is safe to repeat, so the reconcile finishes an
      // interrupted uninstall by running it again
      this.deps.store.setJournal({
        op: "uninstall",
        tag: null,
        step: "uninstall",
        previousPlist: null,
        at: this.now(),
      });
      await this.removeEverything();
    });
  }

  private async removeEverything() {
    await this.bootoutFn(MANAGED_LABEL, this.launchdDeps());
    await rm(this.plist, { force: true });
    await rm(join(this.root, "versions"), { recursive: true, force: true });
    await rm(join(this.root, "downloads"), { recursive: true, force: true });
    this.deps.store.setManaged(false);
    this.deps.store.setInstalls(null, null);
    this.deps.store.setApplied(null);
    this.deps.store.setPending(null);
    this.deps.store.setJournal(null);
    this.cachedService = null;
  }

  // Two trees at most, whatever interrupted what: anything under
  // versions/ that is neither slot is removed.
  private async prune() {
    const { active, previous } = this.deps.store.installs();
    const keep = new Set([active?.tag, previous?.tag]);
    let names: string[] = [];
    try {
      names = await readdir(join(this.root, "versions"));
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      await rm(join(this.root, "versions", name), {
        recursive: true,
        force: true,
      });
    }
  }

  async dismiss(): Promise<EnginePageState> {
    this.assertLocal();
    if (this.deps.lock.running()) this.busy();
    this.failure = null;
    return this.publish();
  }

  async reconcile(): Promise<EnginePageState> {
    const journal = this.deps.store.journal();
    if (!journal || !this.deps.local) {
      // launchd's view is cached, and the cache starts empty: read it once
      // here, or a job that is stopped or crash-looping reads as nothing
      // until the next operation. At start, never on the sampler's path.
      if (this.deps.local && this.deps.store.managed()) {
        await this.refreshService().catch(() => undefined);
        return this.publish();
      }
      return this.pageState();
    }
    this.deps.log.warn(
      `engine ${journal.op}: reconciling ${journal.step} for ${journal.tag ?? "configuration"}`,
    );
    const installs = this.deps.store.installs();
    const target = journal.tag ? this.versionDir(journal.tag) : null;
    const active = installs.active;
    // The verification can take a minute. It holds the lock and shows as
    // the swap it is finishing, so the page is locked and mlx-spy serves
    // meanwhile: a monitor that stays dark because the engine is in
    // trouble is the wrong way round.
    this.operation = {
      kind: journal.op,
      tag: journal.tag,
      phase: "restarting",
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
    this.publish();
    try {
      await this.deps.lock.run("reconcile", () =>
        this.reconcileJournal(journal, target, active),
      );
    } catch (error) {
      this.deps.log.error(
        `engine ${journal.op}: reconcile failed: ${describeError(error)}`,
      );
    } finally {
      this.operation = null;
    }
    await this.refreshService().catch(() => undefined);
    return this.publish();
  }

  private async reconcileJournal(
    journal: EngineJournal,
    target: string | null,
    active: InstallRecord | null,
  ) {
    if (journal.op === "uninstall") {
      await this.removeEverything();
      this.deps.log("engine uninstall: reconciled forward");
      return;
    }
    {
      const info = await this.printFn(MANAGED_LABEL, this.launchdDeps());
      const newJob =
        target !== null &&
        info?.program === join(target, "mlx-serve") &&
        (await this.verify(join(target, "mlx-serve")));
      if (newJob && journal.tag) {
        const record = await this.record(journal.tag);
        if (journal.op === "rollback") {
          this.deps.store.setInstalls(record, null);
        } else if (journal.tag !== active?.tag) {
          this.deps.store.setInstalls(record, active);
        }
        // else an Apply or a Restart: the same build, so the slots stay.
        // Writing it as "record over active" would make one tree both
        // active and previous, and the next Rollback would delete the
        // running one.
        if (this.deps.store.config().pending) this.deps.store.commitPending();
        this.deps.store.setManaged(true);
        this.deps.store.setJournal(null);
        this.deps.log(`engine ${journal.op}: reconciled forward`);
      } else {
        const restored = await this.restoreJournal(journal, active);
        if (!restored) {
          throw new Error("the previous mlx-serve did not come back");
        }
        // The tree an unfinished install or upgrade was heading for is
        // nobody's now. A rollback's target is the previous build, which
        // stays.
        const staged = journal.op === "install" || journal.op === "upgrade";
        if (staged && target !== null && journal.tag !== active?.tag) {
          await rm(target, { recursive: true, force: true });
        }
        this.deps.store.setPending(null);
        this.deps.store.setJournal(null);
        this.deps.log(`engine ${journal.op}: reconciled by rollback`);
      }
      await this.prune();
    }
  }

  private mode(): EngineState["mode"] {
    if (!this.deps.local) return "remote";
    if (this.deps.store.managed()) return "managed";
    return this.deps.engineUp() ? "unmanaged" : "absent";
  }

  private spyState(): SpyState {
    const at = this.now();
    const usage = (this.deps.cpuUsage ?? process.cpuUsage)();
    const current: CpuReading = {
      at,
      userMicros: usage.user,
      systemMicros: usage.system,
    };
    const cpuPct = cpuPercent(this.cpuPrevious, current);
    this.cpuPrevious = current;
    const path = this.deps.execPath ?? process.execPath ?? Bun.main;
    const check = publicCheck(this.deps.store.releaseCheck(SPY_REPO));
    const development = this.deps.version === "v0.0.0-dev";
    return {
      version: this.deps.version,
      // The formula's own directories, not the prefix: from source the
      // executable is bun, which brew installed too.
      brew:
        !development &&
        (path.includes("/Cellar/mlx-spy/") || path.includes("/opt/mlx-spy/")),
      startedAt: this.startedAt,
      rssBytes:
        this.deps.probes.processMemory(process.pid)?.footprint ??
        process.memoryUsage.rss(),
      cpuPct,
      check,
      offered: development
        ? null
        : offered(check.releases, false, this.deps.version),
    };
  }

  private schedulePoll(delay: number) {
    if (this.stopped) return;
    const set = this.deps.setTimeout ?? setTimeout;
    this.pollTimer = set(() => {
      this.pollTimer = null;
      void this.check().finally(() => this.schedulePoll(CHECK_EVERY_MS));
    }, delay);
  }

  private async checkRepo(repo: string, assetName: string) {
    const previous = this.deps.store.releaseCheck(repo);
    try {
      const releases = await fetchReleases(repo, {
        token: this.deps.token,
        fetch: this.fetch,
        assetName,
      });
      this.deps.store.setReleaseCheck(repo, {
        releases,
        checkedAt: this.now(),
        error: null,
      });
    } catch (error) {
      this.deps.store.setReleaseCheck(repo, {
        releases: previous?.releases ?? [],
        checkedAt: this.now(),
        error: describeError(error),
      });
    }
  }

  private release(tag: string): ReleaseDetails {
    const releases = this.deps.store.releaseCheck(ENGINE_REPO)?.releases ?? [];
    if (!isSafeTag(tag, releases)) {
      throw new EngineManagerError(400, "release tag is not offered");
    }
    const release = releases.find((item) => item.tag === tag)!;
    if (!release.asset) {
      throw new EngineManagerError(409, `${tag} has no ${ENGINE_ASSET} asset`);
    }
    return release;
  }

  private accept(
    kind: "install" | "upgrade",
    tag: string,
    operation: () => Promise<void>,
  ) {
    if (this.deps.lock.running()) this.busy();
    this.failure = null;
    this.operation = {
      kind,
      tag,
      phase: "downloading",
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
    this.publish();
    const task = this.deps.lock
      .run(kind, async () => {
        try {
          await operation();
        } catch (error) {
          const cancel =
            this.active?.controller.signal.aborted === true &&
            this.operation?.phase !== "restarting";
          if (this.operation?.phase !== "restarting") {
            await this.removeActive();
            await rm(this.versionDir(tag), { recursive: true, force: true });
          }
          if (cancel) {
            this.deps.log(`engine ${kind} ${tag}: cancelled`);
          } else if (!this.failure) {
            this.failure = {
              kind,
              tag,
              message: describeError(error),
              outcome: this.deps.store.installs().active
                ? `${this.deps.store.installs().active!.version} is still serving`
                : "nothing is serving",
              logTail: "",
              at: this.now(),
            };
            this.deps.log.error(
              `engine ${kind} ${tag}: failed: ${describeError(error)}`,
            );
          }
        } finally {
          this.operation = null;
          this.active = null;
          this.activeTask = null;
          this.publish();
        }
      })
      .catch((error) => {
        this.deps.log.error(`engine ${kind}: ${describeError(error)}`);
      });
    this.activeTask = task;
  }

  private async locked(
    kind: OperationKind,
    tag: string | null,
    operation: () => Promise<void>,
  ): Promise<EnginePageState> {
    if (this.deps.lock.running()) this.busy();
    this.failure = null;
    this.operation = {
      kind,
      tag,
      phase: "restarting",
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
    this.publish();
    try {
      await this.deps.lock.run(kind, operation);
      this.operation = null;
      return this.publish();
    } catch (error) {
      this.operation = null;
      this.publish();
      if (error instanceof EngineManagerError) throw error;
      if (error instanceof LockBusyError) this.busy();
      throw new EngineManagerError(502, describeError(error));
    }
  }

  private async stage(release: ReleaseDetails): Promise<InstallRecord> {
    const asset = release.asset!;
    const downloads = join(this.root, "downloads");
    const versions = join(this.root, "versions");
    await mkdir(downloads, { recursive: true });
    await mkdir(versions, { recursive: true });
    const archive = join(downloads, `${release.tag}.tar.gz`);
    const active: ActiveDownload = {
      controller: new AbortController(),
      part: `${archive}.part`,
      archive,
      temporary: join(versions, `${release.tag}.tmp`),
      staged: join(versions, `${release.tag}.staged`),
      startedAt: this.now(),
      publishedAt: 0,
    };
    this.active = active;
    const free = this.freeSpace(this.root);
    if (free !== null && free < release.assetBytes + DOWNLOAD_DISK_MARGIN) {
      throw new Error(
        `not enough disk: ${Math.round(free / 1024 ** 3)} GB free`,
      );
    }
    this.setPhase("downloading", 0, release.assetBytes);
    await this.download(release, active);
    this.setPhase("verifying", release.assetBytes, release.assetBytes);
    const digest = await this.hash(active.archive, active.controller.signal);
    if (digest !== asset.sha256)
      throw new Error(`${release.tag}: sha256 mismatch`);
    this.setPhase("unpacking", release.assetBytes, release.assetBytes);
    await rm(active.temporary, { recursive: true, force: true });
    await rm(active.staged, { recursive: true, force: true });
    const bytes = await readFile(active.archive);
    const bundle = new Bun.Archive(bytes);
    const entries = await bundle.files();
    if (active.controller.signal.aborted) {
      throw active.controller.signal.reason ?? new Error("cancelled");
    }
    const tops = new Set<string>();
    for (const path of entries.keys()) {
      const top = path.replace(/^\.\//, "").split("/")[0];
      if (top) tops.add(top);
    }
    if (
      tops.size !== 1 ||
      !tops.has(EXPECTED_TOP) ||
      !entries.has(`${EXPECTED_TOP}/mlx-serve`)
    ) {
      throw new Error(
        `unexpected archive top directory: ${[...tops].join(", ") || "empty"}`,
      );
    }
    await mkdir(active.temporary, { recursive: true });
    await bundle.extract(active.temporary);
    if (active.controller.signal.aborted) {
      throw active.controller.signal.reason ?? new Error("cancelled");
    }
    await rename(join(active.temporary, EXPECTED_TOP), active.staged);
    await rm(active.temporary, { recursive: true, force: true });
    const binary = join(active.staged, "mlx-serve");
    const result = await this.spawn([binary, "--version"]);
    if (active.controller.signal.aborted) {
      throw active.controller.signal.reason ?? new Error("cancelled");
    }
    if (result.code !== 0) {
      throw new Error(
        `mlx-serve --version failed: ${result.stderr || result.code}`,
      );
    }
    const parsed = parseVersionOutput(`${result.stdout}\n${result.stderr}`);
    const expected = coreVersion(release.tag);
    if (
      !expected ||
      !parsed.version ||
      (parsed.version !== expected && coreVersion(parsed.version) !== expected)
    ) {
      throw new Error(
        `version mismatch: expected ${expected ?? release.tag}, got ${parsed.version ?? "none"}`,
      );
    }
    const final = this.versionDir(release.tag);
    await rm(final, { recursive: true, force: true });
    await rename(active.staged, final);
    await rm(active.archive, { force: true });
    return {
      tag: release.tag,
      version: release.version,
      mlx: parsed.mlx,
      installedAt: this.now(),
    };
  }

  private async download(release: ReleaseDetails, active: ActiveDownload) {
    const signal = active.controller.signal;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.downloadAttempt(release, active);
        await rename(active.part, active.archive);
        return;
      } catch (error) {
        if (signal.aborted || attempt >= RETRIES) throw error;
        this.deps.log.warn(
          `engine download ${release.tag}: ${describeError(error)}; retry ${attempt} of ${RETRIES - 1}`,
        );
        await sleepWithSignal(this.retryDelayMs * attempt, signal);
      }
    }
  }

  private async downloadAttempt(
    release: ReleaseDetails,
    active: ActiveDownload,
  ) {
    const signal = active.controller.signal;
    let have = await this.fileSize(active.part);
    if (have > release.assetBytes) {
      await truncate(active.part, 0);
      have = 0;
    }
    const headers = new Headers({ "user-agent": "mlx-spy" });
    if (this.deps.token)
      headers.set("authorization", `Bearer ${this.deps.token}`);
    if (have > 0) headers.set("range", `bytes=${have}-`);
    const response = await fetchRedirected(release.asset!.downloadUrl, {
      fetch: this.fetch,
      headers,
      signal,
    });
    if (have > 0 && response.status === 200) {
      await truncate(active.part, 0);
      have = 0;
    } else if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`download: HTTP ${response.status}`);
    }
    const expected = release.assetBytes - have;
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== expected) {
      await response.body?.cancel();
      throw new Error(
        `download declared ${declared} bytes, expected ${expected}`,
      );
    }
    if (!response.body) throw new Error("download returned an empty body");
    const handle = await open(active.part, have > 0 ? "a" : "w");
    const stall = new AbortController();
    const onAbort = () => stall.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => stall.abort(), this.stallMs);
    let cancelRead: () => Promise<void> = async () => {};
    try {
      const reader = response.body.getReader();
      // once per download, not per chunk: each call adds a listener that
      // stays until the signal is collected
      const stalled = abortPromise(stall.signal);
      stalled.catch(() => undefined);
      // whatever ends the loop, a read still pending is let go of
      cancelRead = () => reader.cancel().catch(() => undefined);
      while (true) {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) break;
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), this.stallMs);
        if (have + next.value.byteLength > release.assetBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`download exceeded ${release.assetBytes} bytes`);
        }
        await handle.write(next.value);
        have += next.value.byteLength;
        this.progress(have, release.assetBytes, active);
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (stall.signal.aborted) {
        throw new Error(`download sent no data for ${this.stallMs / 1_000} s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      await cancelRead();
      signal.removeEventListener("abort", onAbort);
      await handle.close();
    }
    if (have !== release.assetBytes) {
      throw new Error(`download got ${have} of ${release.assetBytes} bytes`);
    }
  }

  private progress(done: number, total: number, active: ActiveDownload) {
    const now = this.now();
    if (now - active.publishedAt < PROGRESS_EVERY_MS && done !== total) return;
    active.publishedAt = now;
    const elapsed = Math.max(1, now - active.startedAt);
    if (this.operation) {
      this.operation = {
        ...this.operation,
        doneBytes: done,
        totalBytes: total,
        bytesPerSecond: (done * 1_000) / elapsed,
      };
      this.publish();
    }
  }

  private async hash(path: string, signal: AbortSignal): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const file = await open(path, "r");
    try {
      const buffer = new Uint8Array(HASH_CHUNK);
      while (true) {
        if (signal.aborted) throw signal.reason;
        const result = await file.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) break;
        hasher.update(buffer.subarray(0, result.bytesRead));
      }
    } finally {
      await file.close();
    }
    return hasher.digest("hex");
  }

  private async activate(
    record: InstallRecord,
    config: EngineConfig,
    kind: "install" | "upgrade",
  ) {
    const previous = this.deps.store.installs();
    try {
      // Before the swap, so a crash after it still knows what the job was
      // started from: the reconcile commits this row.
      this.deps.store.setPending(config);
      await this.reloadConfig(record, config, kind);
      this.deps.store.setInstalls(record, previous.active);
      this.deps.store.setApplied(config);
      this.deps.store.setPending(null);
      this.deps.store.setManaged(true);
      this.deps.store.setJournal(null);
      await this.prune();
      this.deps.log(`engine ${kind} ${record.tag}: active`);
    } catch (error) {
      // A Cancel caught before the journal row: the job was never
      // touched, so there is nothing to restore and nothing failed.
      const cancelled =
        this.active?.controller.signal.aborted === true &&
        this.operation?.phase !== "restarting";
      if (cancelled) {
        this.deps.store.setPending(null);
        throw error;
      }
      await this.activationFailure(
        kind,
        record.tag,
        error,
        previous.active,
        config,
      );
      throw error;
    }
  }

  private async reloadConfig(
    record: InstallRecord,
    config: EngineConfig,
    kind: OperationKind,
  ) {
    for (const directory of config.modelDirs) {
      await mkdir(directory, { recursive: true });
    }
    await mkdir(dirname(this.launchdLog), { recursive: true });
    const spec = this.spec(record, config);
    await this.reloadFn(spec, {
      ...this.launchdDeps(),
      path: this.plist,
      home: this.home,
      onBeforeBootout: async (previous) => {
        // the last moment a Cancel can still mean "nothing happened"
        if (this.active?.controller.signal.aborted) {
          throw new EngineManagerError(409, "cancelled");
        }
        await this.markLog();
        this.setPhase(
          "restarting",
          this.operation?.totalBytes ?? 0,
          this.operation?.totalBytes ?? 0,
        );
        this.deps.store.setJournal({
          op: kind,
          tag: record.tag,
          step: "reload",
          previousPlist: previous ? new TextDecoder().decode(previous) : null,
          at: this.now(),
        });
      },
    });
    if (!(await this.verify(join(this.versionDir(record.tag), "mlx-serve")))) {
      throw new Error(`mlx-serve ${record.version} failed verification`);
    }
    await this.refreshService();
  }

  private async verify(binary: string): Promise<boolean> {
    const started = this.now();
    while (this.now() - started <= this.verifyTimeoutMs) {
      const first = await this.printFn(MANAGED_LABEL, this.launchdDeps());
      if (
        first?.state === "running" &&
        first.program === binary &&
        first.pid !== null
      ) {
        await this.sleep(this.verifyStableMs);
        const second = await this.printFn(MANAGED_LABEL, this.launchdDeps());
        if (
          second?.state === "running" &&
          second.program === binary &&
          second.pid === first.pid &&
          (await this.deps.health())
        ) {
          this.cachedService = serviceState(second, this.now());
          return true;
        }
      }
      await this.sleep(VERIFY_POLL_MS);
    }
    await this.refreshService();
    return false;
  }

  private async activationFailure(
    kind: OperationKind,
    tag: string | null,
    error: unknown,
    previous: InstallRecord | null,
    config: EngineConfig,
  ) {
    let outcome = "nothing is serving";
    // Read before the rollback: the restored engine writes its own start
    // banner to the same file and would push the reason out of the tail.
    const logTail = await this.logTail();
    // no journal: the failure came before the job was touched
    let restored = true;
    try {
      const journal = this.deps.store.journal();
      if (journal) restored = await this.restoreJournal(journal, previous);
      if (previous) {
        const serving = journal
          ? restored
          : await this.verify(join(this.versionDir(previous.tag), "mlx-serve"));
        if (serving) {
          outcome =
            kind === "rollback" || kind === "apply"
              ? `still on ${previous.version}, serving again`
              : `rolled back to ${previous.version}, serving again`;
        }
      } else {
        this.deps.store.setManaged(false);
        this.deps.store.setInstalls(null, null);
        this.deps.store.setApplied(null);
      }
    } catch (rollbackError) {
      restored = false;
      this.deps.log.error(
        `engine ${kind}: rollback failed: ${describeError(rollbackError)}`,
      );
    }
    // Only a tree this operation staged is discarded. A failed rollback
    // was heading for the previous build, which is still the backup the
    // page offers: deleting it would leave a Rollback button over nothing.
    const staged = kind === "install" || kind === "upgrade";
    if (staged && tag && (!previous || tag !== previous.tag)) {
      await rm(this.versionDir(tag), { recursive: true, force: true });
    }
    this.deps.store.setPending(null);
    // An unrestored engine keeps its journal row: the next start tries
    // again, which is all that stands between this and an engine that
    // stays down.
    if (restored) this.deps.store.setJournal(null);
    this.failure = {
      kind,
      tag,
      message: describeError(error),
      outcome,
      logTail,
      at: this.now(),
    };
    this.deps.log.error(
      `engine ${kind}${tag ? ` ${tag}` : ""}: ${this.failure.message}; ${outcome}`,
    );
    void config;
  }

  // True when what ran before is back and verified. The journal row is
  // the only way to try again, so it is cleared on true and on nothing
  // else.
  private async restoreJournal(
    journal: EngineJournal,
    previous: InstallRecord | null,
  ): Promise<boolean> {
    await this.bootoutFn(MANAGED_LABEL, this.launchdDeps());
    if (journal.previousPlist === null) {
      // nothing ran before: gone is the restored state
      await rm(this.plist, { force: true });
      return true;
    }
    await this.atomicWriteFn(
      this.plist,
      journal.previousPlist,
      this.launchdDeps(),
    );
    await this.bootstrapFn(this.plist, this.launchdDeps());
    if (!previous) return true;
    return this.verify(join(this.versionDir(previous.tag), "mlx-serve"));
  }

  private async record(tag: string): Promise<InstallRecord> {
    const result = await this.spawn([
      join(this.versionDir(tag), "mlx-serve"),
      "--version",
    ]);
    if (result.code !== 0) throw new Error(`cannot read ${tag} version`);
    const parsed = parseVersionOutput(`${result.stdout}\n${result.stderr}`);
    const expected = coreVersion(tag);
    if (!parsed.version || coreVersion(parsed.version) !== expected) {
      throw new Error(`${tag} version does not match its binary`);
    }
    return {
      tag,
      version: tag.replace(/^v/, ""),
      mlx: parsed.mlx,
      installedAt: this.now(),
    };
  }

  private spec(record: InstallRecord, config: EngineConfig): PlistSpec {
    const directory = this.versionDir(record.tag);
    const binary = join(directory, "mlx-serve");
    return {
      label: MANAGED_LABEL,
      programArguments: [
        binary,
        ...configToArgs(config, this.engineLog(config.port)),
      ],
      workingDirectory: this.home,
      environmentVariables: {
        HOME: this.home,
        PATH: `/usr/bin:/bin:${directory}`,
      },
      runAtLoad: true,
      keepAlive: true,
      throttleInterval: 10,
      processType: "Interactive",
      standardOutPath: this.launchdLog,
      standardErrorPath: this.launchdLog,
    };
  }

  private async refreshService() {
    const info = await this.printFn(MANAGED_LABEL, this.launchdDeps());
    this.cachedService = serviceState(info, this.now());
  }

  private assertConfig(config: EngineConfig) {
    const url = new URL(this.deps.engineUrl);
    const issues = validateConfig(config, {
      pinnedModelDir: this.deps.pinnedModelDir,
      watchedPort: Number(url.port || 11234),
      engineHost: url.hostname,
    });
    if (issues.length > 0) {
      throw new EngineManagerError(422, "configuration was refused", issues);
    }
  }

  private assertLocal() {
    if (!this.deps.local) {
      throw new EngineManagerError(
        403,
        "engine management only works when mlx-serve runs on this host",
      );
    }
  }

  private busy(): never {
    const holder = this.deps.lock.running() ?? "another operation";
    throw new EngineManagerError(409, `${holder} is still running`);
  }

  private setPhase(
    phase: Operation["phase"],
    doneBytes: number,
    totalBytes: number,
  ) {
    if (!this.operation) return;
    this.operation = {
      ...this.operation,
      phase,
      doneBytes,
      totalBytes,
      bytesPerSecond:
        phase === "downloading" ? this.operation.bytesPerSecond : 0,
    };
    this.publish();
  }

  private publish(): EnginePageState {
    const state = this.pageState();
    this.deps.publish?.(state);
    return state;
  }

  private launchdDeps(): ReloadDeps {
    return { ...this.deps.launchdDeps, spawn: this.spawn };
  }

  private versionDir(tag: string) {
    return join(this.root, "versions", tag);
  }

  private engineLog(port: number) {
    return join(this.home, ".mlx-serve", "logs", `mlx-serve-${port}.log`);
  }

  private get launchdLog() {
    return join(this.home, ".mlx-serve", "logs", "launchd.log");
  }

  private get plist() {
    return plistPath(MANAGED_LABEL, this.home);
  }

  private async fileSize(path: string) {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  private async removeActive() {
    const active = this.active;
    if (!active) return;
    await Promise.all([
      rm(active.part, { force: true }),
      rm(active.archive, { force: true }),
      rm(active.temporary, { recursive: true, force: true }),
      rm(active.staged, { recursive: true, force: true }),
    ]);
  }

  // Where the engine's launchd log ended when the swap began: a failure
  // tails only what the failed job wrote, not the banner of the run
  // before it. The reload may rotate the file, which resets the mark.
  private logMark = 0;

  private async markLog() {
    try {
      this.logMark = (await stat(this.launchdLog)).size;
    } catch {
      this.logMark = 0;
    }
  }

  private async logTail(): Promise<string> {
    try {
      const bytes = await readFile(this.launchdLog);
      const from = this.logMark <= bytes.length ? this.logMark : 0;
      const lines = new TextDecoder().decode(bytes.subarray(from)).split("\n");
      // a crash loop says the same thing every ten seconds; once is
      // enough
      return lines
        .filter((line, i) => line !== "" && line !== lines[i - 2])
        .filter((line, i, kept) => line !== kept[i - 1])
        .slice(-20)
        .join("\n");
    } catch {
      return "";
    }
  }
}
