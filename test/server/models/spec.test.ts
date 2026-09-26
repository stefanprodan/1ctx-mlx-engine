// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineModelMeta } from "../../../src/server/engine/types.ts";
import { readHeader, SpecReader } from "../../../src/server/models/read.ts";
import {
  countParams,
  type Header,
  headerDtype,
  mergeSpec,
  parseConfig,
  parseDecision,
  parseEmbedding,
  parseGeneration,
  parseLicense,
} from "../../../src/server/models/spec.ts";
import type { ModelInfo } from "../../../src/shared/models.ts";
import bgeSbert from "../../fixtures/spec/bge-small-sbert.json";
import layaAgent from "../../fixtures/spec/laya-multilingual-agent.json";
import layaEncoder from "../../fixtures/spec/laya-multilingual-encoder.json";
import layaHeader from "../../fixtures/spec/laya-multilingual-header.json";
import qwenConfig from "../../fixtures/spec/qwen3.5-0.8b-config.json";
import qwenHeader from "../../fixtures/spec/qwen3.5-0.8b-header.json";

// a small mixture of experts: 4 routed, 2 per token, one shared, its
// experts quantized at 4 bits in groups of 64 and its gate at 8
const MOE_CONFIG = {
  model_type: "qwen3_moe",
  num_hidden_layers: 2,
  hidden_size: 128,
  num_attention_heads: 4,
  vocab_size: 1000,
  max_position_embeddings: 4096,
  num_experts: 4,
  num_experts_per_tok: 2,
  shared_expert_intermediate_size: 64,
  torch_dtype: "bfloat16",
  quantization: {
    bits: 4,
    group_size: 64,
    "model.layers.0.mlp.gate": { bits: 8, group_size: 32 },
  },
};
const MOE_HEADER: Header = {
  // 1000 × 128, not quantized
  "model.embed_tokens.weight": { dtype: "BF16", shape: [1000, 128] },
  // 4 experts × 256 rows × 128 inputs, packed 8 per word
  "model.layers.0.mlp.switch_mlp.up_proj.weight": {
    dtype: "U32",
    shape: [4, 256, 16],
  },
  "model.layers.0.mlp.switch_mlp.up_proj.scales": {
    dtype: "BF16",
    shape: [4, 256, 2],
  },
  "model.layers.0.mlp.switch_mlp.up_proj.biases": {
    dtype: "BF16",
    shape: [4, 256, 2],
  },
  // the router: 4 × 128 at 8 bits in groups of 32, packed 4 per word
  "model.layers.0.mlp.gate.weight": { dtype: "U32", shape: [4, 32] },
  "model.layers.0.mlp.gate.scales": { dtype: "BF16", shape: [4, 4] },
  "model.layers.0.mlp.gate.biases": { dtype: "BF16", shape: [4, 4] },
  "model.norm.weight": { dtype: "BF16", shape: [128] },
};

describe("parseConfig", () => {
  test("a vision model's language shape is under text_config", () => {
    const c = parseConfig(qwenConfig);
    expect(c).toMatchObject({
      modelType: "qwen3_5",
      layers: 24,
      fullAttention: 6,
      restAttention: "linear",
      hiddenSize: 1024,
      heads: 8,
      kvHeads: 2,
      headDim: 256,
      vocab: 248320,
      maxPositions: 262144,
      mtpLayers: 1,
      experts: null,
      bits: 4,
      groupSize: 64,
      mode: "affine",
      dtype: "bfloat16",
    });
    expect(c.overrides.size).toBe(0);
  });

  test("the experts, the shared one and a mixed quant's overrides", () => {
    const c = parseConfig(MOE_CONFIG);
    expect(c.experts).toEqual({ routed: 4, perToken: 2, shared: 1 });
    expect(c.headDim).toBe(32);
    expect(c.kvHeads).toBe(4);
    expect(c.fullAttention).toBeNull();
    expect(c.dtype).toBe("bfloat16");
    expect(c.overrides.get("model.layers.0.mlp.gate")).toEqual({
      bits: 8,
      groupSize: 32,
    });
  });

  test("the full attention every n layers, and nothing from junk", () => {
    expect(
      parseConfig({ num_hidden_layers: 48, full_attention_interval: 4 })
        .fullAttention,
    ).toBe(12);
    const junk = parseConfig("not a config");
    expect(junk.layers).toBeNull();
    expect(junk.bits).toBeNull();
    expect(junk.mode).toBeNull();
    expect(parseConfig({ n_routed_experts: 0 }).experts).toBeNull();
  });
});

