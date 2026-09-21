// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scorecard: one row per model at a preset, its newest finished run,
// ranked by decode. Pure.

import type { Benchmark, BenchmarkPreset } from "../../shared/benchmark.ts";
import { COLUMNS, type Column, type FigureKey } from "./report.ts";

export type ScoreCell = {
  key: FigureKey;
  median: number | null;
  // how close to the best of the column, 1 for the best; null when there
  // is nothing to measure
  share: number | null;
  best: boolean;
};

export type ScoreRow = {
  run: Benchmark;
  // by decode, equal rates sharing a place; null when it has no decode rate
  rank: number | null;
  cells: ScoreCell[];
};

const better = (a: number, b: number, column: Column) =>
  column.higherIsBetter ? a > b : a < b;

// The runs come newest first, as the list route answers. Only the models
// the engine lists count: a deleted one is no choice any more. A model's
// older runs at the preset are left out, and so is a run of another version
// of the session than the newest finished run of any preset and model: its
// numbers are over other work.
export function scorecard(
  runs: Benchmark[],
  preset: BenchmarkPreset,
  present: ReadonlySet<string>,
): ScoreRow[] {
  const finished = runs.filter((b) => b.status === "done");
  const schema = finished[0]?.schema;
  const newest = new Map<string, Benchmark>();
  for (const b of finished) {
    if (b.preset !== preset || b.schema !== schema) continue;
    if (present.has(b.model) && !newest.has(b.model)) newest.set(b.model, b);
  }
  const picked = [...newest.values()];

  const bests = new Map<FigureKey, number>();
  for (const column of COLUMNS) {
    for (const b of picked) {
      const v = b.summary?.[column.key].median;
      if (v == null) continue;
      const held = bests.get(column.key);
      if (held === undefined || better(v, held, column))
        bests.set(column.key, v);
    }
  }

  const rows = picked.map((run) => ({
    run,
    rank: null as number | null,
    cells: COLUMNS.map((column): ScoreCell => {
      const median = run.summary?.[column.key].median ?? null;
      const best = bests.get(column.key);
      const share =
        median == null || best === undefined || median <= 0 || best <= 0
          ? null
          : column.higherIsBetter
            ? median / best
            : best / median;
      // one run has nothing to be best against
      return {
        key: column.key,
        median,
        share,
        best: picked.length > 1 && median !== null && median === best,
      };
    }),
  }));
  const decode = (row: ScoreRow) =>
    row.run.summary?.decodeTps.median ?? Number.NEGATIVE_INFINITY;
  rows.sort((a, b) => decode(b) - decode(a));
  rows.forEach((row, i) => {
    const rate = row.run.summary?.decodeTps.median;
    if (rate == null) return;
    const above = rows[i - 1];
    row.rank =
      above && above.rank !== null && decode(above) === rate
        ? above.rank
        : i + 1;
  });
  return rows;
}
