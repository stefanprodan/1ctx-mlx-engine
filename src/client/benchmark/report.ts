// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Benchmark page says about a run: the cells of its row, the
// deltas against a baseline run, the progress line and the plain-text
// report. Pure.

import type {
  Benchmark,
  BenchmarkProgress,
  BenchmarkSummary,
  BenchmarkTurn,
  Figure,
} from "../../shared/benchmark.ts";
import { DASH, sizeText } from "../format.ts";

export type FigureKey = Exclude<keyof BenchmarkSummary, "contextTokens">;

export type Column = {
  key: FigureKey;
  label: string;
  unit: "tok/s" | "ms" | "%";
  // a higher latency is worse, a higher rate is better
  higherIsBetter: boolean;
};

// The row shows the four figures the page is for; the rest is in the
// opened row. The latency is the cold one: how long the first request of a
// session waits for its first token.
export const COLUMNS: Column[] = [
  { key: "coldLatencyMs", label: "Latency", unit: "ms", higherIsBetter: false },
  {
    key: "coldPrefillTps",
    label: "Prefill",
    unit: "tok/s",
    higherIsBetter: true,
  },
  {
    key: "warmPrefillTps",
    label: "Warm prefill",
    unit: "tok/s",
    higherIsBetter: true,
  },
  { key: "decodeTps", label: "Decode", unit: "tok/s", higherIsBetter: true },
];

export const modelName = (id: string) => id.split("/").pop() ?? id;

export function value(figure: Figure | undefined, unit: Column["unit"]) {
  const v = figure?.median;
  if (v == null) return DASH;
  if (unit === "ms")
    return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  if (unit === "%") return `${v.toFixed(1)}%`;
  return v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
}

// The change of a run against the baseline, in percent of the baseline.
// Null when either side has nothing to compare.
export function delta(
  run: Figure | undefined,
  baseline: Figure | undefined,
): number | null {
  const a = run?.median;
  const b = baseline?.median;
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

export type DeltaCopy = { text: string; tone: "better" | "worse" | "same" };

// Under one percent is noise at three repetitions: it reads as the same.
export function deltaCopy(
  pct: number | null,
  column: Column,
): DeltaCopy | null {
  if (pct === null) return null;
  if (Math.abs(pct) < 1) return { text: "same", tone: "same" };
  const better = pct > 0 === column.higherIsBetter;
  return {
    text: `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`,
    tone: better ? "better" : "worse",
  };
}

// Two runs compare when they replayed the same generated session.
export const comparable = (a: Benchmark, b: Benchmark) =>
  a.scriptHash === b.scriptHash && a.schema === b.schema;

const PHASES: Record<Benchmark["phase"], string> = {
  fit: "Sizing the prompts",
  prepare: "Restarting the engine",
  warmup: "Warming up",
  turns: "Measuring",
  finish: "Done",
};

export function progressCopy(p: BenchmarkProgress): {
  text: string;
  fraction: number;
} {
  const { benchmark: b, repetition, turn } = p;
  const total = b.repetitions * b.turns;
  const measured = p.done.length;
  const where =
    repetition > 0 ? ` · repetition ${repetition} of ${b.repetitions}` : "";
  const at = b.phase === "turns" ? ` · turn ${turn} of ${b.turns}` : "";
  return {
    text: `${PHASES[b.phase]}${where}${at}`,
    fraction: total > 0 ? measured / total : 0,
  };
}

// The tag beside the model: one word, the reasons go in the opened row.
export const statusCopy = (b: Benchmark): string =>
  b.status === "done" ? (b.suspect.length > 0 ? "suspect" : "") : b.status;

export const statusDetail = (b: Benchmark): string | null =>
  b.error ?? (b.suspect.length > 0 ? b.suspect.join(", ") : null);

const pad = (s: string, n: number) => s.padStart(n);

// The report people paste into an issue: what ran, where, and the numbers.
export function report(b: Benchmark, turns: BenchmarkTurn[]): string {
  const s = b.summary;
  const line = (
    label: string,
    figure: Figure | undefined,
    unit: Column["unit"],
  ) => {
    const spread =
      figure?.spreadPct == null ? "" : `  ±${figure.spreadPct.toFixed(1)}%`;
    const shown = value(figure, unit);
    const withUnit =
      shown === DASH || unit !== "tok/s" ? shown : `${shown} tok/s`;
    return `${label.padEnd(20)}${withUnit}${spread}`;
  };
  const out = [
    `1ctx-mlx-engine benchmark #${b.id} (${b.preset}, ${b.status})`,
    `model      ${b.model}${b.quantization ? ` (${b.quantization})` : ""}`,
    `engine     mlx-serve ${b.engineVersion ?? "unknown"}`,
    `args       ${b.engineArgs.join(" ") || "unknown"}`,
    `host       ${[b.chip, b.memoryBytes ? sizeText(b.memoryBytes) : null, b.os].filter(Boolean).join(", ")}`,
    `workload   ${b.turns} turns x ${b.repetitions} repetitions, ${b.maxTokens} tokens a turn, thinking on, script ${b.scriptHash}`,
    `context    ${s?.contextTokens ?? DASH} tokens at the last turn`,
    "",
    line("cold latency", s?.coldLatencyMs, "ms"),
    line("cold prefill", s?.coldPrefillTps, "tok/s"),
    line("warm latency", s?.warmLatencyMs, "ms"),
    line("warm prefill", s?.warmPrefillTps, "tok/s"),
    line("decode", s?.decodeTps, "tok/s"),
    line("decode, first turn", s?.decodeFirstTps, "tok/s"),
    line("decode, last turn", s?.decodeLastTps, "tok/s"),
    line("cache", s?.cachePct, "%"),
    `${"peak memory".padEnd(20)}${b.peakMemoryBytes ? sizeText(b.peakMemoryBytes) : DASH}`,
  ];
  if (b.suspect.length > 0) out.push("", `suspect: ${b.suspect.join(", ")}`);
  if (b.error) out.push("", `error: ${b.error}`);
  if (turns.length > 0) {
    out.push(
      "",
      "rep turn  prompt  cached  prefill ms  generated  decode ms  finish",
    );
    for (const t of turns) {
      out.push(
        [
          pad(String(t.repetition), 3),
          pad(String(t.turn), 4),
          pad(String(t.promptN), 7),
          pad(String(t.cachedN), 7),
          pad(t.promptMs.toFixed(0), 11),
          pad(String(t.predictedN), 10),
          pad(t.predictedMs.toFixed(0), 10),
          `  ${t.finishReason ?? DASH}`,
        ].join(" "),
      );
    }
  }
  return out.join("\n");
}
