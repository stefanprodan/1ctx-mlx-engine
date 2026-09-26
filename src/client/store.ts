// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one WebSocket every page shares and the signals fed by it. A
// snapshot arrives on connect and a sample every second; the socket comes
// back two seconds after a close. Components read the signals; code that
// handles messages by hand subscribes with listen(). The page on screen
// lives here too, with go(), which moves the history and the scroll.

import { computed, signal } from "@preact/signals";
import type { ActionEvent, ActionName } from "../shared/actions.ts";
import type { BenchmarkProgress } from "../shared/benchmark.ts";
import type { Download } from "../shared/downloads.ts";
import {
  type EngineMode,
  type EnginePageState,
  type Updates,
  updatesOf,
} from "../shared/engine.ts";
import type { Sample } from "../shared/sample.ts";
import type { Snapshot, WsMessage } from "../shared/socket.ts";

export type Page =
  | "monitor"
  | "requests"
  | "models"
  | "server"
  | "scorecard"
  | "run";
export type Connection = "connecting" | "live" | "reconnecting";

// one bundle serves every path; the page is the one the path names
export const pageOf = (pathname: string): Page =>
  pathname === "/requests"
    ? "requests"
    : pathname === "/models"
      ? "models"
      : pathname === "/server"
        ? "server"
        : pathname === "/benchmark"
          ? "run"
          : pathname === "/benchmark/scorecard"
            ? "scorecard"
            : "monitor";

// the pages in the rail's order, with the section a page sits under: the
// rail, its folded strip and the page head read this one table
export type Section = "Monitor" | "Engine" | "Benchmark";
export const PAGES: readonly {
  page: Page;
  href: string;
  label: string;
  section: Section | null;
}[] = [
  { page: "monitor", href: "/", label: "Overview", section: "Monitor" },
  {
    page: "requests",
    href: "/requests",
    label: "Requests",
    section: "Monitor",
  },
  { page: "models", href: "/models", label: "Models", section: "Engine" },
  { page: "server", href: "/server", label: "Server", section: "Engine" },
  { page: "run", href: "/benchmark", label: "Run", section: "Benchmark" },
  {
    page: "scorecard",
    href: "/benchmark/scorecard",
    label: "Scorecard",
    section: "Benchmark",
  },
];

