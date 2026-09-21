// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// GET /api/models: every model the engine lists, with its spec. The list is
// the sampler's and the meta the adapter kept from the same read, so the
// route asks the engine nothing; the checkpoints are read from
// --model-dir, and only when the engine is on this host.

import type { ModelSpec } from "../../shared/models.ts";
import { mergeSpec } from "../models/spec.ts";
import type { HandleDeps } from "./deps.ts";
import { json } from "./http.ts";

export async function modelsRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const meta = deps.engine.modelMeta?.();
  const reader = deps.local ? (deps.specs ?? null) : null;
  const specs: ModelSpec[] = [];
  for (const info of deps.sampler.currentModels()) {
    const disk = reader ? await reader.read(info.id) : null;
    const done = deps.downloads?.lastDone(info.id) ?? null;
    specs.push(
      mergeSpec(
        info,
        meta?.get(info.id),
        disk,
        done ? { revision: done.revision, finishedAt: done.finishedAt } : null,
      ),
    );
  }
  return json(specs);
}
