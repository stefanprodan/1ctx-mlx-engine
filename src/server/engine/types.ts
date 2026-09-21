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

// What the running engine says about itself when asked directly: its build
// and the budgets the process was started with. Fields are null when the
// body did not carry them (no model loaded, an older engine).
export type EngineProps = {
  version: string | null;
  limits: CacheLimits | null;
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

// one timestamped read of the metrics, what the rate math compares
export type Reading = { t: number; metrics: EngineMetrics };

export interface Engine {
  readonly id: EngineId;
  readonly url: string;
  health(): Promise<boolean>;
  models(): Promise<ModelInfo[]>;
  metrics(): Promise<EngineMetrics>;
  // Facts only the engine itself can state: its build and the budgets of
  // the running process. The call may go through the engine's model-load
  // path, so it is made only while a model is resident, once per engine
  // process. Null when the engine has no such endpoint.
  props?(): Promise<EngineProps | null>;
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
