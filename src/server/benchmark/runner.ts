// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One benchmark run: the whole of it is one operation under the lock the
// actions and the engine manager share, so nothing loads a model or swaps
// the engine under a measurement. It starts from a button, only on a local
// engine this program manages, and it is the one caller of the engine's
// chat endpoint.
//
// Every repetition is prepared on its own (restart, empty disk tier, load,
// a discarded warmup), so the repetitions are independent trials: a hot
// cache that still held the previous repetition would put the later ones
// under a different memory pressure.

import type {
  Benchmark,
  BenchmarkDetail,
  BenchmarkPhase,
  BenchmarkProgress,
  BenchmarkStartBody,
  BenchmarkTurn,
} from "../../shared/benchmark.ts";
import { isBenchmarkPreset } from "../../shared/benchmark.ts";
import type { ModelInfo } from "../../shared/models.ts";
import type { Sample } from "../../shared/sample.ts";
import type { Engine } from "../engine/types.ts";
import type { ExclusiveLock } from "../lib/lock.ts";
import type { Log } from "../lib/log.ts";
import { scriptHash } from "./hash.ts";
import { looksBroken, notEnglish } from "./output.ts";
import {
  buildSession,
  piecesOf,
  ratiosOf,
  requestFor,
  targetsOf,
  turnsOf,
} from "./script.ts";
import { summarize, suspects } from "./stats.ts";
import type { BenchmarkStore } from "./store.ts";

// bump when the stored run changes meaning
const SCHEMA = 1;
const REPETITIONS = 3;
const MAX_TOKENS = 256;
const HEALTH_WAIT_MS = 60_000;
const HEALTH_POLL_MS = 500;

export const LOCK_LABEL = "benchmark";

// carries the HTTP status the route should answer with
export class BenchmarkError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RunFacts = Pick<
  Benchmark,
  "appVersion" | "engineVersion" | "engineArgs" | "chip" | "memoryBytes" | "os"
>;

export type RunnerDeps = {
  engine: Engine;
  store: BenchmarkStore;
  lock: ExclusiveLock;
  sampler: {
    onSample(fn: (s: Sample) => void): () => void;
    currentModels(): ModelInfo[];
    refreshModels(): Promise<ModelInfo[]>;
  };
  // the unlocked halves of diskClear, shared with the actions
  prepare: {
    restart(): Promise<unknown>;
    clearDisk(): Promise<unknown>;
  };
  // why a run may not start now (not local, not managed, a download is
  // running), null when it may; the server's check, not the page's
  refusal(): string | null;
  facts(): RunFacts;
  log: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tag?: () => string;
  repetitions?: number;
  maxTokens?: number;
};

class Cancelled extends Error {}

