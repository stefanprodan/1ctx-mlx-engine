// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the Benchmark page says about a run: the cells of its row, the
// deltas against a baseline run, the progress line and the plain-text
// report. Pure.

import type {
  Benchmark,
  BenchmarkPreset,
  BenchmarkProgress,
  BenchmarkSummary,
  BenchmarkTurn,
  Figure,
} from "../../shared/benchmark.ts";
import { DASH, duration, sizeText } from "../format.ts";

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

// The runs table narrowed to what was typed, any part of the model id in
// any case, so "35B" finds every 35B model and "mlx-community" an org, and
// to a preset when one is picked.
export function matching(
  runs: Benchmark[],
  query: string,
  preset: BenchmarkPreset | null,
): Benchmark[] {
  const q = query.trim().toLowerCase();
  return runs.filter(
    (b) =>
      (preset === null || b.preset === preset) &&
      (q === "" || b.model.toLowerCase().includes(q)),
  );
}

// what the table says when the search and the preset leave no row
export function noMatchCopy(
  query: string,
  preset: BenchmarkPreset | null,
): string {
  const q = query.trim();
  const runs = preset === null ? "runs" : `${preset} runs`;
  return q === "" ? `No ${runs}.` : `No ${runs} match ${q}.`;
}

// Two runs compare when both finished and replayed the same session: a
// failed or cancelled one has figures over the turns it got to, no more.
export const comparable = (a: Benchmark, b: Benchmark) =>
  a.status === "done" &&
  b.status === "done" &&
  a.scriptHash === b.scriptHash &&
  a.schema === b.schema;

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

// How a turn ended, in the page's words: the engine's "length" is the token
// limit it cut the turn at, "tool_calls" a tool call; any other word is the
// engine's own.
const FINISH_TEXT = new Map([
  ["length", "limit"],
  ["tool_calls", "tools"],
]);

export const finishText = (reason: string | null): string =>
  reason === null ? DASH : (FINISH_TEXT.get(reason) ?? reason);

// The opened row: every figure a run has, in the groups a reader looks for
// them in, the spread beside each. The row shows four figures and a phone
// only two, so nothing here may depend on the row.
export type DetailRow = {
  label: string;
  value: string;
  // dim, after the value: the unit of a rate, the spread of a figure
  unit?: string;
  spread?: string;
};

export type DetailGroup = { title: string; rows: DetailRow[] };

// The engine's arguments that say how it was tuned: the ones every managed
// engine has (serve mode, where it listens, where the models and the log
// are) are left out, with their values.
const PLUMBING_VALUED = new Set([
  "--host",
  "--port",
  "--model-dir",
  "--log-file",
  "--log-level",
]);
const PLUMBING_BARE = new Set(["--serve", "--metrics"]);

export function tuningArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=")[0]!;
    if (PLUMBING_BARE.has(name)) continue;
    if (PLUMBING_VALUED.has(name)) {
      // the value follows, unless it came as --flag=value
      if (!arg.includes("=") && !args[i + 1]?.startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// when the run started, with the year the row leaves out
const fmtDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const tokens = (n: number | null | undefined) =>
  n == null ? DASH : `${n.toLocaleString("en-US")} tok`;

function figureRow(
  label: string,
  figure: Figure | undefined,
  unit: Column["unit"],
): DetailRow {
  const shown = value(figure, unit);
  const row: DetailRow = { label, value: shown };
  if (shown !== DASH && unit === "tok/s") row.unit = "tok/s";
  if (figure?.spreadPct != null) {
    row.spread = `±${figure.spreadPct.toFixed(1)}%`;
  }
  return row;
}

export function detailGroups(b: Benchmark): DetailGroup[] {
  const s = b.summary;
  const size = (n: number | null) => (n ? sizeText(n) : DASH);
  return [
    {
      title: "Latency",
      rows: [
        figureRow("Cold", s?.coldLatencyMs, "ms"),
        figureRow("Warm", s?.warmLatencyMs, "ms"),
      ],
    },
    {
      title: "Prefill",
      rows: [
        figureRow("Cold", s?.coldPrefillTps, "tok/s"),
        figureRow("Warm", s?.warmPrefillTps, "tok/s"),
        figureRow("Cache hit", s?.cachePct, "%"),
      ],
    },
    {
      title: "Decode",
      rows: [
        figureRow("Overall", s?.decodeTps, "tok/s"),
        figureRow("First turn", s?.decodeFirstTps, "tok/s"),
        figureRow("Last turn", s?.decodeLastTps, "tok/s"),
      ],
    },
    {
      title: "Memory",
      rows: [
        { label: "Engine, peak", value: size(b.peakMemoryBytes) },
        { label: "MLX active, peak", value: size(b.peakActiveBytes) },
        { label: "Host", value: size(b.memoryBytes) },
      ],
    },
    {
      title: "Workload",
      rows: [
        { label: "Preset", value: b.preset },
        { label: "Turns", value: `${b.turns} x ${b.repetitions}` },
        { label: "Per turn", value: tokens(b.maxTokens) },
        { label: "First prompt", value: tokens(b.firstPromptTokens) },
        { label: "Context", value: tokens(s?.contextTokens) },
      ],
    },
    {
      title: "Setup",
      rows: [
        { label: "Engine", value: `mlx-serve ${b.engineVersion ?? DASH}` },
        { label: "Chip", value: b.chip ?? DASH },
        { label: "OS", value: b.os ?? DASH },
        { label: "Date", value: fmtDate.format(b.startedAt) },
        {
          label: "Duration",
          value:
            b.finishedAt == null ? DASH : duration(b.finishedAt - b.startedAt),
        },
      ],
    },
  ];
}

// Which against which, in a line that fits a phone: the models' names cut
// short, never ending on a separator. The ticks in the table say which
// rows, with their times.
const VERSUS_CHARS = 13;
const short = (id: string) =>
  modelName(id)
    .slice(0, VERSUS_CHARS)
    .replace(/[-._]+$/, "");

export const versus = (run: Benchmark, baseline: Benchmark): string =>
  `${short(run.model)} vs ${short(baseline.model)}`;

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
    `args       ${tuningArgs(b.engineArgs).join(" ") || "none"}`,
    `host       ${[b.chip, b.memoryBytes ? sizeText(b.memoryBytes) : null, b.os].filter(Boolean).join(", ")}`,
    `workload   ${b.turns} turns x ${b.repetitions} repetitions, ${b.maxTokens} tokens a turn, thinking on, script ${b.scriptHash}`,
    `prompts    ${b.firstPromptTokens ?? DASH} tokens at the first turn, ${s?.contextTokens ?? DASH} at the last`,
    `started    ${new Date(b.startedAt).toISOString()}${b.finishedAt == null ? "" : `, took ${duration(b.finishedAt - b.startedAt)}`}`,
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
    `${"peak MLX active".padEnd(20)}${b.peakActiveBytes ? sizeText(b.peakActiveBytes) : DASH}`,
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
          `  ${finishText(t.finishReason)}`,
        ].join(" "),
      );
    }
  }
  return out.join("\n");
}
