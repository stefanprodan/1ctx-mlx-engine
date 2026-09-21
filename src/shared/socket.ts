// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What GET /api/snapshot answers and what /ws pushes. The page and the
// server both read these, so neither imports the other.

import type { ActionEvent, ActionName } from "./actions.ts";
import type { BenchmarkProgress } from "./benchmark.ts";
import type { Download } from "./downloads.ts";
import type { EngineMode, EnginePageState, Updates } from "./engine.ts";
import type { DiskDir, DiskSpace, HostInfo } from "./host.ts";
import type { CacheLimits, Capability, EngineId, ModelInfo } from "./models.ts";
import type { Sample } from "./sample.ts";

export type Snapshot = {
  version: string;
  // when the binary was compiled; null when running from source
  build: string | null;
  engine: {
    id: EngineId;
    url: string;
    local: boolean;
    // what the manager makes of the engine; null without a manager. "absent"
    // is how the other pages know to say not installed instead of offline
    mode: EngineMode | null;
    version: string | null;
    capabilities: Capability[];
    limits: CacheLimits | null;
  };
  host: (HostInfo & { disk: DiskSpace | null }) | null;
  sample: Sample | null;
  models: ModelInfo[];
  disk: DiskDir[];
  events: ActionEvent[];
  // what holds the lock the actions, the manager and the benchmark share
  running: ActionName | "benchmark" | null;
  // the benchmark in progress; finished ones come from /api/benchmarks
  benchmark: BenchmarkProgress | null;
  downloads: Download[];
  modelDir: string | null;
  // the newer builds on offer; null without a manager
  updates: Updates | null;
};

export type WsMessage =
  | { type: "snapshot"; data: Snapshot }
  | { type: "sample"; data: Sample }
  | { type: "event"; data: ActionEvent }
  | { type: "download"; data: Download }
  // every step of the run in progress, and once more when it has ended
  | { type: "benchmark"; data: BenchmarkProgress }
  // a finished run deleted, in any tab
  | { type: "benchmarkRemoved"; data: { id: number } }
  | { type: "engine"; data: EnginePageState };
