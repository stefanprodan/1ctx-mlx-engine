// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The management routes under /api/engine and 1ctx-mlx-engine's own restart,
// all under rule 5: local only, behind the manager's lock.

import type { EngineConfig, ServiceBody } from "../../shared/engine.ts";

import type { HandleDeps } from "./deps.ts";
import { body, HttpError, json, object, stringField } from "./http.ts";

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

export async function engineRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
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

export const ENGINE_PATHS = new Set([
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

export async function selfRestartRoute(
  req: Request,
  deps: HandleDeps,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  await body(req, true);
  const restart = deps.selfRestart;
  if (!restart?.isLaunchd()) {
    return json(
      { error: "1ctx-mlx-engine restart requires the launchd service" },
      409,
    );
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
