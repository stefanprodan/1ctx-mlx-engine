// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Scatter } from "../../src/client/benchmark/Scatter.tsx";
import {
  dots,
  HEIGHT,
  PAD,
  plane,
  SERIES,
  slotOf,
  ticks,
  tipPlace,
} from "../../src/client/benchmark/scatter.ts";
import type { Benchmark, Figure } from "../../src/shared/benchmark.ts";

const fig = (median: number | null): Figure => ({ median, spreadPct: 1 });

const run = (
  id: number,
  model: string,
  waitMs: number | null,
  decode: number | null,
) =>
  ({
    id,
    model,
    summary: {
      warmLatencyMs: fig(waitMs),
      decodeTps: fig(decode),
    },
  }) as unknown as Benchmark;

describe("scatter", () => {
  test("a dot per run with both figures, the wait in seconds", () => {
    const listed = ["org/b", "org/a", "org/c"];
    expect(
      dots(
        [
          run(1, "org/a", 2400, 88.4),
          run(2, "org/b", 35_600, 22.3),
          run(3, "org/c", null, 50),
          run(4, "org/c", 3000, null),
        ],
        listed,
      ),
    ).toEqual([
      { id: 1, model: "org/a", slot: 1, wait: 2.4, decode: 88.4 },
      { id: 2, model: "org/b", slot: 2, wait: 35.6, decode: 22.3 },
    ]);
    // a run without a summary has no place either, nor a figure a scale
    // cannot place
    expect(dots([{ ...run(5, "org/a", 1, 1), summary: null }], listed)).toEqual(
      [],
    );
    expect(
      dots(
        [
          run(6, "org/a", Number.NaN, 50),
          run(7, "org/a", 3000, Number.POSITIVE_INFINITY),
        ],
        listed,
      ),
    ).toEqual([]);
  });

  test("the colour follows the model among the listed, never its rank", () => {
    const listed = ["z/last", "a/first", "m/middle"];
    expect(slotOf("a/first", listed)).toBe(1);
    expect(slotOf("m/middle", listed)).toBe(2);
    expect(slotOf("z/last", listed)).toBe(3);
    // the order the engine lists them in does not matter
    expect(slotOf("m/middle", [...listed].reverse())).toBe(2);
    // a model the engine does not list, and one past the last slot
    expect(slotOf("gone/model", listed)).toBe(0);
    const many = Array.from({ length: SERIES + 1 }, (_, i) => `org/m${i}`);
    expect(slotOf(`org/m${SERIES - 1}`, many)).toBe(SERIES);
    expect(slotOf(`org/m${SERIES}`, many)).toBe(0);
  });

  test("ticks are round steps from 0 past the largest value", () => {
    expect(ticks(37.4)).toEqual([0, 10, 20, 30, 40]);
    expect(ticks(88.4)).toEqual([0, 20, 40, 60, 80, 100]);
    // a maximum on a step gets one more, not a coarser step
    expect(ticks(100)).toEqual([0, 20, 40, 60, 80, 100, 120]);
    expect(ticks(4)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ticks(0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(ticks(0)).toEqual([0, 1]);
    expect(ticks(Number.NaN)).toEqual([0, 1]);
  });

  test("the plane puts 0 at the corner and the last tick at the far edge", () => {
    const p = plane(
      [
        { id: 1, model: "a/a", slot: 1, wait: 2.4, decode: 88.4 },
        { id: 2, model: "b/b", slot: 2, wait: 35.6, decode: 22.3 },
      ],
      500,
    );
    expect(p.xs.at(-1)).toBe(40);
    expect(p.ys.at(-1)).toBe(100);
    expect(p.w).toBe(500 - PAD.left - PAD.right);
    expect(p.x(0)).toBe(PAD.left);
    expect(p.x(40)).toBe(500 - PAD.right);
    expect(p.y(0)).toBe(HEIGHT - PAD.bottom);
    expect(p.y(100)).toBe(PAD.top);
    // no dots and no width still give finite scales
    const empty = plane([], 0);
    expect(Number.isFinite(empty.x(0))).toBeTrue();
    expect(Number.isFinite(empty.y(0))).toBeTrue();
  });

  test("a tip goes beside its dot, else under it, never past an edge", () => {
    const plane = { w: 500, h: 280 };
    const tip = { w: 200, h: 40 };
    // room on the right
    expect(tipPlace({ x: 100, y: 100 }, tip, plane)).toEqual({
      left: 114,
      top: 86,
    });
    // no room on the right: left of the dot
    expect(tipPlace({ x: 400, y: 100 }, tip, plane)).toEqual({
      left: 186,
      top: 86,
    });
    // near the top, held inside
    expect(tipPlace({ x: 100, y: 4 }, tip, plane).top).toBe(0);
    // a phone: no room either side, under the dot and centred on it
    const narrow = { w: 328, h: 280 };
    const wide = { w: 300, h: 60 };
    expect(tipPlace({ x: 200, y: 100 }, wide, narrow)).toEqual({
      left: 28,
      top: 114,
    });
    // near the bottom it goes over the dot instead
    expect(tipPlace({ x: 200, y: 240 }, wide, narrow)).toEqual({
      left: 28,
      top: 166,
    });
    // near an edge, held inside
    expect(tipPlace({ x: 20, y: 100 }, wide, narrow).left).toBe(0);
  });

  test("the legend names every dot with its two figures", () => {
    const html = render(
      <Scatter
        dots={[
          { id: 1, model: "org/Ling-4bit", slot: 1, wait: 2.38, decode: 88.4 },
          { id: 2, model: "org/Qwen-4bit", slot: 0, wait: 35.6, decode: 22.3 },
        ]}
      />,
    );
    expect(html).toContain(
      '<li><i style="background:var(--series-1);"></i><span class="model">Ling-4bit</span><span class="v">2.4 s</span><span class="v">88.4</span><small>tok/s</small></li>',
    );
    expect(html).toContain("background:var(--series-0);");
    expect(html).toContain('<span class="v">35.6 s</span>');
  });
});
