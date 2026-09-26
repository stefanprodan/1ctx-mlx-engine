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

// What a model is for. mlx-serve serves more than chat: embeddings for
// retrieval, typed decisions, media. Every path that is about chat (the
// request a sample credits, the engine's default, the daily driver, the
// benchmark) takes chat models only.
export type ModelKind = "chat" | "embedding" | "decision" | "media" | "other";

const MEDIA = ["image", "audio", "music", "video", "3d"];

// First match wins. An embedding checkpoint is not a chat model even when
// the engine says it is: mlx-serve lists Qwen3-Embedding with "chat" and
// answers a chat request to it with noise.
export function modelKind(capabilities: readonly string[]): ModelKind {
  if (capabilities.includes("decisions")) return "decision";
  if (capabilities.includes("embeddings")) return "embedding";
  if (capabilities.includes("chat")) return "chat";
  if (capabilities.some((c) => MEDIA.includes(c))) return "media";
  return "other";
}

export const isChat = (m: { capabilities: readonly string[] }) =>
  modelKind(m.capabilities) === "chat";

// What the engine says of a resident model's process, from /props: the
// window it serves and how long a context fits in memory now.
export type ModelRuntime = {
  context: number | null;
  safeContext: number | null;
};

export type ModelInfo = {
  id: string;
  loaded: boolean;
  state: string; // engine's own word: "ready", "unloaded", "loading", ...
  // why the last load failed, while the state says "error"
  error?: string | null;
  bytesResident: number;
  bytesOnDisk: number;
  contextLength: number | null;
  // the engine's word for the weights' precision ("4-bit"), null when unsaid
  quantization: string | null;
  capabilities: string[]; // engine words: chat, tool_use, vision, ...
  // a resident chat or embedding model's /props, null until it is read
  runtime?: ModelRuntime | null;
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
  // the layers with full attention; null when unsaid
  fullAttention: number | null;
  // what the rest have: "linear" (Qwen3.5's DeltaNet), "sliding" (a
  // window, Gemma's and ModernBERT's); null when unsaid
  restAttention: string | null;
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
  // a decision model's checkpoint: its encoder, the window the state,
  // question and options share, the options' part of it, and whether its
  // confidences were calibrated
  decision: {
    encoder: string | null;
    window: number | null;
    optionBudget: number | null;
    calibrated: boolean | null;
  } | null;
  // an embedding model's: the longest input and how tokens become a vector
  embedding: {
    maxInput: number | null;
    pooling: string | null;
  } | null;
  license: string | null;
  // the download that brought it; without one, the date is config.json's
  revision: string | null;
  downloadedAt: number | null;
};
