// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { scriptHash } from "../../../src/server/benchmark/hash.ts";
import {
  buildSession,
  piecesOf,
  ratiosOf,
  requestFor,
  targetsOf,
  turnsOf,
} from "../../../src/server/benchmark/script.ts";

const base = {
  preset: "40K",
  tag: "a",
  ratios: null,
  window: null,
  maxTokens: 256,
} as const;

test("the session is the same for every run but for the tag", () => {
  const a = buildSession(base);
  const b = buildSession({ ...base, tag: "b" });
  expect(a.system.startsWith("[bench a] ")).toBe(true);
  expect(a.system.slice("[bench a] ".length)).toBe(
    b.system.slice("[bench b] ".length),
  );
  expect(a.steps).toEqual(b.steps);
  expect(buildSession(base)).toEqual(a);
});

test("without a fit every piece is sized by the guess", () => {
  const session = buildSession(base);
  expect(session.steps).toHaveLength(turnsOf("40K") - 1);
  const first = session.system.length + JSON.stringify(session.tools).length;
  expect(first).toBeGreaterThan(15_000 * 2.6 * 0.98);
  expect(first).toBeLessThan(15_000 * 2.6 * 1.02);
  // 8k tokens, the largest result
  expect(session.steps[5]!.result.length).toBe(Math.floor(8_000 * 2.6));
});

test("the fit sizes each piece by its own ratio", () => {
  const draft = buildSession({ ...base, tag: "" });
  const pieces = piecesOf(draft);
  expect(pieces).toHaveLength(2 + draft.steps.length);
  // a tokenizer that makes a token of 3 chars of prose, 2 of everything else
  const counts = pieces.map((text, i) =>
    Math.round(text.length / (i === 0 ? 3 : 2)),
  );
  const ratios = ratiosOf(draft, counts);
  expect(ratios.system).toBeCloseTo(3, 2);
  expect(ratios.results[0]).toBeCloseTo(2, 2);
  expect(ratios.toolTokens).toBe(counts[1]!);
  const fitted = buildSession({ ...base, tag: "", ratios });
  const tokens = piecesOf(fitted).map((text, i) =>
    Math.round(text.length / (i === 0 ? 3 : 2)),
  );
  // the first request lands on its target, and so does every result
  expect(tokens[0]! + tokens[1]!).toBeGreaterThan(15_000 * 0.99);
  expect(tokens[0]! + tokens[1]!).toBeLessThan(15_000 * 1.01);
  expect(tokens[2 + 5]).toBe(8_000);
  // nonsense from the tokenizer is bounded, and nothing falls back to the guess
  const wild = ratiosOf(draft, [1, 0, 1e9]);
  expect(wild.system).toBe(8);
  expect(wild.results[0]).toBe(1);
  expect(wild.results[1]).toBe(2.6);
});

test("a small window shrinks every target together", () => {
  const whole = targetsOf("40K", 262_144, 256);
  expect(whole.first).toBe(15_000);
  const small = targetsOf("40K", 40_960, 256);
  const total = small.first + small.results.reduce((a, b) => a + b, 0);
  expect(total).toBeLessThanOrEqual(40_960 - 256 - 2048);
  expect(total).toBeGreaterThan(38_000);
  expect(small.results[5]! / small.first).toBeCloseTo(8 / 15, 2);
  expect(targetsOf("40K", null, 256)).toEqual(whole);
});

test("a turn carries the calls and results before it, and only those", () => {
  const session = buildSession(base);
  const cold = requestFor(session, 1, "org/model", 256);
  expect(cold.messages.map((m) => m.role)).toEqual(["system", "user"]);
  expect(cold.enable_thinking).toBe(true);
  expect(cold.stream).toBe(false);
  expect(cold.max_tokens).toBe(256);
  const third = requestFor(session, 3, "org/model", 256);
  expect(third.messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
    "tool",
  ]);
  // a later turn extends the earlier one: that is what the cache holds
  expect(third.messages.slice(0, 2)).toEqual(cold.messages);
  const call = third.messages[2];
  const result = third.messages[3];
  if (call?.role !== "assistant" || result?.role !== "tool") throw new Error();
  expect(result.tool_call_id).toBe(call.tool_calls[0]!.id);
  expect(() =>
    JSON.parse(call.tool_calls[0]!.function.arguments),
  ).not.toThrow();
  expect(session.tools.map((t) => t.function.name)).toContain(
    call.tool_calls[0]!.function.name,
  );
});

test("the hash names the workload, not the run", () => {
  const hash = (
    preset: "20K" | "40K",
    window: number | null = null,
    max = 256,
  ) => scriptHash(preset, window, max);
  expect(hash("40K")).toBe(hash("40K"));
  expect(hash("40K")).not.toBe(hash("20K"));
  expect(hash("40K")).toMatch(/^[0-9a-f]{16}$/);
  // a window that fits the session changes nothing; one that shrinks it,
  // or another generation length, is another workload
  expect(hash("40K", 262_144)).toBe(hash("40K"));
  expect(hash("40K", 40_960)).not.toBe(hash("40K"));
  expect(hash("40K", null, 512)).not.toBe(hash("40K"));
});
