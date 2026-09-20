// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  median,
  summarize,
  suspects,
} from "../../../src/server/benchmark/stats.ts";
import type { BenchmarkTurn } from "../../../src/shared/benchmark.ts";

// Recorded from mlx-serve 26.9.5 with Qwen3-0.6B-4bit: a cold turn, a turn
// that appends a tool call and its result, and a resend of the same turn.
const recorded: BenchmarkTurn[] = [
  {
    repetition: 1,
    turn: 1,
    promptN: 13000,
    cachedN: 0,
    promptMs: 779.859,
    predictedN: 256,
    predictedMs: 1378.317,
    tokenizeMs: 3.714,
    finishReason: "length",
  },
  {
    repetition: 1,
    turn: 2,
    promptN: 15067,
    cachedN: 12840,
    promptMs: 210.927,
    predictedN: 256,
    predictedMs: 1445.61,
    tokenizeMs: 3.723,
    finishReason: "length",
  },
  {
    repetition: 1,
    turn: 3,
    promptN: 15067,
    cachedN: 15066,
    promptMs: 30.648,
    predictedN: 256,
    predictedMs: 1330.953,
    tokenizeMs: 0.004,
    finishReason: "length",
  },
];

const clean = { firstTarget: 13000, otherRequests: false };

test("median", () => {
  expect(median([])).toBeNull();
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
});

test("the rates are the engine's own, over uncached and generated tokens", () => {
  const s = summarize(recorded);
  // the engine said 16669.67 and 10558.159 for the same requests
  expect(s.coldPrefillTps.median).toBeCloseTo(16669.67, 0);
  expect(s.coldLatencyMs.median).toBeCloseTo(783.573, 3);
  // the resend prefilled one token: left out of the warm rate
  expect(s.warmPrefillTps.median).toBeCloseTo(10558.159, 0);
  expect(s.decodeTps.median).toBeCloseTo((768 * 1000) / 4154.88, 2);
  expect(s.decodeFirstTps.median).toBeCloseTo(185.734, 2);
  expect(s.decodeLastTps.median).toBeCloseTo(192.343, 2);
  expect(s.cachePct.median).toBeCloseTo((27906 / 30134) * 100, 3);
  expect(s.contextTokens).toBe(15067);
  // one repetition has no spread
  expect(s.decodeTps.spreadPct).toBeNull();
});

test("what was not observed is null, never 0", () => {
  const s = summarize([recorded[0]!]);
  expect(s.warmPrefillTps.median).toBeNull();
  expect(s.warmLatencyMs.median).toBeNull();
  expect(s.cachePct.median).toBeNull();
  expect(s.decodeLastTps.median).toBeNull();
  expect(summarize([]).contextTokens).toBeNull();
  const stalled = summarize([{ ...recorded[0]!, predictedN: 0 }]);
  expect(stalled.decodeTps.median).toBeNull();
});

test("the figure is the median over the repetitions, with the spread", () => {
  const rep = (repetition: number, predictedMs: number) => ({
    ...recorded[0]!,
    repetition,
    predictedMs,
  });
  const s = summarize([rep(1, 1000), rep(2, 1280), rep(3, 1600)]);
  expect(s.decodeTps.median).toBe(200);
  expect(s.decodeTps.spreadPct).toBeCloseTo(((256 - 160) / 200) * 100, 6);
});

test("a clean run has no suspects", () => {
  expect(suspects(recorded, clean)).toEqual([]);
});

test("each rule names its reason", () => {
  const [cold, second, third] = recorded as [
    BenchmarkTurn,
    BenchmarkTurn,
    BenchmarkTurn,
  ];
  expect(suspects([{ ...cold, cachedN: 512 }], clean)).toEqual([
    "cold turn hit the cache",
  ]);
  // the agt4 case: a turn that prefills most of its prompt again
  expect(suspects([cold, { ...second, cachedN: 4096 }, third], clean)).toEqual([
    "cache did not hold",
  ]);
  expect(suspects([{ ...cold, finishReason: "stop" }], clean)).toEqual([
    "turn ended early",
  ]);
  expect(suspects([cold], { ...clean, firstTarget: 15000 })).toEqual([
    "prompt size drifted",
  ]);
  expect(suspects([cold], { ...clean, firstTarget: null })).toEqual([]);
  expect(suspects(recorded, { ...clean, otherRequests: true })).toEqual([
    "other requests ran",
  ]);
});
