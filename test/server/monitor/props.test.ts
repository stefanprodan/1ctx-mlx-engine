// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Engine, EngineProps } from "../../../src/server/engine/types.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { History } from "../../../src/server/monitor/history.ts";
import { EngineFacts } from "../../../src/server/monitor/props.ts";
import type { ModelInfo } from "../../../src/shared/models.ts";

const model = (id: string, loaded = true): ModelInfo => ({
  id,
  loaded,
  state: loaded ? "ready" : "unloaded",
  bytesResident: 0,
  bytesOnDisk: 0,
  contextLength: 8192,
  quantization: null,
  capabilities: ["chat"],
});

const answer = (version: string, context: number): EngineProps => ({
  version,
  limits: { hotBytes: 1, diskBytes: 2 },
  runtime: { context, safeContext: context },
});

// an engine whose /props answers wait for the test to release them, one
// pending call at a time, so a scan can be caught in flight
function gatedEngine() {
  const calls: { model: string; resolve: (p: EngineProps | null) => void }[] =
    [];
  const engine = {
    props: (model: string) =>
      new Promise<EngineProps | null>((resolve) =>
        calls.push({ model, resolve }),
      ),
  } as unknown as Engine;
  // let the scan reach its next await
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { engine, calls, tick };
}

describe("EngineFacts", () => {
  test("a list that arrives mid-scan is read next, the latest one", async () => {
    const { engine, calls, tick } = gatedEngine();
    const history = new History(":memory:");
    const facts = new EngineFacts(engine, history, silent);
    let done = 0;
    facts.read([model("a/x")], () => done++);
    await tick();
    // two lists while the first scan waits: only the last is read
    facts.read([model("a/x"), model("b/y")], () => done++);
    facts.read([model("b/y")], () => done++);
    calls[0]!.resolve(answer("26.9.6", 100));
    await tick();
    await tick();
    expect(calls.map((c) => c.model)).toEqual(["a/x", "b/y"]);
    calls[1]!.resolve(answer("26.9.6", 200));
    await facts.settle();
    expect(done).toBe(2);
    // the second scan's list no longer has a/x
    expect(facts.runtimeOf("a/x")).toBeNull();
    expect(facts.runtimeOf("b/y")?.context).toBe(200);
    history.close();
  });

  test("a scan of a process that restarted publishes nothing", async () => {
    const { engine, calls, tick } = gatedEngine();
    const history = new History(":memory:");
    const facts = new EngineFacts(engine, history, silent);
    facts.read([model("a/x")], () => {});
    await tick();
    facts.forgetModels(); // the engine went away while the scan waited
    calls[0]!.resolve(answer("26.9.5", 100));
    await facts.settle();
    expect(facts.runtimeOf("a/x")).toBeNull();
    expect(facts.currentVersion()).toBeNull();
    expect(history.loadEngineProps()).toBeNull();
    history.close();
  });

  test("a read that fails keeps the model's last runtime", async () => {
    const { engine, calls, tick } = gatedEngine();
    const history = new History(":memory:");
    const facts = new EngineFacts(engine, history, silent);
    facts.read([model("a/x")], () => {});
    await tick();
    calls[0]!.resolve(answer("26.9.6", 100));
    await facts.settle();
    facts.read([model("a/x")], () => {});
    await tick();
    calls[1]!.resolve(null);
    await facts.settle();
    expect(facts.runtimeOf("a/x")?.context).toBe(100);
    // unloaded since: the runtime goes, whatever the engine said last
    facts.read([model("a/x", false)], () => {});
    await facts.settle();
    expect(facts.runtimeOf("a/x")).toBeNull();
    history.close();
  });
});
