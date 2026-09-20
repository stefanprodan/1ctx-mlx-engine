// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  COLUMNS,
  comparable,
  delta,
  deltaCopy,
  progressCopy,
  report,
  statusCopy,
  statusDetail,
  value,
} from "../../src/client/benchmark/report.ts";
import type { Benchmark, Figure } from "../../src/shared/benchmark.ts";

const fig = (median: number | null, spreadPct: number | null = 1): Figure => ({
  median,
  spreadPct,
});

const run = (over: Partial<Benchmark> = {}): Benchmark => ({
  id: 4,
  status: "done",
  phase: "finish",
  error: null,
  model: "org/Model-4bit",
  quantization: "4-bit",
  preset: "40K",
  turns: 8,
  repetitions: 3,
  maxTokens: 256,
  schema: 1,
  scriptHash: "abc",
  firstPromptTokens: 15010,
  appVersion: "v0.2.0",
  engineVersion: "26.9.5",
  engineArgs: ["--serve", "--prefix-cache-mem", "16GB"],
  chip: "Apple M2 Max",
  memoryBytes: 96 * 2 ** 30,
  os: "macOS 26.6",
  summary: {
    coldLatencyMs: fig(24310),
    coldPrefillTps: fig(617.4),
    warmLatencyMs: fig(5200),
    warmPrefillTps: fig(540.2),
    decodeTps: fig(84.46),
    decodeFirstTps: fig(95),
    decodeLastTps: fig(76),
    cachePct: fig(81.34),
    contextTokens: 41200,
  },
  suspect: [],
  peakMemoryBytes: 38 * 2 ** 30,
  peakActiveBytes: 30 * 2 ** 30,
  startedAt: 1,
  finishedAt: 2,
  ...over,
});

test("a figure reads at the precision its size deserves", () => {
  expect(value(fig(24310), "ms")).toBe("24.3 s");
  expect(value(fig(413.5), "ms")).toBe("414 ms");
  expect(value(fig(617.4), "tok/s")).toBe("617");
  expect(value(fig(24040.9), "tok/s")).toBe("24,041");
  expect(value(fig(84.46), "tok/s")).toBe("84.5");
  expect(value(fig(81.34), "%")).toBe("81.3%");
  expect(value(fig(null), "tok/s")).toBe("–");
  expect(value(undefined, "ms")).toBe("–");
});

test("the delta is against the baseline and says which way is better", () => {
  const decode = COLUMNS.find((c) => c.key === "decodeTps")!;
  const cold = COLUMNS.find((c) => c.key === "coldLatencyMs")!;
  expect(delta(fig(110), fig(100))).toBeCloseTo(10, 6);
  expect(delta(fig(null), fig(100))).toBeNull();
  expect(delta(fig(100), fig(0))).toBeNull();
  expect(deltaCopy(10, decode)).toEqual({ text: "+10%", tone: "better" });
  expect(deltaCopy(-4.26, decode)).toEqual({ text: "−4.3%", tone: "worse" });
  // a latency that went up got worse
  expect(deltaCopy(12, cold)).toEqual({ text: "+12%", tone: "worse" });
  expect(deltaCopy(0.4, decode)).toEqual({ text: "same", tone: "same" });
  expect(deltaCopy(null, decode)).toBeNull();
});

test("runs compare only over the same generated session", () => {
  expect(comparable(run(), run({ model: "other/quant" }))).toBe(true);
  expect(comparable(run(), run({ scriptHash: "def" }))).toBe(false);
});

test("the progress line names the phase, the repetition and the turn", () => {
  const b = run({ status: "running", phase: "turns" });
  expect(
    progressCopy({ benchmark: b, repetition: 2, turn: 5, done: new Array(12) }),
  ).toEqual({
    text: "Measuring · repetition 2 of 3 · turn 5 of 8",
    fraction: 0.5,
  });
  expect(
    progressCopy({
      benchmark: { ...b, phase: "fit" },
      repetition: 0,
      turn: 0,
      done: [],
    }),
  ).toEqual({ text: "Sizing the prompts", fraction: 0 });
});

test("the status cell says why, not just what", () => {
  expect(statusCopy(run())).toBe("");
  const early = run({ suspect: ["cache did not hold"] });
  expect(statusCopy(early)).toBe("suspect");
  expect(statusDetail(early)).toBe("cache did not hold");
  const failed = run({ status: "failed", error: "HTTP 500" });
  expect(statusCopy(failed)).toBe("failed");
  expect(statusDetail(failed)).toBe("HTTP 500");
  expect(statusDetail(run())).toBeNull();
  expect(statusCopy(run({ status: "cancelled" }))).toBe("cancelled");
});

test("the report is what gets pasted into an issue", () => {
  const text = report(run({ suspect: ["other requests ran"] }), [
    {
      repetition: 1,
      turn: 1,
      promptN: 15010,
      cachedN: 5,
      promptMs: 24300.4,
      predictedN: 256,
      predictedMs: 2700,
      tokenizeMs: 9,
      finishReason: "length",
    },
  ]);
  expect(text).toContain("benchmark #4 (40K, done)");
  expect(text).toContain("model      org/Model-4bit (4-bit)");
  expect(text).toContain("engine     mlx-serve 26.9.5");
  expect(text).toContain("host       Apple M2 Max, 96 GB, macOS 26.6");
  expect(text).toContain("cold prefill        617 tok/s  ±1.0%");
  expect(text).toContain("cache               81.3%  ±1.0%");
  expect(text).toContain("peak memory         38 GB");
  expect(text).toContain("suspect: other requests ran");
  expect(text).toContain(
    "  1    1   15010       5       24300        256       2700   length",
  );
  expect(report(run({ summary: null }), [])).toContain("decode              –");
});
