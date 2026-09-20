import { describe, expect, test } from "bun:test";
import { BenchmarkError } from "../../../src/server/benchmark/runner.ts";
import { DEFAULTS } from "../../../src/server/engine/config.ts";
import { EngineManagerError } from "../../../src/server/engine/manager/index.ts";
import type {
  Engine,
  EngineMetrics,
} from "../../../src/server/engine/types.ts";
import { DownloadError } from "../../../src/server/models/error.ts";
import { History } from "../../../src/server/monitor/history.ts";
import type { WebDeps } from "../../../src/server/web/deps.ts";
import { handle, snapshot } from "../../../src/server/web/index.ts";
import type {
  CacheLimits,
  Capability,
  ModelInfo,
} from "../../../src/shared/models.ts";

const MODEL = "org/model";
const model: ModelInfo = {
  id: MODEL,
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 1,
  contextLength: 1000,
  quantization: null,
  capabilities: ["chat"],
};

class WebEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake";

  async health() {
    return true;
  }
  async models() {
    return [model];
  }
  async metrics(): Promise<EngineMetrics> {
    throw new Error("unused");
  }
  async load() {}
  async unload() {}
  capabilities(): Set<Capability> {
    return new Set(["load", "unload"]);
  }
  cacheDirs() {
    return [];
  }
  logFile() {
    return null;
  }
  processNames() {
    return [];
  }
  serviceLabel() {
    return null;
  }
}

function setup() {
  const engine = new WebEngine();
  const history = new History(":memory:");
  const sampler = {
    currentModels: () => [model],
    currentDisk: () => [],
    currentVersion: () => "26.9.5",
    currentLimits: () => null,
    onSample: () => () => {},
  };
  const actions = {
    events: [],
    running: () => null,
    onEvent: () => () => {},
  };
  const deps = {
    engine,
    history,
    sampler,
    actions,
    version: "vtest",
    local: true,
    currentLimits: () => sampler.currentLimits(),
    host: null,
  } as unknown as WebDeps;
  return { engine, history, deps };
}

