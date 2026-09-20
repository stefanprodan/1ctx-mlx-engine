// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the routes are handed: the running parts of the program.

import type { HostInfo } from "../../shared/host.ts";
import type { CacheLimits } from "../../shared/models.ts";
import type { Actions } from "../actions.ts";
import type { EngineManager } from "../engine/manager/index.ts";
import type { Engine } from "../engine/types.ts";
import type { ExclusiveLock } from "../lib/lock.ts";
import type { Downloader } from "../models/download.ts";
import type { History } from "../monitor/history.ts";
import type { Sampler } from "../monitor/sampler.ts";

export type WebDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  actions: Actions;
  downloads: Downloader;
  manager?: EngineManager;
  selfRestart?: {
    isLaunchd: () => boolean;
    exit: (code: number) => void;
    delayMs?: number;
    // the lock the actions and the manager share
    lock?: ExclusiveLock;
  };
  version: string;
  // the compile time of this binary, null from source
  build?: string | null;
  local: boolean;
  currentLimits: () => CacheLimits | null;
  host: HostInfo | null;
  // where downloads land; null when the host cannot say (tests)
  modelDir: string | null;
  now?: () => number;
};

// handle() also serves focused tests that do not exercise downloads.
// Production serve() requires the runner through WebDeps.
export type HandleDeps = Omit<WebDeps, "downloads" | "modelDir"> & {
  downloads?: Downloader;
  modelDir?: string | null;
};
