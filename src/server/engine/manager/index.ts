// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import type {
  EngineConfig,
  EnginePageState,
  EngineState,
  Operation,
  OperationKind,
  ServiceBody,
} from "../../../shared/engine.ts";
import { describeError } from "../../lib/fetch.ts";
import { LockBusyError } from "../../lib/lock.ts";
import { DEFAULTS, validateConfig } from "../config.ts";
import { isNewer, offered } from "../release.ts";
import {
  createManagerContext,
  ENGINE_REPO,
  type EngineManagerDeps,
  EngineManagerError,
  type ManagerContext,
  versionDir,
} from "./context.ts";
import {
  prune,
  reconcile,
  removeActive,
  removeEverything,
  restoreJournal,
} from "./journal.ts";
import {
  CHECK_AFTER_MS,
  publicCheck,
  publicCheckRepos,
  schedulePoll,
} from "./poll.ts";
import { selfState } from "./self.ts";
import { release, stage } from "./stage.ts";
import {
  activate,
  activationFailure,
  defaultPortProbe,
  defaultSpawn,
  reloadConfig,
  service as runService,
} from "./swap.ts";

export class EngineManager {
  private readonly context: ManagerContext;

  constructor(deps: EngineManagerDeps) {
    this.context = createManagerContext(
      deps,
      () => this.publish(),
      () => this.pageState(),
      (phase, doneBytes, totalBytes) =>
        this.setPhase(phase, doneBytes, totalBytes),
      defaultSpawn,
      defaultPortProbe,
    );
  }

  state(): EngineState {
    const context = this.context;
    const url = new URL(context.deps.engineUrl);
    const defaults = DEFAULTS(
      context.deps.pinnedModelDir,
      context.deps.engineUrl,
    );
    const installs = context.deps.store.installs();
    const check = publicCheck(context.deps.store.releaseCheck(ENGINE_REPO));
    const mode = this.mode();
    const refusal =
      mode === "unmanaged"
        ? `Port ${defaults.port} is in use by an mlx-serve that 1ctx-mlx-engine did not install. Stop it first.`
        : null;
    return {
      mode,
      refusal,
      remoteHost: mode === "remote" ? url.hostname : null,
      active: installs.active,
      previous: installs.previous,
      service: context.cachedService,
      config: context.deps.store.config().applied ?? defaults,
      defaults,
      pinnedModelDir: context.deps.pinnedModelDir,
      watchedPort: defaults.port,
      home: context.home,
      preReleases: context.deps.store.preReleases(),
      check,
      offered: offered(
        check.releases,
        context.deps.store.preReleases(),
        installs.active?.tag ?? null,
      ),
      operation: context.operation,
      failure: context.failure,
    };
  }

  running(): string | null {
    return this.context.deps.lock.running();
  }

  pageState(): EnginePageState {
    return { engine: this.state(), self: selfState(this.context) };
  }

  startPolling() {
    const context = this.context;
    if (context.pollTimer !== null || context.stopped) return;
    schedulePoll(context, CHECK_AFTER_MS, () => this.check());
  }

  shutdown() {
    const context = this.context;
    context.stopped = true;
    context.active?.controller.abort();
    if (context.pollTimer !== null) {
      (context.deps.clearTimeout ?? clearTimeout)(context.pollTimer);
      context.pollTimer = null;
    }
  }

  async check(): Promise<EnginePageState> {
    return publicCheckRepos(this.context);
  }

  install(tag: string, config: EngineConfig): EnginePageState {
    const context = this.context;
    this.assertLocal();
    if (context.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is already installed");
    }
    this.assertConfig(config);
    const details = release(context, tag);
    this.accept("install", tag, async () => {
      if (await context.portProbe(config.host, config.port)) {
        throw new EngineManagerError(
          409,
          `Port ${config.port} is in use by an mlx-serve that 1ctx-mlx-engine did not install. Stop it first.`,
        );
      }
      const record = await stage(context, details);
      await activate(context, record, config, "install", prune, restoreJournal);
    });
    return this.pageState();
  }

