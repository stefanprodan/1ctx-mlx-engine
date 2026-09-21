// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Requests history as the grid shows it (pure, tested in
// test/client/requests.test.ts): the search and the outcome filter, a
// row's figures and faint line, and the groups of its opened row, in the
// benchmark runs' units so the two read alike.

import type { LastRequest } from "../../shared/requests.ts";
import { count, DASH } from "../format.ts";
import type { GridGroup } from "../shell/Grid.tsx";

export type Outcome = "completed" | "cancelled";

export const OUTCOMES: (Outcome | null)[] = [null, "completed", "cancelled"];

export const outcomeLabel = (o: Outcome | null) =>
  o === null ? "All" : o === "completed" ? "Completed" : "Cancelled";

export function matchingRequests(
  list: LastRequest[],
  query: string,
  outcome: Outcome | null,
): LastRequest[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (r) =>
      (outcome === null || r.cancelled === (outcome === "cancelled")) &&
      (q === "" || (r.model ?? "").toLowerCase().includes(q)),
  );
}

// what the grid says when the search and the filter leave no row
export function noRequestsCopy(query: string, outcome: Outcome | null) {
  const q = query.trim();
  const what = outcome === null ? "requests" : `${outcome} requests`;
  return q === "" ? `No ${what}.` : `No ${what} match ${q}.`;
}

// a time as the runs show a latency: ms under 10 s, then seconds
export const ms = (v: number | null) =>
  v == null || v <= 0
    ? DASH
    : v >= 10_000
      ? `${(v / 1000).toFixed(1)} s`
      : `${Math.round(v)} ms`;

// a rate as the runs show one: grouped when whole, a decimal when small
export function rate(tokens: number, time: number): string {
  if (tokens <= 0 || time <= 0) return DASH;
  const v = (tokens * 1000) / time;
  return v >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
}

const whole = (n: number) => n.toLocaleString("en-US");

export const cachedTokens = (r: LastRequest) =>
  Math.max(r.promptTokens - r.prefillTokens, 0);

export function cachedShare(r: LastRequest): number | null {
  const cached = cachedTokens(r);
  return r.promptTokens > 0 && cached > 0
    ? Math.max(1, Math.round((cached / r.promptTokens) * 100))
    : null;
}

// the engine's own time, else the wall clock from the start it saw
export function totalMs(r: LastRequest): number | null {
  const engine = r.prefillMs + r.decodeMs;
  if (engine > 0) return engine;
  return r.startedAt == null ? null : r.finishedAt - r.startedAt;
}

export const figures = (r: LastRequest) => ({
  ttft: ms(r.ttftMs),
  prefill: rate(r.prefillTokens, r.prefillMs),
  decode: rate(r.generated, r.decodeMs),
});

// the faint line under the model, after its time: the prompt and how much
// of it the cache had
export function sizeLine(r: LastRequest): string {
  if (r.promptTokens <= 0) return "";
  const share = cachedShare(r);
  return ` · ${count(r.promptTokens)} tok${share ? ` · ${share}% cached` : ""}`;
}

// said above the groups: a cancel is worth a look, as a suspect run is
export function requestWhy(r: LastRequest): string | null {
  if (!r.cancelled) return null;
  return r.count > 1
    ? `${r.count} requests cancelled by their clients in the same second`
    : "Cancelled by the client";
}

export function requestTag(r: LastRequest): string | null {
  return !r.cancelled && r.count > 1
    ? `${r.count} requests in the same second`
    : null;
}

const tok = (n: number) =>
  n > 0 ? { value: whole(n), unit: "tok" } : { value: DASH };

export function requestGroups(
  r: LastRequest,
  clock: (t: number) => string,
): GridGroup[] {
  const share = cachedShare(r);
  const cached = cachedTokens(r);
  const prefillRate = rate(r.prefillTokens, r.prefillMs);
  const decodeRate = rate(r.generated, r.decodeMs);
  return [
    {
      title: "Timing",
      rows: [
        {
          label: "Started",
          value: r.startedAt == null ? "not seen" : clock(r.startedAt),
        },
        { label: "Finished", value: clock(r.finishedAt) },
        { label: "TTFT", value: ms(r.ttftMs) },
        { label: "Total", value: ms(totalMs(r)) },
      ],
    },
    {
      title: "Prefill",
      rows: [
        { label: "Prompt", ...tok(r.promptTokens) },
        share
          ? {
              label: "Cached",
              value: whole(cached),
              unit: "tok",
              spread: `${share}%`,
            }
          : { label: "Cached", value: DASH },
        { label: "Time", value: ms(r.prefillMs) },
        prefillRate === DASH
          ? { label: "Rate", value: DASH }
          : { label: "Rate", value: prefillRate, unit: "tok/s" },
      ],
    },
    {
      title: "Decode",
      rows: [
        { label: "Generated", ...tok(r.generated) },
        { label: "Time", value: ms(r.decodeMs) },
        decodeRate === DASH
          ? { label: "Rate", value: DASH }
          : { label: "Rate", value: decodeRate, unit: "tok/s" },
      ],
    },
  ];
}
