// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyEngine,
  engineMode,
  followsInPlace,
  landsOnEngine,
  modelsKeyOf,
  pageOf,
  refreshSnapshot,
  replaced,
  updates,
} from "../../src/client/store.ts";
import type { EnginePageState } from "../../src/shared/engine.ts";
import type { ModelInfo } from "../../src/shared/models.ts";
import type { Snapshot } from "../../src/shared/socket.ts";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "org/model",
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 2,
  contextLength: 4096,
  quantization: null,
  capabilities: ["chat"],
  ...over,
});

describe("store", () => {
  test("a plain left click follows in place, a modified one does not", () => {
    const click = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(followsInPlace(click)).toBe(true);
    expect(followsInPlace({ ...click, button: 1 })).toBe(false);
    expect(followsInPlace({ ...click, metaKey: true })).toBe(false);
    expect(followsInPlace({ ...click, ctrlKey: true })).toBe(false);
    expect(followsInPlace({ ...click, shiftKey: true })).toBe(false);
    expect(followsInPlace({ ...click, altKey: true })).toBe(false);
  });

  test("pageOf names the view from the path", () => {
    expect(pageOf("/")).toBe("monitor");
    expect(pageOf("/requests")).toBe("requests");
    expect(pageOf("/models")).toBe("models");
    expect(pageOf("/server")).toBe("server");
    expect(pageOf("/engine")).toBe("monitor");
    expect(pageOf("/benchmark")).toBe("run");
    expect(pageOf("/benchmark/scorecard")).toBe("scorecard");
    expect(pageOf("/requests/")).toBe("monitor");
  });

  test("only a landing on a bare host goes to the Engine page", () => {
    const origin = "http://host:11235";
    expect(landsOnEngine("/", "", origin, "absent")).toBeTrue();
    expect(
      landsOnEngine("/", "https://github.com/", origin, "absent"),
    ).toBeTrue();
    // a click on Monitor in the nav stays on the Monitor
    expect(
      landsOnEngine("/", `${origin}/engine`, origin, "absent"),
    ).toBeFalse();
    expect(landsOnEngine("/requests", "", origin, "absent")).toBeFalse();
    expect(landsOnEngine("/", "", origin, "managed")).toBeFalse();
    expect(landsOnEngine("/", "", origin, "unmanaged")).toBeFalse();
    expect(landsOnEngine("/", "", origin, null)).toBeFalse();
  });

  test("a page reloads only when a compiled server was replaced", () => {
    expect(replaced("1789915000", "1789916000")).toBeTrue();
    expect(replaced("1789915000", "1789915000")).toBeFalse();
    // from source there is no build id: Bun's dev server reloads instead
    expect(replaced(null, null)).toBeFalse();
    expect(replaced(null, "1789916000")).toBeFalse();
    expect(replaced("1789915000", null)).toBeFalse();
    expect(replaced(undefined, "1789916000")).toBeFalse();
  });

  test("the models key changes only with the residency picture", () => {
    const a = modelsKeyOf([model()]);
    expect(modelsKeyOf([model({ contextLength: 8192 })])).toBe(a);
    expect(modelsKeyOf([model({ state: "loading" })])).not.toBe(a);
    expect(modelsKeyOf([model({ bytesResident: 0 })])).not.toBe(a);
    expect(modelsKeyOf([model({ favorite: true })])).not.toBe(a);
    expect(modelsKeyOf([model(), model({ id: "org/other" })])).not.toBe(a);
    expect(modelsKeyOf([])).toBe("");
  });
});

describe("the engine push and a snapshot in flight", () => {
  const snap = (engine: string | null) =>
    ({
      engine: { mode: "managed" },
      updates: { engine, self: null },
      models: [],
      downloads: [],
      running: null,
      benchmark: null,
    }) as unknown as Snapshot;
  const push = (offered: string | null) =>
    ({
      engine: {
        mode: "managed",
        operation: null,
        failure: null,
        offered: offered ? { version: offered } : null,
      },
      self: { offered: null },
    }) as unknown as EnginePageState;

  test("a snapshot sent before a push does not undo it", async () => {
    const real = globalThis.fetch;
    let answer: (body: Snapshot) => void = () => {};
    globalThis.fetch = (() =>
      Promise.resolve({
        json: () => new Promise<Snapshot>((r) => (answer = r)),
      })) as unknown as typeof fetch;
    try {
      // the offer is there, a snapshot leaves, then the upgrade starts
      const pending = refreshSnapshot();
      await Promise.resolve();
      applyEngine(push(null));
      expect(updates.value?.engine).toBeNull();
      answer(snap("26.9.5"));
      await pending;
      expect(updates.value?.engine).toBeNull();
      // a snapshot sent after the push is the newer word
      const next = refreshSnapshot();
      await Promise.resolve();
      answer(snap("26.9.6"));
      await next;
      expect(updates.value?.engine).toBe("26.9.6");
      expect(engineMode.value).toBe("managed");
    } finally {
      globalThis.fetch = real;
      updates.value = null;
      engineMode.value = null;
    }
  });
});
