// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../../package.json";
import { parseSize } from "./engine/config.ts";
import { DEFAULT_PORT } from "./lib/net.ts";

const buildVersion = process.env.ONECTX_MLX_BUILD_VERSION;
export const VERSION = buildVersion || `v${pkg.version}`;
// When the binary was compiled, injected like the version. It is what
// tells an open page that the server behind it was replaced: every dev
// build reports the same VERSION, so the version cannot. Null from
// source, where Bun's dev server reloads the page itself.
export const BUILD = process.env.ONECTX_MLX_BUILD_ID || null;

export const DEFAULT_ENGINE = "http://127.0.0.1:11234";
export const DEFAULT_DB = join(homedir(), ".1ctx-mlx-engine", "engine.db");
// Outside the data directory: models are the user's, tens of gigabytes that
// other MLX tools read too, and removing ~/.1ctx-mlx-engine must not take
// them along.
export const DEFAULT_MODEL_DIR = join(homedir(), "models");
export const DEFAULT_RETENTION_DAYS = 7;

export const HELP = `\x1b[1m1ctx-mlx-engine\x1b[0m - monitor and control an LLM inference server

\x1b[1mUsage:\x1b[0m
  1ctx-mlx-engine [options]
  1ctx-mlx-engine service install [options] [--restart]
  1ctx-mlx-engine service status|start|stop|restart
  1ctx-mlx-engine service uninstall [--purge]

\x1b[1mOptions:\x1b[0m
  --engine <url>       engine base URL (default: ${DEFAULT_ENGINE})
  --listen <host:port> bind address (default: the Tailscale address, else
                       127.0.0.1, port ${DEFAULT_PORT})
  --db <path>          SQLite history file (default:
                       ~/.1ctx-mlx-engine/engine.db; ":memory:" keeps
                       nothing)
  --retention <days>   history retention (default: ${DEFAULT_RETENTION_DAYS})
  --model-dir <path>   where downloads from the Hugging Face Hub land, as
                       <owner>/<name> directories (default: ~/models)
  --hot-cache-max <n>  hot cache budget per model, e.g. 16GB (default: read
                       from the engine's launchd plist when local)
  --disk-cache-max <n> SSD cache tier budget per model, e.g. 50GB (same)
  --log-file <path|off> append logs to a rotating file (default: off)
  --once               print one JSON sample and exit
  -v, --version        show version
  -h, --help           show this help
  Keys: ~/.1ctx-mlx-engine/secrets/hf.key when installed
                       (.preview/secrets/ from source); the Hub is
                       anonymous when the file is missing; read at start

\x1b[1mAPI:\x1b[0m
  GET /                        the dashboard
  GET /requests                finished and in-flight engine requests
  GET|POST /api/downloads          list downloads or start one (body {"repo"})
  GET|DELETE /api/downloads/<id>   read or forget a download
  POST /api/downloads/<id>/cancel  stop a download; its parts are kept
  GET /api/snapshot            latest sample and model list
  GET /api/history?range=1h    series for 1h, 6h, 24h or 7d
  WS  /ws                      snapshot on connect, then one sample per second
  POST /api/actions/<name>     load, unload, default (body {"model"}), free,
                               diskClear (the last two only for a local engine),
                               historyClear (wipes the sample database),
                               requestsClear (wipes the stored requests),
                               favorite (toggles the daily-driver star)

\x1b[1mExamples:\x1b[0m
  1ctx-mlx-engine --engine http://127.0.0.1:11234 --once
  1ctx-mlx-engine --engine http://studio.tailnet:11234 --listen 127.0.0.1:11235`;

export interface ListenAddress {
  hostname: string | null;
  port: number | null;
}

export interface Options {
  engineUrl: string;
  listen: ListenAddress | null;
  dbPath: string;
  modelDir: string;
  retentionDays: number;
  once: boolean;
  hotMax: number | null;
  diskMax: number | null;
  logFile: string;
}

export type CliResult =
  | { kind: "run"; options: Options }
  | { kind: "help"; text: string }
  | { kind: "version" }
  | { kind: "service"; argv: string[] }
  | { kind: "error"; message: string };