describe("countParams", () => {
  test("the recorded checkpoint, exact", () => {
    const counted = countParams(
      [qwenHeader as unknown as Header],
      parseConfig(qwenConfig),
    );
    expect(counted).toEqual({ params: 852985920, activeParams: null });
  });

  test("packed weights, per-module groups, the active share", () => {
    const { params, activeParams } = countParams(
      [MOE_HEADER],
      parseConfig(MOE_CONFIG),
    );
    const embed = 1000 * 128;
    const experts = 4 * 256 * 2 * 64;
    const gate = 4 * 4 * 32;
    expect(params).toBe(embed + experts + gate + 128);
    expect(activeParams).toBe(embed + experts / 2 + gate + 128);
  });

  test("experts as one module each, and a tied output projection", () => {
    const config = parseConfig({
      num_experts: 2,
      num_experts_per_tok: 1,
      tie_word_embeddings: true,
    });
    const { params, activeParams } = countParams(
      [
        {
          "model.embed_tokens.weight": { dtype: "BF16", shape: [100, 8] },
          "lm_head.weight": { dtype: "BF16", shape: [100, 8] },
          "model.layers.0.mlp.experts.0.w1.weight": {
            dtype: "BF16",
            shape: [16, 8],
          },
          "model.layers.0.mlp.experts.1.w1.weight": {
            dtype: "BF16",
            shape: [16, 8],
          },
        },
      ],
      config,
    );
    expect(params).toBe(800 + 256);
    expect(activeParams).toBe(800 + 128);
    // untied, the projection is a parameter of its own
    const untied = { ...config, tied: false };
    expect(
      countParams(
        [
          {
            "model.embed_tokens.weight": { dtype: "BF16", shape: [100, 8] },
            "lm_head.weight": { dtype: "BF16", shape: [100, 8] },
          },
        ],
        untied,
      ).params,
    ).toBe(1600);
  });

  test("the headers of several files are one checkpoint", () => {
    const [a, b] = [{} as Header, {} as Header];
    for (const [i, [name, t]] of Object.entries(MOE_HEADER).entries()) {
      (i % 2 ? a : b)[name] = t;
    }
    expect(countParams([a, b], parseConfig(MOE_CONFIG))).toEqual(
      countParams([MOE_HEADER], parseConfig(MOE_CONFIG)),
    );
  });
});

describe("the card and the generation config", () => {
  test("the license from the front matter only", () => {
    expect(parseLicense("---\nlicense: apache-2.0\ntags:\n- mlx\n---\n")).toBe(
      "apache-2.0",
    );
    expect(parseLicense('---\r\nlicense: "mit"\r\n---\r\n')).toBe("mit");
    expect(parseLicense("# card\nlicense: mit\n")).toBeNull();
    expect(parseLicense("---\ntags: []\n---\nlicense: mit")).toBeNull();
  });

  test("the sampling, null where unsaid", () => {
    expect(parseGeneration({ temperature: 0.7, top_k: 20 })).toEqual({
      temperature: 0.7,
      topP: null,
      topK: 20,
    });
  });
});

const INFO: ModelInfo = {
  id: "org/model",
  loaded: false,
  state: "unloaded",
  bytesResident: 0,
  bytesOnDisk: 100,
  contextLength: 32768,
  quantization: "4-bit",
  capabilities: ["chat"],
};
const META: EngineModelMeta = {
  architecture: "qwen3_moe",
  layers: 40,
  hiddenSize: 2048,
  vocab: 1000,
  maxTokens: 262144,
  isMoe: true,
  mtpLoaded: false,
  temperature: 1,
  topP: 0.95,
  topK: null,
  inputs: ["text"],
};

