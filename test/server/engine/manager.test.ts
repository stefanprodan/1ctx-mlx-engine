// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULTS,
  parseLaunchdArgs,
} from "../../../src/server/engine/config.ts";
import {
  cpuPercent,
  defaultPortProbe,
  ENGINE_REPO,
  EngineManager,
  EngineManagerError,
  MANAGED_LABEL,
} from "../../../src/server/engine/manager/index.ts";
import { EngineStore } from "../../../src/server/engine/store.ts";
import { ExclusiveLock } from "../../../src/server/lib/lock.ts";
import type { Log } from "../../../src/server/lib/log.ts";
import { History } from "../../../src/server/monitor/history.ts";
import type { LaunchdInfo } from "../../../src/server/service/launchd.ts";
import { plistPath, renderPlist } from "../../../src/server/service/plist.ts";
import type { EngineConfig } from "../../../src/shared/engine.ts";

const servers: Bun.Server<unknown>[] = [];
const roots: string[] = [];

const log: Log = Object.assign(() => {}, {
  warn: () => {},
  error: () => {},
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function archive(top = "mlx-serve-macos-arm64"): Promise<Uint8Array> {
  const root = await mkdtemp(join(tmpdir(), "mlx-spy-archive-"));
  roots.push(root);
  const path = join(root, "engine.tar.gz");
  await Bun.Archive.write(
    path,
    {
      [`${top}/mlx-serve`]: "#!/bin/sh\necho mlx-serve 26.9.5\n",
      [`${top}/lib/libmlx.dylib`]: "fake",
    },
    { compress: "gzip" },
  );
  return new Uint8Array(await readFile(path));
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function assetServer(
  bytes: Uint8Array,
  inspect?: (request: Request) => void,
): { url: string; hits: () => number } {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      count++;
      inspect?.(request);
      return new Response(new Blob([bytes as BlobPart]), {
        headers: { "content-length": String(bytes.length) },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}/engine.tar.gz`,
    hits: () => count,
  };
}

type HarnessOptions = {
  bytes?: Uint8Array;
  sha256?: string;
  tag?: string;
  versionOutput?: string;
  portInUse?: boolean;
  health?: boolean;
  wrongProgram?: boolean;
  crashLoop?: boolean;
  token?: string | null;
  url?: string;
  holdReload?: Promise<void>;
};

async function harness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "mlx-spy-install-"));
  roots.push(root);
  const home = join(root, "home");
  const engineRoot = join(root, "engine");
  const pinned = join(home, ".mlx-spy", "models");
  const history = new History(":memory:");
  const store = new EngineStore(history.db);
  const lock = new ExclusiveLock();
  const bytes = options.bytes ?? (await archive());
  const served = options.url ? null : assetServer(bytes);
  const tag = options.tag ?? "v26.9.5";
  const url = options.url ?? served!.url;
  store.setReleaseCheck(ENGINE_REPO, {
    releases: [
      {
        tag,
        version: tag.replace(/^v/, ""),
        prerelease: tag.includes("-"),
        publishedAt: "2026-09-20T00:00:00Z",
        assetBytes: bytes.length,
        asset: {
          downloadUrl: url,
          sha256: options.sha256 ?? digest(bytes),
        },
      },
    ],
    checkedAt: 1,
    error: null,
  });
  let job: LaunchdInfo | null = null;
  let time = 1_000;
  let pid = 40;
  let bootouts = 0;
  const path = plistPath(MANAGED_LABEL, home);
  const loadPlist = async () => {
    const args = parseLaunchdArgs(await readFile(path, "utf8"));
    job = {
      state: "running",
      pid: ++pid,
      program: args[0] ?? null,
      lastExitCode: 0,
    };
  };
  const deps: ConstructorParameters<typeof EngineManager>[0] = {
    store,
    lock,
    engineUrl: "http://127.0.0.1:11234",
    pinnedModelDir: pinned,
    local: true,
    engineUp: () => job?.state === "running",
    health: async () => options.health ?? true,
    log,
    version: "v1.0.0",
    probes: { processMemory: () => null },
    token: options.token,
    home,
    root: engineRoot,
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
    retryDelayMs: 0,
    verifyStableMs: 1,
    verifyTimeoutMs: 5,
    portProbe: async () => options.portInUse ?? false,
    freeSpace: () => Number.MAX_SAFE_INTEGER,
    spawn: async (argv) => {
      if (argv[1] === "--version") {
        return {
          code: 0,
          stdout:
            options.versionOutput ??
            `mlx-serve ${argv[0].includes("v26.9.6") ? "26.9.6" : "26.9.5"}\nmlx 0.32.2`,
          stderr: "",
        };
      }
      throw new Error(`unexpected spawn: ${argv.join(" ")}`);
    },
    launchd: {
      reload: async (spec, deps) => {
        let previous: Uint8Array | null = null;
        try {
          previous = new Uint8Array(await readFile(path));
        } catch {}
        await deps?.onBeforeBootout?.(previous);
        await options.holdReload;
        bootouts++;
        job = null;
        await Bun.write(path, renderPlist(spec));
        job = {
          state: options.crashLoop ? "waiting" : "running",
          pid: ++pid,
          program: options.wrongProgram
            ? join(engineRoot, "versions", "wrong", "mlx-serve")
            : spec.programArguments[0],
          lastExitCode: options.crashLoop ? 1 : 0,
        };
      },
      print: async () => {
        if (options.crashLoop && job) job = { ...job, pid: ++pid };
        return job;
      },
      bootout: async () => {
        bootouts++;
        job = null;
      },
      bootstrap: async () => loadPlist(),
      kickstart: async () => {
        if (job) job = { ...job, pid: ++pid };
      },
      atomicWrite: async (target, data) => {
        await Bun.write(target, data);
      },
    },
  };
  const manager = new EngineManager(deps);
  // a second manager over the same store: mlx-spy after a restart
  const restarted = () => new EngineManager(deps);
  const config = DEFAULTS(pinned, "http://127.0.0.1:11234");
  const settled = async () => {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (!manager.state().operation) return;
      await Bun.sleep(1);
    }
    throw new Error("manager did not settle");
  };
  return {
    root,
    home,
    engineRoot,
    pinned,
    history,
    store,
    lock,
    manager,
    restarted,
    config,
    tag,
    served,
    path,
    settled,
    job: () => job,
    bootouts: () => bootouts,
  };
}

async function installed(options: HarnessOptions = {}) {
  const value = await harness(options);
  value.manager.install(value.tag, value.config);
  await value.settled();
  expect(value.manager.state().failure).toBeNull();
  return value;
}

describe("the port probe", () => {
  test("a port that accepts is in use, a closed one is free", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port as number;
    expect(await defaultPortProbe("127.0.0.1", port)).toBeTrue();
    // the wide bind is probed through loopback
    expect(await defaultPortProbe("0.0.0.0", port)).toBeTrue();
    await server.stop(true);
    expect(await defaultPortProbe("127.0.0.1", port)).toBeFalse();
  });
});

describe("spy process rate", () => {
  test("computes percent of one core from cpuUsage deltas", () => {
    expect(
      cpuPercent(
        { at: 1_000, userMicros: 100, systemMicros: 100 },
        { at: 2_000, userMicros: 500_100, systemMicros: 100 },
      ),
    ).toBe(50);
    expect(cpuPercent(null, { at: 1, userMicros: 1, systemMicros: 1 })).toBe(0);
  });
});

describe("EngineManager install", () => {
  test("downloads, verifies, unpacks, activates, and writes fixed plist keys", async () => {
    const value = await installed();
    const state = value.manager.state();
    expect(state.mode).toBe("managed");
    expect(state.active).toMatchObject({ tag: "v26.9.5", mlx: "0.32.2" });
    expect(value.store.managed()).toBeTrue();
    expect(
      existsSync(join(value.engineRoot, "versions", value.tag, "mlx-serve")),
    ).toBeTrue();
    expect(existsSync(value.pinned)).toBeTrue();
    const plist = await readFile(value.path, "utf8");
    expect(plist).toContain("<string>com.stefanprodan.mlx-serve</string>");
    expect(plist).toContain(
      "<key>ProcessType</key>\n  <string>Interactive</string>",
    );
    expect(plist).toContain(
      "<key>ThrottleInterval</key>\n  <integer>10</integer>",
    );
    expect(value.job()?.program).toBe(
      join(value.engineRoot, "versions", value.tag, "mlx-serve"),
    );
    value.history.close();
  });

  test("rejects a bad digest and removes download artifacts", async () => {
    const value = await harness({ sha256: "0".repeat(64) });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toContain("sha256 mismatch");
    expect(
      existsSync(join(value.engineRoot, "downloads", `${value.tag}.tar.gz`)),
    ).toBeFalse();
    expect(value.bootouts()).toBe(0);
    value.history.close();
  });

  test("rejects an unexpected archive top directory", async () => {
    const value = await harness({ bytes: await archive("other") });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toContain(
      "unexpected archive top directory",
    );
    expect(value.bootouts()).toBe(0);
    value.history.close();
  });

  test("rejects a binary version mismatch", async () => {
    const value = await harness({ versionOutput: "mlx-serve 26.9.4" });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toContain(
      "version mismatch",
    );
    expect(value.bootouts()).toBe(0);
    value.history.close();
  });

  test("accepts a prerelease whose binary reports only the core version", async () => {
    const value = await installed({ tag: "v26.9.5-pre-release.1" });
    expect(value.manager.state().active?.tag).toBe("v26.9.5-pre-release.1");
    value.history.close();
  });

  test("drops the GitHub token on a cross-origin redirect", async () => {
    const bytes = await archive();
    let authorization: string | null = "not requested";
    const target = assetServer(bytes, (request) => {
      authorization = request.headers.get("authorization");
    });
    const redirect = Bun.serve({
      port: 0,
      fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer secret");
        return Response.redirect(target.url, 302);
      },
    });
    servers.push(redirect);
    const value = await installed({
      bytes,
      token: "secret",
      url: `http://localhost:${redirect.port}/asset`,
    });
    expect(authorization).toBeNull();
    value.history.close();
  });

  test("refuses a foreign listener before downloading", async () => {
    const value = await harness({ portInUse: true });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toBe(
      "Port 11234 is in use by an mlx-serve that mlx-spy did not install. Stop it first.",
    );
    expect(value.served?.hits()).toBe(0);
    value.history.close();
  });

  test("fails when health answers but the launchd job crash-loops", async () => {
    const value = await harness({ crashLoop: true, health: true });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toContain(
      "failed verification",
    );
    expect(value.store.managed()).toBeFalse();
    value.history.close();
  });

  test("fails verification for the wrong launchd program path", async () => {
    const value = await harness({ wrongProgram: true });
    value.manager.install(value.tag, value.config);
    await value.settled();
    expect(value.manager.state().failure?.message).toContain(
      "failed verification",
    );
    expect(value.manager.state().failure?.outcome).toBe("nothing is serving");
    value.history.close();
  });

  test("cancels a stalled download before the swap", async () => {
    const bytes = await archive();
    const stalled = Bun.serve({
      port: 0,
      fetch() {
        return new Response(new ReadableStream({ start() {} }), {
          headers: { "content-length": String(bytes.length) },
        });
      },
    });
    servers.push(stalled);
    const value = await harness({
      bytes,
      url: `http://127.0.0.1:${stalled.port}/asset`,
    });
    value.manager.install(value.tag, value.config);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (value.manager.state().operation?.phase === "downloading") {
        await Bun.sleep(1);
        break;
      }
      await Bun.sleep(1);
    }
    await value.manager.cancel();
    expect(value.manager.state().operation).toBeNull();
    expect(value.manager.state().failure).toBeNull();
    expect(value.bootouts()).toBe(0);
    expect(
      existsSync(
        join(value.engineRoot, "downloads", `${value.tag}.tar.gz.part`),
      ),
    ).toBeFalse();
    value.history.close();
  });

  test("cancels before the swap and refuses cancellation after it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const value = await harness({ holdReload: held });
    value.manager.install(value.tag, value.config);
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (value.manager.state().operation?.phase === "restarting") break;
      await Bun.sleep(1);
    }
    await expect(value.manager.cancel()).rejects.toMatchObject({ status: 409 });
    release();
    await value.settled();
    value.history.close();
  });
});

