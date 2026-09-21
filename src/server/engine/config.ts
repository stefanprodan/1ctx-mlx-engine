// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  ConfigField,
  ConfigIssue,
  EngineConfig,
} from "../../shared/engine.ts";
import type { CacheLimits } from "../../shared/models.ts";

// mlx-serve's own size grammar (parseSizeArg in main.zig): <n>{KB,MB,GB},
// a bare number of bytes, or "0"/"off". Binary units, as the engine uses.
export function parseSize(s: string): number | null {
  const v = s.trim();
  if (v === "off" || v === "0") return 0;
  const m = /^(\d+)\s*(KB|MB|GB|B)?$/i.exec(v);
  if (!m) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] ?? 1;
  return Number(m[1]) * mult;
}

function loopback(host: string): boolean {
  let value = host.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

// The bind follows the page's own: a program that listens beyond loopback
// serves other machines, and an engine on 127.0.0.1 would answer none of
// them.
export function DEFAULTS(
  pinnedModelDir: string,
  engineUrl: string,
  listenHost = "127.0.0.1",
): EngineConfig {
  const url = new URL(engineUrl);
  return {
    host:
      loopback(url.hostname) && loopback(listenHost) ? "127.0.0.1" : "0.0.0.0",
    port: url.port === "" ? 11234 : Number(url.port),
    modelDirs: [pinnedModelDir],
    prefixCacheMem: null,
    prefixCacheDisk: null,
    prefixCacheEntries: null,
    maxResidentModels: null,
    maxResidentMem: null,
    ctxSize: null,
    idleEvictSeconds: null,
    temp: null,
    topP: null,
    topK: null,
    kvQuant: "off",
    mtp: false,
    pld: true,
    noVision: false,
    logLevel: "info",
    extraArgs: [],
  };
}

type SplitArgs = { args: string[]; valid: boolean };

function splitArgLine(line: string): SplitArgs {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of line) {
    if (escaped) {
      token += char;
      started = true;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
  }
  if (started) args.push(token);
  return { args, valid: quote === null && !escaped };
}

function addValue(args: string[], flag: string, value: string | number | null) {
  if (value !== null) args.push(flag, String(value));
}

// Flag names and defaults were checked against mlx-serve 26.9.2 --help on
// 2026-09-20. The binary path is supplied separately by the plist.
export function configToArgs(config: EngineConfig, logFile: string): string[] {
  const args = [
    "--serve",
    "--metrics",
    "--host",
    config.host,
    "--port",
    String(config.port),
  ];
  for (const dir of config.modelDirs) args.push("--model-dir", dir);
  addValue(args, "--prefix-cache-mem", config.prefixCacheMem);
  addValue(args, "--prefix-cache-disk", config.prefixCacheDisk);
  addValue(args, "--prefix-cache-entries", config.prefixCacheEntries);
  addValue(args, "--max-resident-models", config.maxResidentModels);
  addValue(args, "--max-resident-mem", config.maxResidentMem);
  addValue(args, "--ctx-size", config.ctxSize);
  addValue(args, "--idle-evict-secs", config.idleEvictSeconds);
  addValue(args, "--temp", config.temp);
  addValue(args, "--top-p", config.topP);
  addValue(args, "--top-k", config.topK);
  args.push("--kv-quant", config.kvQuant);
  if (config.noVision) args.push("--no-vision");
  if (!config.pld) args.push("--no-pld");
  if (config.mtp) args.push("--mtp");
  args.push("--log-file", logFile, "--log-level", config.logLevel);
  for (const line of config.extraArgs) {
    args.push(...splitArgLine(line).args);
  }
  return args;
}

const TYPED_FLAGS = new Set([
  "--serve",
  "--metrics",
  "--host",
  "--port",
  "--model-dir",
  "--prefix-cache-mem",
  "--prefix-cache-disk",
  "--prefix-cache-entries",
  "--max-resident-models",
  "--max-resident-mem",
  "--ctx-size",
  "--idle-evict-secs",
  "--temp",
  "--top-p",
  "--top-k",
  "--kv-quant",
  "--mtp",
  "--pld",
  "--no-pld",
  "--no-vision",
  "--log-file",
  "--log-level",
  "--api-key",
  "--api-key-env",
]);

function issue(issues: ConfigIssue[], field: ConfigField, message: string) {
  issues.push({ field, message });
}

function validInteger(value: number | null, min: number, max = Infinity) {
  return (
    value === null ||
    (Number.isInteger(value) &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max)
  );
}

export type ConfigValidation = {
  pinnedModelDir: string;
  watchedPort: number;
  engineHost: string;
};

export function validateConfig(
  config: EngineConfig,
  validation: ConfigValidation,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.host !== "127.0.0.1" && config.host !== "0.0.0.0") {
    issue(issues, "host", "Host must be 127.0.0.1 or 0.0.0.0.");
  }
  if (!validInteger(config.port, 1, 65_535)) {
    issue(issues, "port", "Port must be between 1 and 65535.");
  } else if (config.port !== validation.watchedPort) {
    issue(
      issues,
      "port",
      `1ctx-mlx-engine is watching port ${validation.watchedPort}. ` +
        "Change where it looks with 1ctx-mlx-engine service install --engine.",
    );
  }
  if (config.host === "127.0.0.1" && !loopback(validation.engineHost)) {
    issue(
      issues,
      "host",
      `1ctx-mlx-engine reaches mlx-serve at ${validation.engineHost}. ` +
        "A loopback-only listener would hide it.",
    );
  }
  if (config.modelDirs.length < 1 || config.modelDirs.length > 8) {
    issue(issues, "modelDirs", "Use between 1 and 8 model directories.");
  }
  if (config.modelDirs.some((dir) => !isAbsolute(dir))) {
    issue(issues, "modelDirs", "Model directories must be absolute paths.");
  }
  if (!config.modelDirs.includes(validation.pinnedModelDir)) {
    issue(
      issues,
      "modelDirs",
      "1ctx-mlx-engine's model directory must stay in the list.",
    );
  }
  for (const [field, value] of [
    ["prefixCacheMem", config.prefixCacheMem],
    ["prefixCacheDisk", config.prefixCacheDisk],
  ] as const) {
    if (value !== null && parseSize(value) === null) {
      issue(issues, field, "Use bytes or a size ending in KB, MB, or GB.");
    }
  }
  if (
    config.maxResidentMem !== null &&
    config.maxResidentMem !== "auto" &&
    parseSize(config.maxResidentMem) === null
  ) {
    issue(
      issues,
      "maxResidentMem",
      "Use auto, bytes, or a size ending in KB, MB, or GB.",
    );
  }
  if (!validInteger(config.prefixCacheEntries, 0)) {
    issue(issues, "prefixCacheEntries", "Entries must be zero or greater.");
  }
  if (!validInteger(config.maxResidentModels, 1, 16)) {
    issue(issues, "maxResidentModels", "Models must be between 1 and 16.");
  }
  if (!validInteger(config.ctxSize, 1)) {
    issue(issues, "ctxSize", "Context size must be a positive integer.");
  }
  if (!validInteger(config.idleEvictSeconds, 0)) {
    issue(issues, "idleEvictSeconds", "Idle eviction must be zero or greater.");
  }
  if (
    config.temp !== null &&
    (!Number.isFinite(config.temp) || config.temp < 0 || config.temp > 2)
  ) {
    issue(issues, "temp", "Temperature must be between 0 and 2.");
  }
  if (
    config.topP !== null &&
    (!Number.isFinite(config.topP) || config.topP < 0 || config.topP > 1)
  ) {
    issue(issues, "topP", "Top-p must be between 0 and 1.");
  }
  if (!validInteger(config.topK, 0)) {
    issue(issues, "topK", "Top-k must be zero or greater.");
  }
  for (const line of config.extraArgs) {
    if (
      [...line].some((char) => {
        const code = char.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      issue(issues, "extraArgs", "Extra arguments cannot contain controls.");
      continue;
    }
    const split = splitArgLine(line);
    if (
      !split.valid ||
      split.args.length === 0 ||
      !split.args[0].startsWith("--")
    ) {
      issue(issues, "extraArgs", "Each extra argument must start with --.");
      continue;
    }
    const denied = split.args.find((arg) => {
      const name = arg.split("=", 1)[0];
      return name.startsWith("--") && TYPED_FLAGS.has(name);
    });
    if (denied) {
      issue(
        issues,
        "extraArgs",
        `${denied.split("=", 1)[0]} is managed by 1ctx-mlx-engine.`,
      );
    }
  }
  return issues;
}

// The <string> children of the ProgramArguments array in a launchd plist.
// The plist is our own XML file, so a scan for the array after the key is
// enough; a binary plist yields no arguments.
export function parseLaunchdArgs(xml: string): string[] {
  const key = xml.indexOf("<key>ProgramArguments</key>");
  if (key === -1) return [];
  const start = xml.indexOf("<array>", key);
  const end = xml.indexOf("</array>", start);
  if (start === -1 || end === -1) return [];
  const body = xml.slice(start, end);
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

// Hot budget defaults to 2 GB and the SSD tier to off, as in mlx-serve.
export function limitsFromArgs(args: string[]): CacheLimits {
  const limits: CacheLimits = { hotBytes: 2 * 1024 ** 3, diskBytes: 0 };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (name !== "--prefix-cache-mem" && name !== "--prefix-cache-disk") {
      continue;
    }
    const raw = inline ?? args[++i];
    const bytes = raw === undefined ? null : parseSize(raw);
    if (bytes === null) continue;
    if (name === "--prefix-cache-mem") limits.hotBytes = bytes;
    else limits.diskBytes = bytes;
  }
  return limits;
}

// The budgets are launch flags on the local engine's LaunchAgent.
export function cacheLimits(serviceLabel: string): CacheLimits | null {
  const plist = join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${serviceLabel}.plist`,
  );
  try {
    const args = parseLaunchdArgs(readFileSync(plist, "utf8"));
    return args.length ? limitsFromArgs(args) : null;
  } catch {
    return null;
  }
}
