// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileSink,
  createLogs,
  errorFields,
  format,
  type LogFields,
  rotateStopped,
  scrubErrors,
} from "../../../src/server/lib/log.ts";

const at = new Date("2026-09-21T22:39:12.345Z");

describe("log format", () => {
  test("matches Go slog text quoting", () => {
    expect(
      format(at, "runner", "info", "send end", {
        a: "plain",
        b: "",
        c: "two words",
        d: "a=b",
        e: "a\\b",
        f: "a\x7fb",
        g: "a\nb",
        h: "a\tb",
        i: 'quote"here',
        j: "nonbreaking\u00a0space",
        k: "zero\u200bwidth",
        l: "snowman☃",
        m: "line\u2028separator",
        n: "bad\ud800x",
      }),
    ).toBe(
      'time=2026-09-21T22:39:12.345Z level=INFO msg="send end" area=runner a=plain b="" c="two words" d="a=b" e=a\\b f=a\x7fb g="a\\nb" h="a\\tb" i="quote\\"here" j="nonbreaking\\u00a0space" k="zero\\u200bwidth" l=snowman☃ m="line\\u2028separator" n="bad\\xed\\xa0\\x80x"',
    );
  });

  test("keeps field order, formats milliseconds and reports bad fields", () => {
    const fields = {
      count: 1_000_000,
      duration: 123.5,
      enabled: true,
      empty: undefined,
      time: "wrong",
      "bad-key": "wrong",
      infinite: Number.POSITIVE_INFINITY,
      object: null,
    } as unknown as LogFields;
    expect(format(at, "web", "warn", "request", fields)).toBe(
      "time=2026-09-21T22:39:12.345Z level=WARN msg=request area=web count=1e+06 duration=124ms enabled=true bad_fields=4",
    );
    expect(format(at, "web", "info", "quick", { duration: 0.49 })).toEndWith(
      "duration=0ms",
    );
  });
});

describe("error fields", () => {
  test("cuts one line, cleans URLs and keeps typed details", () => {
    const error = Object.assign(
      new TypeError(
        `failed https://user:pass@fault.test/path?q=private\n${"x".repeat(300)}`,
      ),
      { code: "ETIMEDOUT", status: 503, retry: true },
    );
    expect(errorFields(error, false)).toEqual({
      error_type: "TypeError",
      error: "failed https://fault.test/path",
      error_code: "ETIMEDOUT",
      status: 503,
      retry: true,
    });
  });

  test("cuts the error at 200 characters when it is written", () => {
    expect(format(at, "a", "error", "b", { error: "x".repeat(200) })).toBe(
      `time=2026-09-21T22:39:12.345Z level=ERROR msg=b area=a error=${"x".repeat(200)}`,
    );
    expect(format(at, "a", "error", "b", { error: "x".repeat(201) })).toBe(
      `time=2026-09-21T22:39:12.345Z level=ERROR msg=b area=a error=${"x".repeat(197)}...`,
    );
  });

  test("scrubs a key the cut would have split", () => {
    const key = "sk-straddling-the-cut-0123456789";
    const lines: LogFields[] = [];
    const log = scrubErrors(
      {
        info() {},
        warn() {},
        error: (_msg, fields) => {
          lines.push(fields ?? {});
        },
      },
      () => [key],
    );
    log.error("b", errorFields(new Error(`${"x".repeat(190)}${key}`), false));
    const line = format(at, "a", "error", "b", lines[0]);
    expect(line).not.toContain(key.slice(0, 7));
    expect(line).toContain("[key]");
  });

  test("keeps only source frame locations", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at inner (/repo/src/server/sessions/store.ts:212:9)",
      "    at next (/repo/src/shared/words.ts:88:3)",
      "    at test (/repo/test/example.test.ts:4:1)",
    ].join("\n");
    expect(errorFields(error).stack).toBe(
      "sessions/store.ts:212 shared/words.ts:88",
    );
  });

  test("reads the relative frames of a binary built with a sourcemap", () => {
    const error = new TypeError("boom");
    error.stack = [
      "TypeError: boom",
      "    at boom (src/server/lib/b.ts:1:55)",
      "    at src/server/main.ts:2:5",
    ].join("\n");
    expect(errorFields(error).stack).toBe("lib/b.ts:1 main.ts:2");
  });

  test("never reads a frame out of the message's later lines", () => {
    const error = new Error("first\n    at fake (/x/src/server/secret.ts:1:1)");
    error.stack = [
      "Error: first",
      "    at fake (/x/src/server/secret.ts:1:1)",
      "    at real (/x/src/server/web/router.ts:9:2)",
    ].join("\n");
    expect(errorFields(error).stack).toBe("web/router.ts:9");
  });
});

describe("createLogs", () => {
  test("writes one slog line per event, under its area", () => {
    const lines: string[] = [];
    const logs = createLogs(
      (line) => lines.push(line),
      () => at,
    );
    const log = logs("engine");

    log.info("operation start", { op: "upgrade", tag: "v26.9.5" });
    log.warn("download retry", { attempt: 1 });
    logs("sampler").error("tick failed", { error: "boom" });

    expect(lines).toEqual([
      'time=2026-09-21T22:39:12.345Z level=INFO msg="operation start" area=engine op=upgrade tag=v26.9.5',
      'time=2026-09-21T22:39:12.345Z level=WARN msg="download retry" area=engine attempt=1',
      'time=2026-09-21T22:39:12.345Z level=ERROR msg="tick failed" area=sampler error=boom',
    ]);
  });

  test("collapses repeats until the event changes", () => {
    const lines: string[] = [];
    let time = Date.parse("2026-09-20T12:00:00.000Z");
    let closeWindow: (() => void) | null = null;
    const log = createLogs(
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
    )("sampler");

    log.error("tick failed", { error: "boom" });
    time += 1_000;
    log.error("tick failed", { error: "boom" });
    time += 1_000;
    log.error("tick failed", { error: "boom" });
    log.error("tick failed", { error: "other" });

    expect(lines.map((line) => line.replace(/^\S+ /, ""))).toEqual([
      'level=ERROR msg="tick failed" area=sampler error=boom',
      'level=ERROR msg="tick failed" area=sampler error=boom repeated=2',
      'level=ERROR msg="tick failed" area=sampler error=other',
    ]);
    expect(closeWindow).toBeNull();
  });

  test("the same event in another area is not a repeat", () => {
    const lines: string[] = [];
    const logs = createLogs((line) => lines.push(line));
    logs("actions").error("listener failed");
    logs("downloads").error("listener failed");
    expect(lines).toHaveLength(2);
  });

  test("emits the repeat count when the window closes", () => {
    const lines: string[] = [];
    const callbacks: Array<() => void> = [];
    const log = createLogs(
      (line) => lines.push(line),
      () => at,
      {
        setTimer: (callback) => {
          callbacks.push(callback);
          return callback;
        },
        clearTimer: () => {},
      },
    )("app");
    log.info("same");
    log.info("same");
    callbacks[0]!();
    expect(lines[1]).toEndWith("msg=same area=app repeated=1");
  });

  test("close writes the pending count and closes the sink", () => {
    const lines: string[] = [];
    let closed = false;
    const sink = Object.assign((line: string) => void lines.push(line), {
      close: () => {
        closed = true;
      },
    });
    const logs = createLogs(sink, () => at);
    logs("app").info("same");
    logs("app").info("same");
    logs.close();
    expect(lines[1]).toEndWith("repeated=1");
    expect(closed).toBeTrue();
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
