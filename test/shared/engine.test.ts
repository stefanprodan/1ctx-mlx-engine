// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  type EngineState,
  isDevVersion,
  type Release,
  releaseUrl,
  updatesOf,
} from "../../src/shared/engine.ts";

const release = (version: string): Release => ({
  tag: `v${version}`,
  version,
  prerelease: false,
  publishedAt: "2026-09-21T00:00:00Z",
  assetBytes: 1,
});
const engine = (mode: EngineState["mode"], offered: Release | null) =>
  ({ mode, offered }) as EngineState;

describe("releaseUrl", () => {
  test("the release page of a tag, escaped", () => {
    expect(releaseUrl("ddalcu/mlx-serve", "v26.9.5")).toBe(
      "https://github.com/ddalcu/mlx-serve/releases/tag/v26.9.5",
    );
    expect(releaseUrl("o/r", "v1.0.0+build/x")).toBe(
      "https://github.com/o/r/releases/tag/v1.0.0%2Bbuild%2Fx",
    );
  });
});

describe("updatesOf", () => {
  test("mlx-serve's offer is an update only when the engine is ours", () => {
    const r = release("26.9.5");
    expect(updatesOf(engine("managed", r), null)).toEqual({
      engine: "26.9.5",
      self: null,
    });
    // the Server page shows the progress or the failure in the offer's place
    expect(
      updatesOf({ ...engine("managed", r), operation: {} } as EngineState, null)
        .engine,
    ).toBeNull();
    expect(
      updatesOf({ ...engine("managed", r), failure: {} } as EngineState, null)
        .engine,
    ).toBeNull();
    // an absent or unmanaged engine is offered an install, no update
    expect(updatesOf(engine("absent", r), null).engine).toBeNull();
    expect(updatesOf(engine("unmanaged", r), null).engine).toBeNull();
  });

  test("this program's own offer, whatever the engine", () => {
    expect(updatesOf(engine("absent", null), release("1.2.0"))).toEqual({
      engine: null,
      self: "1.2.0",
    });
  });
});

describe("isDevVersion", () => {
  test("a build from source and a deployed one with its commit", () => {
    expect(isDevVersion("v0.0.0-dev")).toBe(true);
    expect(isDevVersion("v0.0.0-dev+1a2b3c4")).toBe(true);
    expect(isDevVersion("v0.0.0-dev+1a2b3c4.dirty5d6e7f")).toBe(true);
  });

  test("a release is not, nor a look-alike", () => {
    expect(isDevVersion("v0.2.0")).toBe(false);
    expect(isDevVersion("v0.0.0-devel")).toBe(false);
  });
});
