// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createLog } from "../src/log.ts";

describe("createLog", () => {
  test("writes timestamp, level, and message fields", () => {
    const lines: string[] = [];
    const log = createLog(
      (line) => lines.push(line),
      () => new Date("2026-09-20T12:00:00.000Z"),
    );

    log("started");
    log.warn("retrying");
    log.error("stopped");

    expect(lines).toEqual([
      "2026-09-20T12:00:00.000Z info started",
      "2026-09-20T12:00:00.000Z warn retrying",
      "2026-09-20T12:00:00.000Z error stopped",
    ]);
    expect(lines[0].split(" ", 3)).toEqual([
      "2026-09-20T12:00:00.000Z",
      "info",
      "started",
    ]);
  });
});
