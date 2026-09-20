// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What GET /api/snapshot answers and what /ws pushes. The page and the
// server both read these, so neither imports the other.

import type { ActionEvent, ActionName } from "./actions.ts";
import type { Download } from "./downloads.ts";
import type { EnginePageState } from "./engine.ts";
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
    version: string | null;
    capabilities: Capability[];
    limits: CacheLimits | null;
  };
  host: (HostInfo & { disk: DiskSpace | null }) | null;
  sample: Sample | null;
  models: ModelInfo[];
  disk: DiskDir[];
  events: ActionEvent[];
  running: ActionName | null;
  downloads: Download[];
  modelDir: string | null;
};

export type WsMessage =
  | { type: "snapshot"; data: Snapshot }
  | { type: "sample"; data: Sample }
  | { type: "event"; data: ActionEvent }
  | { type: "download"; data: Download }
  | { type: "engine"; data: EnginePageState };
