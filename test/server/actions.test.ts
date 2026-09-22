import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionError,
  Actions,
  clearDirContents,
} from "../../src/server/actions.ts";
import { parseMetrics, parseModels } from "../../src/server/engine/mlxserve.ts";
import type { Engine, EngineMetrics } from "../../src/server/engine/types.ts";
import { ExclusiveLock } from "../../src/server/lib/lock.ts";
import { History } from "../../src/server/monitor/history.ts";
import { Sampler } from "../../src/server/monitor/sampler.ts";
import { handle } from "../../src/server/web/index.ts";
import { ACTION_NAMES, type ActionEvent } from "../../src/shared/actions.ts";
import type { Capability, ModelInfo } from "../../src/shared/models.ts";
import metricsFixture from "../fixtures/metrics.json";
import modelsFixture from "../fixtures/models.json";
import { testLog } from "./log.ts";

const QWEN = "Jundot/Qwen3.8-27B-oQ4e-mtp";
const APODEX = "stefanprodan/Apodex-1.1-mini-oQ4e-mtp";
const ORNITH = "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp";

// An engine whose load/unload mutate its model list, as mlx-serve does.
class ControlEngine implements Engine {
  readonly id = "mlxserve" as const;
  readonly url = "http://fake:11234";
  list: ModelInfo[] = parseModels(modelsFixture);
  calls: string[] = [];
  failNext: string | null = null;
  caps: Set<Capability> = new Set([
    "load",
    "unload",
    "default",
    "restart",
    "diskClear",
    "rescan",
  ]);
  label: string | null = "com.fake.engine";
  dirs: string[] = [];

  async health() {
    return true;
  }
  async models(): Promise<ModelInfo[]> {
    return structuredClone(this.list);
  }
  async metrics(): Promise<EngineMetrics> {
    return parseMetrics(metricsFixture);
  }
  private set(id: string, loaded: boolean) {
    const m = this.list.find((m) => m.id === id)!;
    m.loaded = loaded;
    m.state = loaded ? "ready" : "unloaded";
  }
  async props() {
    return { version: "26.9.5", limits: null };
  }
  async load(id: string, asDefault: boolean) {
    this.calls.push(`load ${id} ${asDefault}`);
    if (this.failNext) throw new Error(this.failNext);
    this.set(id, true);
  }
  async unload(id: string) {
    this.calls.push(`unload ${id}`);
    if (this.failNext) throw new Error(this.failNext);
    this.set(id, false);
  }
  async rescan() {
    this.calls.push("rescan");
  }
  capabilities() {
    return this.caps;
  }
  cacheDirs() {
    return this.dirs;
  }
  logFile() {
    return null;
  }
  processNames() {
    return ["fake-engine"];
  }
  serviceLabel() {
    return this.label;
  }
}

async function setup(local = true) {
  const engine = new ControlEngine();
  const history = new History(":memory:");
  const sampler = new Sampler(engine, history, { now: () => 1000 });
  await sampler.tick();
  const logs: string[] = [];
  const spawned: string[][] = [];
  const cleared: string[] = [];
  // a real model directory: delete works on files, not on an injected fake
  const modelDir = await mkdtemp(join(tmpdir(), "1ctx-models-"));
  for (const id of [QWEN, APODEX, ORNITH]) {
    const dir = join(modelDir, ...id.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "model.safetensors"), "weights");
  }
  const forgotten: string[] = [];
  const held: string[] = [];
  let downloading: string | null = null;
  const lock = new ExclusiveLock();
  const actions = new Actions({
    engine,
    sampler,
    history,
    local,
    log: testLog((l) => logs.push(l)),
    lock,
    uid: 501,
    now: () => 5000,
    modelDir,
    downloads: () => ({
      hold: (repo) => {
        held.push(repo);
        return () => held.splice(held.indexOf(repo), 1);
      },
      blocking: (repo) =>
        repo === downloading ? `${repo} is downloading` : null,
      forget: (repo) => {
        forgotten.push(repo);
        return 1;
      },
    }),
    spawn: async (cmd) => {
      spawned.push(cmd);
      return { code: 0, stderr: "" };
    },
    clearDir: async (root) => {
      cleared.push(root);
      return 2;
    },
  });
  return {
    engine,
    history,
    sampler,
    actions,
    lock,
    logs,
    spawned,
    cleared,
    modelDir,
    forgotten,
    held,
    download: (repo: string | null) => {
      downloading = repo;
    },
  };
}

