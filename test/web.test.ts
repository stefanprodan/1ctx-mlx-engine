import { describe, expect, test } from "bun:test";
import type {
  CacheLimits,
  Capability,
  Engine,
  EngineMetrics,
  ModelInfo,
} from "../src/engine/types.ts";
import { History } from "../src/history.ts";
import { PullError } from "../src/pull.ts";
import { handle, snapshot, type WebDeps } from "../src/web.ts";

const MODEL = "org/model";
const model: ModelInfo = {
  id: MODEL,
  loaded: true,
  state: "ready",
  bytesResident: 1,
  bytesOnDisk: 1,
  contextLength: 1000,
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
  async cacheLimits(): Promise<CacheLimits | null> {
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
// test/pull.test.ts.
function fakePulls() {
  const calls: string[] = [];
  const pull = {
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
    pull,
    list: () => [pull],
    get: (id: number) => (id === 3 ? pull : null),
    async start(repo: string) {
      calls.push(`start ${repo}`);
      if (repo === "bad") throw new PullError(400, "repo must be x");
      return pull;
    },
    async cancel(id: number) {
      calls.push(`cancel ${id}`);
      if (id !== 3) throw new PullError(404, "Pull not found");
      return { ...pull, status: "cancelled" };
    },
    async remove(id: number) {
      calls.push(`remove ${id}`);
      if (id !== 3) throw new PullError(404, "Pull not found");
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

describe("pulls API", () => {
  test("lists, starts, reads, cancels and forgets downloads", async () => {
    const s = setup();
    const runner = fakePulls();
    const deps = {
      ...s.deps,
      pulls: runner,
      modelDir: "/m",
    } as unknown as WebDeps;
    expect(snapshot(deps).pulls).toEqual([runner.pull]);
    expect(snapshot(deps).modelDir).toBe("/m");
    expect(snapshot(s.deps).pulls).toEqual([]);
    expect(snapshot(s.deps).modelDir).toBeNull();

    const list = await response(deps, "/api/pulls");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([runner.pull]);

    const started = await response(deps, "/api/pulls", "POST", {
      repo: "org/new",
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual(runner.pull);
    const refused = await response(deps, "/api/pulls", "POST", {
      repo: "bad",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "repo must be x" });
    expect(
      (await response(deps, "/api/pulls", "POST", { repo: 1 })).status,
    ).toBe(400);
    expect((await response(deps, "/api/pulls", "POST", {})).status).toBe(400);

    expect((await response(deps, "/api/pulls/3")).status).toBe(200);
    expect((await response(deps, "/api/pulls/4")).status).toBe(404);

    const cancelled = await response(deps, "/api/pulls/3/cancel", "POST");
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as any).status).toBe("cancelled");
    expect((await response(deps, "/api/pulls/4/cancel", "POST")).status).toBe(
      404,
    );
    expect((await response(deps, "/api/pulls/3/cancel")).status).toBe(405);

    const removed = await response(deps, "/api/pulls/3", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await response(deps, "/api/pulls/4", "DELETE")).status).toBe(404);
    expect((await response(deps, "/api/pulls/x")).status).toBe(404);
    expect((await response(deps, "/api/pulls/3", "PATCH")).status).toBe(405);
    expect(
      (
        await response(
          deps,
          "/api/pulls",
          "POST",
          { repo: "a/b" },
          "http://evil",
        )
      ).status,
    ).toBe(403);
    // without a runner the routes do not exist
    expect((await response(s.deps, "/api/pulls")).status).toBe(404);
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
