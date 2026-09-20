// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../../src/server/engine/config.ts";
import { EngineStore } from "../../../src/server/engine/store.ts";
import { History } from "../../../src/server/monitor/history.ts";
import type { InstallRecord } from "../../../src/shared/engine.ts";

const PINNED = "/Users/x/models";

function install(tag: string, installedAt: number): InstallRecord {
  return {
    tag,
    version: tag.replace(/^v/, ""),
    mlx: "0.32.2",
    installedAt,
  };
}

describe("EngineStore", () => {
  test("round-trips config, settings, ownership and installs", () => {
    const history = new History(":memory:");
    const store = new EngineStore(history.db);
    const applied = DEFAULTS(PINNED, "http://127.0.0.1:11234");
    const pending = { ...applied, temp: 1, topP: 0.95 };

    expect(store.config()).toEqual({ applied: null, pending: null });
    expect(store.preReleases()).toBeFalse();
    expect(store.managed()).toBeFalse();
    expect(store.installs()).toEqual({ active: null, previous: null });

    store.setApplied(applied);
    store.setPending(pending);
    expect(store.config()).toEqual({ applied, pending });
    expect(store.commitPending()).toEqual(pending);
    expect(store.config()).toEqual({ applied: pending, pending: null });

    store.setPreReleases(true);
    store.setManaged(true);
    expect(store.preReleases()).toBeTrue();
    expect(store.managed()).toBeTrue();

    const active = install("v26.9.5", 200);
    const previous = install("v26.9.4", 100);
    store.setInstalls(active, previous);
    expect(store.installs()).toEqual({ active, previous });
    store.setInstalls(previous, null);
    expect(store.installs()).toEqual({ active: previous, previous: null });
    history.close();
  });

  test("round-trips and clears the journal", () => {
    const history = new History(":memory:");
    const store = new EngineStore(history.db);
    const journal = {
      op: "upgrade" as const,
      tag: "v26.9.5",
      step: "bootout",
      previousPlist: "<plist/>",
      at: 123,
    };
    expect(store.journal()).toBeNull();
    store.setJournal(journal);
    expect(store.journal()).toEqual(journal);
    store.setJournal(null);
    expect(store.journal()).toBeNull();
    history.close();
  });

  test("keeps release checks separate by repository", () => {
    const history = new History(":memory:");
    const store = new EngineStore(history.db);
    const engine = {
      releases: [
        {
          tag: "v26.9.5",
          version: "26.9.5",
          prerelease: false,
          publishedAt: "2026-09-20T00:00:00Z",
          assetBytes: 10,
          asset: {
            downloadUrl: "https://example.test/engine.tar.gz",
            sha256: "a".repeat(64),
          },
        },
      ],
      checkedAt: 100,
      error: null,
    };
    const self = { releases: [], checkedAt: 200, error: "offline" };
    store.setReleaseCheck("ddalcu/mlx-serve", engine);
    store.setReleaseCheck("stefanprodan/1ctx-mlx-engine", self);
    expect(store.releaseCheck("ddalcu/mlx-serve")).toEqual(engine);
    expect(store.releaseCheck("stefanprodan/1ctx-mlx-engine")).toEqual(self);
    expect(store.releaseCheck("other/repo")).toBeNull();
    store.setReleaseCheck("ddalcu/mlx-serve", null);
    expect(store.releaseCheck("ddalcu/mlx-serve")).toBeNull();
    history.close();
  });

  test("shares History's handle without taking ownership", () => {
    const history = new History(":memory:");
    new EngineStore(history.db);
    expect(history.count()).toBe(0);
    history.close();
  });
});