const rejects = async (p: Promise<unknown>, status: number, re: RegExp) => {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).status).toBe(status);
  expect((err as ActionError).message).toMatch(re);
};

describe("Actions", () => {
  test("unload goes through the adapter, refreshes models, logs", async () => {
    const s = await setup();
    const events: ActionEvent[] = [];
    s.actions.onEvent((e) => events.push(e));
    const ev = await s.actions.run("unload", { model: QWEN });
    expect(ev).toMatchObject({ action: "unload", model: QWEN, ok: true });
    // Ornith is still resident: it takes over as the engine's default
    expect(s.engine.calls).toEqual([`unload ${QWEN}`, `load ${ORNITH} true`]);
    expect(s.sampler.currentModels().find((m) => m.id === QWEN)?.loaded).toBe(
      false,
    );
    expect(events).toEqual([ev]);
    expect(s.actions.events).toEqual([ev]);
    expect(s.logs).toEqual([
      `level=INFO msg=action action=unload model=${QWEN} duration=0ms detail="unloaded, ${ORNITH} is the default"`,
    ]);
    s.history.close();
  });

  test("unloading the last resident model leaves no default to set", async () => {
    const s = await setup();
    await s.actions.run("unload", { model: QWEN });
    s.engine.calls = [];
    const ev = await s.actions.run("unload", { model: ORNITH });
    expect(ev.detail).toBe("unloaded");
    expect(s.engine.calls).toEqual([`unload ${ORNITH}`]);
    s.history.close();
  });

  test("the favorite takes the default over another resident model", async () => {
    const s = await setup();
    await s.actions.run("load", { model: APODEX }); // three resident in the fake
    await s.actions.run("favorite", { model: APODEX });
    s.engine.calls = [];
    await s.actions.run("unload", { model: QWEN });
    expect(s.engine.calls).toEqual([`unload ${QWEN}`, `load ${APODEX} true`]);
    s.history.close();
  });

  test("load makes the model the default", async () => {
    const s = await setup();
    await s.actions.run("load", { model: APODEX });
    await s.actions.run("default", { model: QWEN });
    expect(s.engine.calls).toEqual([
      `load ${APODEX} true`,
      `load ${QWEN} true`,
    ]);
    s.history.close();
  });

  test("favorite toggles 1ctx-mlx-engine's own mark, one model at most", async () => {
    const s = await setup(false); // no engine call: works remotely too
    const fav = () =>
      s.sampler.currentModels().find((m) => m.favorite)?.id ?? null;
    expect((await s.actions.run("favorite", { model: QWEN })).detail).toBe(
      "daily driver",
    );
    expect(fav()).toBe(QWEN);
    await s.actions.run("favorite", { model: APODEX });
    expect(fav()).toBe(APODEX);
    expect((await s.actions.run("favorite", { model: APODEX })).detail).toBe(
      "no daily driver",
    );
    expect(fav()).toBeNull();
    expect(s.engine.calls).toEqual([]);
    s.history.close();
  });

  test("model ids must name a listed model", async () => {
    const s = await setup();
    await rejects(s.actions.run("load", {}), 400, /needs a model id/);
    await rejects(
      s.actions.run("load", { model: "x/y" }),
      400,
      /unknown model/,
    );
    await rejects(
      s.actions.run("unload", { model: APODEX }),
      400,
      /not loaded/,
    );
    await rejects(s.actions.run("nuke", {}), 404, /unknown action/);
    expect(s.engine.calls).toEqual([]);
    s.history.close();
  });

  test("capabilities gate the actions", async () => {
    const s = await setup();
    s.engine.caps = new Set(["load"]);
    await rejects(s.actions.run("unload", { model: QWEN }), 403, /cannot/);
    await rejects(s.actions.run("free", {}), 403, /cannot free/);
    s.history.close();
  });

  test("free, diskClear and delete need a local engine", async () => {
    const s = await setup(false);
    await rejects(s.actions.run("free", {}), 403, /on this host/);
    await rejects(s.actions.run("diskClear", {}), 403, /on this host/);
    await rejects(
      s.actions.run("delete", { model: APODEX }),
      403,
      /on this host/,
    );
    // adapter actions still work remotely
    await s.actions.run("unload", { model: QWEN });
    expect(s.spawned).toEqual([]);
    s.history.close();
  });

  test("free runs launchctl kickstart -k on the service label", async () => {
    const s = await setup();
    const ev = await s.actions.run("free", {});
    expect(s.spawned).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/com.fake.engine"],
    ]);
    expect(ev.detail).toBe("restarted com.fake.engine");
    s.history.close();
  });

  test("free without a service label is refused", async () => {
    const s = await setup();
    s.engine.label = null;
    await rejects(s.actions.run("free", {}), 403, /not a launchd service/);
    expect(s.spawned).toEqual([]);
    s.history.close();
  });

  test("diskClear restarts first, then wipes only the adapter's dirs", async () => {
    const s = await setup();
    s.engine.dirs = ["/tmp/a", "/tmp/b"];
    const ev = await s.actions.run("diskClear", { path: "/" });
    expect(s.spawned).toHaveLength(1);
    expect(s.cleared).toEqual(["/tmp/a", "/tmp/b"]);
    expect(ev.detail).toBe("restarted, removed 4 cache dirs");
    s.history.close();
  });

  test("delete removes the checkpoint and the owner dir it empties", async () => {
    const s = await setup();
    await s.actions.run("unload", { model: QWEN });
    s.engine.calls = [];
    const ev = await s.actions.run("delete", { model: QWEN });
    expect(ev).toMatchObject({ action: "delete", model: QWEN, ok: true });
    expect(ev.detail).toMatch(/^deleted \d+\.\d GB$/);
    // Jundot held only this model; the other owner keeps its two
    expect((await readdir(s.modelDir)).sort()).toEqual(["stefanprodan"]);
    expect(await readdir(join(s.modelDir, "stefanprodan"))).toHaveLength(2);
    // the records would resume the weights back into the gap
    expect(s.forgotten).toEqual([QWEN]);
    // no download of it may start while it runs, and the hold is released
    expect(s.held).toEqual([]);
    // a rescan only adds: the engine is not asked
    expect(s.engine.calls).toEqual([]);
    s.history.close();
  });

  test("delete refuses a resident model and keeps its files", async () => {
    const s = await setup();
    await rejects(s.actions.run("delete", { model: QWEN }), 400, /is loaded/);
    expect(await readdir(join(s.modelDir, ...QWEN.split("/")))).toEqual([
      "model.safetensors",
    ]);
    expect(s.forgotten).toEqual([]);
    s.history.close();
  });

  test("delete asks the engine again: a load since the last list counts", async () => {
    const s = await setup();
    // loaded straight through the engine, after the sampler's last list
    const m = s.engine.list.find((m) => m.id === APODEX)!;
    m.loaded = true;
    m.state = "ready";
    await rejects(s.actions.run("delete", { model: APODEX }), 400, /is loaded/);
    expect(await readdir(join(s.modelDir, ...APODEX.split("/")))).toEqual([
      "model.safetensors",
    ]);
    expect(s.forgotten).toEqual([]);
    expect(s.held).toEqual([]);
    s.history.close();
  });

  test("delete refuses while the repo is downloading", async () => {
    const s = await setup();
    s.download(APODEX);
    await rejects(
      s.actions.run("delete", { model: APODEX }),
      409,
      /is downloading/,
    );
    expect(await readdir(join(s.modelDir, ...APODEX.split("/")))).toEqual([
      "model.safetensors",
    ]);
    s.history.close();
  });

  test("delete refuses a model that is not in the model directory", async () => {
    const s = await setup();
    // the engine scans it from somewhere this program did not download into
    await rm(join(s.modelDir, ...APODEX.split("/")), { recursive: true });
    await rejects(
      s.actions.run("delete", { model: APODEX }),
      404,
      /is not in /,
    );
    s.history.close();
  });

  test("a deleted model stays listed, marked, and cannot load", async () => {
    const s = await setup();
    await s.actions.run("favorite", { model: APODEX });
    await s.actions.run("delete", { model: APODEX });
    // a daily driver that cannot load is no daily driver
    expect(s.history.favorite()).toBeNull();
    const row = () => s.sampler.currentModels().find((m) => m.id === APODEX);
    // the fake engine still lists it, as mlx-serve does after a rescan
    await s.sampler.refreshModels();
    expect(row()).toMatchObject({ deleted: true, state: "deleted" });
    for (const name of ["load", "default", "delete", "favorite"] as const) {
      await rejects(s.actions.run(name, { model: APODEX }), 400, /is deleted/);
    }
    // our own restart keeps the mark: the engine process is the same
    const again = new Sampler(s.engine, s.history, { now: () => 1000 });
    await again.tick();
    expect(again.currentModels().find((m) => m.id === APODEX)?.deleted).toBe(
      true,
    );
    // a download of the same repo puts the files back
    s.sampler.unmarkDeleted(APODEX);
    expect(row()?.deleted).toBeUndefined();
    expect(row()?.state).not.toBe("deleted");
    s.history.close();
  });

  test("a new engine process drops a mark only once the files are back", async () => {
    const s = await setup();
    const epoch = s.sampler.currentEpoch();
    // a mark from another epoch: a restart detected after the delete, which
    // may have walked the directory while the files were still there
    s.history.saveDeleted(new Map([[APODEX, epoch + 1]]));
    const gone = new Sampler(s.engine, s.history, {
      now: () => 1000,
      modelOnDisk: () => false,
    });
    await gone.tick();
    expect(gone.currentModels().find((m) => m.id === APODEX)?.deleted).toBe(
      true,
    );
    // the mark moves to the epoch it was checked in
    expect(s.history.loadDeleted().get(APODEX)).toBe(epoch);
    s.history.saveDeleted(new Map([[APODEX, epoch + 1]]));
    const back = new Sampler(s.engine, s.history, {
      now: () => 1000,
      modelOnDisk: (id) => id === APODEX,
    });
    await back.tick();
    expect(
      back.currentModels().find((m) => m.id === APODEX)?.deleted,
    ).toBeUndefined();
    expect(s.history.loadDeleted().size).toBe(0);
    s.history.close();
  });

  test("a deleted model that is resident keeps the mark, only unload", async () => {
    const s = await setup();
    await s.actions.run("delete", { model: APODEX });
    // its unlinked weights mapped by a load that raced the delete
    const m = s.engine.list.find((m) => m.id === APODEX)!;
    m.loaded = true;
    m.state = "ready";
    await s.sampler.refreshModels();
    const row = s.sampler.currentModels().find((m) => m.id === APODEX);
    expect(row).toMatchObject({ deleted: true, state: "ready" });
    await rejects(
      s.actions.run("favorite", { model: APODEX }),
      400,
      /is deleted/,
    );
    const ev = await s.actions.run("unload", { model: APODEX });
    expect(ev.ok).toBe(true);
    s.history.close();
  });

  test("a mark goes when the engine stops listing the model", async () => {
    const s = await setup();
    await s.actions.run("delete", { model: APODEX });
    s.engine.list = s.engine.list.filter((m) => m.id !== APODEX);
    await s.sampler.refreshModels();
    expect(s.history.loadDeleted().size).toBe(0);
    s.history.close();
  });

  test("a failed spawn is a 502 with the exit code", async () => {
    const s = await setup();
    const actions = new Actions({
      engine: s.engine,
      sampler: s.sampler,
      history: s.history,
      local: true,
      log: testLog(() => {}),
      spawn: async () => ({ code: 3, stderr: "no such service" }),
    });
    await rejects(actions.run("free", {}), 502, /exited 3: no such service/);
    expect(actions.events[0]).toMatchObject({ ok: false, action: "free" });
    s.history.close();
  });

  test("an engine error is logged and answered 502", async () => {
    const s = await setup();
    s.engine.failNext = "HTTP 500 out of memory";
    await rejects(s.actions.run("load", { model: APODEX }), 502, /HTTP 500/);
    expect(s.logs[0]).toStartWith(
      `level=WARN msg="action failed" action=load model=${APODEX} duration=0ms error_type=Error error="HTTP 500 out of memory"`,
    );
    s.history.close();
  });

  test("one action at a time", async () => {
    const s = await setup();
    let release!: () => void;
    s.engine.load = () =>
      new Promise((r) => {
        release = r;
      });
    const first = s.actions.run("load", { model: APODEX });
    await Bun.sleep(0);
    expect(s.actions.running()).toBe("load");
    await rejects(
      s.actions.run("unload", { model: QWEN }),
      409,
      /load is still running/,
    );
    release();
    await first;
    expect(s.actions.running()).toBeNull();
    s.history.close();
  });

  test("the manager lock refuses every action", async () => {
    const s = await setup();
    let release!: () => void;
    const held = s.lock.run(
      "upgrade",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Bun.sleep(0);
    for (const name of ACTION_NAMES) {
      const body =
        name === "unload"
          ? { model: QWEN }
          : name === "load" ||
              name === "default" ||
              name === "favorite" ||
              name === "delete"
            ? { model: APODEX }
            : {};
      await rejects(s.actions.run(name, body), 409, /upgrade is still running/);
    }
    release();
    await held;
    expect(s.engine.calls).toEqual([]);
    s.history.close();
  });
  test("busy holds through the model refresh after the action", async () => {
    const s = await setup();
    let release!: (list: ModelInfo[]) => void;
    const list = await s.engine.models();
    s.engine.models = () =>
      new Promise((r) => {
        release = r;
      });
    const first = s.actions.run("load", { model: APODEX });
    await Bun.sleep(0);
    // the adapter call is done, the refresh of the list is not
    expect(s.engine.calls).toEqual([`load ${APODEX} true`]);
    expect(s.actions.running()).toBe("load");
    await rejects(
      s.actions.run("unload", { model: QWEN }),
      409,
      /load is still running/,
    );
    release(list);
    await first;
    expect(s.actions.running()).toBeNull();
    s.history.close();
  });

  test("the route answers with the action's status", async () => {
    const s = await setup();
    const deps = {
      engine: s.engine,
      sampler: s.sampler,
      history: s.history,
      actions: s.actions,
      version: "vtest",
      local: true,
      currentLimits: () => s.sampler.currentLimits(),
      host: null,
    };
    const post = (name: string, body?: unknown) =>
      handle(
        new Request(`http://x/api/actions/${name}`, {
          method: "POST",
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        deps,
      );
    const ok = await post("unload", { model: QWEN });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ActionEvent).ok).toBe(true);
    expect((await post("free")).status).toBe(200);
    expect((await post("load", { model: "nope" })).status).toBe(400);
    expect((await post("bogus")).status).toBe(404);
    const snap = await handle(new Request("http://x/api/snapshot"), deps);
    expect(((await snap.json()) as any).events).toHaveLength(2);
    s.history.close();
  });

  test("requestsClear wipes the requests, keeps the samples", async () => {
    const { actions, history } = await setup(false);
    history.addRequest({
      startedAt: 1,
      finishedAt: 2,
      count: 1,
      cancelled: false,
      generated: 10,
      promptTokens: 5,
      prefillTokens: 5,
      prefillMs: 100,
      decodeMs: 200,
      ttftMs: 100,
      model: "org/model",
    });
    expect(history.requests()).toHaveLength(1);
    const ev = await actions.run("requestsClear", {});
    expect(ev.ok).toBe(true);
    expect(ev.detail).toBe("removed 1 request");
    expect(history.requests()).toEqual([]);
    expect(history.count()).toBe(1);
    expect(history.loadSamplerState().lastRequest).toBeNull();
    history.close();
  });
});

describe("clearDirContents", () => {
  test("removes children, keeps the root, tolerates a missing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "1ctx-mlx-engine-cache-"));
    await writeFile(join(root, "a"), "x");
    await Bun.write(join(root, "fp1", "shard"), "y");
    expect(await clearDirContents(root)).toBe(2);
    expect(await readdir(root)).toEqual([]);
    expect(await clearDirContents(join(root, "missing"))).toBe(0);
  });

  test("historyClear wipes the samples, keeps the sampler state", async () => {
    // a remote engine too: nothing here touches it
    const { actions, history } = await setup(false);
    expect(history.count()).toBe(1);
    const ev = await actions.run("historyClear", {});
    expect(ev.ok).toBe(true);
    expect(ev.detail).toBe("removed 1 sample");
    expect(history.count()).toBe(0);
    expect(history.latest()).toBeNull();
    expect(history.loadSamplerState().epoch).toBe(0);
    // the last request went with the history: the next sample cannot put
    // it back on the page
    expect(history.loadSamplerState().lastRequest).toBeNull();
    expect(history.requests()).toEqual([]);
    history.close();
  });
});
