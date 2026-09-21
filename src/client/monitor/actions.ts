// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The control actions: the dialog copy (pure, tested in
// test/client/actions.test.ts) and runAction, which confirms, posts and lets
// the /ws event show the outcome in every tab.

import { computed } from "@preact/signals";
import type { ActionEvent, ActionName } from "../../shared/actions.ts";
import type { Capability } from "../../shared/models.ts";
import { gb } from "../format.ts";
import { confirm, type TextPart } from "../shell/Confirm.tsx";
import {
  absent,
  busy,
  event,
  refreshSnapshot,
  sample,
  setBusy,
  snapshot,
} from "../store.ts";

export const ACTION_LABEL: Record<ActionName, string> = {
  load: "load",
  unload: "unload",
  default: "set default",
  delete: "delete",
  free: "restart engine",
  diskClear: "clear disk cache",
  historyClear: "clear history",
  requestsClear: "clear requests",
  favorite: "daily driver",
};

const ENGINE_NAME: Record<"mlxserve" | "omlx", string> = {
  mlxserve: "mlx-serve",
  omlx: "oMLX",
};

// facts about the engine the dialogs and the tiles need, from the snapshot
export const engineName = computed(() =>
  snapshot.value ? ENGINE_NAME[snapshot.value.engine.id] : "engine",
);
export const engineLocal = computed(
  () => snapshot.value?.engine.local ?? false,
);
export const limits = computed(() => snapshot.value?.engine.limits ?? null);
export const diskTotal = computed(
  () => snapshot.value?.disk.reduce((n, d) => n + d.bytes, 0) ?? 0,
);
export const loadedCount = computed(
  () => snapshot.value?.models.filter((m) => m.loaded).length ?? 0,
);
export const can = (c: Capability) =>
  snapshot.value?.engine.capabilities.includes(c) ?? false;

// Restart engine, in the Runtime head and in the rail's menu: a local
// engine this program can restart. The reason when it cannot, "" when it
// can; either button is also off while an action runs
export const restartBlocked = computed(() =>
  !absent.value && engineLocal.value && can("restart")
    ? ""
    : absent.value
      ? "mlx-serve is not installed"
      : "restarts the engine service, local engine only",
);

export type ConfirmContext = {
  engineName: string;
  loadedCount: number;
  diskTotal: number;
  // the engine's footprint after the load: what it holds now plus the
  // model's weights, which are mmap'd whole from disk
  loadBytes: number;
  // what a delete frees and where from
  modelBytes: number;
  modelDir: string;
};

export function modelBytes(model: string | null): number {
  return snapshot.value?.models.find((m) => m.id === model)?.bytesOnDisk ?? 0;
}

export function loadEstimate(model: string | null): number {
  const s = sample.value ?? snapshot.value?.sample ?? null;
  const m = snapshot.value?.models.find((x) => x.id === model);
  return (s?.mem.procFootprint ?? 0) + (m?.bytesOnDisk ?? 0);
}

// The dialog copy states what happens, from the engine notes: an unload
// drops the model's RAM prefix cache, a restart drops everything but the
// SSD tier, loading past the residency cap evicts the least recently used.
export function confirmText(
  action: ActionName,
  model: string | null,
  ctx: ConfirmContext,
): TextPart[] {
  const evict =
    ctx.loadedCount >= 2
      ? " Two models are resident, so the least recently used one is evicted."
      : "";
  const m = { code: model ?? "" };
  switch (action) {
    case "load":
      return [
        "Confirm loading ",
        m,
        `? Estimated memory usage after load: ${gb(ctx.loadBytes)} GB.${evict}`,
      ];
    case "default":
      return [
        "Make ",
        m,
        ` the default model? It is loaded if needed and chat requests without a model go to it.${evict}`,
      ];
    case "delete":
      return [
        "Delete ",
        m,
        `? Its ${gb(ctx.modelBytes)} GB are removed from ${ctx.modelDir}. The engine lists it as deleted until it restarts.`,
      ];
    case "unload":
      return []; // frees only, no dialog
    case "free":
      return [`Confirm ${ctx.engineName} restart`];
    case "diskClear":
      return [
        `Restart the engine service and delete the SSD cache tier (${gb(ctx.diskTotal)} GB)? Every model is unloaded and every cached prefix is gone.`,
      ];
    case "historyClear":
      return [
        "Delete the stored history? Every sample of the last 7 days is removed from 1ctx-mlx-engine's database and the graphs start over.",
      ];
    case "requestsClear":
      return [
        "Delete the stored requests? The list and the last request shown in the bar are removed from 1ctx-mlx-engine's database.",
      ];
    case "favorite":
      return []; // a toggle, no dialog
  }
}

export async function runAction(action: ActionName, model: string | null) {
  if (busy.value) return;
  const label = ACTION_LABEL[action];
  // a first load costs nothing already there and an unload only frees, so
  // neither needs a dialog; a second load is a memory decision and gets
  // the estimate
  const silent =
    action === "favorite" ||
    action === "unload" ||
    (action === "load" && loadedCount.value === 0);
  if (!silent) {
    // the restart dialog offers the disk wipe as an option: diskClear is a
    // restart plus the deletion of the SSD tier
    const canDiskClear = can("diskClear") && engineLocal.value;
    const a = await confirm(
      confirmText(action, model, {
        engineName: engineName.value,
        loadedCount: loadedCount.value,
        diskTotal: diskTotal.value,
        loadBytes: loadEstimate(model),
        modelBytes: modelBytes(model),
        modelDir: snapshot.value?.modelDir ?? "the model directory",
      }),
      label[0].toUpperCase() + label.slice(1),
      action === "free" && canDiskClear
        ? `${gb(diskTotal.value, 0)} GB`
        : undefined,
    );
    if (!a.ok) return;
    if (a.checked) action = "diskClear";
  }
  setBusy(action);
  try {
    const res = await fetch(`/api/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(model ? { model } : {}),
    });
    const body = (await res.json()) as ActionEvent | { error: string };
    if (!res.ok) {
      event.value = {
        t: Date.now(),
        action,
        model,
        ok: false,
        ms: 0,
        detail: (body as { error: string }).error ?? `HTTP ${res.status}`,
      };
    }
    // a 200 carries the event; the /ws push shows it in every tab
  } catch (err) {
    event.value = {
      t: Date.now(),
      action,
      model,
      ok: false,
      ms: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    setBusy(null);
    void refreshSnapshot();
  }
}
