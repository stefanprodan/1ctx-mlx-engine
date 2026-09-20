// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  buildSession,
  fitScale,
  requestFor,
  scriptHash,
  targetsOf,
  turnsOf,
} from "../../../src/server/benchmark/script.ts";

const base = {
  preset: "agent",
  tag: "a",
  scale: 1,
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

test("the sizes follow the preset and the scale", () => {
  const session = buildSession(base);
  expect(session.steps).toHaveLength(turnsOf("agent") - 1);
  const first = session.system.length + JSON.stringify(session.tools).length;
  expect(first).toBeGreaterThan(15_000 * 2.6 * 0.98);
  expect(first).toBeLessThan(15_000 * 2.6 * 1.02);
  // 8k tokens, the largest result
  expect(session.steps[5]!.result.length).toBe(Math.floor(8_000 * 2.6));
  const half = buildSession({ ...base, scale: 0.5 });
  expect(half.steps[5]!.result.length).toBe(Math.floor(8_000 * 2.6 * 0.5));
});

test("a small window shrinks every target together", () => {
  const whole = targetsOf("agent", 262_144, 256);
  expect(whole.first).toBe(15_000);
  const small = targetsOf("agent", 40_960, 256);
  const total = small.first + small.results.reduce((a, b) => a + b, 0);
  expect(total).toBeLessThanOrEqual(40_960 - 256 - 1024);
  expect(total).toBeGreaterThan(39_000);
  expect(small.results[5]! / small.first).toBeCloseTo(8 / 15, 2);
  expect(targetsOf("agent", null, 256)).toEqual(whole);
});

test("the fit is bounded", () => {
  expect(fitScale(15_000, 13_000)).toBeCloseTo(1.1538, 3);
  expect(fitScale(15_000, 0)).toBe(1);
  expect(fitScale(15_000, 100)).toBe(4);
  expect(fitScale(15_000, 1_000_000)).toBe(0.25);
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
  expect(scriptHash("agent")).toBe(scriptHash("agent"));
  expect(scriptHash("agent")).not.toBe(scriptHash("short"));
  expect(scriptHash("agent")).toMatch(/^[0-9a-f]{16}$/);
});
