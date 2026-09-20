// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { LaunchdInfo } from "../../../src/server/service/launchd.ts";
import { renderPlist } from "../../../src/server/service/plist.ts";
import {
  runService,
  SERVICE_LABEL,
  type ServiceDeps,
  type ServiceFiles,
  type ServiceLaunchd,
} from "../../../src/server/service/service.ts";

function harness() {
  const events: string[] = [];
  const output: string[] = [];
  const removed: string[] = [];
  const files = new Map<string, Uint8Array>();
  let loaded = false;
  let info: LaunchdInfo | null = null;

  const fs: ServiceFiles = {
    mkdir: async (path) => {
      events.push(`mkdir:${path}`);
    },
    read: async (path) => files.get(path) ?? null,
    remove: async (path) => {
      removed.push(path);
      files.delete(path);
    },
  };
  const launchd: ServiceLaunchd = {
    isLoaded: async () => {
      events.push("isLoaded");
      return loaded;
    },
    reload: async (spec, path) => {
      events.push("reload");
      files.set(path, new TextEncoder().encode(renderPlist(spec)));
      loaded = true;
      info = {
        state: "running",
        pid: 42,
        program: spec.programArguments[0],
        lastExitCode: 0,
      };
    },
    bootout: async () => {
      events.push("bootout");
      loaded = false;
      info = null;
    },
    bootstrap: async () => {
      events.push("bootstrap");
      loaded = true;
    },
    print: async () => info,
  };
  const deps: ServiceDeps = {
    home: "/Users/test",
    execPath: "/opt/homebrew/Cellar/1ctx-mlx-engine/1.2.3/bin/1ctx-mlx-engine",
    osVersion: () => "macOS 26.6 (25G83)",
    defaultHostname: () => "127.0.0.1",
    write: (line) => output.push(line),
    sleep: async () => {},
    probe: async () => "v1.2.3",
    files: fs,
    launchd,
  };
  return {
    deps,
    events,
    files,
    output,
    removed,
    setLoaded: (value: boolean) => {
      loaded = value;
    },
  };
}

describe("service install", () => {
  test("writes a stable agent, reloads it, then waits for health", async () => {
    const h = harness();
    await runService(
      [
        "install",
        "--engine",
        "http://127.0.0.1:11234",
        "--listen",
        "0.0.0.0:11235",
        "--model-dir",
        "/Users/test/models",
      ],
      h.deps,
    );

    expect(h.events.slice(0, 3)).toEqual([
      "isLoaded",
      "mkdir:/Users/test/.1ctx-mlx-engine",
      "reload",
    ]);
    const path = `/Users/test/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
    const xml = new TextDecoder().decode(h.files.get(path));
    expect(xml).toContain(
      "/opt/homebrew/opt/1ctx-mlx-engine/bin/1ctx-mlx-engine",
    );
    expect(xml).toContain("<string>--log-file</string>");
    expect(xml).toContain(
      "<string>/Users/test/.1ctx-mlx-engine/1ctx-mlx-engine.log</string>",
    );
    expect(xml).toContain(
      "<string>/Users/test/.1ctx-mlx-engine/launchd.log</string>",
    );
    expect(h.output).toEqual([
      "1ctx-mlx-engine v1.2.3 up at http://127.0.0.1:11235",
    ]);
  });

  test("requires restart when an agent is already loaded", async () => {
    const h = harness();
    h.setLoaded(true);
    await expect(runService(["install"], h.deps)).rejects.toThrow(
      "use install --restart",
    );
    expect(h.events).toEqual(["isLoaded"]);
  });

  test("refuses a host below the supported floor by name", async () => {
    const h = harness();
    h.deps.osVersion = () => "macOS 15.7.1";
    await expect(runService(["install"], h.deps)).rejects.toThrow(
      "macOS 26 or newer is required; found macOS 15.7.1",
    );
    expect(h.events).toEqual([]);
  });
});

describe("service lifecycle", () => {
  test("reports label, state, pid, binary, version, and url", async () => {
    const h = harness();
    await runService(["install", "--listen", ":11235"], h.deps);
    h.output.length = 0;
    await runService(["status"], h.deps);
    expect(h.output[0]).toContain(`label: ${SERVICE_LABEL}`);
    expect(h.output[0]).toContain("state: running");
    expect(h.output[0]).toContain("pid: 42");
    expect(h.output[0]).toContain(
      "binary: /opt/homebrew/opt/1ctx-mlx-engine/bin/1ctx-mlx-engine",
    );
    expect(h.output[0]).toContain("version: v1.2.3");
    expect(h.output[0]).toContain("url: http://127.0.0.1:11235");
  });

  test("uninstalls and purges only the database and logs", async () => {
    const h = harness();
    await runService(
      [
        "install",
        "--db",
        "/Users/test/data/history.db",
        "--log-file",
        "/Users/test/logs/spy.log",
      ],
      h.deps,
    );
    h.removed.length = 0;
    await runService(["uninstall", "--purge"], h.deps);

    expect(h.events).toContain("bootout");
    expect(h.removed).toContain("/Users/test/data/history.db");
    expect(h.removed).toContain("/Users/test/logs/spy.log");
    expect(h.removed).toContain("/Users/test/.1ctx-mlx-engine/launchd.log");
    expect(h.removed.some((path) => path.includes("secrets"))).toBe(false);
    expect(h.removed.some((path) => path.includes("models"))).toBe(false);
  });
});
