// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The engine adapter contract. Everything 1ctx-mlx-engine knows about an
// inference server goes through this interface, so a second engine is a new
// file under src/engine/, not a rewrite. Names are normalised here: adapters
// translate their server's counter names into these fields.

import type {
  CacheLimits,
  Capability,
  EngineId,
  ModelInfo,
  ModelRuntime,
} from "../../shared/models.ts";

// Monotonic counters. All reset to zero when the engine process restarts;
// the sampler detects that as a new epoch.
export type EngineCounters = {
  promptTokens: number; // every prompt token, cached or not
  prefillTokens: number; // prompt tokens actually computed
  cachedPromptTokens: number; // prompt tokens served from the prefix cache
  generationTokens: number;
  requestsSuccess: number;
  requestsCancelled: number;
  cacheQueries: number;
  cacheHits: number;
};

export type EngineGauges = {
  requestsRunning: number;
  requestsWaiting: number;
  requestsPrefilling: number;
  gpuPct: number;
  // the engine process footprint as the engine reports it (bytes)
  memoryBytes: number;
  // tokens of the current (or last) request; advance while it runs
  generationTokensLive: number;
  prefillTokensLive: number;
  // allocator view: active is what MLX holds for weights + KV, cache is
  // MLX's reclaimable buffer pool (not the prefix cache)
  mlxActiveBytes: number;
  mlxCacheBytes: number;
};

export type HistogramSummary = { count: number; sum: number };

export type EngineHistograms = {
  ttftSeconds: HistogramSummary;
  e2eLatencySeconds: HistogramSummary;
  prefillTimeSeconds: HistogramSummary;
  decodeTimeSeconds: HistogramSummary;
  promptTokens: HistogramSummary;
  outputTokens: HistogramSummary;
};

export type EngineMetrics = {
  counters: EngineCounters;
  gauges: EngineGauges;
  histograms: EngineHistograms;
};

// What the running engine says when asked about one resident model: its
// build and the budgets of the process, then that model's runtime. Fields
// are null when the body did not carry them: a model that is not resident
// gets the memory counters only.
export type EngineProps = {
  version: string | null;
  limits: CacheLimits | null;
  runtime: ModelRuntime | null;
};

// What the engine measured for one chat request, from the `timings` of its
// answer. Token counts and milliseconds, as the engine states them.
export type ChatTimings = {
  promptN: number;
  cachedN: number;
  promptMs: number;
  predictedN: number;
  predictedMs: number;
  tokenizeMs: number;
  finishReason: string | null;
};

// One chat answer: what the engine measured, and what the model wrote, which
// the benchmark reads for signs of a broken model and never keeps: its prose
// (reasoning and content) apart from its tool calls, whose arguments hold
// file names and data in any script.
export type ChatAnswer = {
  timings: ChatTimings;
  prose: string;
  tools: string;
};

// What the engine says of a model beyond the list's row: the checkpoint's
// shape as it read it and the sampling it applies. A remote engine's
// models are known by this alone.
export type EngineModelMeta = {
  architecture: string | null;
  layers: number | null;
  hiddenSize: number | null;
  vocab: number | null;
  maxTokens: number | null;
  isMoe: boolean | null;
  // the multi-token prediction head in use; said for a resident model only
  mtpLoaded: boolean | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  inputs: string[];
};

// one timestamped read of the metrics, what the rate math compares
export type Reading = { t: number; metrics: EngineMetrics };

export interface Engine {
  readonly id: EngineId;
  readonly url: string;
  health(): Promise<boolean>;
  models(): Promise<ModelInfo[]>;
  // the meta of the last models() read, by id; nothing new is fetched
  modelMeta?(): ReadonlyMap<string, EngineModelMeta>;
  metrics(): Promise<EngineMetrics>;
  // Facts only the engine itself can state: its build, the budgets of the
  // running process and a resident model's runtime. A status read: it
  // loads nothing and does not count as use of the model. Null when the
  // engine has no such endpoint or did not answer.
  props?(model: string): Promise<EngineProps | null>;
  load(id: string, asDefault: boolean): Promise<void>;
  unload(id: string): Promise<void>;
  // walk the model directory again for checkpoints added since the engine
  // started; engines advertise "rescan" only when this is implemented
  rescan?(): Promise<void>;
  // One non-streaming chat request, for the benchmark only: never the
  // sampler, only from a button, under the shared lock. The body is the
  // caller's. Aborting the signal cancels the generation in the engine.
  // Engines advertise "benchmark" only when their answer carries timings.
  chat?(body: unknown, signal: AbortSignal): Promise<ChatAnswer>;
  // How many tokens the default model's tokenizer makes of a text; the
  // benchmark sizes its prompts with it. Same terms as chat(), and it needs
  // a default model resident, which a run has just loaded.
  tokenize?(content: string, signal: AbortSignal): Promise<number>;
  capabilities(): Set<Capability>;
  // disk tier locations, sized by the host probes
  cacheDirs(): string[];
  // per-request log to tail, null when the engine has none
  logFile(): string | null;
  // executable basenames the host probe may match for the engine's pid
  processNames(): string[];
  // launchd label of the engine service, for the local-only "free" action
  // (launchctl kickstart -k); null when the engine is not a service
  serviceLabel(): string | null;
}
