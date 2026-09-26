// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Models page's pure half: the join of the live list with the specs,
// the order, the search and the filters, a row's figures and faint line
// and a download's line; the opened row's groups are in groups.ts. Tested
// in test/client/models.test.ts.

import type { Download } from "../../shared/downloads.ts";
import {
  type ModelInfo,
  type ModelSpec,
  modelKind,
} from "../../shared/models.ts";
import { DASH, modelSize, sizeText } from "../format.ts";
import { timeLeft } from "../monitor/download.ts";

// a model as the page shows it: the sample's live row, the route's spec
export type ModelRow = { info: ModelInfo; spec: ModelSpec };

// what the page knows of a model before its spec arrives: the list's row
export function blankSpec(info: ModelInfo): ModelSpec {
  return {
    id: info.id,
    bytesOnDisk: info.bytesOnDisk,
    contextLength: info.contextLength,
    maxPositions: null,
    capabilities: info.capabilities,
    inputs: [],
    modelType: null,
    params: null,
    activeParams: null,
    layers: null,
    fullAttention: null,
    restAttention: null,
    hiddenSize: null,
    heads: null,
    kvHeads: null,
    headDim: null,
    vocab: null,
    experts: null,
    mtpLayers: null,
    mtpLoaded: null,
    quantization: info.quantization,
    bits: null,
    groupSize: null,
    mode: null,
    dtype: null,
    files: null,
    temperature: null,
    topP: null,
    topK: null,
    decision: null,
    embedding: null,
    license: null,
    revision: null,
    downloadedAt: null,
  };
}

export function joinRows(models: ModelInfo[], specs: ModelSpec[]): ModelRow[] {
  const byId = new Map(specs.map((s) => [s.id, s]));
  return models.map((info) => ({
    info,
    spec: byId.get(info.id) ?? blankSpec(info),
  }));
}

export const FILTERS = ["all", "loaded", "unloaded"] as const;
export type Filter = (typeof FILTERS)[number];
export const filterLabel = (f: Filter) =>
  f === "all" ? "All" : f === "loaded" ? "Loaded" : "Unloaded";

// the name after the owner, so one owner's models do not bunch together
export const modelName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const modelOwner = (id: string) =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
export const byName = <T extends { info: { id: string } }>(list: T[]) =>
  [...list].sort(
    (a, b) =>
      modelName(a.info.id).localeCompare(modelName(b.info.id), "en", {
        sensitivity: "base",
        numeric: true,
      }) || a.info.id.localeCompare(b.info.id),
  );

export function matchingModels(
  list: ModelRow[],
  query: string,
  filter: Filter,
): ModelRow[] {
  const q = query.trim().toLowerCase();
  return byName(list).filter(
    ({ info, spec }) =>
      (filter === "all" || info.loaded === (filter === "loaded")) &&
      (q === "" ||
        info.id.toLowerCase().includes(q) ||
        (spec.modelType?.toLowerCase().includes(q) ?? false) ||
        // the tag a row shows: "embed" finds the embedding models
        (kindTag(info.capabilities)?.includes(q) ?? false)),
  );
}

// 35B, 0.9B, 135M, 1.2T: a parameter count as a model's name says it
export function params(n: number | null): string {
  if (n === null) return DASH;
  if (n >= 1e12) return `${+(n / 1e12).toFixed(1)}T`;
  // a 0.8B model says 0.8B, not 800M; a 135M one says 135M
  if (n >= 5e8) return `${+(n / 1e9).toFixed(1)}B`;
  return `${Math.round(n / 1e6)}M`;
}

// a context window in K, as the engine's flags and model cards say it; a
// window under 1K in tokens (an embedding model's 512 is not 1K)
export const context = (tokens: number | null) =>
  tokens === null
    ? DASH
    : tokens < 1024
      ? String(tokens)
      : `${Math.round(tokens / 1024)}K`;

const DTYPE: Record<string, string> = {
  float16: "FP16",
  bfloat16: "BF16",
  float32: "FP32",
};

// the bits when the checkpoint says, else the engine's word, else the
// dtype of weights that are not quantized, else nothing
export const quant = (s: ModelSpec) =>
  s.bits !== null
    ? `${s.bits}-bit`
    : (s.quantization ?? (s.dtype ? (DTYPE[s.dtype] ?? s.dtype) : null));