describe("a decision checkpoint", () => {
  test("the agent's config: encoder, window, option budget, calibration", () => {
    expect(parseDecision(layaAgent)).toEqual({
      encoder: "jhu-clsp/mmBERT-base",
      window: 1024,
      optionBudget: 256,
      // all three temperatures are 1: none were fitted
      calibrated: false,
    });
    expect(parseDecision({ temperature: [1.2, 1, 0.9] }).calibrated).toBe(true);
    expect(parseDecision({})).toEqual({
      encoder: null,
      window: null,
      optionBudget: null,
      calibrated: null,
    });
  });

  test("the encoder's shape and the exact count, FP16 from the header", () => {
    const config = parseConfig(layaEncoder);
    expect(config).toMatchObject({
      modelType: "modernbert",
      layers: 22,
      // global every third layer, a sliding window in between
      fullAttention: 8,
      restAttention: "sliding",
      hiddenSize: 768,
      heads: 12,
      // the base model's word, not the weights': the header says FP16
      dtype: "float32",
    });
    const header = layaHeader as Header;
    expect(countParams([header], config).params).toBe(321_908_998);
    expect(headerDtype([header])).toBe("float16");
  });
});

describe("an embedding checkpoint", () => {
  test("the longest input and the pooling, from either file", () => {
    expect(parseEmbedding(bgeSbert, null)).toEqual({
      maxInput: 512,
      pooling: null,
    });
    expect(
      parseEmbedding(null, {
        pooling_mode_cls_token: true,
        pooling_mode_mean_tokens: false,
      }),
    ).toEqual({ maxInput: null, pooling: "CLS token" });
    // a checkpoint with neither file says nothing
    expect(parseEmbedding(null, null)).toBeNull();
  });

  test("a quantized checkpoint's dtype is not in its headers", () => {
    expect(
      headerDtype([
        {
          "a.weight": { dtype: "U32", shape: [4, 4] },
          "a.scales": { dtype: "BF16", shape: [4, 1] },
        },
      ]),
    ).toBeNull();
  });
});

describe("mergeSpec", () => {
  test("a decision model's own group, and no embedding one", () => {
    const info: ModelInfo = { ...INFO, capabilities: ["decisions"] };
    const disk = {
      config: parseConfig(layaEncoder),
      generation: null,
      decision: parseDecision(layaAgent),
      embedding: null,
      license: "apache-2.0",
      params: 321_908_998,
      activeParams: null,
      files: 1,
      addedAt: 0,
    };
    const s = mergeSpec(info, undefined, disk, null);
    expect(s.decision?.window).toBe(1024);
    expect(s.embedding).toBeNull();
  });

  test("an embedding model's input is the engine's window when unsaid", () => {
    const info: ModelInfo = {
      ...INFO,
      contextLength: 32768,
      capabilities: ["chat", "embeddings"],
    };
    const s = mergeSpec(info, undefined, null, null);
    expect(s.embedding).toEqual({ maxInput: 32768, pooling: null });
    expect(s.decision).toBeNull();
  });

  test("a remote engine's model: what the engine said, no files", () => {
    const s = mergeSpec(INFO, META, null, null);
    expect(s).toMatchObject({
      modelType: "qwen3_moe",
      layers: 40,
      bits: 4,
      params: null,
      files: null,
      maxPositions: 262144,
      experts: { routed: null, perToken: null, shared: null },
      inputs: ["text"],
      revision: null,
    });
  });

  test("the checkpoint for its shape, the engine for its sampling", () => {
    const disk = {
      config: parseConfig(MOE_CONFIG),
      generation: { temperature: 0.6, topP: 0.8, topK: 40 },
      decision: null,
      embedding: null,
      license: "mit",
      params: 10,
      activeParams: 5,
      files: 2,
      addedAt: 3,
    };
    const s = mergeSpec(INFO, META, disk, {
      revision: "abc",
      finishedAt: 7,
    });
    expect(s).toMatchObject({
      layers: 2,
      maxPositions: 4096,
      experts: { routed: 4, perToken: 2, shared: 1 },
      temperature: 1,
      topP: 0.95,
      topK: 40,
      params: 10,
      activeParams: 5,
      license: "mit",
      revision: "abc",
      downloadedAt: 7,
    });
    expect(s.mtpLoaded).toBe(false);
    // no download record: the date is the config's
    expect(mergeSpec(INFO, META, disk, null)).toMatchObject({
      revision: null,
      downloadedAt: 3,
    });
    // experts under a key not read here: the engine still says MoE
    const unread = { ...disk, config: parseConfig(qwenConfig) };
    expect(mergeSpec(INFO, META, unread, null).experts).toEqual({
      routed: null,
      perToken: null,
      shared: null,
    });
    expect(
      mergeSpec(INFO, { ...META, isMoe: false }, unread, null).experts,
    ).toBeNull();
  });
});

