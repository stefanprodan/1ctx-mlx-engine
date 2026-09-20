// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one WebSocket every page shares and the signals fed by it. A
// snapshot arrives on connect and a sample every second; the socket comes
// back two seconds after a close. Components read the signals; code that
// handles messages by hand subscribes with listen(). Nothing here touches
// the DOM.

import { computed, signal } from "@preact/signals";
import type { ActionEvent, ActionName } from "../shared/actions.ts";
import type { Download } from "../shared/downloads.ts";
import type { Sample } from "../shared/sample.ts";
import type { Snapshot, WsMessage } from "../shared/socket.ts";

export type Page = "monitor" | "requests" | "engine";
export type Connection = "connecting" | "live" | "reconnecting";

// one bundle serves every path; the page is the one the path names
export const pageOf = (pathname: string): Page =>
  pathname === "/requests"
    ? "requests"
    : pathname === "/engine"
      ? "engine"
      : "monitor";

export const connection = signal<Connection>("connecting");
export const connected = computed(() => connection.value === "live");
// the socket's first message, then /api/snapshot after an action or a
// change in residency
export const snapshot = signal<Snapshot | null>(null);
export const sample = signal<Sample | null>(null);
// The model list rides on every sample; the signal changes only when the
// residency picture does, so the table re-renders on a change, not 60
// times a minute. Its value comes from snapshots: a sample whose picture
// differs triggers the fetch of one.
export const models = signal<Sample["models"]>([]);
export const event = signal<ActionEvent | null>(null);
// The action in flight: this tab's, or the one the server reports in a
// snapshot (another tab's). Every control is disabled while it is set.
export const busy = signal<ActionName | null>(null);
let localAction = false;
export function setBusy(action: ActionName | null) {
  localAction = action !== null;
  busy.value = action;
}
export const version = computed(() => snapshot.value?.version ?? null);
// The downloads, newest first: the snapshot's list, then every download
// message replaces its row (or adds one on top).
export const downloads = signal<Download[]>([]);
export function applyDownload(download: Download) {
  const list = downloads.value;
  const at = list.findIndex((p) => p.id === download.id);
  downloads.value =
    at === -1
      ? [download, ...list]
      : list.map((p, i) => (i === at ? download : p));
}

// The page is the bundle the tab loaded; the server behind the socket can
// be replaced under it (a deploy, an upgrade). The first
// snapshot's build is the one this bundle came from, so a later snapshot
// with another build means the code on screen is old. Pure, for the test.
export const replaced = (
  loaded: string | null | undefined,
  now: string | null | undefined,
) => loaded != null && now != null && loaded !== now;
let loadedBuild: string | null | undefined;
function checkBuild(snap: Snapshot) {
  if (loadedBuild === undefined) loadedBuild = snap.build;
  else if (replaced(loadedBuild, snap.build)) location.reload();
}

export const modelsKeyOf = (list: Sample["models"]) =>
  list
    .map((m) => `${m.id}:${m.state}:${m.bytesResident}:${m.favorite ? 1 : 0}`)
    .join("|");
let modelsKey = "";
function setSnapshot(snap: Snapshot) {
  snapshot.value = snap;
  // a snapshot taken before this tab's own action registered must not
  // release the buttons early
  if (snap.running || !localAction) busy.value = snap.running;
  downloads.value = snap.downloads;
  const key = modelsKeyOf(snap.models);
  if (key === modelsKey) return;
  modelsKey = key;
  models.value = snap.models;
}

// The socket's messages reach the code that renders by hand through
// listen(); a fetched snapshot updates the signals only.
type Listener = (msg: WsMessage) => void;
const listeners = new Set<Listener>();
export function listen(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (msg: WsMessage) => {
  for (const fn of listeners) fn(msg);
};

export function refreshSnapshot(): Promise<Snapshot | null> {
  return fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => {
      setSnapshot(snap);
      return snap;
    })
    .catch(() => null);
}

export function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    connection.value = "live";
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as WsMessage;
    if (msg.type === "snapshot") {
      checkBuild(msg.data);
      setSnapshot(msg.data);
      if (msg.data.sample) sample.value = msg.data.sample;
    } else if (msg.type === "sample") {
      sample.value = msg.data;
      // a load or an eviction since the snapshot: fetch the new picture
      if (modelsKeyOf(msg.data.models) !== modelsKey) void refreshSnapshot();
    } else if (msg.type === "event") {
      event.value = msg.data;
      // another tab may have run it; the residency changed either way
      void refreshSnapshot();
    } else if (msg.type === "download") {
      applyDownload(msg.data);
    }
    emit(msg);
  };
  ws.onclose = () => {
    connection.value = "reconnecting";
    setTimeout(connect, 2000);
  };
}
