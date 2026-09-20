// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The /api/downloads routes.

import type { HandleDeps } from "./deps.ts";
import { body, json, stringField } from "./http.ts";

// Downloads: list, start (or resume) one, cancel it, forget it.
export async function downloadsRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  const runner = deps.downloads;
  if (!runner) return json({ error: "not found" }, 404);
  const url = new URL(req.url);
  if (url.pathname === "/api/downloads") {
    if (req.method === "GET") return json(runner.list());
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const value = await body(req);
    const repo = stringField(value, "repo", true)!;
    return json(await runner.start(repo), 202);
  }
  const match = /^\/api\/downloads\/(\d+)(?:\/(cancel))?$/.exec(url.pathname);
  if (!match) return json({ error: "not found" }, 404);
  const id = Number(match[1]);
  if (match[2] === "cancel") {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    await body(req, true);
    return json(await runner.cancel(id));
  }
  if (req.method === "GET") {
    const download = runner.get(id);
    return download
      ? json(download)
      : json({ error: "Download not found" }, 404);
  }
  if (req.method === "DELETE") {
    await runner.remove(id);
    return json({ ok: true });
  }
  return json({ error: "method not allowed" }, 405);
}
