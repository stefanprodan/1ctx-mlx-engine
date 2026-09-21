// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The control actions: load, unload and set-default go through the engine
// adapter; free (a launchd restart of the service), disk clear (delete the
// SSD cache tier contents) and delete (remove a model from the model
// directory) are the program's only spawns and deletions, and all three run
// only when the engine is on this host; history clear wipes
// 1ctx-mlx-engine's own sample database and touches no engine, as does favorite
// (the daily-driver mark on one model). Every action is an
// explicit user request from the UI, is checked against the engine's
// capabilities and the current model list, runs one at a time, and is logged
// with its outcome. The sampler never calls into here.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActionEvent,
  type ActionName,
  isActionName,
} from "../shared/actions.ts";
import type { Capability } from "../shared/models.ts";
import type { Engine } from "./engine/types.ts";
import { ExclusiveLock, LockBusyError } from "./lib/lock.ts";
import type { Log } from "./lib/log.ts";
import { removeModel } from "./models/remove.ts";
import type { History } from "./monitor/history.ts";
import type { Sampler } from "./monitor/sampler.ts";

// carries the HTTP status the route should answer with
export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SpawnResult = { code: number; stderr: string };

// What a delete needs of the downloader: a hold that refuses a new start of
// the repo while the delete runs, whether its files are in flight, and the
// records to forget.
export type DownloadRecords = {
  hold(repo: string): () => void;
  blocking(repo: string): string | null;
  forget(repo: string): number;
};

// The engine capability an action needs, null when the engine takes no part
// in it: those work on 1ctx-mlx-engine's own database, or on the model
// directory it downloads into.
const CAPABILITY: Record<ActionName, Capability | null> = {
  load: "load",
  unload: "unload",
  default: "default",
  delete: null,
  free: "restart",
  diskClear: "diskClear",
  historyClear: null,
  requestsClear: null,
  favorite: null,
};

// The actions that touch this host's files or services, and so need the
// engine to run here.
const LOCAL_ONLY: ActionName[] = ["free", "diskClear", "delete"];

export type ActionDeps = {
  engine: Engine;
  sampler: Sampler;
  history: History;
  local: boolean;
  log: Log;
  lock?: ExclusiveLock;
  // launchd domain owner; the service runs in the user's gui domain
  uid?: number;
  now?: () => number;
  // where this program's downloads land; a delete touches nothing else
  modelDir?: string | null;
  // the downloader, for the records a deleted model leaves behind; a getter
  // because the downloader is built after the actions
  downloads?: () => DownloadRecords | null;
  // injectable for tests: the process spawn and the directory wipe
  spawn?: (cmd: string[]) => Promise<SpawnResult>;
  clearDir?: (root: string) => Promise<number>;
};

const EVENTS_KEPT = 50;

async function bunSpawn(cmd: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr: stderr.trim() };
}

// Deletes the children of `root`, never `root` itself: the engine recreates
// per-model directories under it on the next load. A missing root is fine.
export async function clearDirContents(root: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err: any) {
    if (err?.code === "ENOENT") return 0;
    throw err;
  }
  for (const name of names) {
    await rm(join(root, name), { recursive: true, force: true });
  }
  return names.length;
}

export class Actions {
  readonly events: ActionEvent[] = [];
  private readonly lock: ExclusiveLock;
  private readonly listeners = new Set<(e: ActionEvent) => void>();
  private readonly now: () => number;
  private readonly spawn: (cmd: string[]) => Promise<SpawnResult>;
  private readonly clearDir: (root: string) => Promise<number>;
  private readonly uid: number;

  constructor(private readonly deps: ActionDeps) {
    this.lock = deps.lock ?? new ExclusiveLock();
    this.now = deps.now ?? Date.now;
    this.spawn = deps.spawn ?? bunSpawn;
    this.clearDir = deps.clearDir ?? clearDirContents;
    this.uid = deps.uid ?? process.getuid?.() ?? 501;
  }

