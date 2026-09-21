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
  | "rescan"
  | "benchmark";

export type ModelInfo = {
  id: string;
  loaded: boolean;
  state: string; // engine's own word: "ready", "unloaded", "loading", ...
  bytesResident: number;
  bytesOnDisk: number;
  contextLength: number | null;
  // the engine's word for the weights' precision ("4-bit"), null when unsaid
  quantization: string | null;
  capabilities: string[]; // engine words: chat, tool_use, vision, ...
  // undefined when the engine does not expose which model is its default
  isDefault?: boolean;
  // 1ctx-mlx-engine's own mark: the one model the user calls their daily driver
  favorite?: boolean;
  // its files were deleted here and the engine lists it until it restarts
  deleted?: boolean;
};

// The engine's cache budgets, per resident model (mlx-serve applies both to
// each model it loads). 0 means that tier is off. Null when unknown.
export type CacheLimits = {
  hotBytes: number;
  diskBytes: number;
};

// What GET /api/models says of a model: the engine's own facts joined with
// what its checkpoint on disk says. Every figure is null when neither
// source states it (a remote engine has no files here). The live state,
// resident or not, the favorite, a delete, rides on the sample instead.
export type ModelSpec = {
  id: string;
  bytesOnDisk: number;
  // the window the engine serves, then what the checkpoint allows
  contextLength: number | null;
  maxPositions: number | null;
  capabilities: string[];
  inputs: string[];
  modelType: string | null;
  params: number | null;
  // a mixture of experts: the parameters one token goes through
  activeParams: number | null;
  layers: number | null;
  // the layers with full attention, the rest are linear; null when unsaid
  fullAttention: number | null;
  hiddenSize: number | null;
  heads: number | null;
  kvHeads: number | null;
  headDim: number | null;
  vocab: number | null;
  // null for a dense model; the counts null when only the engine said MoE
  experts: {
    routed: number | null;
    perToken: number | null;
    shared: number | null;
  } | null;
  mtpLayers: number | null;
  // whether the engine runs them, known while the model is resident
  mtpLoaded: boolean | null;
  // the engine's word for the precision when the bits are not known
  quantization: string | null;
  bits: number | null;
  groupSize: number | null;
  mode: string | null;
  dtype: string | null;
  files: number | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  license: string | null;
  // the download that brought it; without one, the date is config.json's
  revision: string | null;
  downloadedAt: number | null;
};