  upgrade(tag: string): EnginePageState {
    const context = this.context;
    this.assertLocal();
    if (!context.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    const config = context.deps.store.config().applied;
    if (!config) throw new EngineManagerError(409, "no applied configuration");
    const details = release(context, tag);
    // The page only offers a newer build; the route must not trust that.
    // The same tag again would replace the running tree in place and
    // leave one build in both slots.
    const running = context.deps.store.installs().active;
    if (running && !isNewer(tag, running.tag)) {
      throw new EngineManagerError(
        409,
        `${tag} is not newer than the running ${running.tag}`,
      );
    }
    this.accept("upgrade", tag, async () => {
      const record = await stage(context, details);
      await activate(context, record, config, "upgrade", prune, restoreJournal);
    });
    return this.pageState();
  }

  async cancel(): Promise<EnginePageState> {
    const context = this.context;
    this.assertLocal();
    if (!context.operation || !context.active) {
      throw new EngineManagerError(409, "no install is running");
    }
    if (context.operation.phase === "restarting") {
      throw new EngineManagerError(
        409,
        "cancel is too late; mlx-serve is restarting",
      );
    }
    context.active.controller.abort();
    await context.activeTask;
    return this.pageState();
  }

  async applyConfig(config: EngineConfig): Promise<EnginePageState> {
    const context = this.context;
    this.assertLocal();
    this.assertConfig(config);
    if (!context.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    return this.locked("apply", null, async () => {
      const active = context.deps.store.installs().active;
      const applied = context.deps.store.config().applied;
      if (!active || !applied) {
        throw new EngineManagerError(409, "no active mlx-serve install");
      }
      context.deps.store.setPending(config);
      try {
        await reloadConfig(context, active, config, "apply");
        context.deps.store.commitPending();
        context.deps.store.setJournal(null);
      } catch (error) {
        context.deps.store.setPending(null);
        await activationFailure(
          context,
          "apply",
          null,
          error,
          active,
          applied,
          restoreJournal,
        );
        throw new EngineManagerError(502, describeError(error));
      }
    });
  }

  async setPreReleases(value: boolean): Promise<EnginePageState> {
    this.assertLocal();
    if (this.context.deps.lock.running()) this.busy();
    this.context.deps.store.setPreReleases(value);
    return this.publish();
  }

  async service(op: ServiceBody["op"]): Promise<EnginePageState> {
    this.assertLocal();
    if (!this.context.deps.store.managed()) {
      throw new EngineManagerError(409, "mlx-serve is not managed");
    }
    return this.locked(op, null, () => runService(this.context, op));
  }

  async rollback(): Promise<EnginePageState> {
    const context = this.context;
    this.assertLocal();
    const installs = context.deps.store.installs();
    const config = context.deps.store.config().applied;
    if (!installs.active || !installs.previous || !config) {
      throw new EngineManagerError(409, "no previous mlx-serve install");
    }
    return this.locked("rollback", installs.previous.tag, async () => {
      const old = installs.active!;
      const target = installs.previous!;
      try {
        await reloadConfig(context, target, config!, "rollback");
        context.deps.store.setInstalls(target, null);
        context.deps.store.setJournal(null);
        await rm(versionDir(context, old.tag), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        await activationFailure(
          context,
          "rollback",
          target.tag,
          error,
          old,
          config!,
          restoreJournal,
        );
        throw new EngineManagerError(502, describeError(error));
      }
    });
  }

  async uninstall(): Promise<EnginePageState> {
    const context = this.context;
    this.assertLocal();
    return this.locked("uninstall", null, async () => {
      // every step below is safe to repeat, so the reconcile finishes an
      // interrupted uninstall by running it again
      context.deps.store.setJournal({
        op: "uninstall",
        tag: null,
        step: "uninstall",
        previousPlist: null,
        at: context.now(),
      });
      await removeEverything(context);
    });
  }

  async dismiss(): Promise<EnginePageState> {
    this.assertLocal();
    if (this.context.deps.lock.running()) this.busy();
    this.context.failure = null;
    return this.publish();
  }

  async reconcile(): Promise<EnginePageState> {
    return reconcile(this.context);
  }

  private mode(): EngineState["mode"] {
    const context = this.context;
    if (!context.deps.local) return "remote";
    if (context.deps.store.managed()) return "managed";
    return context.deps.engineUp() ? "unmanaged" : "absent";
  }

  private accept(
    kind: "install" | "upgrade",
    tag: string,
    operation: () => Promise<void>,
  ) {
    const context = this.context;
    if (context.deps.lock.running()) this.busy();
    context.failure = null;
    context.operation = {
      kind,
      tag,
      phase: "downloading",
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
    this.publish();
    const task = context.deps.lock
      .run(kind, async () => {
        try {
          await operation();
        } catch (error) {
          const cancel =
            context.active?.controller.signal.aborted === true &&
            context.operation?.phase !== "restarting";
          if (context.operation?.phase !== "restarting") {
            await removeActive(context);
            await rm(versionDir(context, tag), {
              recursive: true,
              force: true,
            });
          }
          if (cancel) {
            context.deps.log(`engine ${kind} ${tag}: cancelled`);
          } else if (!context.failure) {
            context.failure = {
              kind,
              tag,
              message: describeError(error),
              outcome: context.deps.store.installs().active
                ? `${context.deps.store.installs().active!.version} is still serving`
                : "nothing is serving",
              logTail: "",
              at: context.now(),
            };
            context.deps.log.error(
              `engine ${kind} ${tag}: failed: ${describeError(error)}`,
            );
          }
        } finally {
          context.operation = null;
          context.active = null;
          context.activeTask = null;
          this.publish();
        }
      })
      .catch((error) => {
        context.deps.log.error(`engine ${kind}: ${describeError(error)}`);
      });
    context.activeTask = task;
  }

  private async locked(
    kind: OperationKind,
    tag: string | null,
    operation: () => Promise<void>,
  ): Promise<EnginePageState> {
    const context = this.context;
    if (context.deps.lock.running()) this.busy();
    context.failure = null;
    context.operation = {
      kind,
      tag,
      phase: "restarting",
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
    this.publish();
    try {
      await context.deps.lock.run(kind, operation);
      context.operation = null;
      return this.publish();
    } catch (error) {
      context.operation = null;
      this.publish();
      if (error instanceof EngineManagerError) throw error;
      if (error instanceof LockBusyError) this.busy();
      throw new EngineManagerError(502, describeError(error));
    }
  }

  private assertConfig(config: EngineConfig) {
    const context = this.context;
    const url = new URL(context.deps.engineUrl);
    const issues = validateConfig(config, {
      pinnedModelDir: context.deps.pinnedModelDir,
      watchedPort: Number(url.port || 11234),
      engineHost: url.hostname,
    });
    if (issues.length > 0) {
      throw new EngineManagerError(422, "configuration was refused", issues);
    }
  }

  private assertLocal() {
    if (!this.context.deps.local) {
      throw new EngineManagerError(
        403,
        "engine management only works when mlx-serve runs on this host",
      );
    }
  }

  private busy(): never {
    const holder = this.context.deps.lock.running() ?? "another operation";
    throw new EngineManagerError(409, `${holder} is still running`);
  }

  private setPhase(
    phase: Operation["phase"],
    doneBytes: number,
    totalBytes: number,
  ) {
    const context = this.context;
    if (!context.operation) return;
    context.operation = {
      ...context.operation,
      phase,
      doneBytes,
      totalBytes,
      bytesPerSecond:
        phase === "downloading" ? context.operation.bytesPerSecond : 0,
    };
    this.publish();
  }

  private publish(): EnginePageState {
    const state = this.pageState();
    this.context.deps.publish?.(state);
    return state;
  }
}

export type { CpuReading, EngineManagerDeps } from "./context.ts";
export {
  ENGINE_REPO,
  EngineManagerError,
  MANAGED_LABEL,
  SELF_REPO,
} from "./context.ts";
export { cpuPercent } from "./self.ts";
export { defaultPortProbe } from "./swap.ts";
