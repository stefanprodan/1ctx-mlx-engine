// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Number and time formatting shared by the pages. Pure; tested in
// test/ui/format.test.ts.

// Binary GB everywhere memory is shown, the unit About This Mac uses for
// the machine (96 GB, not 103) and the engine's own --prefix-cache-* flags
// use for their budgets. Only the host disk is decimal, as Finder labels it.
export const GB = 2 ** 30;
// A value with no fact behind it is one quiet dash, everywhere; the CSS
// dims it through the "none" class. Counts stay 0: that is a fact.
export const DASH = "–";
export const gb = (b: number | null | undefined, d = 1) =>
  b == null ? DASH : (b / GB).toFixed(d);
export const diskSize = (b: number) =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`;
export const num = (n: number | null | undefined, d = 0) =>
  n == null ? DASH : n.toFixed(d);
export const count = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}K`
      : `${n}`;

// an uptime: "3d 4h", "2h 15m", "40s"
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

// The order of every model list on the page: the daily driver first, then
// by id. The engine lists resident models first, which moves a row on
// every load and unload; residency shows in the dot instead.
export function orderModels<T extends { id: string; favorite?: boolean }>(
  list: T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.favorite ?? false) - Number(a.favorite ?? false) ||
      a.id.localeCompare(b.id),
  );
}
