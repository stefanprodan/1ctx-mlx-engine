// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseCli } from "../src/cli.ts";

function error(argv: string[]): string {
  const result = parseCli(argv);
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
}

describe("parseCli", () => {
  test("accepts flag=value", () => {
    const result = parseCli([
      "--engine=http://engine:11234",
      "--db=:memory:",
      "--retention=2",
      "--hot-cache-max=16GB",
      "--disk-cache-max=off",
    ]);
    expect(result.kind).toBe("run");
    if (result.kind !== "run") return;
    expect(result.options.engineUrl).toBe("http://engine:11234");
    expect(result.options.dbPath).toBe(":memory:");
    expect(result.options.retentionDays).toBe(2);
    expect(result.options.hotMax).toBe(16 * 1024 ** 3);
    expect(result.options.diskMax).toBe(0);
  });

  test("parses supported listen forms", () => {
    const cases = [
      ["host:1234", { hostname: "host", port: 1234 }],
      [":1234", { hostname: null, port: 1234 }],
      ["host", { hostname: "host", port: null }],
      ["[::1]:1234", { hostname: "::1", port: 1234 }],
    ] as const;
    for (const [value, expected] of cases) {
      const result = parseCli([`--listen=${value}`]);
      expect(result.kind, value).toBe("run");
      if (result.kind === "run")
        expect(result.options.listen).toEqual(expected);
    }
    expect(error(["--listen=a:b:c"])).toBe("invalid --listen: a:b:c");
    expect(error(["--listen=:65536"])).toBe("invalid --listen port: 65536");
  });

  test("validates retention", () => {
    expect(error(["--retention", "0"])).toBe(
      "--retention must be a positive number of days: 0",
    );
    expect(error(["--retention=nope"])).toBe(
      "--retention must be a positive number of days: nope",
    );
  });

  test("validates cache sizes", () => {
    expect(error(["--hot-cache-max", "16TB"])).toBe(
      "--hot-cache-max expects <n>{KB,MB,GB} or off: 16TB",
    );
    expect(error(["--disk-cache-max=nope"])).toBe(
      "--disk-cache-max expects <n>{KB,MB,GB} or off: nope",
    );
  });

  test("rejects unknown flags and missing values", () => {
    expect(error(["--unknown"])).toBe("unknown argument: --unknown");
    expect(error(["--engine"])).toBe("--engine needs a value");
    expect(error(["--db", "--once"])).toBe("--db needs a value");
  });

  test("returns help and version results", () => {
    expect(parseCli(["-h"]).kind).toBe("help");
    expect(parseCli(["--help"]).kind).toBe("help");
    expect(parseCli(["-v"])).toEqual({ kind: "version" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
  });

  test("routes service arguments verbatim", () => {
    expect(parseCli(["service", "install", "--listen=:11236"])).toEqual({
      kind: "service",
      argv: ["install", "--listen=:11236"],
    });
  });

  test("parses log file paths and off", () => {
    const file = parseCli(["--log-file", "/tmp/mlx-spy.log"]);
    expect(file.kind).toBe("run");
    if (file.kind === "run") {
      expect(file.options.logFile).toBe("/tmp/mlx-spy.log");
    }
    const off = parseCli(["--log-file=off"]);
    expect(off.kind).toBe("run");
    if (off.kind === "run") expect(off.options.logFile).toBe("off");
    expect(error(["--log-file="])).toBe("--log-file must not be empty");
  });
});
