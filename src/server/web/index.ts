// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API and WebSocket push over the sampler, history, actions and the
// download runner. The page is an HTML import passed from main.ts so tests
// can import this module without invoking Bun's bundler.

import type { HTMLBundle } from "bun";
import type { EnginePageState } from "../../shared/engine.ts";
import { RANGES, type Range } from "../../shared/history.ts";
import type { Snapshot, WsMessage } from "../../shared/socket.ts";
import { ActionError } from "../actions.ts";
import { EngineManagerError } from "../engine/manager/index.ts";
import { diskSpace } from "../host/info.ts";
import { DownloadError } from "../models/error.ts";
import type { HandleDeps, WebDeps } from "./deps.ts";
import { downloadsRoute } from "./downloads.ts";
import { engineRoute, spyRestartRoute } from "./engine.ts";
import { body, HttpError, json, sameOrigin } from "./http.ts";

const SAMPLES_TOPIC = "samples";

export function isRange(value: string | null): value is Range {
  return value !== null && value in RANGES;
}

export function snapshot(deps: HandleDeps): Snapshot {
  return {
    version: deps.version,
    build: deps.build ?? null,
    engine: {
      id: deps.engine.id,
      url: deps.engine.url,
      local: deps.local,
      // A managed tree states its build without touching /props. Otherwise
      // the sampler's guarded engine fact remains the source of truth.
      version:
        deps.manager?.state().mode === "managed"
          ? (deps.manager.state().active?.version ?? null)
          : deps.sampler.currentVersion(),
      capabilities: [...deps.engine.capabilities()],
      // The provider applies current launch configuration and CLI overrides,
      // then falls back to facts reported by the running engine.
      limits: deps.currentLimits(),
    },
    host: deps.host
      ? { ...deps.host, disk: diskSpace(deps.host.diskPath) }
      : null,
    sample: deps.history.latest(),
    models: deps.sampler.currentModels(),
    disk: deps.sampler.currentDisk(),
    events: deps.actions.events,
    running: deps.actions.running(),
    downloads: deps.downloads?.list() ?? [],
    modelDir: deps.modelDir ?? null,
  };
}

async function actionRoute(
  req: Request,
  deps: HandleDeps,
  name: string,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const requestBody = await body(req, true);
  try {
    return json(await deps.actions.run(name, requestBody));
  } catch (err) {
    if (err instanceof ActionError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}

export async function handle(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" && !sameOrigin(req)) {
    return json({ error: "cross-origin request" }, 403);
  }
  try {
    const action = /^\/api\/actions\/([a-zA-Z]+)$/.exec(url.pathname);
    if (action) return await actionRoute(req, deps, action[1]);
    if (
      url.pathname === "/api/engine" ||
      url.pathname.startsWith("/api/engine/")
    ) {
      return await engineRoute(req, deps);
    }
    if (url.pathname === "/api/spy/restart") {
      return await spyRestartRoute(req, deps);
    }
    if (
      url.pathname === "/api/downloads" ||
      url.pathname.startsWith("/api/downloads/")
    ) {
      return await downloadsRoute(req, deps);
    }
    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    switch (url.pathname) {
      case "/api/snapshot":
        return json(snapshot(deps));
      case "/api/requests":
        return json(deps.history.requests());
      case "/api/history": {
        const range = url.searchParams.get("range") ?? "1h";
        if (!isRange(range)) {
          return json(
            { error: `range must be one of ${Object.keys(RANGES).join(", ")}` },
            400,
          );
        }
        return json({
          range,
          series: deps.history.series(range, (deps.now ?? Date.now)()),
        });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (err) {
    if (err instanceof EngineManagerError) {
      return json(
        err.issues
          ? { error: err.message, issues: err.issues }
          : { error: err.message },
        err.status,
      );
    }
    if (err instanceof DownloadError || err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    throw err;
  }
}

export function serve(
  deps: WebDeps,
  listen: { hostname: string; port: number },
  page: HTMLBundle,
) {
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    // MLX_SPY_DEV=1 (make preview) turns on Bun's dev server: the page's
    // CSS and TypeScript are bundled on demand and hot-reloaded in the
    // browser; off, the bundle is built once at startup
    development: process.env.MLX_SPY_DEV === "1",
    routes: {
      "/": page,
      "/requests": page,
      "/engine": page,
    },
    fetch(req, server) {
      if (new URL(req.url).pathname === "/ws") {
        if (!sameOrigin(req)) {
          return new Response("cross-origin request", { status: 403 });
        }
        return server.upgrade(req)
          ? undefined
          : new Response("websocket upgrade failed", { status: 400 });
      }
      return handle(req, deps);
    },
    websocket: {
      open(ws) {
        ws.subscribe(SAMPLES_TOPIC);
        const message: WsMessage = { type: "snapshot", data: snapshot(deps) };
        ws.send(JSON.stringify(message));
      },
      message() {},
      close(ws) {
        ws.unsubscribe(SAMPLES_TOPIC);
      },
    },
  });
  const publish = (message: WsMessage) =>
    server.publish(SAMPLES_TOPIC, JSON.stringify(message));
  const unsubscribe = deps.sampler.onSample((sample) =>
    publish({ type: "sample", data: sample }),
  );
  const unsubscribeEvents = deps.actions.onEvent((event) =>
    publish({ type: "event", data: event }),
  );
  const unsubscribeDownloads = deps.downloads.onEvent((download) =>
    publish({ type: "download", data: download }),
  );
  return {
    server,
    publishEngine(state: EnginePageState) {
      publish({ type: "engine", data: state });
    },
    stop() {
      unsubscribe();
      unsubscribeEvents();
      unsubscribeDownloads();
      server.stop(true);
    },
  };
}