// a safetensors file with the given header and no tensors after it
function safetensors(header: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(json.length), true);
  out.set(json, 8);
  return out;
}

async function modelDir() {
  const root = await mkdtemp(join(tmpdir(), "1ctx-spec-"));
  const dir = join(root, "org", "moe");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(MOE_CONFIG));
  await writeFile(join(dir, "README.md"), "---\nlicense: mit\n---\n# moe\n");
  const names = Object.keys(MOE_HEADER);
  await writeFile(
    join(dir, "model-00001-of-00002.safetensors"),
    safetensors(
      Object.fromEntries(names.slice(0, 4).map((n) => [n, MOE_HEADER[n]])),
    ),
  );
  await writeFile(
    join(dir, "model-00002-of-00002.safetensors"),
    safetensors(
      Object.fromEntries(names.slice(4).map((n) => [n, MOE_HEADER[n]])),
    ),
  );
  return { root, dir };
}

// a decision checkpoint's layout: no config.json, the encoder's in its
// own directory, the agent's beside the weights
async function decisionDir() {
  const root = await mkdtemp(join(tmpdir(), "1ctx-spec-"));
  const dir = join(root, "org", "laya");
  await mkdir(join(dir, "encoder"), { recursive: true });
  await writeFile(
    join(dir, "encoder", "config.json"),
    JSON.stringify(layaEncoder),
  );
  await writeFile(join(dir, "rl_agent_config.json"), JSON.stringify(layaAgent));
  await writeFile(join(dir, "README.md"), "---\nlicense: apache-2.0\n---\n");
  await writeFile(join(dir, "model.safetensors"), safetensors(layaHeader));
  return { root, dir };
}