function request(
  path: string,
  method = "GET",
  value?: unknown,
  origin?: string,
) {
  const headers = new Headers();
  headers.set("host", "x");
  if (origin) headers.set("origin", origin);
  if (value !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

async function response(
  deps: WebDeps,
  path: string,
  method = "GET",
  value?: unknown,
  origin?: string,
) {
  const result = await handle(request(path, method, value, origin), deps);
  expect(result.headers.get("cache-control")).toBe("no-store");
  return result;
}

// A runner with the surface the routes use; the real one is tested in
// test/server/models/download.test.ts.
function fakeDownloads() {
  const calls: string[] = [];
  const download = {
    id: 3,
    repo: "org/new",
    revision: "abc",
    dir: "/m/org/new",
    status: "queued" as const,
    bytesTotal: 10,
    bytesDone: 0,
    filesTotal: 1,
    filesDone: 0,
    file: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    speedBps: null,
  };
  return {
    calls,
    download,
    list: () => [download],
    get: (id: number) => (id === 3 ? download : null),
    async start(repo: string) {
      calls.push(`start ${repo}`);
      if (repo === "bad") throw new DownloadError(400, "repo must be x");
      return download;
    },
    async cancel(id: number) {
      calls.push(`cancel ${id}`);
      if (id !== 3) throw new DownloadError(404, "Download not found");
      return { ...download, status: "cancelled" };
    },
    async remove(id: number) {
      calls.push(`remove ${id}`);
      if (id !== 3) throw new DownloadError(404, "Download not found");
    },
    onEvent: () => () => {},
  };
}

describe("snapshot", () => {
  test("reads current engine limits each time", () => {
    const s = setup();
    let limits: CacheLimits | null = { hotBytes: 1, diskBytes: 2 };
    s.deps.sampler.currentLimits = () => limits;
    expect(snapshot(s.deps).engine.limits).toEqual(limits);

    limits = { hotBytes: 3, diskBytes: 4 };
    expect(snapshot(s.deps).engine.limits).toEqual(limits);
    s.history.close();
  });
});

describe("downloads API", () => {
  test("the snapshot says what the manager makes of the engine", () => {
    const s = setup();
    // without a manager there is nothing to say
    expect(snapshot(s.deps).engine.mode).toBeNull();
    const bare = {
      ...s.deps,
      manager: { state: () => ({ mode: "absent", active: null }) },
    } as unknown as WebDeps;
    expect(snapshot(bare).engine.mode).toBe("absent");
    const managed = {
      ...s.deps,
      manager: {
        state: () => ({ mode: "managed", active: { version: "26.9.4" } }),
      },
    } as unknown as WebDeps;
    expect(snapshot(managed).engine).toMatchObject({
      mode: "managed",
      version: "26.9.4",
    });
  });

  test("lists, starts, reads, cancels and forgets downloads", async () => {
    const s = setup();
    const runner = fakeDownloads();
    const deps = {
      ...s.deps,
      downloads: runner,
      modelDir: "/m",
    } as unknown as WebDeps;
    expect(snapshot(deps).downloads).toEqual([runner.download]);
    expect(snapshot(deps).modelDir).toBe("/m");
    expect(snapshot(s.deps).downloads).toEqual([]);
    expect(snapshot(s.deps).modelDir).toBeNull();

    const list = await response(deps, "/api/downloads");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([runner.download]);

    const started = await response(deps, "/api/downloads", "POST", {
      repo: "org/new",
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual(runner.download);
    const refused = await response(deps, "/api/downloads", "POST", {
      repo: "bad",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "repo must be x" });
    expect(
      (await response(deps, "/api/downloads", "POST", { repo: 1 })).status,
    ).toBe(400);
    expect((await response(deps, "/api/downloads", "POST", {})).status).toBe(
      400,
    );

    expect((await response(deps, "/api/downloads/3")).status).toBe(200);
    expect((await response(deps, "/api/downloads/4")).status).toBe(404);

    const cancelled = await response(deps, "/api/downloads/3/cancel", "POST");
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as any).status).toBe("cancelled");
    expect(
      (await response(deps, "/api/downloads/4/cancel", "POST")).status,
    ).toBe(404);
    expect((await response(deps, "/api/downloads/3/cancel")).status).toBe(405);

    const removed = await response(deps, "/api/downloads/3", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await response(deps, "/api/downloads/4", "DELETE")).status).toBe(
      404,
    );
    expect((await response(deps, "/api/downloads/x")).status).toBe(404);
    expect((await response(deps, "/api/downloads/3", "PATCH")).status).toBe(
      405,
    );
    expect(
      (
        await response(
          deps,
          "/api/downloads",
          "POST",
          { repo: "a/b" },
          "http://evil",
        )
      ).status,
    ).toBe(403);
    // without a runner the routes do not exist
    expect((await response(s.deps, "/api/downloads")).status).toBe(404);
    expect(runner.calls).toEqual([
      "start org/new",
      "start bad",
      "cancel 3",
      "cancel 4",
      "remove 3",
      "remove 4",
    ]);
    s.history.close();
  });
});

// A manager with the surface the routes use; the real one is tested in
// test/engine/install.test.ts.
function fakeManager(options: { remote?: boolean; busy?: string } = {}) {
  const calls: string[] = [];
  const state = { engine: { mode: "managed" }, self: { version: "vtest" } };
  const guard = () => {
    if (options.remote) {
      throw new EngineManagerError(403, "mlx-serve is not on this host");
    }
  };
  const act =
    (name: string) =>
    (...args: unknown[]) => {
      guard();
      calls.push(`${name}:${JSON.stringify(args)}`);
      return state;
    };
  const manager = {
    pageState: () => state,
    running: () => options.busy ?? null,
    check: act("check"),
    install: act("install"),
    upgrade: act("upgrade"),
    cancel: act("cancel"),
    applyConfig: (config: { port: number }) => {
      guard();
      if (config.port !== 11234) {
        throw new EngineManagerError(422, "configuration refused", [
          { field: "port", message: "1ctx-mlx-engine is watching port 11234." },
        ]);
      }
      calls.push("applyConfig");
      return state;
    },
    setPreReleases: act("setPreReleases"),
    service: act("service"),
    rollback: act("rollback"),
    dismiss: act("dismiss"),
    uninstall: act("uninstall"),
  };
  return { manager, calls, state };
}

describe("engine management routes", () => {
  const withManager = (options: Parameters<typeof fakeManager>[0] = {}) => {
    const { deps, history } = setup();
    const fake = fakeManager(options);
    const exits: number[] = [];
    const next = {
      ...deps,
      manager: fake.manager,
      selfRestart: {
        isLaunchd: () => true,
        exit: (code: number) => exits.push(code),
        delayMs: 0,
      },
    } as unknown as WebDeps;
    return { deps: next, history, exits, ...fake };
  };

  test("reads answer the page state, writes reach the manager", async () => {
    const { deps, calls, state, history } = withManager();
    const read = await response(deps, "/api/engine");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(state);
    const config = DEFAULTS("/m", "http://127.0.0.1:11234");
    const install = await response(deps, "/api/engine/install", "POST", {
      tag: "v26.9.4",
      config,
    });
    expect(install.status).toBe(202);
    expect(
      (await response(deps, "/api/engine/upgrade", "POST", { tag: "v1.0.0" }))
        .status,
    ).toBe(202);
    for (const [path, method, value] of [
      ["/api/engine/check", "POST", undefined],
      ["/api/engine/cancel", "POST", undefined],
      ["/api/engine/config", "PUT", config],
      ["/api/engine/settings", "PUT", { preReleases: true }],
      ["/api/engine/service", "POST", { op: "stop" }],
      ["/api/engine/rollback", "POST", undefined],
      ["/api/engine/dismiss", "POST", undefined],
      ["/api/engine", "DELETE", undefined],
    ] as const) {
      const result = await response(deps, path, method, value);
      expect(`${path} ${result.status}`).toBe(`${path} 200`);
    }
    expect(calls).toEqual([
      `install:${JSON.stringify(["v26.9.4", config])}`,
      'upgrade:["v1.0.0"]',
      "check:[]",
      "cancel:[]",
      "applyConfig",
      "setPreReleases:[true]",
      'service:["stop"]',
      "rollback:[]",
      "dismiss:[]",
      "uninstall:[]",
    ]);
    history.close();
  });

  test("bad bodies, wrong methods and typos are told apart", async () => {
    const { deps, calls, history } = withManager();
    const status = async (
      path: string,
      method: string,
      value?: unknown,
      origin?: string,
    ) => (await response(deps, path, method, value, origin)).status;
    expect(await status("/api/engine/service", "POST", { op: "kill" })).toBe(
      400,
    );
    expect(await status("/api/engine/settings", "PUT", {})).toBe(400);
    expect(await status("/api/engine/install", "POST", { tag: 1 })).toBe(400);
    expect(await status("/api/engine/rollback", "GET")).toBe(405);
    expect(await status("/api/engine/typo", "GET")).toBe(404);
    expect(
      await status("/api/engine/rollback", "POST", undefined, "http://evil"),
    ).toBe(403);
    expect(
      await status("/api/self/restart", "POST", undefined, "http://evil"),
    ).toBe(403);
    expect(calls).toEqual([]);
    history.close();
  });

  test("a refused configuration is 422 with the issues", async () => {
    const { deps, history } = withManager();
    const result = await response(deps, "/api/engine/config", "PUT", {
      ...DEFAULTS("/m", "http://127.0.0.1:11234"),
      port: 11500,
    });
    expect(result.status).toBe(422);
    expect(await result.json()).toEqual({
      error: "configuration refused",
      issues: [
        { field: "port", message: "1ctx-mlx-engine is watching port 11234." },
      ],
    });
    history.close();
  });

  test("a remote engine: writes are 403, the read and 1ctx-mlx-engine's restart work", async () => {
    const { deps, exits, history } = withManager({ remote: true });
    expect((await response(deps, "/api/engine")).status).toBe(200);
    expect((await response(deps, "/api/engine/rollback", "POST")).status).toBe(
      403,
    );
    expect((await response(deps, "/api/engine", "DELETE")).status).toBe(403);
    expect((await response(deps, "/api/self/restart", "POST")).status).toBe(
      200,
    );
    await Bun.sleep(5);
    expect(exits).toEqual([0]);
    history.close();
  });

  test("1ctx-mlx-engine's restart is refused mid-operation and outside launchd", async () => {
    const busy = withManager({ busy: "upgrade" });
    const held = await response(busy.deps, "/api/self/restart", "POST");
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "upgrade is still running" });
    busy.history.close();
    const plain = withManager();
    (plain.deps.selfRestart as { isLaunchd: () => boolean }).isLaunchd = () =>
      false;
    const refused = await response(plain.deps, "/api/self/restart", "POST");
    expect(refused.status).toBe(409);
    await Bun.sleep(5);
    expect(busy.exits).toEqual([]);
    expect(plain.exits).toEqual([]);
    plain.history.close();
  });
});

