// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The copy of a download row in the models table (pure, tested in
// test/client/download.test.ts): which downloads the table shows, the dot,
// the bytes and speed, the time left or the state word.

import type { Download } from "../../shared/downloads.ts";
import { DASH, eta, gb } from "../format.ts";

// A finished download whose model the engine lists is that model's row now;
// every other download stays until it is removed.
export function visibleDownloads(
  downloads: Download[],
  models: { id: string }[],
): Download[] {
  const listed = new Set(models.map((m) => m.id));
  return downloads.filter((p) => p.status !== "done" || !listed.has(p.repo));
}

export function downloadDot(p: Download): string {
  switch (p.status) {
    case "running":
      return "loading";
    case "failed":
      return "error";
    case "done":
      return "ready";
    default:
      return "";
  }
}

// Under a MB/s the speed would read 0 and a time left from a trickle is
// noise: the bytes say it is moving.
const fast = (p: Download): p is Download & { speedBps: number } =>
  p.status === "running" && p.speedBps !== null && p.speedBps >= 1024 ** 2;

// "5 min" while it runs at a speed worth dividing by, else null. Both pages
// show it where the state word would be: the bar says the share.
export function timeLeft(p: Download): string | null {
  if (!fast(p) || p.bytesTotal <= p.bytesDone) return null;
  return eta((p.bytesTotal - p.bytesDone) / p.speedBps);
}

export function downloadState(p: Download): string {
  return p.status === "running" ? (timeLeft(p) ?? DASH) : p.status;
}

// "3.2 / 16.7 GB · 48 MB/s" while running, the size when queued or done,
// what arrived when it stopped.
export function downloadMeta(p: Download): string {
  const total = `${gb(p.bytesTotal)} GB`;
  if (p.status === "queued" || p.status === "done") return total;
  const parts = [`${gb(p.bytesDone)} / ${total}`];
  if (fast(p)) parts.push(`${Math.round(p.speedBps / 1024 ** 2)} MB/s`);
  return parts.join(" · ");
}

// The share done, for the bar under the id.
export function downloadPct(p: Download): number {
  if (p.bytesTotal <= 0) return 0;
  return Math.min(100, (p.bytesDone / p.bytesTotal) * 100);
}