describe("SpecReader", () => {
  test("a decision checkpoint, from its encoder and agent configs", async () => {
    const { root } = await decisionDir();
    const spec = await new SpecReader(root).read("org/laya");
    expect(spec?.decision).toEqual(parseDecision(layaAgent));
    expect(spec?.config.hiddenSize).toBe(768);
    expect(spec?.config.dtype).toBe("float16");
    expect(spec?.params).toBe(321_908_998);
    expect(spec?.license).toBe("apache-2.0");
    expect(spec?.embedding).toBeNull();
  });

  test("an encoder directory that is a symlink is not followed", async () => {
    const { root, dir } = await decisionDir();
    const elsewhere = await mkdtemp(join(tmpdir(), "1ctx-spec-out-"));
    await writeFile(
      join(elsewhere, "config.json"),
      JSON.stringify(layaEncoder),
    );
    await rm(join(dir, "encoder"), { recursive: true });
    await symlink(elsewhere, join(dir, "encoder"));
    expect(await new SpecReader(root).read("org/laya")).toBeNull();
  });

  test("an embedding checkpoint's sentence-transformers files", async () => {
    const { root, dir } = await modelDir();
    await writeFile(
      join(dir, "sentence_bert_config.json"),
      JSON.stringify(bgeSbert),
    );
    await mkdir(join(dir, "1_Pooling"));
    await writeFile(
      join(dir, "1_Pooling", "config.json"),
      JSON.stringify({ pooling_mode_mean_tokens: true }),
    );
    const spec = await new SpecReader(root).read("org/moe");
    expect(spec?.embedding).toEqual({ maxInput: 512, pooling: "mean" });
  });

  test("reads the checkpoint once, again when it changes", async () => {
    const { root, dir } = await modelDir();
    const reader = new SpecReader(root);
    const spec = await reader.read("org/moe");
    expect(spec?.files).toBe(2);
    expect(spec?.license).toBe("mit");
    expect(spec?.generation).toBeNull();
    expect(spec?.addedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(spec?.params).toBe(
      countParams([MOE_HEADER], parseConfig(MOE_CONFIG)).params,
    );
    expect(await reader.read("org/moe")).toBe(spec);
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ ...MOE_CONFIG, num_hidden_layers: 3 }),
    );
    await utimes(
      join(dir, "config.json"),
      new Date(),
      new Date(Date.now() + 5000),
    );
    expect((await reader.read("org/moe"))?.config.layers).toBe(3);
  });

  test("a missing file makes no count rather than a wrong one", async () => {
    const { root, dir } = await modelDir();
    await writeFile(join(dir, "model-00002-of-00002.safetensors"), "junk");
    const spec = await new SpecReader(root).read("org/moe");
    expect(spec?.params).toBeNull();
    expect(spec?.files).toBe(2);
  });

  test("nothing outside the root, nothing through a symlink", async () => {
    const { root, dir } = await modelDir();
    const reader = new SpecReader(root);
    expect(await reader.read("../org/moe")).toBeNull();
    expect(await reader.read("org/missing")).toBeNull();
    await symlink(dir, join(root, "org", "linked"));
    expect(await reader.read("org/linked")).toBeNull();
    const plain = join(root, "org", "plain");
    await mkdir(plain);
    await symlink(join(dir, "config.json"), join(plain, "config.json"));
    expect(await reader.read("org/plain")).toBeNull();
  });

  test("a header longer than its file, or absurd, is no header", async () => {
    const { dir } = await modelDir();
    const bad = join(dir, "bad.safetensors");
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setBigUint64(0, 2n ** 40n, true);
    await writeFile(bad, bytes);
    expect(await readHeader(bad)).toBeNull();
    await writeFile(bad, new Uint8Array(4));
    expect(await readHeader(bad)).toBeNull();
    // complete JSON, but the length says more than the file holds
    const short = safetensors({ a: { dtype: "F32", shape: [1] } });
    new DataView(short.buffer).setBigUint64(0, BigInt(short.length), true);
    await writeFile(bad, short);
    expect(await readHeader(bad)).toBeNull();
    // a header over the budget left is refused
    const ok = safetensors({ a: { dtype: "F32", shape: [1] } });
    await writeFile(bad, ok);
    expect((await readHeader(bad))?.bytes).toBe(ok.length - 8);
    expect(await readHeader(bad, ok.length - 9)).toBeNull();
  });

  test("an oversized config is not read", async () => {
    const { root, dir } = await modelDir();
    await writeFile(
      join(dir, "config.json"),
      `{"pad": "${"x".repeat(5 * 2 ** 20)}"}`,
    );
    expect(await new SpecReader(root).read("org/moe")).toBeNull();
  });

  test("a file rewritten under its name is read again", async () => {
    const { root, dir } = await modelDir();
    const reader = new SpecReader(root);
    expect((await reader.read("org/moe"))?.license).toBe("mit");
    await writeFile(
      join(dir, "README.md"),
      "---\nlicense: apache-2.0\n---\n# a longer card\n",
    );
    expect((await reader.read("org/moe"))?.license).toBe("apache-2.0");
  });

  test("two requests at once share one read", async () => {
    const { root } = await modelDir();
    const reader = new SpecReader(root);
    const [a, b] = await Promise.all([
      reader.read("org/moe"),
      reader.read("org/moe"),
    ]);
    expect(a).toBe(b);
  });
});
