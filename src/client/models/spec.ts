// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Models page's pure half: the join of the live list with the specs,
// the order, the search and the filters, a row's figures and faint line,
// the opened row's groups and a download's line. Tested in
// test/client/models.test.ts.

import type { Download } from "../../shared/downloads.ts";
import type { ModelInfo, ModelSpec } from "../../shared/models.ts";
import { DASH, modelSize, sizeText } from "../format.ts";
import { timeLeft } from "../monitor/download.ts";
import type { GridGroup } from "../shell/Grid.tsx";

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
        (spec.modelType?.toLowerCase().includes(q) ?? false)),
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

// a context window in K, as the engine's flags and model cards say it
export const context = (tokens: number | null) =>
  tokens === null ? DASH : `${Math.round(tokens / 1024)}K`;

const thousands = (n: number | null) =>
  n === null ? DASH : n.toLocaleString("en-US");
const plain = (n: number | null) => (n === null ? DASH : String(n));
const fixed = (n: number | null) => (n === null ? DASH : String(+n.toFixed(2)));

// the bits when the checkpoint says, else the engine's word, else nothing
export const quant = (s: ModelSpec) =>
  s.bits !== null ? `${s.bits}-bit` : s.quantization;

export function figures(s: ModelSpec) {
  return {
    params: params(s.params),
    size: modelSize(s.bytesOnDisk),
    context: context(s.contextLength),
  };
}

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
  if (info.state === "error" || info.state === "failed") {
    return { word: info.state, tone: "bad" };
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
};
// streaming is every model's; it says nothing about this one
export const capabilityTags = (s: ModelSpec) =>
  s.capabilities
    .filter((c) => c !== "streaming")
    .map((c) => CAPABILITY[c] ?? c);

const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function headsSpread(s: ModelSpec): string | undefined {
  const parts = [
    s.kvHeads !== null ? `${s.kvHeads} KV` : null,
    s.headDim !== null ? `${s.headDim} dim` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

export function modelGroups(s: ModelSpec): GridGroup[] {
  const linear =
    s.layers !== null && s.fullAttention !== null && s.fullAttention < s.layers
      ? `${s.fullAttention} full, ${s.layers - s.fullAttention} linear`
      : undefined;
  const groups: GridGroup[] = [
    {
      title: "Architecture",
      rows: [
        { label: "Type", value: s.modelType ?? DASH },
        {
          label: "Parameters",
          value: params(s.params),
          spread:
            s.activeParams === null
              ? undefined
              : `${params(s.activeParams)} active`,
        },
        { label: "Layers", value: plain(s.layers), spread: linear },
        { label: "Hidden size", value: thousands(s.hiddenSize) },
        { label: "Heads", value: plain(s.heads), spread: headsSpread(s) },
        { label: "Vocabulary", value: thousands(s.vocab) },
      ],
    },
  ];
  if (s.experts) {
    groups.push({
      title: "Experts",
      rows: [
        { label: "Routed", value: plain(s.experts.routed) },
        { label: "Per token", value: plain(s.experts.perToken) },
        { label: "Shared", value: plain(s.experts.shared) },
      ],
    });
  }
  const tokens = (n: number | null) => (n === null ? undefined : "tokens");
  groups.push(
    {
      title: "Context",
      rows: [
        {
          label: "Served",
          value: thousands(s.contextLength),
          unit: tokens(s.contextLength),
        },
        {
          label: "Model max",
          value: thousands(s.maxPositions),
          unit: tokens(s.maxPositions),
        },
        {
          label: "MTP",
          value: s.mtpLayers ? String(s.mtpLayers) : DASH,
          unit: !s.mtpLayers
            ? undefined
            : s.mtpLayers === 1
              ? "layer"
              : "layers",
          // what the engine runs, said while the model is resident
          spread:
            !s.mtpLayers || s.mtpLoaded === null
              ? undefined
              : s.mtpLoaded
                ? "in use"
                : "off",
        },
      ],
    },
    {
      title: "Weights",
      rows: [
        {
          label: "Quantization",
          value: quant(s) ?? DASH,
          spread: s.mode ?? undefined,
        },
        { label: "Group size", value: plain(s.groupSize) },
        { label: "Dtype", value: s.dtype ?? DASH },
        { label: "On disk", value: sizeText(s.bytesOnDisk) },
        {
          label: "Files",
          value: plain(s.files),
          unit: s.files === null ? undefined : "safetensors",
        },
      ],
    },
    {
      title: "Sampling defaults",
      rows: [
        { label: "Temperature", value: fixed(s.temperature) },
        { label: "Top p", value: fixed(s.topP) },
        { label: "Top k", value: plain(s.topK) },
      ],
    },
    {
      title: "Source",
      rows: [
        { label: "Revision", value: s.revision?.slice(0, 7) ?? DASH },
        { label: "License", value: s.license ?? DASH },
        {
          label: "Downloaded",
          value: s.downloadedAt === null ? DASH : day.format(s.downloadedAt),
        },
      ],
    },
  );
  return groups;
}

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
