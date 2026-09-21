// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { trackMonitor } from "../../src/client/monitor/Monitor.tsx";
import { connection } from "../../src/client/store.ts";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("trackMonitor", () => {
  // the socket's close handler sets the connection and schedules the
  // reconnect after it: a throw there leaves the tab reconnecting forever
  test("a lost socket does not throw from the tiles' reset", () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    trackMonitor();
    expect(() => {
      connection.value = "reconnecting";
    }).not.toThrow();
    expect(() => {
      connection.value = "live";
      connection.value = "reconnecting";
    }).not.toThrow();
  });
});
