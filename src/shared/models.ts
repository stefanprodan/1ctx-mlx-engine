// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The engine facts the page reads: what a model row and the cache budgets
// look like once an adapter has normalised them.

export type EngineId = "mlxserve" | "omlx";

export type Capability =
  | "load"
  | "unload"
  | "default"
  | "restart"
  | "diskClear"
  | "rescan";

export type ModelInfo = {
  id: string;
  loaded: boolean;
  state: string; // engine's own word: "ready", "unloaded", "loading", ...
  bytesResident: number;
  bytesOnDisk: number;
  contextLength: number | null;
  capabilities: string[]; // engine words: chat, tool_use, vision, ...
  // undefined when the engine does not expose which model is its default
  isDefault?: boolean;
  // 1ctx-mlx-engine's own mark: the one model the user calls their daily driver
  favorite?: boolean;
};

// The engine's cache budgets, per resident model (mlx-serve applies both to
// each model it loads). 0 means that tier is off. Null when unknown.
export type CacheLimits = {
  hotBytes: number;
  diskBytes: number;
};
