// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The request in flight and the last one that finished, as the sampler
// reports them.

export type InFlight = {
  startedAt: number; // unix ms, the oldest request still open
  prefillMs: number; // engine time spent with a prefill running
  decodeMs: number; // engine time spent generating with no prefill
};

export type LastRequest = {
  startedAt: number | null; // null when the start was not seen (restart)
  finishedAt: number;
  count: number; // requests that completed in the same tick
  cancelled: boolean;
  generated: number; // tokens
  promptTokens: number; // the prompt, cached or not (0 when unknown)
  prefillTokens: number; // prompt tokens computed (not cached)
  prefillMs: number; // the engine's own timings
  decodeMs: number;
  ttftMs: number | null;
  // the engine reports nothing per model: the sampler fills this in from
  // the models resident at the finish (see attributeModel), null when none
  model?: string | null;
};
