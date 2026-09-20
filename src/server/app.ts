// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import page from "../client/index.html";
import type { EnginePageState } from "../shared/engine.ts";
import { Actions } from "./actions.ts";
import { BenchmarkRunner, LOCK_LABEL } from "./benchmark/runner.ts";
import { BenchmarkStore } from "./benchmark/store.ts";
import { BUILD, type Options, VERSION } from "./cli.ts";
import { cacheLimits, configToArgs, limitsFromArgs } from "./engine/config.ts";
import { EngineManager } from "./engine/manager/index.ts";
import { MlxServe } from "./engine/mlxserve.ts";
import { EngineStore } from "./engine/store.ts";
import { createHostProbes } from "./host/index.ts";
import { hostInfo, macosVersion, osMajor } from "./host/info.ts";
import { isLocalUrl } from "./host/local.ts";
import { ExclusiveLock } from "./lib/lock.ts";
import { createFileSink, createLog } from "./lib/log.ts";
import { DEFAULT_PORT, tailscaleAddress } from "./lib/net.ts";
import { loadKey, secretsDir } from "./lib/secrets.ts";
import { Downloader } from "./models/download.ts";
import { DownloadStore } from "./models/store.ts";
import { History } from "./monitor/history.ts";
import { takeSample } from "./monitor/sample.ts";
import { Sampler } from "./monitor/sampler.ts";
import { SERVICE_LABEL } from "./service/service.ts";
import { serve } from "./web/index.ts";

// Rates need two readings; one second matches the sampler's tick.
const ONCE_WINDOW_MS = 1000;

export class AppError extends Error {}

export interface AppDeps {
  macosVersion?: () => string | null;
}