  onEvent(fn: (e: ActionEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  running(): ActionName | "benchmark" | null {
    return this.lock.running() as ActionName | "benchmark" | null;
  }

  // Validates, runs, logs. Throws ActionError with the status to answer.
  async run(name: string, body: unknown): Promise<ActionEvent> {
    if (!isActionName(name)) {
      throw new ActionError(404, `unknown action: ${name}`);
    }
    const capability = CAPABILITY[name];
    if (capability && !this.deps.engine.capabilities().has(capability)) {
      throw new ActionError(403, `${this.deps.engine.id} cannot ${name}`);
    }
    if (LOCAL_ONLY.includes(name) && !this.deps.local) {
      throw new ActionError(
        403,
        `${name} only works when the engine runs on this host`,
      );
    }
    const model = this.modelFor(name, body);
    try {
      return await this.lock.run(name, async () => {
        const started = this.now();
        let ok = true;
        let detail = "";
        // a refusal keeps its own status; an adapter, spawn or file failure is 502
        let status = 502;
        try {
          detail = await this.perform(name, model);
        } catch (err) {
          ok = false;
          detail = err instanceof Error ? err.message : String(err);
          if (err instanceof ActionError) status = err.status;
        }
        // the table must reflect the new residency without waiting 5 s; the
        // action stays busy until every tab has the event so a second one
        // cannot start on a stale picture
        await this.deps.sampler.refreshModels();
        const event: ActionEvent = {
          t: this.now(),
          action: name,
          model,
          ok,
          ms: this.now() - started,
          detail,
        };
        this.events.push(event);
        if (this.events.length > EVENTS_KEPT) this.events.shift();
        this.deps.log(
          `action ${name}${model ? ` ${model}` : ""}: ${ok ? "ok" : "failed"} in ${event.ms} ms${detail ? ` (${detail})` : ""}`,
        );
        for (const fn of this.listeners) fn(event);
        if (!ok) throw new ActionError(status, detail);
        return event;
      });
    } catch (error) {
      if (error instanceof LockBusyError) {
        throw new ActionError(409, error.message);
      }
      throw error;
    }
  }

  // The model id comes from the request but must name a model the engine
  // listed; the actions never forward arbitrary strings to the engine.
  private modelFor(name: ActionName, body: unknown): string | null {
    if (
      name === "free" ||
      name === "diskClear" ||
      name === "historyClear" ||
      name === "requestsClear"
    ) {
      return null;
    }
    const id = (body as any)?.model;
    if (typeof id !== "string" || id === "") {
      throw new ActionError(400, `${name} needs a model id`);
    }
    const known = this.deps.sampler.currentModels().find((m) => m.id === id);
    if (!known) throw new ActionError(400, `unknown model: ${id}`);
    if (name === "unload" && !known.loaded) {
      throw new ActionError(400, `${id} is not loaded`);
    }
    // the weights are mapped while the model is resident; unload first
    if (name === "delete" && known.loaded) {
      throw new ActionError(400, `${id} is loaded`);
    }
    // the engine still lists a deleted model until it restarts
    if (name !== "unload" && known.deleted) {
      throw new ActionError(400, `${id} is deleted`);
    }
    return id;
  }

  private async perform(name: ActionName, model: string | null) {
    switch (name) {
      // A load makes the model the engine's default, and an unload hands the
      // default to the model still resident (the favorite first): a request
      // without a model then goes to what is in memory instead of cold
      // loading something else.
      case "load": {
        const asDefault = this.deps.engine.capabilities().has("default");
        await this.deps.engine.load(model!, asDefault);
        return asDefault ? "loaded as default" : "loaded";
      }
      case "unload": {
        await this.deps.engine.unload(model!);
        if (!this.deps.engine.capabilities().has("default")) return "unloaded";
        const rest = (await this.deps.sampler.refreshModels()).filter(
          (m) => m.loaded && m.id !== model,
        );
        const next = rest.find((m) => m.favorite) ?? rest[0];
        if (!next) return "unloaded";
        await this.deps.engine.load(next.id, true);
        return `unloaded, ${next.id} is the default`;
      }
      case "default":
        await this.deps.engine.load(model!, true);
        return "loaded as default";
      case "delete":
        return this.deleteModel(model!);
      case "favorite": {
        const fav = this.deps.history.toggleFavorite(model!);
        this.deps.sampler.stampModels();
        return fav === model ? "daily driver" : "no daily driver";
      }
      case "free":
        return this.restartEngine();
      case "diskClear": {
        // as mlxctl does: restart first so the engine holds no handle on the
        // tier and does not rebuild its index over vanishing files
        await this.restartEngine();
        const removed = await this.clearDiskTier();
        return `restarted, removed ${removed} cache dir${removed === 1 ? "" : "s"}`;
      }
      case "historyClear": {
        const n = this.deps.history.clear();
        this.deps.sampler.forgetLastRequest();
        return `removed ${n} sample${n === 1 ? "" : "s"}`;
      }
      case "requestsClear": {
        const n = this.deps.history.clearRequests();
        this.deps.sampler.forgetLastRequest();
        return `removed ${n} request${n === 1 ? "" : "s"}`;
      }
    }
  }

  // Full cleanup for one model: the download records that would otherwise
  // resume the weights back into the gap, its checkpoint under this
  // program's model directory, then the deleted mark on the row. Records go
  // first: files without records are a model that still works, records
  // without files would write half a model back. No rescan: mlx-serve's
  // only adds, so the engine lists the model until it restarts. A download
  // in flight for the same repo refuses the delete, and none may start
  // while it runs. The SSD cache tier is keyed by prompt fingerprint, not by
  // model, so nothing there can be attributed to one model and it is left
  // alone.
  private async deleteModel(id: string): Promise<string> {
    const root = this.deps.modelDir ?? null;
    if (!root) throw new ActionError(403, "no model directory");
    const records = this.deps.downloads?.() ?? null;
    const release = records?.hold(id) ?? (() => {});
    try {
      const blocking = records?.blocking(id) ?? null;
      if (blocking) throw new ActionError(409, blocking);
      // the list checked above can be 5 s old, and a client may have loaded
      // the model straight through the engine since: ask again
      const known = (await this.deps.sampler.refreshModels()).find(
        (m) => m.id === id,
      );
      if (known?.loaded) throw new ActionError(400, `${id} is loaded`);
      const bytes = known?.bytesOnDisk ?? 0;
      records?.forget(id);
      if (!(await removeModel(root, id))) {
        throw new ActionError(404, `${id} is not in ${root}`);
      }
      this.deps.sampler.markDeleted(id);
      return bytes > 0
        ? `deleted ${(bytes / 1024 ** 3).toFixed(1)} GB`
        : "deleted";
    } finally {
      release();
    }
  }

  // The two below take no lock: they are for run() above and for a caller
  // that already holds the shared lock (the benchmark, whose whole run is
  // one operation; the lock is not reentrant).
  async clearDiskTier(): Promise<number> {
    let removed = 0;
    for (const root of this.deps.engine.cacheDirs()) {
      removed += await this.clearDir(root);
    }
    return removed;
  }

  async restartEngine(): Promise<string> {
    const label = this.deps.engine.serviceLabel();
    if (!label) throw new ActionError(403, "engine is not a launchd service");
    const target = `gui/${this.uid}/${label}`;
    const r = await this.spawn(["launchctl", "kickstart", "-k", target]);
    if (r.code !== 0) {
      throw new Error(
        `launchctl kickstart ${target} exited ${r.code}${r.stderr ? `: ${r.stderr}` : ""}`,
      );
    }
    return `restarted ${label}`;
  }
}
