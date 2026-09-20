// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Benchmark page's signals and its calls to the server. The run in
// progress lives in the store (it rides on the socket); the finished runs
// are read here, again whenever one ends.

import { signal } from "@preact/signals";
import type {
  Benchmark,
  BenchmarkDetail,
  BenchmarkPreset,
} from "../../shared/benchmark.ts";
import { api } from "../api.ts";

export const runs = signal<Benchmark[]>([]);
export const details = signal<Record<number, BenchmarkDetail>>({});
// The runs ticked for comparison, the baseline first; never more than two.
export const picked = signal<number[]>([]);
export const failure = signal<string | null>(null);

// an answer that a later read has overtaken is dropped
let reads = 0;

export function fetchRuns() {
  const read = ++reads;
  void api<Benchmark[]>("/api/benchmarks")
    .then((list) => {
      if (read !== reads) return;
      runs.value = list;
      // a detail read while its run went on is stale once the run ends
      for (const b of list) {
        const held = details.value[b.id]?.benchmark;
        if (held && held.status !== b.status) fetchDetail(b.id);
      }
      const ids = new Set(list.map((b) => b.id));
      picked.value = picked.value.filter((id) => ids.has(id));
    })
    .catch(() => {});
}

export function fetchDetail(id: number) {
  void api<BenchmarkDetail>(`/api/benchmarks/${id}`)
    .then((detail) => {
      details.value = { ...details.value, [id]: detail };
    })
    .catch(() => {});
}

const call = (work: Promise<unknown>) =>
  work
    .then(() => {
      failure.value = null;
    })
    .catch((err: Error) => {
      failure.value = err.message;
    })
    .finally(fetchRuns);

export const startRun = (model: string, preset: BenchmarkPreset) =>
  call(api("/api/benchmarks", "POST", { model, preset }));

export const cancelRun = (id: number) =>
  call(api(`/api/benchmarks/${id}/cancel`, "POST"));

export const removeRun = (id: number) =>
  call(api(`/api/benchmarks/${id}`, "DELETE"));

// A third tick replaces the second: the baseline stays.
export function togglePick(id: number) {
  const now = picked.value;
  picked.value = now.includes(id)
    ? now.filter((p) => p !== id)
    : now.length < 2
      ? [...now, id]
      : [now[0]!, id];
}
