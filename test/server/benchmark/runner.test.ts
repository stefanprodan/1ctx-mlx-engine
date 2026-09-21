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
import type { ChatAnswer } from "../../../src/server/engine/types.ts";
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
    serving: 0,
    up: true,
    // what the model writes on every turn, and the tool calls it makes
    output: "I will read the manifest next and check the image tag.",
    tools: "",
    onClear: () => {},
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
      m.gauges.requestsRunning = state.serving;
      m.gauges.requestsWaiting = 0;
      return m;
    },
    load: async (id: string, asDefault: boolean) => {
      calls.push(`load ${id} ${asDefault}`);
    },
    unload: async () => {},
    chat: async (body: unknown, signal: AbortSignal): Promise<ChatAnswer> => {
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
      return { timings, prose: state.output, tools: state.tools };
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
      clearDisk: async () => {
        fake.state.calls.push("clearDisk");
        fake.state.onClear();
      },
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

const body = { model: ORNITH, preset: "20K" };

test("a run prepares every repetition on its own, in order", async () => {
  const t = setup();
  const started = t.runner.start(body);
  expect(started.status).toBe("running");
  expect(t.lock.running()).toBe("benchmark");
  expect(t.runner.active()?.benchmark.id).toBe(started.id);
  // what was resident before the first restart is not the run's peak
  t.sample(9e9, 9e9);
  t.state.onClear = () => t.sample(5e9, 4e9);
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
    "chat 10 256",
  ];
  // the fit first: a load, then the tokenizer on the system prompt, the
  // tool schemas and the four results; no chat request, nothing cached
  expect(t.state.calls).toEqual([
    `load ${ORNITH} true`,
    ...new Array(6).fill("tokenize"),
    ...rep,
    ...rep,
  ]);
  expect(t.lock.running()).toBeNull();
  expect(t.runner.active()).toBeNull();

  const { benchmark, turns } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("done");
  expect(benchmark.phase).toBe("finish");
  expect(benchmark.suspect).toEqual([]);
  expect(turns).toHaveLength(10);
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
  expect(status({ model: "", preset: "20K" })).toBe(400);
  expect(status({ model: ORNITH, preset: "ladder" })).toBe(400);
  expect(status(body)).toBe(403);
  expect(t.store.list()).toEqual([]);

  const free = setup();
  expect(() => free.runner.start({ model: "no/such", preset: "20K" })).toThrow(
    "unknown model",
  );
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

test("a model that loops makes the run suspect, once, and says where", async () => {
  const t = setup();
  // a working model at full speed, but the same words over and over
  t.state.output = "the image tag is wrong. ".repeat(60);
  const started = t.runner.start(body);
  await t.runner.idle();
  const { benchmark, turns } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("done");
  expect(benchmark.suspect).toEqual(["output looks broken"]);
  // the figures stand: the engine did its work
  expect(benchmark.summary?.decodeTps.median).not.toBeNull();
  const flagged = t.lines.filter((l) => l.includes("output looks broken"));
  expect(flagged).toEqual([
    `benchmark ${body.model} (${body.preset}): turn 1.1 output looks broken`,
  ]);
  // the text is read, never kept
  expect(JSON.stringify(turns)).not.toContain("image tag");
});

test("a model that answers in Chinese makes the run suspect", async () => {
  const t = setup();
  t.state.output = "我将读取清单并检查镜像标签，然后记录每一步。";
  const started = t.runner.start(body);
  await t.runner.idle();
  const { benchmark } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("done");
  expect(benchmark.suspect).toEqual(["did not answer in English"]);
  expect(t.lines.filter((l) => l.includes("in English"))).toEqual([
    `benchmark ${body.model} (${body.preset}): turn 1.1 did not answer in English`,
  ]);
});

test("a tool call's arguments are data, not the answer's language", async () => {
  const t = setup();
  t.state.tools = 'read {"path":"docs/部署指南.md","note":"部署 配置 镜像"}';
  const started = t.runner.start(body);
  await t.runner.idle();
  expect(t.runner.detail(started.id).benchmark.suspect).toEqual([]);
});

test("the session asks for English", async () => {
  const t = setup();
  let system = "";
  const chat = t.engine.chat;
  t.engine.chat = async (b: unknown, signal: AbortSignal) => {
    // the warmup is one user message; a turn opens with the system prompt
    const { messages } = b as Chat;
    if (messages.length > 1) system = messages[0]!.content;
    return chat(b, signal);
  };
  t.runner.start(body);
  await t.runner.idle();
  expect(system).toContain("Respond only in English.");
});

test("a request that began after the route's check fails the run before any restart", async () => {
  const t = setup();
  t.state.serving = 1;
  const started = t.runner.start(body);
  await t.runner.idle();
  const { benchmark } = t.runner.detail(started.id);
  expect(benchmark.status).toBe("failed");
  expect(benchmark.error).toBe("The engine is serving a request");
  expect(t.state.calls).toEqual([]);
  expect(t.lock.running()).toBeNull();
});

test("a request during the warmup makes the run suspect too", async () => {
  const t = setup();
  const started = t.runner.start(body);
  const stop = t.runner.onProgress((p) => {
    if (p.benchmark.phase === "warmup") t.state.extraRequests = 1;
  });
  await t.runner.idle();
  stop();
  expect(t.runner.detail(started.id).benchmark.suspect).toEqual([
    "other requests ran",
  ]);
});

test("a final write that fails still ends the run in memory", async () => {
  const t = setup();
  const finish = t.store.finish.bind(t.store);
  let broken = true;
  t.store.finish = (b) => {
    if (broken) throw new Error("disk full");
    return finish(b);
  };
  t.runner.start(body);
  await t.runner.idle();
  expect(t.runner.active()).toBeNull();
  expect(t.lock.running()).toBeNull();
  broken = false;
  expect(t.runner.start(body).status).toBe("running");
  await t.runner.idle();
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
  // a reason an older build stored and this one no longer has is dropped
  store.save({
    ...store.get(left.id)!,
    suspect: ["turn ended early", "cache did not hold"] as never,
  });
  expect(store.get(left.id)?.suspect).toEqual(["cache did not hold"]);
  expect(store.list()[0]?.suspect).toEqual(["cache did not hold"]);
  // the turns go with the run
  expect(store.remove(left.id)).toBe(true);
  expect(store.turns(left.id)).toEqual([]);
  expect(store.remove(left.id)).toBe(false);
});
