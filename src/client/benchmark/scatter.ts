// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scorecard's scatter: a dot per model at a preset, the wait before a
// warm turn's answer starts across, the decode rate up. What an agent
// trades between, read at a glance: the top left starts soonest and writes
// fastest. Pure, tested in test/client/scatter.test.ts.

import type { Benchmark } from "../../shared/benchmark.ts";

// the categorical slots in tokens.css; a model past the last one is drawn
// in the neutral one rather than a colour another model already wears
export const SERIES = 6;

export type Dot = {
  id: number;
  model: string;
  // 1 to SERIES, or 0 for the neutral colour
  slot: number;
  // the median wait on a warm turn, in seconds
  wait: number;
  // the median decode rate, tok/s
  decode: number;
};

// The colour follows the model, never its rank: the slot is its place
// among every model the engine lists, so another preset or a model without
// a run there repaints nothing.
export function slotOf(model: string, listed: string[]): number {
  const at = [...listed].sort().indexOf(model);
  return at >= 0 && at < SERIES ? at + 1 : 0;
}

// A run without either figure has no place on the plane, nor one whose
// figure is not a number a scale can place.
export function dots(runs: Benchmark[], listed: string[]): Dot[] {
  const out: Dot[] = [];
  for (const run of runs) {
    const wait = run.summary?.warmLatencyMs.median;
    const decode = run.summary?.decodeTps.median;
    if (wait == null || decode == null) continue;
    if (!Number.isFinite(wait) || !Number.isFinite(decode)) continue;
    out.push({
      id: run.id,
      model: run.model,
      slot: slotOf(run.model, listed),
      wait: wait / 1000,
      decode,
    });
  }
  return out;
}

// Round ticks from 0 past the largest value, about five of them: a step of
// 1, 2 or 5 times a power of ten. Past it, never on it: a dot on the last
// line would sit on the frame, and one step of headroom costs less than a
// padded maximum that tips the step (100 padded to 105 made the axis 150).
export function ticks(max: number, count = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out = [0];
  while (out[out.length - 1]! <= max) out.push(out.length * step);
  // a step below 1 carries its float error into the labels
  return out.map((v) => Number(v.toPrecision(12)));
}

export const HEIGHT = 280;
export const PAD = { top: 14, right: 18, bottom: 30, left: 52 };

export type Plane = {
  xs: number[];
  ys: number[];
  // the plot's inner size, and a figure's pixel from the SVG's corner
  w: number;
  h: number;
  x: (wait: number) => number;
  y: (decode: number) => number;
};

// The scales for a width: 0 at the corner, the last tick at the far edge.
export function plane(list: Dot[], width: number): Plane {
  const xs = ticks(Math.max(0, ...list.map((d) => d.wait)));
  const ys = ticks(Math.max(0, ...list.map((d) => d.decode)));
  const xMax = xs[xs.length - 1]!;
  const yMax = ys[ys.length - 1]!;
  const w = Math.max(0, width - PAD.left - PAD.right);
  const h = HEIGHT - PAD.top - PAD.bottom;
  return {
    xs,
    ys,
    w,
    h,
    x: (v) => PAD.left + (v / xMax) * w,
    y: (v) => PAD.top + h - (v / yMax) * h,
  };
}

// Where a tip of this size goes: beside its dot, right when it fits, else
// left; on a plane too narrow for either, under the dot (over it near the
// bottom), so the dot it names stays in sight. Never past an edge.
export function tipPlace(
  dot: { x: number; y: number },
  tip: { w: number; h: number },
  plane: { w: number; h: number },
  gap = 14,
): { left: number; top: number } {
  const clampX = (v: number) => Math.max(0, Math.min(v, plane.w - tip.w));
  const clampY = (v: number) => Math.max(0, Math.min(v, plane.h - tip.h));
  if (dot.x + gap + tip.w <= plane.w) {
    return { left: dot.x + gap, top: clampY(dot.y - gap) };
  }
  if (dot.x - gap - tip.w >= 0) {
    return { left: dot.x - gap - tip.w, top: clampY(dot.y - gap) };
  }
  const below = dot.y + gap;
  return {
    left: clampX(dot.x - tip.w / 2),
    top: below + tip.h <= plane.h ? below : clampY(dot.y - gap - tip.h),
  };
}
