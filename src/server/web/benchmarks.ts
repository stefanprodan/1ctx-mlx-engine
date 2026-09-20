// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The /api/benchmarks routes.

import { BenchmarkError } from "../benchmark/runner.ts";
import type { HandleDeps } from "./deps.ts";
import { body, json } from "./http.ts";

// Benchmarks: list, start one, read one with its turns, cancel it, delete it.
export async function benchmarksRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  const runner = deps.benchmarks;
  if (!runner) return json({ error: "not found" }, 404);
  const url = new URL(req.url);
  try {
    if (url.pathname === "/api/benchmarks") {
      if (req.method === "GET") return json(runner.list());
      if (req.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      return json(runner.start(await body(req)), 202);
    }
    const match = /^\/api\/benchmarks\/(\d+)(?:\/(cancel))?$/.exec(
      url.pathname,
    );
    if (!match) return json({ error: "not found" }, 404);
    const id = Number(match[1]);
    if (match[2] === "cancel") {
      if (req.method !== "POST") {
        return json({ error: "method not allowed" }, 405);
      }
      await body(req, true);
      runner.cancel(id);
      return json({ ok: true });
    }
    if (req.method === "GET") return json(runner.detail(id));
    if (req.method === "DELETE") {
      runner.remove(id);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    if (err instanceof BenchmarkError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}
