// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DASH } from "../../src/client/format.ts";
import {
  figures,
  matchingRequests,
  ms,
  noRequestsCopy,
  rate,
  requestGroups,
  requestTag,
  requestWhy,
  sizeLine,
  totalMs,
} from "../../src/client/requests/list.ts";
import type { LastRequest } from "../../src/shared/requests.ts";

const req = (over: Partial<LastRequest> = {}): LastRequest => ({
  startedAt: 1_000,
  finishedAt: 3_000,
  count: 1,
  cancelled: false,
  generated: 256,
  promptTokens: 42_050,
  prefillTokens: 2_075,
  prefillMs: 237,
  decodeMs: 882,
  ttftMs: 237,
  model: "mlx-community/Qwen3.5-0.8B-4bit",
  ...over,
});

describe("requests list", () => {
  test("search by model and filter by outcome", () => {
    const list = [
      req({ finishedAt: 1 }),
      req({ finishedAt: 2, cancelled: true }),
      req({ finishedAt: 3, model: "org/gemma-4" }),
      req({ finishedAt: 4, model: null }),
    ];
    const at = (q: string, o: "completed" | "cancelled" | null) =>
      matchingRequests(list, q, o).map((r) => r.finishedAt);
    expect(at("", null)).toEqual([1, 2, 3, 4]);
    expect(at(" QWEN ", null)).toEqual([1, 2]);
    expect(at("", "cancelled")).toEqual([2]);
    expect(at("", "completed")).toEqual([1, 3, 4]);
    expect(at("gemma", "cancelled")).toEqual([]);
  });

  test("the blank line names the filter and the search", () => {
    expect(noRequestsCopy("", null)).toBe("No requests.");
    expect(noRequestsCopy(" 35B ", null)).toBe("No requests match 35B.");
    expect(noRequestsCopy("", "cancelled")).toBe("No cancelled requests.");
    expect(noRequestsCopy("x", "completed")).toBe(
      "No completed requests match x.",
    );
  });

  test("figures in the runs' units", () => {
    expect(figures(req())).toEqual({
      ttft: "237 ms",
      prefill: "8,755",
      decode: "290",
    });
    expect(figures(req({ ttftMs: null, prefillMs: 0, decodeMs: 0 }))).toEqual({
      ttft: DASH,
      prefill: DASH,
      decode: DASH,
    });
    expect(ms(12_345)).toBe("12.3 s");
    expect(rate(5, 1000)).toBe("5.0");
  });

  test("the faint line, the total and the outcome", () => {
    expect(sizeLine(req())).toBe(" · 42.0K tok · 95% cached");
    expect(sizeLine(req({ prefillTokens: 42_050 }))).toBe(" · 42.0K tok");
    expect(sizeLine(req({ promptTokens: 0, prefillTokens: 0 }))).toBe("");
    expect(totalMs(req())).toBe(1119);
    expect(totalMs(req({ prefillMs: 0, decodeMs: 0 }))).toBe(2000);
    expect(
      totalMs(req({ prefillMs: 0, decodeMs: 0, startedAt: null })),
    ).toBeNull();
    expect(requestWhy(req())).toBeNull();
    expect(requestWhy(req({ cancelled: true }))).toBe(
      "Cancelled by the client",
    );
    expect(requestWhy(req({ cancelled: true, count: 3 }))).toBe(
      "3 requests cancelled by their clients in the same second",
    );
    expect(requestTag(req({ count: 2 }))).toBe("2 requests in the same second");
    expect(requestTag(req({ count: 2, cancelled: true }))).toBeNull();
  });

  test("the opened row's groups", () => {
    const groups = requestGroups(req(), (t) => `t${t}`);
    expect(groups.map((g) => g.title)).toEqual(["Timing", "Prefill", "Decode"]);
    expect(groups[0]!.rows).toEqual([
      { label: "Started", value: "t1000" },
      { label: "Finished", value: "t3000" },
      { label: "TTFT", value: "237 ms" },
      { label: "Total", value: "1119 ms" },
    ]);
    expect(groups[1]!.rows).toEqual([
      { label: "Prompt", value: "42,050", unit: "tok" },
      { label: "Cached", value: "39,975", unit: "tok", spread: "95%" },
      { label: "Time", value: "237 ms" },
      { label: "Rate", value: "8,755", unit: "tok/s" },
    ]);
    expect(groups[2]!.rows).toEqual([
      { label: "Generated", value: "256", unit: "tok" },
      { label: "Time", value: "882 ms" },
      { label: "Rate", value: "290", unit: "tok/s" },
    ]);
    const bare = requestGroups(
      req({ startedAt: null, promptTokens: 0, prefillTokens: 0, generated: 0 }),
      (t) => `t${t}`,
    );
    expect(bare[0]!.rows[0]).toEqual({ label: "Started", value: "not seen" });
    expect(bare[1]!.rows.slice(0, 2)).toEqual([
      { label: "Prompt", value: DASH },
      { label: "Cached", value: DASH },
    ]);
  });
});
