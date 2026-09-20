import { describe, expect, test } from "bun:test";
import {
  limitsFromArgs,
  MlxServe,
  parseLaunchdArgs,
  parseMetrics,
  parseModels,
  parseProps,
  parseSize,
} from "../src/engine/mlxserve.ts";
import metricsFixture from "./fixtures/metrics.json";
import modelsFixture from "./fixtures/models.json";
import propsFixture from "./fixtures/props.json";

describe("parseMetrics", () => {
  const m = parseMetrics(metricsFixture);

  test("normalises counters", () => {
    expect(m.counters.promptTokens).toBe(42781);
    expect(m.counters.prefillTokens).toBe(848);
    expect(m.counters.cachedPromptTokens).toBe(41933);
    expect(m.counters.generationTokens).toBe(26);
    expect(m.counters.requestsSuccess).toBe(1);
    expect(m.counters.cacheQueries).toBe(1);
    expect(m.counters.cacheHits).toBe(1);
  });

  test("converts memory_mb to bytes and keeps allocator gauges", () => {
    expect(m.gauges.memoryBytes).toBe(39439 * 1024 * 1024);
    expect(m.gauges.mlxActiveBytes).toBe(40846363996);
    expect(m.gauges.mlxCacheBytes).toBe(78704656);
    expect(m.gauges.generationTokensLive).toBe(26);
    expect(m.gauges.requestsRunning).toBe(0);
  });

  test("keeps histogram count and sum", () => {
    expect(m.histograms.ttftSeconds.count).toBe(1);
    expect(m.histograms.ttftSeconds.sum).toBeCloseTo(11.2586, 3);
    expect(m.histograms.decodeTimeSeconds.sum).toBeCloseTo(1.2063, 3);
  });

  test("tolerates a missing or malformed body", () => {
    const empty = parseMetrics({});
    expect(empty.counters.promptTokens).toBe(0);
    expect(empty.gauges.memoryBytes).toBe(0);
    expect(empty.histograms.ttftSeconds).toEqual({ count: 0, sum: 0 });
    expect(parseMetrics(null).gauges.gpuPct).toBe(0);
  });
});

describe("parseModels", () => {
  const models = parseModels(modelsFixture);

  test("maps every listed model", () => {
    expect(models.map((m) => m.id)).toEqual([
      "Jundot/Qwen3.8-27B-oQ4e-mtp",
      "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp",
      "stefanprodan/Apodex-1.1-mini-oQ4e-mtp",
    ]);
  });

  test("carries residency and sizes", () => {
    const [qwen, , apodex] = models;
    expect(qwen.loaded).toBe(true);
    expect(qwen.state).toBe("ready");
    expect(qwen.bytesResident).toBe(16971681558);
    expect(qwen.contextLength).toBe(133120);
    expect(qwen.capabilities).toContain("tool_use");
    expect(apodex.capabilities).not.toContain("reasoning");
    expect(apodex.loaded).toBe(false);
    expect(apodex.state).toBe("unloaded");
    expect(apodex.bytesResident).toBe(0);
    expect(apodex.bytesOnDisk).toBe(21612875019);
  });

  test("leaves isDefault unknown (mlx-serve does not expose it)", () => {
    for (const m of models) expect(m.isDefault).toBeUndefined();
  });

  test("ignores entries without an id and empty bodies", () => {
    expect(parseModels({ data: [{ loaded: true }] })).toEqual([]);
    expect(parseModels(undefined)).toEqual([]);
  });
});