function parseListen(value: string): ListenAddress | string {
  // host, :port, host:port or [v6]:port
  const match = /^(?:\[([^\]]+)\]|([^:]*))(?::(\d+))?$/.exec(value);
  if (!match) return `invalid --listen: ${value}`;
  const port = match[3] === undefined ? null : Number(match[3]);
  if (port !== null && (port < 1 || port > 65535)) {
    return `invalid --listen port: ${match[3]}`;
  }
  return { hostname: match[1] ?? (match[2] || null), port };
}

export function formatListen(listen: ListenAddress): string {
  const hostname = listen.hostname ?? "";
  const formatted = hostname.includes(":") ? `[${hostname}]` : hostname;
  return listen.port === null ? formatted : `${formatted}:${listen.port}`;
}

export function optionsToArgs(options: Options): string[] {
  const args = [
    "--engine",
    options.engineUrl,
    "--db",
    options.dbPath,
    "--retention",
    String(options.retentionDays),
    "--model-dir",
    options.modelDir,
  ];
  if (options.listen) args.push("--listen", formatListen(options.listen));
  if (options.hotMax !== null) {
    args.push("--hot-cache-max", String(options.hotMax));
  }
  if (options.diskMax !== null) {
    args.push("--disk-cache-max", String(options.diskMax));
  }
  args.push("--log-file", options.logFile);
  return args;
}

export function parseCli(argv: string[]): CliResult {
  if (argv[0] === "service") {
    return { kind: "service", argv: argv.slice(1) };
  }

  let engineUrl = DEFAULT_ENGINE;
  let listenValue: string | null = null;
  let dbPath = DEFAULT_DB;
  let modelDir = DEFAULT_MODEL_DIR;
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let once = false;
  let hotMax: number | null = null;
  let diskMax: number | null = null;
  let logFile = "off";

  function value(i: number): [string, number] | CliResult {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    if (eq !== -1) return [arg.slice(eq + 1), i];
    const next = argv[i + 1];
    // A value that really starts with a dash can use --flag=value.
    if (next === undefined || next.startsWith("-")) {
      return { kind: "error", message: `${arg} needs a value` };
    }
    return [next, i + 1];
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split("=")[0];
    if (arg === "-h" || arg === "--help") {
      return { kind: "help", text: HELP };
    }
    if (arg === "-v" || arg === "--version") {
      return { kind: "version" };
    }
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (
      name !== "--engine" &&
      name !== "--listen" &&
      name !== "--db" &&
      name !== "--model-dir" &&
      name !== "--retention" &&
      name !== "--hot-cache-max" &&
      name !== "--disk-cache-max" &&
      name !== "--log-file"
    ) {
      return { kind: "error", message: `unknown argument: ${arg}` };
    }

    const parsed = value(i);
    if (!Array.isArray(parsed)) return parsed;
    const [raw, nextIndex] = parsed;
    i = nextIndex;

    if (name === "--engine") engineUrl = raw;
    else if (name === "--listen") listenValue = raw;
    else if (name === "--db") dbPath = raw === ":memory:" ? raw : resolve(raw);
    else if (name === "--model-dir") {
      if (raw === "") {
        return { kind: "error", message: "--model-dir must not be empty" };
      }
      modelDir = resolve(raw);
    } else if (name === "--log-file") {
      if (raw === "") {
        return { kind: "error", message: "--log-file must not be empty" };
      }
      logFile = raw === "off" ? raw : resolve(raw);
    } else if (name === "--retention") {
      retentionDays = Number(raw);
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return {
          kind: "error",
          message: `--retention must be a positive number of days: ${raw}`,
        };
      }
    } else {
      const bytes = parseSize(raw);
      if (bytes === null) {
        return {
          kind: "error",
          message: `${name} expects <n>{KB,MB,GB} or off: ${raw}`,
        };
      }
      if (name === "--hot-cache-max") hotMax = bytes;
      else diskMax = bytes;
    }
  }

  try {
    new URL(engineUrl);
  } catch {
    return { kind: "error", message: `invalid engine URL: ${engineUrl}` };
  }

  let listen: ListenAddress | null = null;
  if (!once && listenValue !== null) {
    const parsed = parseListen(listenValue);
    if (typeof parsed === "string") {
      return { kind: "error", message: parsed };
    }
    listen = parsed;
  }

  return {
    kind: "run",
    options: {
      engineUrl,
      listen,
      dbPath,
      modelDir,
      retentionDays,
      once,
      hotMax,
      diskMax,
      logFile,
    },
  };
}