describe("benchmarks API", () => {
  const benchmark = { id: 7, status: "running", model: MODEL };
  const progress = { benchmark, repetition: 1, turn: 2, done: [] };
  function fakeBenchmarks() {
    const calls: string[] = [];
    return {
      calls,
      active: () => progress,
      list: () => [benchmark],
      start: (value: unknown) => {
        calls.push(`start ${JSON.stringify(value)}`);
        return benchmark;
      },
      detail: (id: number) => {
        if (id !== 7) throw new BenchmarkError(404, "Benchmark not found");
        return { benchmark, turns: [] };
      },
      cancel: (id: number) => {
        calls.push(`cancel ${id}`);
      },
      remove: (id: number) => {
        calls.push(`remove ${id}`);
        throw new BenchmarkError(409, "The benchmark is still running");
      },
    };
  }

  test("lists, starts, reads, cancels and refuses a delete", async () => {
    const s = setup();
    const runner = fakeBenchmarks();
    const deps = { ...s.deps, benchmarks: runner } as unknown as WebDeps;
    expect(snapshot(deps).benchmark).toEqual(progress as never);
    expect(snapshot(s.deps).benchmark).toBeNull();

    const list = await response(deps, "/api/benchmarks");
    expect(await list.json()).toEqual([benchmark]);
    const started = await response(deps, "/api/benchmarks", "POST", {
      model: MODEL,
      preset: "40K",
    });
    expect(started.status).toBe(202);
    expect(runner.calls).toEqual([`start {"model":"${MODEL}","preset":"40K"}`]);
    const one = await response(deps, "/api/benchmarks/7");
    expect(await one.json()).toEqual({ benchmark, turns: [] });
    expect((await response(deps, "/api/benchmarks/8")).status).toBe(404);
    const cancelled = await response(deps, "/api/benchmarks/7/cancel", "POST");
    expect(await cancelled.json()).toEqual({ ok: true });
    const removed = await response(deps, "/api/benchmarks/7", "DELETE");
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({
      error: "The benchmark is still running",
    });
    expect((await response(deps, "/api/benchmarks", "PUT")).status).toBe(405);
    // without a runner the routes are not there
    expect((await response(s.deps, "/api/benchmarks")).status).toBe(404);
  });

  test("a start from another origin is refused", async () => {
    const s = setup();
    const deps = {
      ...s.deps,
      benchmarks: fakeBenchmarks(),
    } as unknown as WebDeps;
    const res = await handle(
      request("/api/benchmarks", "POST", { model: MODEL }, "http://evil"),
      deps,
    );
    expect(res.status).toBe(403);
  });
});
