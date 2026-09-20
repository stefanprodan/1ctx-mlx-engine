// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { modelsKeyOf, pageOf, replaced } from "../../src/client/store.ts";
import type { ModelInfo } from "../../src/shared/models.ts";

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "org/model",
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 2,
  contextLength: 4096,
  capabilities: ["chat"],
  ...over,
});

describe("store", () => {
  test("pageOf names the view from the path", () => {
    expect(pageOf("/")).toBe("monitor");
    expect(pageOf("/requests")).toBe("requests");
    expect(pageOf("/engine")).toBe("engine");
    expect(pageOf("/requests/")).toBe("monitor");
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
