// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConfigIssue,
  EnginePageState,
  Failure,
  Operation,
  ServiceState,
} from "../../../shared/engine.ts";
import { diskSpace } from "../../host/info.ts";
import type { HostProbes } from "../../host/types.ts";
import { DOWNLOAD_STALL_MS } from "../../lib/fetch.ts";
import type { ExclusiveLock } from "../../lib/lock.ts";
import type { Log } from "../../lib/log.ts";
import {
  atomicWrite,
  bootout,
  bootstrap,
  kickstart,
  print as launchdPrint,
  type ReloadDeps,
  reload,
} from "../../service/launchd.ts";
import { plistPath } from "../../service/plist.ts";
import type { EngineStore } from "../store.ts";

export const ENGINE_REPO = "ddalcu/mlx-serve";
export const SELF_REPO = "stefanprodan/1ctx-mlx-engine";
export const MANAGED_LABEL = "com.stefanprodan.mlx-serve";
export const EXPECTED_TOP = "mlx-serve-macos-arm64";
export const VERIFY_TIMEOUT_MS = 60_000;
export const VERIFY_STABLE_MS = 5_000;
export const VERIFY_POLL_MS = 1_000;
export const PROGRESS_EVERY_MS = 500;
export const RETRIES = 5;
export const RETRY_DELAY_MS = 2_000;
export const HASH_CHUNK = 4 * 1024 * 1024;
export const SERVICE_SETTLE_READS = 20;

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

export type ActiveDownload = {
  controller: AbortController;
  part: string;
  archive: string;
  temporary: string;
  staged: string;
  startedAt: number;
  publishedAt: number;
};

export type Spawn = NonNullable<ReloadDeps["spawn"]>;

export type ManagerContext = {
  deps: EngineManagerDeps;
  home: string;
  root: string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  fetch: typeof globalThis.fetch;
  spawn: Spawn;
  portProbe: (host: string, port: number) => Promise<boolean>;
  freeSpace: (path: string) => number | null;
  reloadFn: typeof reload;
  bootstrapFn: typeof bootstrap;
  bootoutFn: typeof bootout;
  kickstartFn: typeof kickstart;
  printFn: typeof launchdPrint;
  atomicWriteFn: typeof atomicWrite;
  startedAt: number;
  verifyStableMs: number;
  verifyTimeoutMs: number;
  retryDelayMs: number;
  stallMs: number;
  operation: Operation | null;
  failure: Failure | null;
  cachedService: ServiceState | null;
  active: ActiveDownload | null;
  activeTask: Promise<void> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  cpuPrevious: CpuReading | null;
  logMark: number;
  publish: () => EnginePageState;
  pageState: () => EnginePageState;
  setPhase: (
    phase: Operation["phase"],
    doneBytes: number,
    totalBytes: number,
  ) => void;
};

export function createManagerContext(
  deps: EngineManagerDeps,
  publish: () => EnginePageState,
  pageState: () => EnginePageState,
  setPhase: ManagerContext["setPhase"],
  defaultSpawn: Spawn,
  defaultPortProbe: ManagerContext["portProbe"],
): ManagerContext {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  return {
    deps,
    home,
    root: deps.root ?? join(home, ".1ctx-mlx-engine", "engine"),
    now,
    sleep:
      deps.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    fetch: deps.fetch ?? globalThis.fetch,
    spawn: deps.spawn ?? defaultSpawn,
    portProbe: deps.portProbe ?? defaultPortProbe,
    freeSpace: deps.freeSpace ?? ((path) => diskSpace(path)?.free ?? null),
    reloadFn: deps.launchd?.reload ?? reload,
    bootstrapFn: deps.launchd?.bootstrap ?? bootstrap,
    bootoutFn: deps.launchd?.bootout ?? bootout,
    kickstartFn: deps.launchd?.kickstart ?? kickstart,
    printFn: deps.launchd?.print ?? launchdPrint,
    atomicWriteFn: deps.launchd?.atomicWrite ?? atomicWrite,
    startedAt: now(),
    verifyStableMs: deps.verifyStableMs ?? VERIFY_STABLE_MS,
    verifyTimeoutMs: deps.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
    retryDelayMs: deps.retryDelayMs ?? RETRY_DELAY_MS,
    stallMs: deps.stallMs ?? DOWNLOAD_STALL_MS,
    operation: null,
    failure: null,
    cachedService: null,
    active: null,
    activeTask: null,
    pollTimer: null,
    stopped: false,
    cpuPrevious: null,
    logMark: 0,
    publish,
    pageState,
    setPhase,
  };
}

export function launchdDeps(context: ManagerContext): ReloadDeps {
  return { ...context.deps.launchdDeps, spawn: context.spawn };
}

export function versionDir(context: ManagerContext, tag: string) {
  return join(context.root, "versions", tag);
}

export function engineLog(context: ManagerContext, port: number) {
  return join(context.home, ".mlx-serve", "logs", `mlx-serve-${port}.log`);
}

export function launchdLog(context: ManagerContext) {
  return join(context.home, ".mlx-serve", "logs", "launchd.log");
}

export function plist(context: ManagerContext) {
  return plistPath(MANAGED_LABEL, context.home);
}
