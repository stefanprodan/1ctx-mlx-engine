// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a checkpoint says of itself, pure: its config.json, its
// generation_config.json, its model card's front matter and the headers of
// its safetensors files, then the join with what the engine says. Tested
// on files recorded from real checkpoints in test/fixtures/spec/.

import type { ModelInfo, ModelSpec } from "../../shared/models.ts";
import type { EngineModelMeta } from "../engine/types.ts";

export type Experts = {
  routed: number;
  perToken: number | null;
  shared: number | null;
};

export type Quant = { bits: number; groupSize: number };

export type DiskConfig = {
  modelType: string | null;
  layers: number | null;
  fullAttention: number | null;
  hiddenSize: number | null;
  heads: number | null;
  kvHeads: number | null;
  headDim: number | null;
  vocab: number | null;
  maxPositions: number | null;
  mtpLayers: number | null;
  experts: Experts | null;
  bits: number | null;
  groupSize: number | null;
  mode: string | null;
  dtype: string | null;
  // the output projection is the embedding: a stored copy is not counted
  tied: boolean;
  // a mixed quant's per-module settings, by module path
  overrides: Map<string, Quant>;
};

export type Generation = {
  temperature: number | null;
  topP: number | null;
  topK: number | null;
};

// one safetensors header: the tensors by name
export type Header = Record<string, { dtype: string; shape: number[] }>;

export type DiskSpec = {
  config: DiskConfig;
  generation: Generation | null;
  license: string | null;
  params: number | null;
  activeParams: number | null;
  files: number;
  // config.json's modified time: when the checkpoint landed here, for a
  // model this program has no download record of
  addedAt: number;
};

const n = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, any> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, any>)
    : null;

// config.json. A vision model keeps the language model's shape under
// text_config; the quantization and the model type stay at the top.
export function parseConfig(body: unknown): DiskConfig {
  const top = obj(body) ?? {};
  const t = obj(top.text_config) ?? top;
  const layers = n(t.num_hidden_layers);
  const heads = n(t.num_attention_heads);
  const hiddenSize = n(t.hidden_size);
  let fullAttention: number | null = null;
  if (Array.isArray(t.layer_types)) {
    fullAttention = t.layer_types.filter(
      (l: unknown) => l === "full_attention",
    ).length;
  } else if (layers !== null && n(t.full_attention_interval)) {
    fullAttention = Math.floor(layers / t.full_attention_interval);
  }
  const routed =
    n(t.num_experts) ?? n(t.num_local_experts) ?? n(t.n_routed_experts);
  const shared =
    n(t.n_shared_experts) ??
    (n(t.shared_expert_intermediate_size) !== null
      ? t.shared_expert_intermediate_size > 0
        ? 1
        : 0
      : null);
  const q = obj(top.quantization) ?? obj(top.quantization_config);
  const overrides = new Map<string, Quant>();
  const bits = n(q?.bits);
  const groupSize = n(q?.group_size);
  for (const [key, value] of Object.entries(q ?? {})) {
    const o = obj(value);
    const b = n(o?.bits);
    if (!o || b === null) continue;
    overrides.set(key, {
      bits: b,
      groupSize: n(o.group_size) ?? groupSize ?? 64,
    });
  }
  return {
    modelType: str(top.model_type) ?? str(t.model_type),
    layers,
    fullAttention,
    hiddenSize,
    heads,
    kvHeads: n(t.num_key_value_heads) ?? heads,
    headDim:
      n(t.head_dim) ??
      (hiddenSize !== null && heads ? Math.round(hiddenSize / heads) : null),
    vocab: n(t.vocab_size) ?? n(top.vocab_size),
    maxPositions: n(t.max_position_embeddings),
    mtpLayers: n(t.mtp_num_hidden_layers) ?? n(t.num_nextn_predict_layers),
    experts:
      routed !== null && routed > 0
        ? { routed, perToken: n(t.num_experts_per_tok), shared }
        : null,
    bits,
    groupSize,
    mode: q ? (str(q.mode) ?? "affine") : null,
    dtype: str(t.dtype) ?? str(t.torch_dtype) ?? str(top.torch_dtype),
    tied: (t.tie_word_embeddings ?? top.tie_word_embeddings) === true,
    overrides,
  };
}

// generation_config.json: the sampling the model's authors ship
export function parseGeneration(body: unknown): Generation {
  const g = obj(body) ?? {};
  return {
    temperature: n(g.temperature),
    topP: n(g.top_p),
    topK: n(g.top_k),
  };
}

