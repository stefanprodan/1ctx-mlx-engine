// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type BenchmarkError,
  BenchmarkRunner,
  type RunnerDeps,
} from "../../../src/server/benchmark/runner.ts";
import { BenchmarkStore } from "../../../src/server/benchmark/store.ts";
import {
  parseMetrics,
  parseModels,
} from "../../../src/server/engine/mlxserve.ts";
import type { ChatTimings } from "../../../src/server/engine/types.ts";
import { ExclusiveLock } from "../../../src/server/lib/lock.ts";
import type { Log } from "../../../src/server/lib/log.ts";
import type { Sample } from "../../../src/shared/sample.ts";
import metricsFixture from "../../fixtures/metrics.json";
import modelsFixture from "../../fixtures/models.json";

const ORNITH = "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp";

type Chat = {
  messages: { content: string }[];
  tools?: unknown[];
  max_tokens: number;
};

// An engine that counts what it is asked, caches by prefix the way a real
// one does, and can be told to hang or fail on the nth chat request.
function fakeEngine() {
  const calls: string[] = [];
  let served = 0;
  let cached = 0;
  const state = {
    calls,
    hangAt: 0,
    failAt: 0,
    chats: 0,
    extraRequests: 0,
    up: true,
  };
  const engine = {
    id: "mlxserve" as const,
    url: "http://fake:11234",
    health: async () => state.up,
    models: async () => parseModels(modelsFixture),
    metrics: async () => {
      const m = parseMetrics(metricsFixture);
      m.counters.requestsSuccess = served + state.extraRequests;
      m.counters.requestsCancelled = 0;
      return m;
    },
    load: async (id: string, asDefault: boolean) => {
      calls.push(`load ${id} ${asDefault}`);
    },
    unload: async () => {},
    chat: async (body: unknown, signal: AbortSignal): Promise<ChatTimings> => {
      const chat = body as Chat;
      state.chats++;
      calls.push(`chat ${chat.messages.length} ${chat.max_tokens}`);
      if (state.chats === state.failAt) throw new Error("HTTP 500 boom");
      if (state.chats === state.hangAt) {
        await new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("aborted"));
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      served++;
      const promptN = Math.round(
        chat.messages.reduce(
          (n, m) => n + m.content.length,
          JSON.stringify(chat.tools ?? []).length,
        ) / 2.6,
      );
      const timings = {
        promptN,
        cachedN: chat.messages.length > 2 ? cached : 0,
        promptMs: 100,
        predictedN: chat.max_tokens,
        predictedMs: 1000,
        tokenizeMs: 1,
        finishReason: "length",
      };
      cached = promptN;
      return timings;
    },
    tokenize: async (content: string) => {
      calls.push("tokenize");
      return Math.round(content.length / 2.6);
    },
    capabilities: () => new Set(["benchmark" as const]),
    cacheDirs: () => [],
    logFile: () => null,
    processNames: () => [],
    serviceLabel: () => "com.fake.engine",
  };
  return { engine, state, restarted: () => (served = 0) };
}

function setup(over: Partial<RunnerDeps> = {}) {
  const fake = fakeEngine();
  const lock = new ExclusiveLock();
  const store = new BenchmarkStore(new Database(":memory:"));
  const lines: string[] = [];
  const log: Log = Object.assign((l: string) => void lines.push(l), {
    warn: (l: string) => void lines.push(l),
    error: (l: string) => void lines.push(l),
  });
  const samples = new Set<(s: Sample) => void>();
  let n = 0;
  const runner = new BenchmarkRunner({
    engine: fake.engine,
    store,
    lock,
    sampler: {
      onSample: (fn) => {
        samples.add(fn);
        return () => samples.delete(fn);
      },
      currentModels: () => parseModels(modelsFixture),
      refreshModels: async () => parseModels(modelsFixture),
    },
    prepare: {
      restart: async () => {
        fake.state.calls.push("restart");
        fake.restarted();
      },
      clearDisk: async () => void fake.state.calls.push("clearDisk"),
    },
    refusal: () => null,
    facts: () => ({
      appVersion: "v0.0.0-dev",
      engineVersion: "26.9.5",
      engineArgs: ["--serve"],
      chip: "Apple M2 Max",
      memoryBytes: 96 * 2 ** 30,
      os: "26.6",
    }),
    log,
    sleep: async () => {},
    tag: () => `tag-${++n}`,
    repetitions: 2,
    ...over,
  });
  const sample = (footprint: number, active: number) => {
    for (const fn of samples) {
      fn({ mem: { procFootprint: footprint, mlxActive: active } } as Sample);
    }
  };
  return { ...fake, lock, store, runner, lines, sample, samples };
}

const body = { model: ORNITH, preset: "short" };

