// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP API and WebSocket push over the sampler, history, actions and the
// download runner. The page is an HTML import passed from main.ts so tests
// can import this module without invoking Bun's bundler.

import { networkInterfaces } from "node:os";
import type { HTMLBundle } from "bun";
import type {
  EngineConfig,
  EnginePageState,
  ServiceBody,
} from "../../shared/engine.ts";
import { RANGES, type Range } from "../../shared/history.ts";
import type { HostInfo } from "../../shared/host.ts";
import type { CacheLimits } from "../../shared/models.ts";
import type { Snapshot, WsMessage } from "../../shared/socket.ts";
import { ActionError, type Actions } from "../actions.ts";
import { type EngineManager, EngineManagerError } from "../engine/install.ts";
import type { Engine } from "../engine/types.ts";
import { diskSpace } from "../host/info.ts";
import type { ExclusiveLock } from "../lib/lock.ts";
import { DownloadError, type Downloader } from "../models/download.ts";
import type { History } from "../monitor/history.ts";
import type { Sampler } from "../monitor/sampler.ts";

export const DEFAULT_PORT = 11235;
const SAMPLES_TOPIC = "samples";
const MAX_BODY_BYTES = 256 * 1024;

export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const address of addrs ?? []) {
      if (address.family !== "IPv4") continue;
      const [o1, o2] = address.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return address.address;
    }
  }
  return null;
}

export function isRange(value: string | null): value is Range {
  return value !== null && value in RANGES;
}

export type WebDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  actions: Actions;
  downloads: Downloader;
  manager?: EngineManager;
  spyRestart?: {
    isLaunchd: () => boolean;
    exit: (code: number) => void;
    delayMs?: number;
    // the lock the actions and the manager share
    lock?: ExclusiveLock;
  };
  version: string;
  // the compile time of this binary, null from source
  build?: string | null;
  local: boolean;
  currentLimits: () => CacheLimits | null;
  host: HostInfo | null;
  // where downloads land; null when the host cannot say (tests)
  modelDir: string | null;
  now?: () => number;
};

// handle() also serves focused tests that do not exercise downloads.
// Production serve() requires the runner through WebDeps.
type HandleDeps = Omit<WebDeps, "downloads" | "modelDir"> & {
  downloads?: Downloader;
  modelDir?: string | null;
};

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

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function body(
  req: Request,
  empty = false,
): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(400, "body must be at most 256 KB");
  }
  if (!req.body) {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(400, "body must be at most 256 KB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  try {
    return object(JSON.parse(text));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body is not JSON");
  }
}

function stringField(
  value: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const field = value[name];
  if (field === undefined && !required) return undefined;
  if (typeof field !== "string" || (required && field === "")) {
    throw new HttpError(400, `${name} must be a string`);
  }
  return field;
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

// Downloads: list, start (or resume) one, cancel it, forget it.
async function downloadsRoute(
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

function engineConfig(value: unknown): EngineConfig {
  const config = object(value);
  const nullableString = (name: string) =>
    config[name] === null || typeof config[name] === "string";
  const nullableNumber = (name: string) =>
    config[name] === null || typeof config[name] === "number";
  const booleans = ["mtp", "pld", "noVision"];
  const nullableStrings = [
    "prefixCacheMem",
    "prefixCacheDisk",
    "maxResidentMem",
  ];
  const nullableNumbers = [
    "prefixCacheEntries",
    "maxResidentModels",
    "ctxSize",
    "idleEvictSeconds",
    "temp",
    "topP",
    "topK",
  ];
  if (
    (config.host !== "127.0.0.1" && config.host !== "0.0.0.0") ||
    typeof config.port !== "number" ||
    !Array.isArray(config.modelDirs) ||
    !config.modelDirs.every((item) => typeof item === "string") ||
    !nullableStrings.every(nullableString) ||
    !nullableNumbers.every(nullableNumber) ||
    !booleans.every((name) => typeof config[name] === "boolean") ||
    !["off", "4", "8", "turbo2", "turbo4"].includes(config.kvQuant as string) ||
    !["debug", "info", "warn", "error"].includes(config.logLevel as string) ||
    !Array.isArray(config.extraArgs) ||
    !config.extraArgs.every((item) => typeof item === "string")
  ) {
    throw new HttpError(400, "body is not an EngineConfig");
  }
  return config as EngineConfig;
}

async function engineRoute(req: Request, deps: HandleDeps): Promise<Response> {
  const manager = deps.manager;
  if (!manager) return json({ error: "not found" }, 404);
  const path = new URL(req.url).pathname;
  if (path === "/api/engine" && req.method === "GET") {
    return json(manager.pageState());
  }
  if (path === "/api/engine/check" && req.method === "POST") {
    await body(req, true);
    return json(await manager.check());
  }
  if (path === "/api/engine/install" && req.method === "POST") {
    const value = await body(req);
    const tag = stringField(value, "tag", true)!;
    return json(manager.install(tag, engineConfig(value.config)), 202);
  }
  if (path === "/api/engine/upgrade" && req.method === "POST") {
    const value = await body(req);
    return json(manager.upgrade(stringField(value, "tag", true)!), 202);
  }
  if (path === "/api/engine/cancel" && req.method === "POST") {
    await body(req, true);
    return json(await manager.cancel());
  }
  if (path === "/api/engine/config" && req.method === "PUT") {
    return json(await manager.applyConfig(engineConfig(await body(req))));
  }
  if (path === "/api/engine/settings" && req.method === "PUT") {
    const value = await body(req);
    if (typeof value.preReleases !== "boolean") {
      throw new HttpError(400, "preReleases must be a boolean");
    }
    return json(await manager.setPreReleases(value.preReleases));
  }
  if (path === "/api/engine/service" && req.method === "POST") {
    const value = await body(req);
    if (!["start", "stop", "restart"].includes(value.op as string)) {
      throw new HttpError(400, "op must be start, stop, or restart");
    }
    return json(await manager.service(value.op as ServiceBody["op"]));
  }
  if (path === "/api/engine/rollback" && req.method === "POST") {
    await body(req, true);
    return json(await manager.rollback());
  }
  if (path === "/api/engine/dismiss" && req.method === "POST") {
    await body(req, true);
    return json(await manager.dismiss());
  }
  if (path === "/api/engine" && req.method === "DELETE") {
    return json(await manager.uninstall());
  }
  // a path this API has, asked the wrong way, is 405; a typo is 404
  return ENGINE_PATHS.has(path)
    ? json({ error: "method not allowed" }, 405)
    : json({ error: "not found" }, 404);
}

const ENGINE_PATHS = new Set([
  "/api/engine",
  ...[
    "check",
    "install",
    "upgrade",
    "cancel",
    "config",
    "settings",
    "service",
    "rollback",
    "dismiss",
  ].map((name) => `/api/engine/${name}`),
]);

async function spyRestartRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  await body(req, true);
  const restart = deps.spyRestart;
  if (!restart?.isLaunchd()) {
    return json({ error: "mlx-spy restart requires the launchd service" }, 409);
  }
  const holder = deps.manager?.running() ?? deps.actions.running();
  if (holder) return json({ error: `${holder} is still running` }, 409);
  const state = deps.manager?.pageState() ?? { ok: true };
  // The exit waits for the response to leave, and holds the shared lock
  // while it does: an install accepted in that gap would be killed by it.
  const exit = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        restart.exit(0);
        resolve();
      }, restart.delayMs ?? 25);
    });
  if (restart.lock) void restart.lock.run("restart", exit).catch(() => {});
  else void exit();
  return json(state);
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
