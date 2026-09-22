// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  blankSpec,
  capabilityTags,
  downloadLine,
  downloadPct,
  joinRows,
  matchingModels,
  metaLine,
  modelGroups,
  params,
} from "../../src/client/models/spec.ts";
import type { Download } from "../../src/shared/downloads.ts";
import type { ModelInfo, ModelSpec } from "../../src/shared/models.ts";

const info = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  loaded: false,
  state: "unloaded",
  bytesResident: 0,
  bytesOnDisk: 2 ** 30,
  contextLength: 262144,
  quantization: "4-bit",
  capabilities: ["chat", "streaming", "tool_use"],
  ...over,
});

const LIST = [
  info("mlx-community/Qwen3.5-0.8B-4bit"),
  info("Jundot/Qwen3.8-27B-oQ4e-mtp", { loaded: true, state: "ready" }),
  info("stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp", {
    loaded: true,
    state: "ready",
    favorite: true,
  }),
  info("stefanprodan/Apodex-1.1-mini-oQ4e-mtp"),
  info("org/qwen3.5-9B"),
];

const moe: ModelSpec = {
  ...blankSpec(LIST[2]!),
  modelType: "qwen3_5_moe",
  params: 35.1e9,
  activeParams: 3.02e9,
  layers: 40,
  fullAttention: 10,
  heads: 16,
  kvHeads: 2,
  headDim: 256,
  experts: { routed: 256, perToken: 8, shared: 1 },
  bits: 4,
  mode: "affine",
  mtpLayers: 1,
  inputs: ["text", "image"],
};

describe("models", () => {
  test("a parameter count reads as a model's name says it", () => {
    expect(params(35e9)).toBe("35B");
    expect(params(0.853e9)).toBe("0.9B");
    expect(params(1.5e9)).toBe("1.5B");
    expect(params(60e6)).toBe("60M");
    expect(params(134.5e6)).toBe("135M");
    expect(params(1.2e12)).toBe("1.2T");
    expect(params(null)).toBe("–");
  });

  test("the order is the names', the owner and the case aside", () => {
    const rows = joinRows(LIST, []);
    expect(matchingModels(rows, "", "all").map((r) => r.info.id)).toEqual([
      "stefanprodan/Apodex-1.1-mini-oQ4e-mtp",
      "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp",
      "mlx-community/Qwen3.5-0.8B-4bit",
      "org/qwen3.5-9B",
      "Jundot/Qwen3.8-27B-oQ4e-mtp",
    ]);
  });

  test("the search, the residency filter and the spec's type", () => {
    const rows = joinRows(LIST, [moe]);
    const ids = (q: string, f: "all" | "loaded" | "unloaded") =>
      matchingModels(rows, q, f).map((r) => r.info.id);
    expect(ids("", "loaded")).toEqual([
      "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp",
      "Jundot/Qwen3.8-27B-oQ4e-mtp",
    ]);
    expect(ids("QWEN3.5", "unloaded")).toEqual([
      "mlx-community/Qwen3.5-0.8B-4bit",
      "org/qwen3.5-9B",
    ]);
    expect(ids("moe", "all")).toEqual([
      "stefanprodan/Ornith-1.5-35B-A3B-BigBang-oQ4e-mtp",
    ]);
  });

  test("a model the specs do not have yet shows the list's facts", () => {
    const [row] = joinRows([LIST[0]!], []);
    expect(row!.spec.bytesOnDisk).toBe(2 ** 30);
    expect(row!.spec.params).toBeNull();
    expect(metaLine(row!).text).toBe("mlx-community · 4-bit");
  });

  test("the faint line: owner, bits, the active share, the state", () => {
    const [row] = joinRows([LIST[2]!], [moe]);
    expect(metaLine(row!)).toEqual({
      text: "stefanprodan · 4-bit · 3B active",
      state: { word: "loaded", tone: "ok" },
    });
    const deleted = joinRows([info("a/b", { deleted: true })], [])[0]!;
    expect(metaLine(deleted).state).toEqual({ word: "deleted", tone: "bad" });
    const loading = joinRows([info("a/b", { state: "loading" })], [])[0]!;
    expect(metaLine(loading).state?.tone).toBe("busy");
    expect(metaLine(joinRows([info("a/b")], [])[0]!).state).toBeNull();
  });

  test("the groups: experts for a mixture only, dashes where unsaid", () => {
    const titles = modelGroups(moe).map((g) => g.title);
    expect(titles).toEqual([
      "Architecture",
      "Experts",
      "Context",
      "Weights",
      "Sampling defaults",
      "Source",
    ]);
    const arch = modelGroups(moe)[0]!.rows;
    expect(arch.find((r) => r.label === "Layers")).toMatchObject({
      value: "40",
      spread: "10 full, 30 linear",
    });
    expect(arch.find((r) => r.label === "Heads")?.spread).toBe("2 KV, 256 dim");
    const blank = modelGroups(blankSpec(LIST[0]!));
    expect(blank.map((g) => g.title)).not.toContain("Experts");
    const weights = blank.find((g) => g.title === "Weights")!.rows;
    expect(weights.find((r) => r.label === "Quantization")?.value).toBe(
      "4-bit",
    );
    expect(weights.find((r) => r.label === "Files")).toMatchObject({
      value: "–",
      unit: undefined,
    });
  });

  test("the capabilities without streaming, which every model has", () => {
    expect(capabilityTags(moe)).toEqual(["Chat", "Tools"]);
  });
});

const download = (over: Partial<Download>): Download => ({
  id: 1,
  repo: "org/model",
  revision: "abc",
  dir: "/m/org/model",
  status: "running",
  bytesTotal: 4 * 2 ** 30,
  bytesDone: 2 ** 30,
  filesTotal: 4,
  filesDone: 1,
  file: "model-00002-of-00004.safetensors",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
  speedBps: 48 * 2 ** 20,
  ...over,
});

describe("downloadLine", () => {
  test("a running one: bytes, speed and file, the time left at the end", () => {
    expect(downloadLine(download({}))).toEqual({
      meta: "1.0 GB of 4.0 GB · 48 MB/s · file 2 of 4",
      end: "1 min",
    });
    // before the listing sized it
    expect(
      downloadLine(download({ bytesTotal: 0, filesTotal: 0, speedBps: null })),
    ).toEqual({ meta: "", end: "–" });
    // a trickle says its bytes, not 0 MB/s, and no time left
    expect(downloadLine(download({ speedBps: 300_000 }))).toEqual({
      meta: "1.0 GB of 4.0 GB · file 2 of 4",
      end: "–",
    });
  });

  test("queued says only that, a failure its error", () => {
    expect(downloadLine(download({ status: "queued" }))).toEqual({
      meta: "",
      end: "queued",
    });
    expect(
      downloadLine(download({ status: "failed", error: "HTTP 404" })),
    ).toEqual({ meta: "HTTP 404", end: "failed" });
    expect(downloadLine(download({ status: "cancelled" }))).toEqual({
      meta: "1.0 GB of 4.0 GB",
      end: "paused",
    });
  });

  test("the bar's share is clamped", () => {
    expect(downloadPct(download({}))).toBe(25);
    // a resume can count a part twice for a moment
    expect(downloadPct(download({ bytesDone: 5 * 2 ** 30 }))).toBe(100);
    expect(downloadPct(download({ bytesTotal: 0 }))).toBe(0);
  });
});
