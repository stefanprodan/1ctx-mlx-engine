// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  bootstrap,
  type LaunchdFiles,
  parseLaunchdPrint,
  reload,
  type Spawn,
  waitForExit,
} from "../../../src/server/service/launchd.ts";

function result(code = 0, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function memoryFiles(events: string[], plistPath: string): LaunchdFiles {
  const files = new Map<string, Uint8Array>([
    [plistPath, new TextEncoder().encode("old plist")],
  ]);
  return {
    mkdir: async () => {
      events.push("mkdir");
    },
    write: async (path, data) => {
      events.push(`write:${path}`);
      files.set(
        path,
        typeof data === "string" ? new TextEncoder().encode(data) : data,
      );
    },
    read: async (path) => {
      events.push(`read:${path}`);
      const value = files.get(path);
      if (!value) throw new Error(`missing ${path}`);
      return value;
    },
    rename: async (from, to) => {
      events.push(`rename:${from}:${to}`);
      const value = files.get(from);
      if (!value) throw new Error(`missing ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    remove: async (path) => {
      events.push(`remove:${path}`);
      files.delete(path);
    },
  };
}

describe("launchd reload", () => {
  test("stages, journals, exits, renames, rotates, then bootstraps", async () => {
    const events: string[] = [];
    const path = "/home/Library/LaunchAgents/com.example.spy.plist";
    const files = memoryFiles(events, path);
    let prints = 0;
    const spawn: Spawn = async (argv) => {
      events.push(argv.slice(1).join(":"));
      if (argv[1] === "print") {
        prints++;
        return prints === 1 ? result(0, "state = running") : result(1);
      }
      return result();
    };

    await reload(
      {
        label: "com.example.spy",
        programArguments: ["/bin/spy", "--log-file", "/tmp/spy.log"],
        standardOutPath: "/tmp/launchd.log",
        standardErrorPath: "/tmp/launchd.log",
      },
      {
        path,
        files,
        spawn,
        uid: 501,
        sleep: async () => {},
        onBeforeBootout: async (previous) => {
          expect(new TextDecoder().decode(previous ?? undefined)).toBe(
            "old plist",
          );
          events.push("journal");
        },
        rotate: async (logPath) => {
          events.push(`rotate:${logPath}`);
          return true;
        },
      },
    );

    const stage = events.indexOf(`write:${path}.tmp`);
    const journal = events.indexOf("journal");
    const bootout = events.findIndex((event) => event.startsWith("bootout:"));
    const rename = events.indexOf(`rename:${path}.tmp:${path}`);
    const rotate = events.indexOf("rotate:/tmp/launchd.log");
    const start = events.findIndex((event) => event.startsWith("bootstrap:"));
    expect(stage).toBeLessThan(journal);
    expect(journal).toBeLessThan(bootout);
    expect(bootout).toBeLessThan(rename);
    expect(rename).toBeLessThan(rotate);
    expect(rotate).toBeLessThan(start);
  });

  test("leaves the running job untouched when staging fails", async () => {
    const calls: string[][] = [];
    const files = memoryFiles([], "/tmp/spy.plist");
    files.write = async () => {
      throw new Error("disk full");
    };
    await expect(
      reload(
        { label: "com.example.spy", programArguments: ["/bin/spy"] },
        {
          path: "/tmp/spy.plist",
          files,
          spawn: async (argv) => {
            calls.push(argv);
            return result();
          },
        },
      ),
    ).rejects.toThrow("disk full");
    expect(calls).toEqual([]);
  });
});

describe("launchd verbs", () => {
  test("retries Bootstrap failed: 5 once", async () => {
    let calls = 0;
    await bootstrap("/tmp/spy.plist", {
      uid: 501,
      sleep: async () => {},
      spawn: async () => {
        calls++;
        return calls === 1
          ? result(5, "", "Bootstrap failed: 5: Input/output error")
          : result();
      },
    });
    expect(calls).toBe(2);
  });

  test("waits until launchctl no longer knows the job", async () => {
    let calls = 0;
    let time = 0;
    await waitForExit("com.example.spy", {
      uid: 501,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      spawn: async () => {
        calls++;
        return calls < 3 ? result(0, "state = exited") : result(1);
      },
    });
    expect(calls).toBe(3);
    expect(time).toBe(2_000);
  });

  test("parses launchctl print fields with whitespace", () => {
    expect(
      parseLaunchdPrint(
        `service = {\n\tstate = running\n\tprogram = "/bin/spy"\n\tpid = 42\n\tlast exit code = 7\n}`,
      ),
    ).toEqual({
      state: "running",
      pid: 42,
      program: "/bin/spy",
      lastExitCode: 7,
    });
  });

  test("atomically replaces complete plist bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mlx-spy-launchd-"));
    const path = join(root, "spy.plist");
    try {
      await writeFile(path, "old");
      await atomicWrite(path, new TextEncoder().encode("new complete plist"));
      expect(await readFile(path, "utf8")).toBe("new complete plist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