// The window a row's Context column shows: what the engine serves a chat
// model, the longest input of an embedding model, the window a decision
// model's state, question and options share.
export function contextOf(s: ModelSpec): number | null {
  switch (modelKind(s.capabilities)) {
    case "decision":
      return s.decision?.window ?? null;
    case "embedding":
      return s.embedding?.maxInput ?? s.contextLength;
    default:
      return s.contextLength;
  }
}

export function figures(s: ModelSpec) {
  return {
    params: params(s.params),
    size: modelSize(s.bytesOnDisk),
    context: context(contextOf(s)),
  };
}

// the word a model that is not for chat carries beside its name
export const kindTag = (capabilities: readonly string[]): string | null => {
  switch (modelKind(capabilities)) {
    case "embedding":
      return "embeddings";
    case "decision":
      return "decisions";
    case "media":
      return "media";
    default:
      return null;
  }
};

export type RowState = { word: string; tone: "ok" | "busy" | "bad" };

// the faint line under the name, after the star: owner, bits, the active
// share; then the state, unless it is plain unloaded
export function metaLine(row: ModelRow): {
  text: string;
  state: RowState | null;
} {
  const { info, spec } = row;
  const parts = [modelOwner(info.id), quant(spec)];
  if (spec.activeParams !== null) {
    parts.push(`${params(spec.activeParams)} active`);
  }
  const text = parts.filter(Boolean).join(" · ");
  return { text, state: rowState(info) };
}

function rowState(info: ModelInfo): RowState | null {
  if (info.deleted) return { word: "deleted", tone: "bad" };
  // the engine's reason is the word: "MissingWeight" says more than "error"
  if (info.state === "error" || info.state === "failed") {
    return { word: info.error ?? info.state, tone: "bad" };
  }
  if (info.loaded) {
    return info.state === "ready"
      ? { word: "loaded", tone: "ok" }
      : { word: info.state, tone: "busy" };
  }
  if (info.state === "loading") return { word: "loading", tone: "busy" };
  return null;
}

const CAPABILITY: Record<string, string> = {
  chat: "Chat",
  tool_use: "Tools",
  vision: "Vision",
  reasoning: "Reasoning",
  json_schema: "JSON schema",
  embeddings: "Embeddings",
  decisions: "Decisions",
};
// Streaming is every model's, it says nothing about this one. A model that
// is not for chat has its kind only: the engine lists chat and tools on an
// embedding model it cannot really chat with.
export const capabilityTags = (s: ModelSpec) => {
  const kind = modelKind(s.capabilities);
  const own = kind === "embedding" ? ["embeddings"] : null;
  return (own ?? (kind === "decision" ? ["decisions"] : s.capabilities))
    .filter((c) => c !== "streaming")
    .map((c) => CAPABILITY[c] ?? c);
};

const ofTotal = (p: Download) =>
  p.bytesTotal > 0
    ? `${sizeText(p.bytesDone)} of ${sizeText(p.bytesTotal)}`
    : "";

// A download under the form: the figures while it runs, the error when it
// failed, what arrived when it stopped; at the end the time left (the bar
// says the share), else the word.
export function downloadLine(p: Download): { meta: string; end: string } {
  switch (p.status) {
    case "running": {
      // under a MB/s it would read 0: the bytes say it is moving
      const fast = p.speedBps !== null && p.speedBps >= 1024 ** 2;
      const parts = [
        ofTotal(p),
        fast ? `${Math.round((p.speedBps as number) / 1024 ** 2)} MB/s` : "",
        p.filesTotal > 0
          ? `file ${Math.min(p.filesDone + 1, p.filesTotal)} of ${p.filesTotal}`
          : "",
      ];
      return {
        meta: parts.filter(Boolean).join(" · "),
        end: timeLeft(p) ?? DASH,
      };
    }
    case "failed":
      return { meta: p.error ?? "", end: "failed" };
    case "cancelled":
      return { meta: ofTotal(p), end: "paused" };
    case "done":
      return { meta: sizeText(p.bytesTotal), end: "done" };
    default:
      return { meta: "", end: "queued" };
  }
}

// clamped: a resume can count a part twice for a moment
export const downloadPct = (p: Download) =>
  p.bytesTotal > 0
    ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100))
    : 0;
