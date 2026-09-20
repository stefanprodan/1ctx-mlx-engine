// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Engine page's signals: the manager's state from GET /api/engine and
// the {type: "engine"} push, the form over it, and the calls the buttons
// make. The form is this tab's until Apply or Install sends it; a push
// that does not change the applied config leaves an edit alone.

import { computed, signal } from "@preact/signals";
import type {
  ConfigIssue,
  EngineConfig,
  EnginePageState,
} from "../../engine/manage.ts";
import {
  changedFields,
  type Form,
  refusalLine,
  toConfig,
  toForm,
} from "./config.ts";

export const pageState = signal<EnginePageState | null>(null);
export const engine = computed(() => pageState.value?.engine ?? null);
export const spy = computed(() => pageState.value?.spy ?? null);

export const form = signal<Form | null>(null);
// what the form is compared against: the applied config, or DEFAULTS
// before there is a service
const applied = signal<Form | null>(null);
export const issues = signal<ConfigIssue[]>([]);
// the foot's message after a refused or failed Apply or Install
export const footError = signal<string | null>(null);
// Every other action's failure, shown at the top of the page: the foot is
// far from the button that failed, and a remote engine has no foot.
export const pageError = signal<string | null>(null);
// a call this tab made and that has not answered yet
export const pending = signal(false);

export const changed = computed(() =>
  form.value && applied.value
    ? changedFields(form.value, applied.value)
    : new Set<string>(),
);

// The manager's lock, or this tab's own call in flight: every mutating
// control goes off, mlx-spy's Restart included.
export const locked = computed(
  () => (engine.value?.operation ?? null) !== null || pending.value,
);

const key = (config: EngineConfig) => JSON.stringify(config);
let appliedKey = "";

export function setPageState(next: EnginePageState) {
  pageState.value = next;
  const e = next.engine;
  const k = key(e.config);
  if (k === appliedKey && form.value) return;
  // The applied config moved: this tab's Apply, another tab's, or the
  // first load. The baseline always follows it. The form follows only
  // when it holds no edit: what someone is typing is theirs, and the
  // outlines then show it against the new baseline.
  const editing = form.value !== null && changed.value.size > 0;
  appliedKey = k;
  applied.value = toForm(e.config, e.home);
  if (editing) return;
  form.value = toForm(e.config, e.home);
  issues.value = [];
  footError.value = null;
}

// A push is always newer than the answer to a request sent before it.
let pushes = 0;
export function pushPageState(next: EnginePageState) {
  pushes++;
  setPageState(next);
}

export function edit(patch: Partial<Form>) {
  if (!form.value) return;
  form.value = { ...form.value, ...patch };
  // a refusal belongs to the text that was refused
  const touched = new Set(Object.keys(patch));
  if (issues.value.some((i) => touched.has(i.field))) {
    issues.value = issues.value.filter((i) => !touched.has(i.field));
  }
  if (issues.value.length === 0) footError.value = null;
}

export function revert() {
  if (applied.value) form.value = { ...applied.value };
  issues.value = [];
  footError.value = null;
}

class Refused extends Error {
  constructor(
    message: string,
    readonly issues: ConfigIssue[],
  ) {
    super(message);
  }
}

async function call(path: string, method: string, body?: unknown) {
  const sent = pushes;
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    issues?: ConfigIssue[];
  } & Partial<EnginePageState>;
  if (!res.ok) {
    throw new Refused(data.error ?? `HTTP ${res.status}`, data.issues ?? []);
  }
  if (data.engine && data.spy && sent === pushes) {
    setPageState(data as EnginePageState);
  }
}

export function refresh(): Promise<void> {
  return call("/api/engine", "GET").catch(() => {});
}

async function run(what: string, op: () => Promise<void>, form = false) {
  if (pending.value) return;
  pending.value = true;
  footError.value = null;
  pageError.value = null;
  try {
    await op();
  } catch (error) {
    const refused = error instanceof Refused ? error.issues : [];
    const message = refused.length
      ? refusalLine(refused, what)
      : error instanceof Error
        ? error.message
        : String(error);
    if (form) {
      issues.value = refused;
      footError.value = message;
    } else {
      pageError.value = `${what} failed: ${message}`;
    }
  } finally {
    pending.value = false;
  }
}

// The form's own parse comes first: text that is not a number never
// reaches the server.
function parsed(what: string): EngineConfig | null {
  const e = engine.value;
  if (!form.value || !e) return null;
  const out = toConfig(form.value, e.home);
  if (out.issues.length) {
    issues.value = out.issues;
    footError.value = refusalLine(out.issues, what);
    return null;
  }
  return out.config;
}

export function applyConfig() {
  const config = parsed("Apply");
  if (!config) return Promise.resolve();
  return run("Apply", () => call("/api/engine/config", "PUT", config), true);
}

export function install(tag: string) {
  const config = parsed("Install");
  if (!config) return Promise.resolve();
  return run(
    "Install",
    () => call("/api/engine/install", "POST", { tag, config }),
    true,
  );
}

export const upgrade = (tag: string) =>
  run("Upgrade", () => call("/api/engine/upgrade", "POST", { tag }));
export const cancel = () =>
  run("Cancel", () => call("/api/engine/cancel", "POST"));
export const rollback = () =>
  run("Rollback", () => call("/api/engine/rollback", "POST"));
const SERVICE = { start: "Start", stop: "Stop", restart: "Restart" };
export const service = (op: "start" | "stop" | "restart") =>
  run(SERVICE[op], () => call("/api/engine/service", "POST", { op }));
export const uninstall = () =>
  run("Uninstall", () => call("/api/engine", "DELETE"));
export const dismiss = () =>
  run("Dismiss", () => call("/api/engine/dismiss", "POST"));
export const check = () =>
  run("Check", () => call("/api/engine/check", "POST"));
export const setPreReleases = (preReleases: boolean) =>
  run("Settings", () => call("/api/engine/settings", "PUT", { preReleases }));
export const restartSpy = () =>
  run("Restart", () => call("/api/spy/restart", "POST"));

// for tests
export function resetEngineState() {
  pageState.value = null;
  form.value = null;
  applied.value = null;
  issues.value = [];
  footError.value = null;
  pageError.value = null;
  pending.value = false;
  appliedKey = "";
  pushes = 0;
}