export class BenchmarkRunner {
  private progress: BenchmarkProgress | null = null;
  private controller: AbortController | null = null;
  private settled: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(p: BenchmarkProgress) => void>();
  private readonly removals = new Set<(id: number) => void>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tag: () => string;
  private readonly repetitions: number;
  private readonly maxTokens: number;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
    this.tag = deps.tag ?? (() => crypto.randomUUID());
    this.repetitions = deps.repetitions ?? REPETITIONS;
    this.maxTokens = deps.maxTokens ?? MAX_TOKENS;
    const n = deps.store.interruptRunning(this.now());
    if (n > 0) deps.log(`benchmark: ${n} unfinished run marked interrupted`);
  }

  onProgress(fn: (p: BenchmarkProgress) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // a run deleted, so that every tab reads the list again, not only the one
  // that deleted it
  onRemove(fn: (id: number) => void): () => void {
    this.removals.add(fn);
    return () => this.removals.delete(fn);
  }

  active(): BenchmarkProgress | null {
    return this.progress;
  }

  // resolves when the run in progress, if any, has ended; for tests
  idle(): Promise<void> {
    return this.settled;
  }

  list(): Benchmark[] {
    return this.deps.store.list();
  }

  detail(id: number): BenchmarkDetail {
    const benchmark = this.deps.store.get(id);
    if (!benchmark) throw new BenchmarkError(404, "Benchmark not found");
    return { benchmark, turns: this.deps.store.turns(id) };
  }

  remove(id: number) {
    if (this.progress?.benchmark.id === id) {
      throw new BenchmarkError(409, "The benchmark is still running");
    }
    if (!this.deps.store.remove(id)) {
      throw new BenchmarkError(404, "Benchmark not found");
    }
    for (const fn of this.removals) fn(id);
  }

  cancel(id: number) {
    if (this.progress?.benchmark.id !== id || !this.controller) {
      throw new BenchmarkError(409, "The benchmark is not running");
    }
    this.controller.abort();
  }

  start(body: unknown): Benchmark {
    const { model, preset } = (body ?? {}) as Partial<BenchmarkStartBody>;
    if (typeof model !== "string" || model === "") {
      throw new BenchmarkError(400, "A benchmark needs a model id");
    }
    if (!isBenchmarkPreset(preset)) {
      throw new BenchmarkError(400, "Unknown preset");
    }
    if (!this.deps.engine.chat || !this.deps.engine.tokenize) {
      throw new BenchmarkError(403, `${this.deps.engine.id} cannot benchmark`);
    }
    const refusal = this.deps.refusal();
    if (refusal) throw new BenchmarkError(403, refusal);
    const known = this.deps.sampler.currentModels().find((m) => m.id === model);
    if (!known) throw new BenchmarkError(400, `unknown model: ${model}`);
    const holder = this.deps.lock.running();
    if (holder !== null) {
      throw new BenchmarkError(409, `${holder} is still running`);
    }
    // a run whose last write failed has let the lock go and is still here
    if (this.progress !== null) {
      throw new BenchmarkError(409, `${LOCK_LABEL} is still running`);
    }
    const benchmark = this.deps.store.create({
      status: "running",
      phase: "fit",
      error: null,
      model,
      quantization: known.quantization,
      preset,
      turns: turnsOf(preset),
      repetitions: this.repetitions,
      maxTokens: this.maxTokens,
      schema: SCHEMA,
      scriptHash: scriptHash(preset, known.contextLength, this.maxTokens),
      firstPromptTokens: null,
      ...this.deps.facts(),
      summary: null,
      suspect: [],
      peakMemoryBytes: null,
      peakActiveBytes: null,
      startedAt: this.now(),
      finishedAt: null,
    });
    this.progress = { benchmark, repetition: 0, turn: 0, done: [] };
    this.controller = new AbortController();
    // the lock is taken before this returns: run() sets its holder
    // synchronously, so a second start or an action sees it at once
    this.settled = this.deps.lock
      .run(LOCK_LABEL, () => this.run(known.contextLength))
      .catch((err) => this.deps.log(`benchmark: ${describe(err)}`));
    // every tab shows the run and turns its buttons off before the fit ends
    this.publish(this.progress);
    return benchmark;
  }

  private async run(window: number | null) {
    const progress = this.progress!;
    const signal = this.controller!.signal;
    const { model, preset } = progress.benchmark;
    let peakMemory = 0;
    let peakActive = 0;
    // from the first restart on: what was resident before is not the run's
    let watching = false;
    const stopWatching = this.deps.sampler.onSample((s) => {
      if (!watching) return;
      peakMemory = Math.max(peakMemory, s.mem.procFootprint);
      peakActive = Math.max(peakActive, s.mem.mlxActive);
    });
    let otherRequests = false;
    let brokenOutput = false;
    let foreignOutput = false;
    const target = targetsOf(preset, window, this.maxTokens).first;
    this.deps.log(`benchmark ${model} (${preset}): started`);
    try {
      // The route's idle check reads the sampler's last second; a request
      // that began since would die in the restart below.
      if (await this.serving())
        throw new Error("The engine is serving a request");
      // The fit: the generated pieces tokenize differently (a JSON
      // inventory worse than a YAML list) and every tokenizer differs, so
      // each piece of a draft session is counted by the model's own
      // tokenizer and sized to its target. No prefill, nothing cached. The
      // tokenizer is the default model's, hence the load.
      await this.deps.engine.load(model, true);
      const draft = buildSession({
        preset,
        tag: "",
        ratios: null,
        window,
        maxTokens: this.maxTokens,
      });
      const counts: number[] = [];
      for (const piece of piecesOf(draft)) {
        if (signal.aborted) throw new Cancelled();
        counts.push(await this.deps.engine.tokenize!(piece, signal));
      }
      const ratios = ratiosOf(draft, counts);

      for (let rep = 1; rep <= this.repetitions; rep++) {
        this.step(progress, "prepare", rep, 0);
        await this.deps.prepare.restart();
        await this.healthy(signal);
        watching = true;
        // a fresh process: anything past the warmup and the turns is not ours
        const before = await this.requestCount();
        await this.deps.prepare.clearDisk();
        await this.deps.engine.load(model, true);
        await this.deps.sampler.refreshModels();

        // the first request of a process pays for the Metal compile
        this.step(progress, "warmup", rep, 0);
        await this.chat(
          {
            model,
            messages: [{ role: "user", content: "Say ready." }],
            max_tokens: 16,
            enable_thinking: false,
            stream: false,
          },
          signal,
        );

        const session = buildSession({
          preset,
          tag: this.tag(),
          ratios,
          window,
          maxTokens: this.maxTokens,
        });
        for (let turn = 1; turn <= progress.benchmark.turns; turn++) {
          this.step(progress, "turns", rep, turn);
          const { timings, prose, tools } = await this.chat(
            requestFor(session, turn, model, this.maxTokens),
            signal,
          );
          // the text is read here and dropped: a run keeps timings only
          const where = `benchmark ${model} (${preset}): turn ${rep}.${turn}`;
          const output = [prose, tools].filter((s) => s !== "").join("\n");
          if (!brokenOutput && looksBroken(output, timings.predictedN)) {
            brokenOutput = true;
            this.deps.log(`${where} output looks broken`);
          }
          // the language is the prose's: a tool call's arguments are data
          if (!foreignOutput && notEnglish(prose)) {
            foreignOutput = true;
            this.deps.log(`${where} did not answer in English`);
          }
          const measured: BenchmarkTurn = { ...timings, repetition: rep, turn };
          this.deps.store.addTurn(progress.benchmark.id, measured);
          progress.done.push(measured);
          if (rep === 1 && turn === 1) {
            progress.benchmark.firstPromptTokens = timings.promptN;
          }
          this.publish(progress);
        }
        const served = (await this.requestCount()) - before;
        const own = progress.benchmark.turns + 1;
        // fewer means the counters went back: the engine restarted under us
        if (served < own) {
          throw new Error("the engine restarted during the run");
        }
        // the counters only: the running gauge drops a moment after the
        // engine has answered, so it reads 1 right after our own last turn
        if (served > own) otherRequests = true;
      }
      this.end(progress, "done", null);
    } catch (err) {
      if (signal.aborted || err instanceof Cancelled) {
        this.end(progress, "cancelled", null);
      } else {
        this.end(progress, "failed", describe(err));
      }
    } finally {
      stopWatching();
      const b = progress.benchmark;
      b.summary = progress.done.length > 0 ? summarize(progress.done) : null;
      b.suspect =
        b.status === "done"
          ? suspects(progress.done, {
              firstTarget: target,
              otherRequests,
              brokenOutput,
              foreignOutput,
              maxTokens: this.maxTokens,
            })
          : [];
      b.peakMemoryBytes = peakMemory > 0 ? peakMemory : null;
      b.peakActiveBytes = peakActive > 0 ? peakActive : null;
      // a write that fails must not leave a run that never ends in memory
      try {
        this.deps.store.finish(b);
        this.deps.log(
          `benchmark ${model} (${preset}): ${b.status}` +
            (b.error ? ` (${b.error})` : ""),
        );
      } finally {
        this.progress = null;
        this.controller = null;
        await this.deps.sampler.refreshModels().catch(() => {});
        this.publish(progress);
      }
    }
  }

  private async chat(body: unknown, signal: AbortSignal) {
    if (signal.aborted) throw new Cancelled();
    return this.deps.engine.chat!(body, signal);
  }

  private async serving(): Promise<boolean> {
    const { gauges } = await this.deps.engine.metrics();
    return gauges.requestsRunning + gauges.requestsWaiting > 0;
  }

  private async requestCount(): Promise<number> {
    const { counters } = await this.deps.engine.metrics();
    return counters.requestsSuccess + counters.requestsCancelled;
  }

  // kickstart returns before the new process listens
  private async healthy(signal: AbortSignal) {
    const deadline = this.now() + HEALTH_WAIT_MS;
    for (;;) {
      if (signal.aborted) throw new Cancelled();
      if (await this.deps.engine.health()) return;
      if (this.now() >= deadline) {
        throw new Error("the engine did not come back after the restart");
      }
      await this.sleep(HEALTH_POLL_MS);
    }
  }

  private step(
    progress: BenchmarkProgress,
    phase: BenchmarkPhase,
    repetition: number,
    turn: number,
  ) {
    progress.benchmark.phase = phase;
    progress.repetition = repetition;
    progress.turn = turn;
    this.deps.store.save(progress.benchmark);
    this.publish(progress);
  }

  // the phase stays where the run ended
  private end(
    progress: BenchmarkProgress,
    status: Benchmark["status"],
    error: string | null,
  ) {
    const b = progress.benchmark;
    b.status = status;
    b.error = error;
    if (status === "done") b.phase = "finish";
    b.finishedAt = this.now();
  }

  private publish(progress: BenchmarkProgress) {
    for (const fn of this.listeners) fn(progress);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