// the license in the model card's YAML front matter, null without one
export function parseLicense(readme: string): string | null {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readme);
  if (!front) return null;
  const line = /^license:[ \t]*(.+)$/m.exec(front[1]!);
  const value = line?.[1]?.trim().replace(/^["']|["']$/g, "");
  return value ? value : null;
}

const product = (shape: number[]) => shape.reduce((a, b) => a * b, 1);

// The parameter count from the tensors' shapes, exact. A quantized weight
// is packed into U32 words with its scales beside it: each row holds
// scales' last dimension times the group size of inputs. The scales and
// biases of a quantization are not parameters, nor is an output projection
// the config says is tied to the embedding. A routed expert's tensors are
// stacked (switch_mlp, experts, leading with the expert count) or one
// module each (experts.<n>.); a token goes through perToken of them.
export function countParams(
  headers: Header[],
  config: DiskConfig,
): { params: number; activeParams: number | null } {
  const all: Header = Object.assign({}, ...headers);
  let params = 0;
  let expertParams = 0;
  const routed = config.experts?.routed ?? null;
  for (const [name, t] of Object.entries(all)) {
    if (name === "__metadata__" || !Array.isArray(t?.shape)) continue;
    if (config.tied && /(^|\.)lm_head\./.test(name)) continue;
    const base = name.replace(/\.(scales|biases)$/, "");
    if (base !== name && all[`${base}.weight`]?.dtype === "U32") continue;
    let count = product(t.shape);
    const module = name.replace(/\.weight$/, "");
    const scales = all[`${module}.scales`];
    if (t.dtype === "U32" && scales && Array.isArray(scales.shape)) {
      const groupSize =
        config.overrides.get(module)?.groupSize ?? config.groupSize ?? 64;
      count =
        product(t.shape.slice(0, -1)) * (scales.shape.at(-1) ?? 0) * groupSize;
    }
    params += count;
    if (
      routed !== null &&
      ((t.shape[0] === routed && /(switch_mlp|experts)\./.test(name)) ||
        /\.experts\.\d+\./.test(name))
    ) {
      expertParams += count;
    }
  }
  const perToken = config.experts?.perToken ?? null;
  const activeParams =
    routed !== null && perToken !== null && expertParams > 0
      ? params - expertParams + (expertParams * perToken) / routed
      : null;
  return { params, activeParams };
}

// the bits in the engine's word for the precision, "4-bit" → 4
const bitsOf = (word: string | null | undefined) => {
  const m = /^(\d+)-bit$/.exec(word ?? "");
  return m ? Number(m[1]) : null;
};

// The join. The checkpoint wins for what it is (its shape, its bits), the
// engine for what it serves (the window, the sampling it applies).
export function mergeSpec(
  info: ModelInfo,
  meta: EngineModelMeta | undefined,
  disk: DiskSpec | null,
  download: { revision: string; finishedAt: number | null } | null,
): ModelSpec {
  const c = disk?.config;
  const g = disk?.generation;
  return {
    id: info.id,
    bytesOnDisk: info.bytesOnDisk,
    contextLength: info.contextLength,
    maxPositions: c?.maxPositions ?? meta?.maxTokens ?? null,
    capabilities: info.capabilities,
    inputs: meta?.inputs ?? [],
    modelType: c?.modelType ?? meta?.architecture ?? null,
    params: disk?.params ?? null,
    activeParams: disk?.activeParams ?? null,
    layers: c?.layers ?? meta?.layers ?? null,
    fullAttention: c?.fullAttention ?? null,
    hiddenSize: c?.hiddenSize ?? meta?.hiddenSize ?? null,
    heads: c?.heads ?? null,
    kvHeads: c?.kvHeads ?? null,
    headDim: c?.headDim ?? null,
    vocab: c?.vocab ?? meta?.vocab ?? null,
    // a config whose experts are under a key not read here still says
    // MoE through the engine
    experts:
      c?.experts ??
      (meta?.isMoe ? { routed: null, perToken: null, shared: null } : null),
    mtpLayers: c?.mtpLayers ?? null,
    mtpLoaded: meta?.mtpLoaded ?? null,
    quantization: info.quantization,
    bits: c?.bits ?? bitsOf(info.quantization),
    groupSize: c?.groupSize ?? null,
    mode: c?.mode ?? null,
    dtype: c?.dtype ?? null,
    files: disk?.files ?? null,
    temperature: meta?.temperature ?? g?.temperature ?? null,
    topP: meta?.topP ?? g?.topP ?? null,
    topK: meta?.topK ?? g?.topK ?? null,
    license: disk?.license ?? null,
    revision: download?.revision ?? null,
    downloadedAt: download?.finishedAt ?? disk?.addedAt ?? null,
  };
}