describe("EngineManager upgrade and configuration", () => {
  test("upgrades, keeps one previous, then rollback deletes the tree it left", async () => {
    const value = await installed();
    const bytes = await archive();
    const next = assetServer(bytes);
    value.store.setReleaseCheck(ENGINE_REPO, {
      releases: [
        {
          tag: "v26.9.6",
          version: "26.9.6",
          prerelease: false,
          publishedAt: "2026-09-21T00:00:00Z",
          assetBytes: bytes.length,
          asset: { downloadUrl: next.url, sha256: digest(bytes) },
        },
      ],
      checkedAt: 2,
      error: null,
    });
    const manager = value.manager as EngineManager;
    const original = join(value.engineRoot, "versions", "v26.9.5");
    manager.upgrade("v26.9.6");
    await value.settled();
    expect(manager.state().active?.tag).toBe("v26.9.6");
    expect(manager.state().previous?.tag).toBe("v26.9.5");
    await manager.rollback();
    expect(manager.state().active?.tag).toBe("v26.9.5");
    expect(manager.state().previous).toBeNull();
    expect(
      existsSync(join(value.engineRoot, "versions", "v26.9.6")),
    ).toBeFalse();
    expect(existsSync(original)).toBeTrue();
    value.history.close();
  });

  test("a rollback that fails keeps the build it was heading for", async () => {
    const options: HarnessOptions = {};
    const value = await installed(options);
    const bytes = await archive();
    const next = assetServer(bytes);
    value.store.setReleaseCheck(ENGINE_REPO, {
      releases: [
        {
          tag: "v26.9.6",
          version: "26.9.6",
          prerelease: false,
          publishedAt: "2026-09-21T00:00:00Z",
          assetBytes: bytes.length,
          asset: { downloadUrl: next.url, sha256: digest(bytes) },
        },
      ],
      checkedAt: 2,
      error: null,
    });
    value.manager.upgrade("v26.9.6");
    await value.settled();
    // the older build does not come up, e.g. it refuses a newer flag
    options.health = false;
    await expect(value.manager.rollback()).rejects.toMatchObject({
      status: 502,
    });
    const state = value.manager.state();
    expect(state.failure?.kind).toBe("rollback");
    expect(state.active?.tag).toBe("v26.9.6");
    // still offered, so it must still be there
    expect(state.previous?.tag).toBe("v26.9.5");
    for (const tag of ["v26.9.5", "v26.9.6"]) {
      expect(existsSync(join(value.engineRoot, "versions", tag))).toBeTrue();
    }
    // nothing was verified as serving, so the row stays for the next
    // start, which finishes the job once the engine can come up
    expect(value.store.journal()?.op).toBe("rollback");
    options.health = true;
    await value.manager.reconcile();
    expect(value.store.journal()).toBeNull();
    expect(value.manager.state().active?.tag).toBe("v26.9.6");
    expect(value.manager.state().previous?.tag).toBe("v26.9.5");
    value.history.close();
  });

  test("refuses the running tag, an older one and a second install", async () => {
    const value = await installed();
    expect(() => value.manager.upgrade(value.tag)).toThrow(/not newer/);
    expect(() => value.manager.install(value.tag, value.config)).toThrow(
      /already installed/,
    );
    expect(value.manager.state().previous).toBeNull();
    value.history.close();
  });

  test("an Apply that crashed after the restart keeps one build per slot", async () => {
    const value = await installed();
    const changed = { ...value.config, topK: 40 };
    // what a crash between the verified restart and the commit leaves
    value.store.setPending(changed);
    value.store.setJournal({
      op: "apply",
      tag: value.tag,
      step: "reload",
      previousPlist: await readFile(value.path, "utf8"),
      at: 1,
    });
    await value.manager.reconcile();
    const state = value.manager.state();
    expect(state.active?.tag).toBe(value.tag);
    expect(state.previous).toBeNull();
    expect(state.config.topK).toBe(40);
    expect(value.store.journal()).toBeNull();
    value.history.close();
  });

  test("a first install that crashed after the swap keeps its config", async () => {
    const value = await installed();
    const custom = { ...value.config, topK: 40 };
    // What a crash between the verified start and the commit leaves: the
    // job is up from the new tree, and the store knows only the pending
    // config and the journal row.
    value.store.setManaged(false);
    value.store.setInstalls(null, null);
    value.store.setApplied(null);
    value.store.setPending(custom);
    value.store.setJournal({
      op: "install",
      tag: value.tag,
      step: "reload",
      previousPlist: null,
      at: 1,
    });
    await value.manager.reconcile();
    const state = value.manager.state();
    expect(state.mode).toBe("managed");
    expect(state.active?.tag).toBe(value.tag);
    expect(state.config.topK).toBe(40);
    expect(value.store.journal()).toBeNull();
    value.history.close();
  });

  test("a restarted mlx-spy reads launchd once at start", async () => {
    const value = await installed();
    // a new process over the same store: the cache is empty
    const again = value.restarted();
    expect(again.state().service).toBeNull();
    await again.reconcile();
    expect(again.state().service?.state).toBe("running");
    value.history.close();
  });

  test("an interrupted uninstall is finished at the next start", async () => {
    const value = await installed();
    value.store.setJournal({
      op: "uninstall",
      tag: null,
      step: "uninstall",
      previousPlist: null,
      at: 1,
    });
    await value.manager.reconcile();
    expect(value.store.managed()).toBeFalse();
    expect(value.manager.state().active).toBeNull();
    expect(existsSync(value.path)).toBeFalse();
    expect(existsSync(join(value.engineRoot, "versions"))).toBeFalse();
    expect(value.store.journal()).toBeNull();
    value.history.close();
  });

  test("boots out a failed loaded job before automatic rollback", async () => {
    const options: HarnessOptions = {};
    const value = await installed(options);
    const before = value.bootouts();
    const bytes = await archive();
    const next = assetServer(bytes);
    value.store.setReleaseCheck(ENGINE_REPO, {
      releases: [
        {
          tag: "v26.9.6",
          version: "26.9.6",
          prerelease: false,
          publishedAt: "2026-09-21T00:00:00Z",
          assetBytes: bytes.length,
          asset: { downloadUrl: next.url, sha256: digest(bytes) },
        },
      ],
      checkedAt: 2,
      error: null,
    });
    options.wrongProgram = true;
    value.manager.upgrade("v26.9.6");
    await value.settled();
    expect(value.bootouts()).toBeGreaterThan(before);
    expect(value.manager.state().active?.tag).toBe("v26.9.5");
    expect(value.manager.state().failure?.outcome).toBe(
      "rolled back to 26.9.5, serving again",
    );
    expect(
      existsSync(join(value.engineRoot, "versions", "v26.9.6")),
    ).toBeFalse();
    value.history.close();
  });
  test("failed apply restores the old plist and applied config", async () => {
    const value = await installed();
    const old = await readFile(value.path, "utf8");
    const changed: EngineConfig = { ...value.config, temp: 1 };
    let calls = 0;
    const manager = new EngineManager({
      store: value.store,
      lock: value.lock,
      engineUrl: "http://127.0.0.1:11234",
      pinnedModelDir: value.pinned,
      local: true,
      engineUp: () => true,
      health: async () => false,
      log,
      version: "v1.0.0",
      probes: { processMemory: () => null },
      home: value.home,
      root: value.engineRoot,
      now: () => calls,
      sleep: async (milliseconds) => {
        calls += milliseconds;
      },
      verifyStableMs: 1,
      verifyTimeoutMs: 2,
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
      launchd: {
        reload: async (spec, deps) => {
          const previous = new Uint8Array(await readFile(value.path));
          await deps?.onBeforeBootout?.(previous);
          await Bun.write(value.path, renderPlist(spec));
        },
        print: async () => ({
          state: "running",
          pid: 1,
          program: parseLaunchdArgs(await readFile(value.path, "utf8"))[0],
          lastExitCode: 0,
        }),
        bootout: async () => {},
        bootstrap: async () => {},
        atomicWrite: async (path, data) => {
          await Bun.write(path, data);
        },
      },
    });
    await expect(manager.applyConfig(changed)).rejects.toBeInstanceOf(
      EngineManagerError,
    );
    expect(value.store.config().applied).toEqual(value.config);
    expect(await readFile(value.path, "utf8")).toBe(old);
    value.history.close();
  });

  test("reconciles a crash after the journal write", async () => {
    const value = await installed();
    const old = await readFile(value.path, "utf8");
    value.store.setJournal({
      op: "upgrade",
      tag: "v26.9.6",
      step: "reload",
      previousPlist: old,
      at: 1,
    });
    await writeFile(value.path, old);
    await value.manager.reconcile();
    expect(value.store.journal()).toBeNull();
    expect(await readFile(value.path, "utf8")).toBe(old);
    expect(value.manager.state().active?.tag).toBe("v26.9.5");
    value.history.close();
  });
});
