// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The contract between the engine manager and the Server page: what
// GET /api/engine answers, what {type: "engine"} carries on /ws, and the
// bodies the management routes take. Types only, so the page can import
// it without dragging the manager into the bundle.

export type KvQuant = "off" | "4" | "8" | "turbo2" | "turbo4";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type BindHost = "127.0.0.1" | "0.0.0.0";

// A null field is not emitted, so the engine's own default applies. Sizes
// keep the engine's grammar ("16GB", "off") and paths are absolute; the
// page abbreviates the home directory on the way in and out.
export type EngineConfig = {
  host: BindHost;
  port: number;
  modelDirs: string[];
  prefixCacheMem: string | null;
  prefixCacheDisk: string | null;
  prefixCacheEntries: number | null;
  maxResidentModels: number | null;
  maxResidentMem: string | null;
  ctxSize: number | null;
  idleEvictSeconds: number | null;
  temp: number | null;
  topP: number | null;
  topK: number | null;
  kvQuant: KvQuant;
  // --mtp forces the head on for MoE targets too; false leaves the choice
  // to the engine
  mtp: boolean;
  // on in the engine by default; false emits --no-pld
  pld: boolean;
  noVision: boolean;
  logLevel: LogLevel;
  extraArgs: string[];
};

export type ConfigField = keyof EngineConfig;

// One refusal, attached to the field that caused it so the page can say
// so next to the control.
export type ConfigIssue = { field: ConfigField; message: string };

export type Release = {
  tag: string;
  // the tag without its leading v, as the page shows it
  version: string;
  prerelease: boolean;
  publishedAt: string;
  assetBytes: number;
};

export type InstallRecord = {
  tag: string;
  version: string;
  // from `mlx-serve --version`, null when the binary did not say
  mlx: string | null;
  installedAt: number;
};

// Which of the page's states the mlx-serve section is in. "unmanaged" is
// a local engine that answers on the port and that 1ctx-mlx-engine did not
// install; "absent" is a local port nothing answers on.
export type EngineMode = "remote" | "unmanaged" | "absent" | "managed";

// launchd's view of the managed job, read after a management operation
// or an explicit refresh, never on the sampler's path.
export type ServiceState = {
  state: "running" | "stopped" | "crashed";
  pid: number | null;
  lastExitCode: number | null;
  // when launchctl was asked
  readAt: number;
};

export type OperationKind =
  | "install"
  | "upgrade"
  | "apply"
  | "rollback"
  | "start"
  | "stop"
  | "restart"
  | "uninstall";

// "restarting" is the swap: from there on cancel is refused.
export type OperationPhase =
  | "downloading"
  | "verifying"
  | "unpacking"
  | "restarting";

export type Operation = {
  kind: OperationKind;
  tag: string | null;
  phase: OperationPhase;
  doneBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
};

// The last operation that failed, kept until it is dismissed or another
// operation starts.
export type Failure = {
  kind: OperationKind;
  tag: string | null;
  message: string;
  // what the engine is doing now, e.g. "rolled back to 26.9.3"
  outcome: string;
  // the tail of the engine's launchd log, empty when there is none
  logTail: string;
  at: number;
};

export type ReleaseCheck = {
  // newest first, stable and pre-release alike
  releases: Release[];
  checkedAt: number | null;
  error: string | null;
};

export type EngineState = {
  mode: EngineMode;
  // why management is refused: the remote host, or the port being held
  // by an engine 1ctx-mlx-engine did not install; null when nothing is refused
  refusal: string | null;
  // the engine's host when it is remote, for the locality line
  remoteHost: string | null;
  active: InstallRecord | null;
  previous: InstallRecord | null;
  service: ServiceState | null;
  // the config the running job was started from; DEFAULTS until the
  // first install
  config: EngineConfig;
  defaults: EngineConfig;
  // 1ctx-mlx-engine's own --model-dir, which must stay in config.modelDirs
  pinnedModelDir: string;
  // the port of 1ctx-mlx-engine's --engine URL, which config.port must match
  watchedPort: number;
  home: string;
  preReleases: boolean;
  check: ReleaseCheck;
  // the release the row offers under the current pre-release setting:
  // newer than the active build when managed, the latest otherwise
  offered: Release | null;
  operation: Operation | null;
  failure: Failure | null;
};

// The GitHub repositories the manager reads releases from, and the page
// a release has there.
export const ENGINE_REPO = "ddalcu/mlx-serve";
export const SELF_REPO = "stefanprodan/1ctx-mlx-engine";
export const releaseUrl = (repo: string, tag: string) =>
  `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;

// What a build from source reports; the page labels it and the manager
// offers it no release. A deploy to the Studio appends the commit, as
// build metadata: "v0.0.0-dev+1a2b3c4", ".dirty<diff hash>" after it when
// the checkout had changes.
export const DEV_VERSION = "v0.0.0-dev";
export const isDevVersion = (version: string) =>
  version === DEV_VERSION || version.startsWith(`${DEV_VERSION}+`);

// 1ctx-mlx-engine's own section.
export type SelfState = {
  version: string;
  startedAt: number;
  rssBytes: number;
  cpuPct: number;
  check: ReleaseCheck;
  offered: Release | null;
};

export type EnginePageState = { engine: EngineState; self: SelfState };

// The newer builds the Server page offers, for the rail's pill on every
// page: mlx-serve's only when it is ours to upgrade (an unmanaged or absent
// engine is offered an install, which is no update) and while the page
// shows the offer (an operation or a failure takes the row's place),
// 1ctx-mlx-engine's own whenever its section offers one. Versions, null
// when none.
export type Updates = { engine: string | null; self: string | null };
export const updatesOf = (
  engine: EngineState,
  self: Release | null,
): Updates => ({
  engine:
    engine.mode === "managed" && !engine.operation && !engine.failure
      ? (engine.offered?.version ?? null)
      : null,
  self: self?.version ?? null,
});

export type InstallBody = { tag: string; config: EngineConfig };
export type UpgradeBody = { tag: string };
export type ServiceBody = { op: "start" | "stop" | "restart" };
export type SettingsBody = { preReleases: boolean };

// 422 from PUT /api/engine/config and POST /api/engine/install
export type ConfigRefusal = { error: string; issues: ConfigIssue[] };
