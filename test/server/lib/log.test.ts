// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSink,
  createLog,
  rotateStopped,
} from "../../../src/server/lib/log.ts";

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

  test("collapses repeats until the message changes", () => {
    const lines: string[] = [];
    let time = Date.parse("2026-09-20T12:00:00.000Z");
    let closeWindow: (() => void) | null = null;
    const log = createLog(
      (line) => lines.push(line),
      () => new Date(time),
      {
        setTimer: (callback) => {
          closeWindow = callback;
          return callback;
        },
        clearTimer: () => {
          closeWindow = null;
        },
      },
    );

    log("tick failed");
    time += 1_000;
    log("tick failed");
    time += 1_000;
    log("tick failed");
    log.warn("recovering");

    expect(lines.map((line) => line.replace(/^\S+ /, ""))).toEqual([
      "info tick failed",
      "info tick failed (repeated 2 times)",
      "warn recovering",
    ]);
    expect(closeWindow).toBeNull();
  });

  test("emits the repeat count when the window closes", () => {
    const lines: string[] = [];
    const callbacks: Array<() => void> = [];
    const log = createLog(
      (line) => lines.push(line),
      () => new Date("2026-09-20T12:00:00.000Z"),
      {
        setTimer: (callback) => {
          callbacks.push(callback);
          return callback;
        },
        clearTimer: () => {},
      },
    );
    log("same");
    log("same");
    callbacks[0]();
    expect(lines[1]).toEndWith("info same (repeated 1 times)");
  });
});

describe("file logging", () => {
  test("off keeps writing to stderr", () => {
    const lines: string[] = [];
    const sink = createFileSink("off", { stderr: (line) => lines.push(line) });
    sink("terminal");
    expect(lines).toEqual(["terminal"]);
  });

  test("creates and appends to a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "1ctx-mlx-engine-log-"));
    const path = join(root, "1ctx-mlx-engine.log");
    try {
      await writeFile(path, "before\n");
      const sink = createFileSink(path);
      sink("after");
      sink.close?.();
      expect(await readFile(path, "utf8")).toBe("before\nafter\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rotates at the boundary and keeps one previous file", async () => {
    const root = await mkdtemp(join(tmpdir(), "1ctx-mlx-engine-log-"));
    const path = join(root, "1ctx-mlx-engine.log");
    try {
      await writeFile(path, "12345678");
      await writeFile(`${path}.1`, "older");
      const sink = createFileSink(path, { threshold: 8 });
      sink("new");
      sink.close?.();
      expect(await readFile(`${path}.1`, "utf8")).toBe("12345678");
      expect(await readFile(path, "utf8")).toBe("new\n");
      // absent, not merely empty
      expect(await Bun.file(`${path}.2`).exists()).toBeFalse();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rotates stopped launchd files only at the threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "1ctx-mlx-engine-log-"));
    const path = join(root, "launchd.log");
    try {
      await writeFile(path, "1234567");
      expect(await rotateStopped(path, 8)).toBe(false);
      await writeFile(path, "12345678");
      expect(await rotateStopped(path, 8)).toBe(true);
      expect(await readFile(`${path}.1`, "utf8")).toBe("12345678");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
