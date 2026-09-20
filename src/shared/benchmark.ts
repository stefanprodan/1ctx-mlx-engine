// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A benchmark run as the routes, the socket and the store say it. The run
// replays a generated agentic session with a forced trajectory and reads
// the engine's own timings: it measures the engine, never the model.

export const BENCHMARK_PRESETS = ["short", "agent"] as const;

export type BenchmarkPreset = (typeof BENCHMARK_PRESETS)[number];

export function isBenchmarkPreset(v: unknown): v is BenchmarkPreset {
  return (
    typeof v === "string" &&
    (BENCHMARK_PRESETS as readonly string[]).includes(v)
  );
}

export type BenchmarkStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  // this program went away mid-run; set at the next start
  | "interrupted";

export type BenchmarkPhase = "fit" | "prepare" | "warmup" | "turns" | "finish";

// Why a run's numbers should not be trusted as they stand. Shown, never
// hidden: a cache that does not hold is a finding.
export type SuspectReason =
  | "cold turn hit the cache"
  | "cache did not hold"
  | "turn ended early"
  | "prompt size drifted"
  | "other requests ran";

// what the engine's `timings` said about one request
export type TurnTimings = {
  promptN: number;
  cachedN: number;
  promptMs: number;
  predictedN: number;
  predictedMs: number;
  tokenizeMs: number;
  finishReason: string | null;
};

export type BenchmarkTurn = TurnTimings & {
  repetition: number;
  // 1 is the cold turn
  turn: number;
};

// A figure is the median over the repetitions; null when no repetition
// observed it, never 0.
export type Figure = {
  median: number | null;
  // (max - min) / median over the repetitions, in percent
  spreadPct: number | null;
};

export type BenchmarkSummary = {
  // tokenize_ms + prompt_ms: the engine reports no time to first token of
  // its own, and this leaves out queue time
  coldLatencyMs: Figure;
  coldPrefillTps: Figure;
  warmLatencyMs: Figure;
  warmPrefillTps: Figure;
  decodeTps: Figure;
  decodeFirstTps: Figure;
  decodeLastTps: Figure;
  cachePct: Figure;
  // the deepest prompt of the session
  contextTokens: number | null;
};

export type Benchmark = {
  id: number;
  status: BenchmarkStatus;
  // where it is, or where it ended
  phase: BenchmarkPhase;
  error: string | null;
  model: string;
  quantization: string | null;
  preset: BenchmarkPreset;
  turns: number;
  repetitions: number;
  maxTokens: number;
  // runs compare only when the workload was the same
  schema: number;
  scriptHash: string;
  // the first request's prompt_n after the fit; null before it
  firstPromptTokens: number | null;
  appVersion: string;
  engineVersion: string | null;
  engineArgs: string[];
  chip: string | null;
  memoryBytes: number | null;
  os: string | null;
  summary: BenchmarkSummary | null;
  suspect: SuspectReason[];
  peakMemoryBytes: number | null;
  peakActiveBytes: number | null;
  startedAt: number;
  finishedAt: number | null;
};

// the run in progress, as the snapshot and {type: "benchmark"} carry it
export type BenchmarkProgress = {
  benchmark: Benchmark;
  repetition: number;
  turn: number;
  // the turns measured so far
  done: BenchmarkTurn[];
};

export type BenchmarkStartBody = {
  model: string;
  preset: BenchmarkPreset;
};

export type BenchmarkDetail = {
  benchmark: Benchmark;
  turns: BenchmarkTurn[];
};
