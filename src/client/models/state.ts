// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Models page's specs. The live list rides on every sample; the specs
// are read from /api/models when the page opens and again whenever the
// list changes (a load, a delete, the rescan after a download).

import { signal } from "@preact/signals";
import type { ModelSpec } from "../../shared/models.ts";
import { api } from "../api.ts";

export const specs = signal<ModelSpec[]>([]);

// an answer a later read has overtaken is dropped
let reads = 0;
export function fetchSpecs() {
  const read = ++reads;
  void api<ModelSpec[]>("/api/models")
    .then((list) => {
      if (read === reads) specs.value = list;
    })
    .catch(() => {});
}
