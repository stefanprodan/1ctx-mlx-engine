// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  configToArgs,
  DEFAULTS,
  limitsFromArgs,
  parseLaunchdArgs,
  parseSize,
  validateConfig,
} from "../../../src/server/engine/config.ts";
import { parseProps } from "../../../src/server/engine/mlxserve.ts";
import type { EngineConfig } from "../../../src/shared/engine.ts";
import propsFixture from "../../fixtures/props.json";

const PINNED = "/Users/x/models";

function config(over: Partial<EngineConfig> = {}): EngineConfig {
  return { ...DEFAULTS(PINNED, "http://127.0.0.1:11234"), ...over };
}

function issues(value: EngineConfig) {
  return validateConfig(value, {
    pinnedModelDir: PINNED,
    watchedPort: 11234,
    engineHost: "127.0.0.1",
  });
}

describe("managed engine configuration", () => {
  test("defaults follow the watched engine", () => {
    expect(DEFAULTS(PINNED, "http://127.0.0.1:11234")).toEqual({
      host: "127.0.0.1",
      port: 11234,
      modelDirs: [PINNED],
      prefixCacheMem: null,
      prefixCacheDisk: null,
      prefixCacheEntries: null,
      maxResidentModels: null,
      maxResidentMem: null,
      ctxSize: null,
      idleEvictSeconds: null,
      temp: null,
      topP: null,
      topK: null,
      kvQuant: "off",
      mtp: false,
      pld: true,
      noVision: false,
      logLevel: "info",
      extraArgs: [],
    });
    expect(DEFAULTS(PINNED, "http://studio.local:12000")).toMatchObject({
      host: "0.0.0.0",
      port: 12000,
    });
    expect(DEFAULTS(PINNED, "http://[::1]:11234").host).toBe("127.0.0.1");
  });

  test("renders every typed field before split extra arguments", () => {
    const args = configToArgs(
      config({
        host: "0.0.0.0",
        modelDirs: [PINNED, "/Volumes/models"],
        prefixCacheMem: "16GB",
        prefixCacheDisk: "50GB",
        prefixCacheEntries: 64,
        maxResidentModels: 2,
        maxResidentMem: "80GB",
        ctxSize: 131072,
        idleEvictSeconds: 3600,
        temp: 1,
        topP: 0.95,
        topK: 40,
        kvQuant: "8",
        mtp: true,
        pld: false,
        noVision: true,
        logLevel: "debug",
        extraArgs: ["--timeout 60", "--config-overrides '{\"x\": 1}'"],
      }),
      "/Users/x/.mlx-serve/logs/mlx-serve-11234.log",
    );
    expect(args).toEqual([
      "--serve",
      "--metrics",
      "--host",
      "0.0.0.0",
      "--port",
      "11234",
      "--model-dir",
      PINNED,
      "--model-dir",
      "/Volumes/models",
      "--prefix-cache-mem",
      "16GB",
      "--prefix-cache-disk",
      "50GB",
      "--prefix-cache-entries",
      "64",
      "--max-resident-models",
      "2",
      "--max-resident-mem",
      "80GB",
      "--ctx-size",
      "131072",
      "--idle-evict-secs",
      "3600",
      "--temp",
      "1",
      "--top-p",
      "0.95",
      "--top-k",
      "40",
      "--kv-quant",
      "8",
      "--no-vision",
      "--no-pld",
      "--mtp",
      "--log-file",
      "/Users/x/.mlx-serve/logs/mlx-serve-11234.log",
      "--log-level",
      "debug",
      "--timeout",
      "60",
      "--config-overrides",
      '{"x": 1}',
    ]);
  });

  test("refuses typed and secret flags in extra arguments", () => {
    for (const line of [
      "--port 9000",
      "--api-key=secret",
      "--timeout 60 --api-key-env TOKEN",
    ]) {
      const found = issues(config({ extraArgs: [line] }));
      expect(found).toHaveLength(1);
      expect(found[0].field).toBe("extraArgs");
    }
  });

  test("refuses controls and malformed extra argument lines", () => {
    expect(issues(config({ extraArgs: ["--timeout\n60"] }))).toEqual([
      {
        field: "extraArgs",
        message: "Extra arguments cannot contain controls.",
      },
    ]);
    expect(issues(config({ extraArgs: ["timeout 60"] }))[0].field).toBe(
      "extraArgs",
    );
  });

  test("refuses a port that 1ctx-mlx-engine does not watch", () => {
    expect(issues(config({ port: 11235 }))).toContainEqual({
      field: "port",
      message:
        "1ctx-mlx-engine is watching port 11234. Change where it looks with " +
        "1ctx-mlx-engine service install --engine.",
    });
  });

  test("refuses a loopback bind for a non-loopback engine host", () => {
    const found = validateConfig(config(), {
      pinnedModelDir: PINNED,
      watchedPort: 11234,
      engineHost: "studio.local",
    });
    expect(found).toContainEqual({
      field: "host",
      message:
        "1ctx-mlx-engine reaches mlx-serve at studio.local; a loopback-only " +
        "listener would hide it.",
    });
  });

  test("requires the pinned absolute model directory", () => {
    expect(issues(config({ modelDirs: [] })).map((item) => item.field)).toEqual(
      ["modelDirs", "modelDirs"],
    );
    expect(issues(config({ modelDirs: ["/tmp/models"] }))).toContainEqual({
      field: "modelDirs",
      message: "1ctx-mlx-engine's model directory must stay in the list.",
    });
    expect(issues(config({ modelDirs: [PINNED, "relative"] }))).toContainEqual({
      field: "modelDirs",
      message: "Model directories must be absolute paths.",
    });
  });

  test("checks sizes and numeric ranges", () => {
    const found = issues(
      config({
        prefixCacheMem: "large",
        maxResidentModels: 17,
        temp: 2.1,
        topP: -0.1,
        topK: -1,
      }),
    );
    expect(found.map((item) => item.field)).toEqual([
      "prefixCacheMem",
      "maxResidentModels",
      "temp",
      "topP",
      "topK",
    ]);
  });

  test("accepts auto for maximum resident memory", () => {
    expect(issues(config({ maxResidentMem: "auto" }))).toEqual([]);
    expect(
      issues(config({ maxResidentMem: "automatic" })).map((item) => item.field),
    ).toEqual(["maxResidentMem"]);
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
    expect(limitsFromArgs(["--prefix-cache-mem", "big"]).hotBytes).toBe(
      2 * GiB,
    );
  });

  test("the recorded budgets are the ones the plist asks for", () => {
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
});
