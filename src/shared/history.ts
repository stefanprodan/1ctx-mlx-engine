// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ranges /api/history takes and the columnar series it answers.

export const DAY_MS = 86_400_000;

export const RANGES = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
} as const;

export type Range = keyof typeof RANGES;

// Columnar, ready for uPlot: one array per series, aligned on `t`.
// Only what the page reads back is persisted. The memory, host and disk
// gauges are live-only: the tiles read them off the Sample and no chart
// plots them, so storing them at 1 Hz for 7 days bought nothing.
export type Series = {
  t: number[];
  engineUp: (0 | 1)[];
  epoch: number[];
  decodeTps: (number | null)[];
  prefillTps: (number | null)[];
  cacheHitPct: (number | null)[];
  cacheTokenPct: (number | null)[];
  ttftMs: (number | null)[]; // mean over the bucket, weighted by ttftN
  ttftN: number[]; // requests the mean covers
  generationTokens: number[];
  requestsTotal: number[];
  promptTokens: number[];
  cachedPromptTokens: number[];
  requestsCancelled: number[];
};