test("a run prepares every repetition on its own, in order", async () => {
  const t = setup();
  const started = t.runner.start(body);
  expect(started.status).toBe("running");
  expect(t.lock.running()).toBe("benchmark");
  expect(t.runner.active()?.benchmark.id).toBe(started.id);
  t.sample(5e9, 4e9);
  await t.runner.idle();

  const rep = [
    "restart",
    "clearDisk",
    `load ${ORNITH} true`,
    "chat 1 16",
    "chat 2 256",
    "chat 4 256",
    "chat 6 256",
    "chat 8 256",
  ];
  // the fit first: a load, then the tokenizer on the system prompt, the
  // tool schemas and the three results; no chat request, nothing cached
  expect(t.state.calls).toEqual([
    `load ${ORNITH} true`,
    ...new Array(5).fill("tokenize"),
    ...rep,
    ...rep,
  ]);
  expect(t.lock.running()).toBeNull();
  expect(t.runner.active()).toBeNull();

  const { benchmark, turns } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("done");
  expect(benchmark.phase).toBe("finish");
  expect(benchmark.suspect).toEqual([]);
  expect(turns).toHaveLength(8);
  expect(benchmark.summary?.decodeTps.median).toBe(256);
  expect(benchmark.summary?.cachePct.median).toBeGreaterThan(50);
  expect(benchmark.firstPromptTokens).toBeGreaterThan(9_800);
  expect(benchmark.firstPromptTokens).toBeLessThan(10_200);
  expect(benchmark.peakMemoryBytes).toBe(5e9);
  expect(benchmark.peakActiveBytes).toBe(4e9);
  expect(benchmark.scriptHash).toMatch(/^[0-9a-f]{16}$/);
  expect(t.samples.size).toBe(0);
});

test("a start is refused with the status the route answers", async () => {
  const t = setup({ refusal: () => "The engine is not managed" });
  const status = (b: unknown) => {
    try {
      t.runner.start(b);
    } catch (err) {
      return (err as BenchmarkError).status;
    }
  };
  expect(status({ model: "", preset: "short" })).toBe(400);
  expect(status({ model: ORNITH, preset: "ladder" })).toBe(400);
  expect(status(body)).toBe(403);
  expect(t.store.list()).toEqual([]);

  const free = setup();
  expect(() =>
    free.runner.start({ model: "no/such", preset: "short" }),
  ).toThrow("unknown model");
  // an action holds the shared lock
  let release = () => {};
  const held = free.lock.run(
    "load",
    () => new Promise<void>((r) => (release = r)),
  );
  expect(() => free.runner.start(body)).toThrow("load is still running");
  release();
  await held;
  // and a run holds it against a second one
  free.state.hangAt = 1;
  const first = free.runner.start(body);
  expect(() => free.runner.start(body)).toThrow("benchmark is still running");
  expect(() => free.runner.remove(first.id)).toThrow("still running");
  free.runner.cancel(first.id);
  await free.runner.idle();
});

test("cancel aborts the request in flight and keeps what was measured", async () => {
  const t = setup();
  // the warmup, two turns, then the third hangs
  t.state.hangAt = 4;
  const started = t.runner.start(body);
  while (t.state.chats < 4) await Bun.sleep(1);
  t.runner.cancel(started.id);
  await t.runner.idle();
  const { benchmark, turns } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("cancelled");
  expect(benchmark.phase).toBe("turns");
  expect(turns).toHaveLength(2);
  expect(benchmark.summary?.coldPrefillTps.median).not.toBeNull();
  expect(t.lock.running()).toBeNull();
  expect(() => t.runner.cancel(started.id)).toThrow("not running");
});

test("a failed turn fails the run and says where", async () => {
  const t = setup();
  t.state.failAt = 3;
  const started = t.runner.start(body);
  await t.runner.idle();
  const { benchmark } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("failed");
  expect(benchmark.error).toBe("HTTP 500 boom");
  expect(benchmark.phase).toBe("turns");
  expect(t.lock.running()).toBeNull();
});

test("an engine that stays down after the restart fails the run", async () => {
  let now = 0;
  const holder: { state?: { up: boolean } } = {};
  const t = setup({
    now: () => (now += 10_000),
    prepare: {
      restart: async () => {
        holder.state!.up = false;
      },
      clearDisk: async () => {},
    },
  });
  holder.state = t.state;
  const started = t.runner.start(body);
  await t.runner.idle();
  const { benchmark } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("failed");
  expect(benchmark.error).toContain("did not come back");
  expect(benchmark.phase).toBe("prepare");
});

test("requests from somebody else make the run suspect", async () => {
  const t = setup();
  const started = t.runner.start(body);
  t.state.extraRequests = 0;
  const stop = t.runner.onProgress((p) => {
    if (p.turn === 2) t.state.extraRequests = 1;
  });
  await t.runner.idle();
  stop();
  const { benchmark } = t.runner.detail(started.id);
  expect(benchmark.suspect).toEqual(["other requests ran"]);
});

test("a run left running by a dead process is interrupted at start", () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const store = new BenchmarkStore(db);
  const t = setup();
  const left = store.create({
    ...t.runner.start(body),
    status: "running",
  });
  t.runner.cancel(t.runner.active()!.benchmark.id);
  store.addTurn(left.id, {
    repetition: 1,
    turn: 1,
    promptN: 1,
    cachedN: 0,
    promptMs: 1,
    predictedN: 1,
    predictedMs: 1,
    tokenizeMs: 0,
    finishReason: "length",
  });
  expect(store.interruptRunning(42)).toBe(1);
  expect(store.get(left.id)?.status).toBe("interrupted");
  expect(store.get(left.id)?.finishedAt).toBe(42);
  expect(store.interruptRunning(43)).toBe(0);
  // the turns go with the run
  expect(store.remove(left.id)).toBe(true);
  expect(store.turns(left.id)).toEqual([]);
  expect(store.remove(left.id)).toBe(false);
});