export async function runApp(
  options: Options,
  deps: AppDeps = {},
): Promise<number | undefined> {
  let engineStore: EngineStore | null = null;
  const engine = new MlxServe(options.engineUrl, {
    managed: () => engineStore?.managed() ?? false,
    config: () => engineStore?.config().applied ?? null,
  });

  if (options.once) {
    const probes = await createHostProbes();
    const sample = await takeSample(engine, ONCE_WINDOW_MS, probes);
    console.log(JSON.stringify(sample, null, 2));
    return sample.engineUp ? 0 : 2;
  }

  const version = (deps.macosVersion ?? macosVersion)();
  if (version === null || (osMajor(version) ?? 0) < 26) {
    throw new AppError(
      `macOS 26 or newer is required; found ${version ?? "unknown"}`,
    );
  }

  const probes = await createHostProbes();
  const local = isLocalUrl(options.engineUrl);

  let hostname = tailscaleAddress() ?? "127.0.0.1";
  let port = DEFAULT_PORT;
  if (options.listen) {
    if (options.listen.hostname) hostname = options.listen.hostname;
    if (options.listen.port !== null) port = options.listen.port;
  }

  let log: ReturnType<typeof createLog>;
  try {
    log = createLog(createFileSink(options.logFile));
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : String(error));
  }

  // Bad key files fail loud and plain without unrelated usage text.
  const keyDir = secretsDir();
  let hubToken: string | null;
  let githubToken: string | null;
  try {
    hubToken = loadKey(join(keyDir, "hf.key"));
    githubToken = loadKey(join(keyDir, "gh.key"));
  } catch (error) {
    log.close?.();
    throw new AppError(error instanceof Error ? error.message : String(error));
  }
  log(`hf key: ${hubToken === null ? "none" : join(keyDir, "hf.key")}`);
  log(`gh key: ${githubToken === null ? "none" : join(keyDir, "gh.key")}`);

  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  mkdirSync(options.modelDir, { recursive: true });
  const history = new History(options.dbPath, options.retentionDays);
  const store = new EngineStore(history.db);
  engineStore = store;
  const sampler = new Sampler(engine, history, { log, probes, local });
  const currentLimits = () => {
    const managed = store.managed() ? store.config().applied : null;
    const managedLimits = managed
      ? limitsFromArgs(configToArgs(managed, "off"))
      : null;
    const label = local ? engine.serviceLabel() : null;
    const plistLimits = label ? cacheLimits(label) : null;
    return options.hotMax !== null ||
      options.diskMax !== null ||
      managedLimits ||
      plistLimits
      ? {
          hotBytes:
            options.hotMax ??
            managedLimits?.hotBytes ??
            plistLimits?.hotBytes ??
            0,
          diskBytes:
            options.diskMax ??
            managedLimits?.diskBytes ??
            plistLimits?.diskBytes ??
            0,
        }
      : sampler.currentLimits();
  };
  const lock = new ExclusiveLock();
  const actions = new Actions({
    engine,
    sampler,
    history,
    local,
    log,
    lock,
  });
  const downloads = new Downloader({
    store: new DownloadStore(history.db),
    modelDir: options.modelDir,
    token: hubToken,
    engine,
    refreshModels: () => sampler.refreshModels(),
    log,
    // a download moves gigabytes through the same disk and memory bus
    blocked: () =>
      lock.running() === LOCK_LABEL ? "A benchmark is running" : null,
  });
  let publishEngine: ((state: EnginePageState) => void) | null = null;
  const manager = new EngineManager({
    store,
    lock,
    engineUrl: options.engineUrl,
    pinnedModelDir: options.modelDir,
    listenHost: hostname,
    local,
    engineUp: () => history.latest()?.engineUp ?? false,
    health: () => engine.health(),
    log,
    version: VERSION,
    probes,
    token: githubToken,
    publish: (state) => publishEngine?.(state),
  });
  const host = await hostInfo();
  const benchmarks = new BenchmarkRunner({
    engine,
    store: new BenchmarkStore(history.db),
    lock,
    sampler,
    prepare: {
      restart: () => actions.restartEngine(),
      clearDisk: () => actions.clearDiskTier(),
    },
    // The run restarts the engine and deletes its cache, so it needs what
    // every managing route needs, checked here and not only by the page;
    // and an engine doing anything else would not be measured alone.
    refusal: () => {
      if (!local) return "A benchmark only runs on an engine on this host";
      if (manager.state().mode !== "managed") {
        return "A benchmark only runs on an engine 1ctx-mlx-engine manages";
      }
      if (downloads.running()) return "A download is running";
      const latest = history.latest();
      if (!latest?.engineUp) return "The engine is not running";
      if (latest.requestsRunning + latest.requestsWaiting > 0) {
        return "The engine is serving a request";
      }
      return null;
    },
    facts: () => {
      const applied = store.config().applied;
      return {
        appVersion: VERSION,
        engineVersion: manager.state().active?.version ?? null,
        engineArgs: applied ? configToArgs(applied, "off") : [],
        chip: host.chip,
        memoryBytes: host.memTotal,
        os: host.os,
      };
    },
    log,
  });
  const web = serve(
    {
      engine,
      sampler,
      history,
      actions,
      downloads,
      benchmarks,
      manager,
      selfRestart: {
        // launchd names the job in the environment of what it starts. A
        // parent pid of 1 is no sign of it: a detached `nohup` process
        // has one too, and an exit there is just a dead server.
        isLaunchd: () => process.env.XPC_SERVICE_NAME === SERVICE_LABEL,
        exit: (code) => process.exit(code),
        lock,
      },
      version: VERSION,
      build: BUILD,
      local,
      currentLimits,
      host,
      modelDir: options.modelDir,
    },
    { hostname, port },
    page,
  );
  publishEngine = (state) => web.publishEngine(state);
  sampler.start();
  downloads.resume();
  // after serve(): finishing an interrupted swap can take a minute, and
  // the page should be there to say so
  void manager.reconcile();
  manager.startPolling();
  log(
    `1ctx-mlx-engine ${VERSION} on http://${web.server.hostname}:${web.server.port}, engine ${options.engineUrl} (${local ? "local" : "remote"}), history ${options.dbPath}, models ${options.modelDir}`,
  );

  const shutdown = () => {
    manager.shutdown();
    sampler.stop();
    downloads.shutdown();
    web.stop();
    history.close();
    log.close?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
