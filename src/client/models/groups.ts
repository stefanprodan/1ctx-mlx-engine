// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Models page's opened row, pure: a model's groups of facts, by kind.
// A chat model has its architecture, experts, context, weights, sampling
// and source; a model that is not for chat has its own group in place of
// the ones about generation. Tested in test/client/models.test.ts.

import {
  type ModelKind,
  type ModelRuntime,
  type ModelSpec,
  modelKind,
} from "../../shared/models.ts";
import { DASH, sizeText } from "../format.ts";
import type { GridGroup } from "../shell/Grid.tsx";
import { params } from "./spec.ts";

const thousands = (n: number | null) =>
  n === null ? DASH : n.toLocaleString("en-US");
const plain = (n: number | null) => (n === null ? DASH : String(n));
const fixed = (n: number | null) => (n === null ? DASH : String(+n.toFixed(2)));

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

const yesNo = (b: boolean | null) => (b === null ? DASH : b ? "yes" : "no");

// The groups of a model that is not for chat: what it is, its own group,
// its weights and where it came from. Context, experts, MTP and sampling
// are about generation and are left out, not shown as dashes.
function otherGroups(s: ModelSpec, kind: ModelKind): GridGroup[] {
  const tokens = (n: number | null) => (n === null ? undefined : "tokens");
  const groups: GridGroup[] = [architecture(s)];
  if (kind === "decision") {
    const d = s.decision;
    groups.push({
      title: "Decision",
      rows: [
        { label: "Encoder", value: d?.encoder ?? DASH },
        {
          label: "Window",
          value: thousands(d?.window ?? null),
          unit: tokens(d?.window ?? null),
        },
        {
          label: "Options",
          value: thousands(d?.optionBudget ?? null),
          unit: tokens(d?.optionBudget ?? null),
        },
        { label: "Calibrated", value: yesNo(d?.calibrated ?? null) },
      ],
    });
  }
  if (kind === "embedding") {
    const e = s.embedding;
    groups.push({
      title: "Embedding",
      rows: [
        { label: "Dimensions", value: thousands(s.hiddenSize) },
        {
          label: "Max input",
          value: thousands(e?.maxInput ?? null),
          unit: tokens(e?.maxInput ?? null),
        },
        { label: "Pooling", value: e?.pooling ?? DASH },
      ],
    });
  }
  groups.push(weights(s), source(s));
  return groups;
}

function architecture(s: ModelSpec): GridGroup {
  const linear =
    s.layers !== null && s.fullAttention !== null && s.fullAttention < s.layers
      ? `${s.fullAttention} full, ${s.layers - s.fullAttention} ${s.restAttention ?? "other"}`
      : undefined;
  return {
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
  };
}

function weights(s: ModelSpec): GridGroup {
  return {
    title: "Weights",
    rows: [
      {
        label: "Quantization",
        value: s.bits !== null ? `${s.bits}-bit` : (s.quantization ?? DASH),
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
  };
}

function source(s: ModelSpec): GridGroup {
  return {
    title: "Source",
    rows: [
      { label: "Revision", value: s.revision?.slice(0, 7) ?? DASH },
      { label: "License", value: s.license ?? DASH },
      {
        label: "Downloaded",
        value: s.downloadedAt === null ? DASH : day.format(s.downloadedAt),
      },
    ],
  };
}

// The opened row's groups. A resident chat model's Context group adds what
// the engine said of it through /props: the window it serves and how long
// a context fits in memory now.
export function modelGroups(
  s: ModelSpec,
  runtime: ModelRuntime | null = null,
): GridGroup[] {
  const kind = modelKind(s.capabilities);
  if (kind !== "chat") return otherGroups(s, kind);
  const groups: GridGroup[] = [architecture(s)];
  // the process's own window beats the list's while the model is resident
  const served = runtime?.context ?? s.contextLength;
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
          value: thousands(served),
          unit: tokens(served),
        },
        {
          label: "Model max",
          value: thousands(s.maxPositions),
          unit: tokens(s.maxPositions),
        },
        // said while the model is resident
        ...(runtime?.safeContext != null
          ? [
              {
                label: "Fits now",
                value: thousands(runtime.safeContext),
                unit: "tokens",
              },
            ]
          : []),
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
    weights(s),
    {
      title: "Sampling defaults",
      rows: [
        { label: "Temperature", value: fixed(s.temperature) },
        { label: "Top p", value: fixed(s.topP) },
        { label: "Top k", value: plain(s.topK) },
      ],
    },
    source(s),
  );
  return groups;
}
