// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the engine states about its own process and its resident models
// through GET /props: the build and the cache budgets, which no other
// endpoint states and the only source of either for a remote engine, and
// each resident model's runtime (the window it serves, the context that
// fits in memory now). Since mlx-serve 26.9.6 /props is a status read: it
// loads nothing and does not stamp the model as used, so it is polled with
// the model list. Every read names a resident model, which is the only way
// the answer carries the build and the budgets.

import {
  type CacheLimits,
  type ModelInfo,
  type ModelRuntime,
  modelKind,
} from "../../shared/models.ts";
import type { Engine, EngineProps } from "../engine/types.ts";
import type { Log } from "../lib/log.ts";
import type { History } from "./history.ts";

export class EngineFacts {
  // seeded from the database, so an engine that comes back with nothing
  // loaded still shows its last known build and budgets
  private version: string | null;
  private limits: CacheLimits | null;
  private runtime = new Map<string, ModelRuntime>();
  private scan: Promise<void> | null = null;
  // a list that arrived while a scan ran: read once that one is done, so
  // the newest list is never skipped
  private next: { models: readonly ModelInfo[]; done: () => void } | null =
    null;
  // bumped when the engine goes away or restarts: a scan of the old
  // process must not publish what it read into the new one
  private process = 0;

  constructor(
    private readonly engine: Engine,
    private readonly history: History,
    private readonly log: Log,
  ) {
    const stored = history.loadEngineProps();
    this.version = stored?.version ?? null;
    this.limits = stored?.limits ?? null;
  }

  currentVersion(): string | null {
    return this.version;
  }

  currentLimits(): CacheLimits | null {
    return this.limits;
  }

  runtimeOf(id: string): ModelRuntime | null {
    return this.runtime.get(id) ?? null;
  }

  // the engine went away or restarted: what it said of its models is gone,
  // and a scan still reading the old process is dropped when it ends
  forgetModels() {
    this.process++;
    this.runtime.clear();
    this.next = null;
  }

  // One read per resident model, in turn, off the tick's path. A list that
  // arrives while a scan runs waits for it, the latest one wins. A read
  // that fails keeps the model's last runtime; a model no longer resident
  // loses it. `done` runs when the new runtimes are in place.
  read(models: readonly ModelInfo[], done: () => void) {
    if (!this.engine.props) return;
    if (this.scan) {
      this.next = { models, done };
      return;
    }
    const process = this.process;
    const resident = models.filter((m) => m.loaded && m.state === "ready");
    this.scan = (async () => {
      const runtime = new Map<string, ModelRuntime>();
      for (const m of resident) {
        const p = await this.engine.props!(m.id).catch(() => null);
        if (process !== this.process) return;
        const known = this.runtime.get(m.id);
        if (!p) {
          if (known) runtime.set(m.id, known);
          continue;
        }
        this.note(p);
        // a decision model's runtime is the engine's generic stub
        if (p.runtime && modelKind(m.capabilities) !== "decision") {
          runtime.set(m.id, p.runtime);
        } else if (known) {
          runtime.set(m.id, known);
        }
      }
      this.runtime = runtime;
      done();
    })()
      .catch(() => {})
      .finally(() => {
        this.scan = null;
        const next = this.next;
        this.next = null;
        if (next) this.read(next.models, next.done);
      });
  }

  // the scan in flight and the one queued behind it
  async settle(): Promise<void> {
    while (this.scan) await this.scan;
  }

  // The build and the budgets, kept when an answer states them and stored
  // when they change: they outlive this engine process, so the next start
  // has something to show before a model is resident again.
  private note(p: EngineProps) {
    const version = p.version ?? this.version;
    const limits = p.limits ?? this.limits;
    const same =
      version === this.version &&
      limits?.hotBytes === this.limits?.hotBytes &&
      limits?.diskBytes === this.limits?.diskBytes;
    if (same) return;
    if (version && version !== this.version) {
      this.log.info("engine version", { version });
    }
    this.version = version;
    this.limits = limits;
    this.history.saveEngineProps({ version, limits });
  }
}