// The page on screen. The rail swaps it in place instead of loading
// another document: a load paints every page empty before its data
// arrives, and the data it would wait for is already here. Set from the
// path at start, then by go() and the history's back and forward.
export const page = signal<Page>("monitor");
let landed = false;
export function go(href: string, replace = false) {
  // a page the tab chose itself: the bare-host landing no longer applies
  landed = true;
  if (href !== location.pathname) {
    if (replace) history.replaceState(null, "", href);
    else history.pushState(null, "", href);
    scrollTo(0, 0);
  }
  page.value = pageOf(href);
}
// a plain click follows in place; a modified or middle click keeps what
// the browser does with a link (a new tab, a new window)
export const followsInPlace = (e: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
export function follow(e: MouseEvent, href: string) {
  if (e.defaultPrevented || !followsInPlace(e)) return;
  e.preventDefault();
  go(href);
}

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
export const busy = signal<ActionName | "benchmark" | null>(null);
let localAction = false;
export function setBusy(action: ActionName | null) {
  localAction = action !== null;
  busy.value = action;
}
export const version = computed(() => snapshot.value?.version ?? null);
// What the manager makes of the engine: the snapshot's word, then every
// engine push (an install in another tab). Absent is a bare host: there
// the pages say not installed and point at the Server page, where an
// engine that is merely down says offline.
export const engineMode = signal<EngineMode | null>(null);
export const absent = computed(() => engineMode.value === "absent");
// The build the engine runs: the snapshot's word, then every engine push
// while the engine is ours (an upgrade or a rollback, in any tab). Only a
// snapshot carries an unmanaged engine's, which the sampler reads.
export const engineVersion = signal<string | null>(null);
// The newer builds the Server page offers, for the rail's pill: the
// snapshot's, then every engine push (a check, an upgrade in another tab).
export const updates = signal<Updates | null>(null);
// what the pill says under the pointer, null when nothing is offered
export const updateNote = (u: Updates | null): string | null => {
  const parts = [
    u?.engine ? `mlx-serve ${u.engine}` : null,
    u?.self ? `1ctx-mlx-engine ${u.self}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} available` : null;
};
// The benchmark in progress: the snapshot's, then every benchmark message.
// The last message of a run carries its final status and clears this; the
// count tells the Benchmark page to read the finished runs again, as a
// deleted run does.
export const benchmark = signal<BenchmarkProgress | null>(null);
export const benchmarksChanged = signal(0);
export function applyBenchmark(progress: BenchmarkProgress) {
  if (progress.benchmark.status === "running") {
    benchmark.value = progress;
    busy.value = "benchmark";
    return;
  }
  benchmark.value = null;
  benchmarksChanged.value++;
  void refreshSnapshot();
}
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

// A bare host has one thing to do, and it is on the Server page: a visit
// that lands on the Monitor from outside (the URL the installer printed, a
// bookmark) goes there. A click on Monitor in the nav stays.
export const landsOnEngine = (
  pathname: string,
  referrer: string,
  origin: string,
  mode: EngineMode | null,
) => mode === "absent" && pathname === "/" && !referrer.startsWith(origin);
function land(snap: Snapshot) {
  if (landed) return;
  landed = true;
  if (
    landsOnEngine(
      location.pathname,
      document.referrer,
      location.origin,
      snap.engine.mode,
    )
  ) {
    go("/server", true);
  }
}

export const modelsKeyOf = (list: Sample["models"]) =>
  list
    .map(
      (m) =>
        `${m.id}:${m.state}:${m.bytesResident}:${m.bytesOnDisk}:${m.favorite ? 1 : 0}:${m.deleted ? 1 : 0}`,
    )
    .join("|");
let modelsKey = "";
// The engine pushes own the mode and the updates: a fetched snapshot sent
// before a push is older than it and leaves both as the push set them.
let enginePushes = 0;
function setSnapshot(snap: Snapshot, stale = false) {
  snapshot.value = snap;
  if (!stale) {
    engineMode.value = snap.engine.mode;
    engineVersion.value = snap.engine.version;
    updates.value = snap.updates;
  }
  // a snapshot taken before this tab's own action registered must not
  // release the buttons early
  if (snap.running || !localAction) busy.value = snap.running;
  downloads.value = snap.downloads;
  benchmark.value = snap.benchmark;
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

// an engine push: the mode, the build and the updates, newer than any
// snapshot in flight
export function applyEngine(state: EnginePageState) {
  enginePushes++;
  engineMode.value = state.engine.mode;
  if (state.engine.mode === "managed") {
    engineVersion.value = state.engine.active?.version ?? null;
  }
  updates.value = updatesOf(state.engine, state.self.offered);
  // A snapshot read during an operation (the new engine's first sample
  // lands before the upgrade lets go of the lock) set busy to it, and the
  // push that ends the operation is the only word that it is over.
  if (!state.engine.operation && busy.value !== null && !localAction) {
    void refreshSnapshot();
  }
}

export function refreshSnapshot(): Promise<Snapshot | null> {
  const sent = enginePushes;
  return fetch("/api/snapshot")
    .then((r) => r.json())
    .then((snap: Snapshot) => {
      setSnapshot(snap, sent !== enginePushes);
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
      land(msg.data);
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
    } else if (msg.type === "benchmark") {
      applyBenchmark(msg.data);
    } else if (msg.type === "benchmarkRemoved") {
      benchmarksChanged.value++;
    } else if (msg.type === "engine") {
      applyEngine(msg.data);
    }
    emit(msg);
  };
  ws.onclose = () => {
    connection.value = "reconnecting";
    setTimeout(connect, 2000);
  };
}