describe("launch configuration", () => {
  const GiB = 1024 ** 3;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ddalcu.mlx-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/mlx-serve</string>
    <string>--serve</string>
    <string>--model-dir</string>
    <string>/Users/x/models &amp; more</string>
    <string>--prefix-cache-mem</string>
    <string>16GB</string>
    <string>--prefix-cache-disk</string>
    <string>50GB</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
</dict>
</plist>`;

  test("parseSize follows the engine's grammar", () => {
    expect(parseSize("16GB")).toBe(16 * GiB);
    expect(parseSize("512mb")).toBe(512 * 1024 ** 2);
    expect(parseSize("8KB")).toBe(8192);
    expect(parseSize("4096")).toBe(4096);
    expect(parseSize("off")).toBe(0);
    expect(parseSize("0")).toBe(0);
    expect(parseSize("16 GB")).toBe(16 * GiB);
    expect(parseSize("lots")).toBeNull();
    expect(parseSize("GB")).toBeNull();
  });

  test("parseLaunchdArgs reads only ProgramArguments", () => {
    const args = parseLaunchdArgs(plist);
    expect(args[0]).toBe("/opt/homebrew/bin/mlx-serve");
    expect(args).toContain("/Users/x/models & more");
    expect(args).not.toContain("/usr/bin");
    expect(parseLaunchdArgs("<plist/>")).toEqual([]);
  });

  test("limitsFromArgs takes the flags, with the engine's defaults", () => {
    expect(limitsFromArgs(parseLaunchdArgs(plist))).toEqual({
      hotBytes: 16 * GiB,
      diskBytes: 50 * GiB,
    });
    expect(limitsFromArgs(["mlx-serve", "--serve"])).toEqual({
      hotBytes: 2 * GiB,
      diskBytes: 0,
    });
    expect(limitsFromArgs(["--prefix-cache-mem=4GB"]).hotBytes).toBe(4 * GiB);
    expect(limitsFromArgs(["--prefix-cache-disk", "off"]).diskBytes).toBe(0);
    // a malformed value keeps the default rather than poisoning the tile
    expect(limitsFromArgs(["--prefix-cache-mem", "big"]).hotBytes).toBe(
      2 * GiB,
    );
  });
});

describe("parseProps", () => {
  const GiB = 1024 ** 3;

  test("takes the build and the budgets of the running process", () => {
    expect(parseProps(propsFixture)).toEqual({
      version: "26.9.5-pre-release.1",
      limits: { hotBytes: 16 * GiB, diskBytes: 50 * GiB },
    });
  });

  test("the recorded budgets are the ones the plist asks for", () => {
    // the two sources must agree, or the tiles would move when the engine
    // answers instead of the plist
    const props = parseProps(propsFixture);
    expect(props.limits).toEqual(
      limitsFromArgs([
        "--prefix-cache-mem",
        "16GB",
        "--prefix-cache-disk",
        "50GB",
      ]),
    );
  });

  test("tolerates a body without settings", () => {
    expect(parseProps({})).toEqual({ version: null, limits: null });
    expect(parseProps(null)).toEqual({ version: null, limits: null });
    expect(parseProps({ settings: { version: 7, prefix_cache: {} } })).toEqual({
      version: null,
      limits: null,
    });
  });
});

describe("the adapter over HTTP", () => {
  // a stand-in engine, so the client and its routes are exercised, not
  // just the parsers
  function serve(routes: Record<string, unknown>) {
    return Bun.serve({
      port: 0,
      fetch(req) {
        const body = routes[new URL(req.url).pathname];
        return body === undefined
          ? new Response("nope", { status: 404 })
          : Response.json(body);
      },
    });
  }

  test("props() asks /props and keeps what matters", async () => {
    const server = serve({ "/props": propsFixture });
    const engine = new MlxServe(server.url.origin);
    expect(await engine.props()).toEqual({
      version: "26.9.5-pre-release.1",
      limits: { hotBytes: 16 * 1024 ** 3, diskBytes: 50 * 1024 ** 3 },
    });
    await server.stop(true);
  });

  test("props() is null when the engine has no such endpoint", async () => {
    const server = serve({ "/health": { status: "ok" } });
    const engine = new MlxServe(server.url.origin);
    expect(await engine.props()).toBeNull();
    await server.stop(true);
  });

  test("health, models and metrics go to their own routes", async () => {
    const server = serve({
      "/health": { status: "ok" },
      "/v1/models": modelsFixture,
      "/metrics.json": metricsFixture,
    });
    const engine = new MlxServe(server.url.origin);
    expect(await engine.health()).toBe(true);
    expect(await engine.models()).toHaveLength(3);
    expect((await engine.metrics()).counters.promptTokens).toBe(42781);
    await server.stop(true);
  });
});
