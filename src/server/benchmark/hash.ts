// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The name of a workload: two runs compare when theirs are equal.

import type { BenchmarkPreset } from "../../shared/benchmark.ts";
import {
  buildSession,
  GENERATOR,
  requestFor,
  targetsOf,
  turnsOf,
} from "./script.ts";

// What two runs share to compare: the last turn's whole request and the
// targets, which a small context window shrinks.
export function scriptHash(
  preset: BenchmarkPreset,
  window: number | null,
  maxTokens: number,
): string {
  const session = buildSession({
    preset,
    tag: "",
    ratios: null,
    window,
    maxTokens,
  });
  const request = requestFor(session, turnsOf(preset), "", maxTokens);
  const targets = targetsOf(preset, window, maxTokens);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify({ GENERATOR, preset, targets, request }));
  return hasher.digest("hex").slice(0, 16);
}
