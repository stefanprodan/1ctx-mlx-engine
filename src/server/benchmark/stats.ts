// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// From the turns' raw timings to the figures a run reports and the reasons
// not to trust them. Pure. The rates follow mlx-serve's own definitions:
// prefill is over the tokens that were not cached, decode over the tokens
// actually generated (reasoning and speculative tokens included).

import type {
  BenchmarkSummary,
  BenchmarkTurn,
  Figure,
  SuspectReason,
} from "../../shared/benchmark.ts";

// A warm turn that prefilled less than this says nothing about prefill
// speed: one token in 30 ms reads as 32 tok/s.
const MIN_PREFILL_TOKENS = 256;

// The tag sits in the message content, so the template's opening tokens can
// match an earlier repetition's; anything beyond that was not cold.
const COLD_ALLOWANCE = 64;

// A later turn finds the whole previous prompt in the cache, less the block
// the engine could not match; under this the cache did not hold.
const HOLD_FLOOR = 0.9;

// The rule starts at turn 3. Turn 2 is the first request that carries tool
// messages, and mlx-serve then renders the prompt differently from the tool
// schemas on (measured on 26.9.4 with a Qwen3 template: a plain second turn
// hits in full, one with a tool result misses from the schemas). Every
// agent session pays that once, so it is a cost to report, in the cache
// figure and the turns, not a reason to distrust the run.
const HOLD_FROM_TURN = 3;

// A model that answers with a tool call stops after a few dozen tokens, and
// a rate over that few says little: such a turn is left out of the first
// and last decode rates. The overall rate is over every generated token.
const MIN_DECODE_TOKENS = 64;

const DRIFT_LIMIT = 0.02;

export type Expectations = {
  // the first request's token target, null when the fit did not run
  firstTarget: number | null;
  // the engine served requests the runner did not make
  otherRequests: boolean;
};

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function figure(values: (number | null)[]): Figure {
  const seen = values.filter((v): v is number => v !== null);
  const mid = median(seen);
  if (mid === null) return { median: null, spreadPct: null };
  const spread =
    seen.length > 1 && mid > 0
      ? ((Math.max(...seen) - Math.min(...seen)) / mid) * 100
      : null;
  return { median: mid, spreadPct: spread };
}

function rate(tokens: number, ms: number): number | null {
  return tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null;
}

function byRepetition(turns: BenchmarkTurn[]): BenchmarkTurn[][] {
  const reps = new Map<number, BenchmarkTurn[]>();
  for (const turn of turns) {
    const list = reps.get(turn.repetition) ?? [];
    list.push(turn);
    reps.set(turn.repetition, list);
  }
  return [...reps.values()].map((list) => list.sort((a, b) => a.turn - b.turn));
}

function sum(turns: BenchmarkTurn[], of: (t: BenchmarkTurn) => number) {
  return turns.reduce((acc, t) => acc + of(t), 0);
}

const uncached = (t: BenchmarkTurn) => Math.max(t.promptN - t.cachedN, 0);
const latency = (t: BenchmarkTurn) => t.tokenizeMs + t.promptMs;
const decode = (t: BenchmarkTurn | undefined) =>
  t && t.predictedN >= MIN_DECODE_TOKENS
    ? rate(t.predictedN, t.predictedMs)
    : null;

export function summarize(turns: BenchmarkTurn[]): BenchmarkSummary {
  const reps = byRepetition(turns).map((rep) => {
    const cold = rep.find((t) => t.turn === 1);
    const warm = rep.filter((t) => t.turn > 1);
    const prefilled = warm.filter((t) => uncached(t) >= MIN_PREFILL_TOKENS);
    const warmPrompt = sum(warm, (t) => t.promptN);
    return {
      coldLatencyMs: cold ? latency(cold) : null,
      coldPrefillTps: cold ? rate(uncached(cold), cold.promptMs) : null,
      warmLatencyMs: median(warm.map(latency)),
      warmPrefillTps: rate(
        sum(prefilled, uncached),
        sum(prefilled, (t) => t.promptMs),
      ),
      decodeTps: rate(
        sum(rep, (t) => t.predictedN),
        sum(rep, (t) => t.predictedMs),
      ),
      decodeFirstTps: decode(cold),
      decodeLastTps: warm.length > 0 ? decode(warm.at(-1)) : null,
      cachePct:
        warmPrompt > 0
          ? (sum(warm, (t) => t.cachedN) / warmPrompt) * 100
          : null,
    };
  });
  const over = (key: keyof (typeof reps)[number]) =>
    figure(reps.map((rep) => rep[key]));
  return {
    coldLatencyMs: over("coldLatencyMs"),
    coldPrefillTps: over("coldPrefillTps"),
    warmLatencyMs: over("warmLatencyMs"),
    warmPrefillTps: over("warmPrefillTps"),
    decodeTps: over("decodeTps"),
    decodeFirstTps: over("decodeFirstTps"),
    decodeLastTps: over("decodeLastTps"),
    cachePct: over("cachePct"),
    contextTokens:
      turns.length > 0 ? Math.max(...turns.map((t) => t.promptN)) : null,
  };
}

export function suspects(
  turns: BenchmarkTurn[],
  expect: Expectations,
): SuspectReason[] {
  const found = new Set<SuspectReason>();
  for (const rep of byRepetition(turns)) {
    rep.forEach((turn, i) => {
      if (turn.finishReason !== "length") found.add("turn ended early");
      if (turn.turn === 1) {
        if (turn.cachedN > COLD_ALLOWANCE) found.add("cold turn hit the cache");
        const target = expect.firstTarget;
        if (
          target !== null &&
          target > 0 &&
          Math.abs(turn.promptN - target) / target > DRIFT_LIMIT
        ) {
          found.add("prompt size drifted");
        }
        return;
      }
      const previous = rep[i - 1];
      if (
        previous &&
        turn.turn >= HOLD_FROM_TURN &&
        turn.cachedN < previous.promptN * HOLD_FLOOR
      ) {
        found.add("cache did not hold");
      }
    });
  }
  if (expect.otherRequests) found.add("other requests ran");
  return [...found];
}
