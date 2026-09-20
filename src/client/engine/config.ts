// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Configuration form's model: every field as the text the input
// holds, so a blank stays a blank (the engine's own default) and a typo
// stays visible until it is fixed. Pure: the page owns the signals.

import type {
  BindHost,
  ConfigField,
  ConfigIssue,
  EngineConfig,
  KvQuant,
  LogLevel,
} from "../../shared/engine.ts";
import { abbreviateHome, expandHome } from "../../shared/paths.ts";

export type Form = {
  host: BindHost;
  port: string;
  modelDirs: string[];
  prefixCacheMem: string;
  prefixCacheDisk: string;
  prefixCacheEntries: string;
  maxResidentModels: string;
  maxResidentMem: string;
  ctxSize: string;
  idleEvictSeconds: string;
  temp: string;
  topP: string;
  topK: string;
  kvQuant: KvQuant;
  mtp: boolean;
  pld: boolean;
  noVision: boolean;
  logLevel: LogLevel;
  extraArgs: string;
};

export const HOST_NOTES: Record<BindHost, string> = {
  "0.0.0.0": "any interface",
  "127.0.0.1": "loopback only",
};
export const KV_QUANTS: KvQuant[] = ["off", "4", "8", "turbo2", "turbo4"];
export const LOG_LEVELS: LogLevel[] = ["info", "warn", "error", "debug"];
export const MAX_MODEL_DIRS = 8;

const text = (value: number | string | null) =>
  value === null ? "" : String(value);

export function toForm(config: EngineConfig, home: string): Form {
  return {
    host: config.host,
    port: String(config.port),
    modelDirs: config.modelDirs.map((d) => abbreviateHome(d, home)),
    prefixCacheMem: text(config.prefixCacheMem),
    prefixCacheDisk: text(config.prefixCacheDisk),
    prefixCacheEntries: text(config.prefixCacheEntries),
    maxResidentModels: text(config.maxResidentModels),
    maxResidentMem: text(config.maxResidentMem),
    ctxSize: text(config.ctxSize),
    idleEvictSeconds: text(config.idleEvictSeconds),
    temp: text(config.temp),
    topP: text(config.topP),
    topK: text(config.topK),
    kvQuant: config.kvQuant,
    mtp: config.mtp,
    pld: config.pld,
    noVision: config.noVision,
    logLevel: config.logLevel,
    extraArgs: config.extraArgs.join("\n"),
  };
}

const NUMERIC: { field: ConfigField & keyof Form; integer: boolean }[] = [
  { field: "port", integer: true },
  { field: "prefixCacheEntries", integer: true },
  { field: "maxResidentModels", integer: true },
  { field: "ctxSize", integer: true },
  { field: "idleEvictSeconds", integer: true },
  { field: "temp", integer: false },
  { field: "topP", integer: false },
  { field: "topK", integer: true },
];

// A blank is null. Anything that is not a number is caught here, where
// the input is; what the number may be is the server's to refuse.
export function toConfig(
  form: Form,
  home: string,
): { config: EngineConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const numbers: Partial<Record<ConfigField, number | null>> = {};
  for (const { field, integer } of NUMERIC) {
    const raw = (form[field] as string).trim();
    if (raw === "") {
      numbers[field] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      issues.push({
        field,
        message: integer ? "Not a whole number." : "Not a number.",
      });
      numbers[field] = null;
      continue;
    }
    numbers[field] = n;
  }
  if (numbers.port == null && !issues.some((i) => i.field === "port")) {
    issues.push({ field: "port", message: "A port is required." });
  }
  const size = (value: string) => value.trim() || null;
  const config: EngineConfig = {
    host: form.host,
    port: numbers.port ?? 0,
    modelDirs: form.modelDirs
      .map((d) => expandHome(d, home))
      .filter((d) => d !== ""),
    prefixCacheMem: size(form.prefixCacheMem),
    prefixCacheDisk: size(form.prefixCacheDisk),
    prefixCacheEntries: numbers.prefixCacheEntries ?? null,
    maxResidentModels: numbers.maxResidentModels ?? null,
    maxResidentMem: size(form.maxResidentMem),
    ctxSize: numbers.ctxSize ?? null,
    idleEvictSeconds: numbers.idleEvictSeconds ?? null,
    temp: numbers.temp ?? null,
    topP: numbers.topP ?? null,
    topK: numbers.topK ?? null,
    kvQuant: form.kvQuant,
    mtp: form.mtp,
    pld: form.pld,
    noVision: form.noVision,
    logLevel: form.logLevel,
    extraArgs: form.extraArgs
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  };
  return { config, issues };
}

// The fields whose text differs from the applied config's: the amber
// outlines, and whether Apply is armed. A directory row counts by index.
export function changedFields(form: Form, applied: Form): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(form) as (keyof Form)[]) {
    if (key === "modelDirs") continue;
    const a = form[key];
    const b = applied[key];
    const same =
      typeof a === "string" && typeof b === "string"
        ? a.trim() === b.trim()
        : a === b;
    if (!same) out.add(key);
  }
  const rows = Math.max(form.modelDirs.length, applied.modelDirs.length);
  for (let i = 0; i < rows; i++) {
    if ((form.modelDirs[i] ?? "").trim() !== (applied.modelDirs[i] ?? "")) {
      out.add(`modelDirs.${i}`);
    }
  }
  if (form.modelDirs.length !== applied.modelDirs.length) {
    out.add("modelDirs");
  }
  return out;
}

export const issueFor = (issues: ConfigIssue[], field: ConfigField) =>
  issues.find((i) => i.field === field)?.message ?? null;

export function refusalLine(issues: ConfigIssue[], what: string): string {
  const fields = new Set(issues.map((i) => i.field)).size;
  return `${what} was refused. ${fields} field${fields === 1 ? "" : "s"} need${
    fields === 1 ? "s" : ""
  } fixing.`;
}
