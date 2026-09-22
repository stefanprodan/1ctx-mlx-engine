// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One slog-text line per event, the format 1ctx writes. The time is on
// every line: launchd's log file carries none. A line that repeats
// within the window is written once, then once more with its count.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

export type LogValue = string | number | boolean | undefined;

export type LogFields = Record<string, LogValue> & {
  time?: never;
  level?: never;
  msg?: never;
  area?: never;
  duration?: number;
};

export type LogLevel = "info" | "warn" | "error";
export type LogMethod = (msg: string, fields?: LogFields) => void;
export type Log = Record<LogLevel, LogMethod>;
export type LogFactory = (area: string) => Log;

const RESERVED = new Set(["time", "level", "msg", "area"]);
const KEY = /^[a-z][a-z0-9_]*$/;
const ERROR_RUNES = 200;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
const ERROR_NAMES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "ActionError",
  "AppError",
  "BenchmarkError",
  "DownloadError",
  "EngineManagerError",
  "HttpError",
  "HubError",
  "LockBusyError",
  "Retryable",
  "ServiceError",
]);
const NON_PRINTABLE = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;

function needsQuote(value: string): boolean {
  if (value === "") return true;
  for (const rune of value) {
    const code = rune.codePointAt(0)!;
    if (code <= 0x20 || rune === "=" || rune === '"') return true;
    if (code > 0x7f && NON_PRINTABLE.test(rune)) return true;
  }
  return false;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function invalidUtf8(code: number): string {
  if (code <= 0xdbff) {
    return [0xed, 0xa0 | ((code - 0xd800) >> 6), 0x80 | (code & 0x3f)]
      .map((byte) => `\\x${hex(byte, 2)}`)
      .join("");
  }
  return [0xed, 0xb0 | ((code - 0xdc00) >> 6), 0x80 | (code & 0x3f)]
    .map((byte) => `\\x${hex(byte, 2)}`)
    .join("");
}

function quote(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const rune = value.slice(i, i + 2);
        const point = rune.codePointAt(0)!;
        out += NON_PRINTABLE.test(rune) ? `\\U${hex(point, 8)}` : rune;
        i++;
      } else {
        out += invalidUtf8(code);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += invalidUtf8(code);
      continue;
    }
    const escapes: Record<number, string> = {
      7: "\\a",
      8: "\\b",
      9: "\\t",
      10: "\\n",
      11: "\\v",
      12: "\\f",
      13: "\\r",
    };
    if (escapes[code] !== undefined) out += escapes[code];
    else if (code === 0x22 || code === 0x5c) out += `\\${value[i]}`;
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else {
      const rune = value[i]!;
      out +=
        code > 0x7f && NON_PRINTABLE.test(rune) ? `\\u${hex(code, 4)}` : rune;
    }
  }
  return `${out}"`;
}

function stringValue(value: string): string {
  return needsQuote(value) ? quote(value) : value;
}

function numberValue(value: number): string {
  if (Object.is(value, -0)) return "-0";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e6 || absolute < 1e-4)) {
    return value.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
  }
  return String(value);
}

// the error is cut here, after the scrubber saw it whole: a key cut in
// half before scrubbing would leave its first half on the line
function cut(value: string): string {
  const runes = [...value];
  return runes.length <= ERROR_RUNES
    ? value
    : `${runes.slice(0, ERROR_RUNES - 3).join("")}...`;
}

export function format(
  at: Date,
  area: string,
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
): string {
  const parts = [
    `time=${at.toISOString()}`,
    `level=${level.toUpperCase()}`,
    `msg=${stringValue(msg)}`,
    `area=${stringValue(area)}`,
  ];
  let bad = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!KEY.test(key) || RESERVED.has(key)) {
      bad++;
      continue;
    }
    if (key === "duration" && typeof value !== "number") {
      bad++;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        bad++;
        continue;
      }
      parts.push(
        `${key}=${
          key === "duration" ? `${Math.round(value)}ms` : numberValue(value)
        }`,
      );
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${key}=${stringValue(key === "error" ? cut(value) : value)}`);
      continue;
    }
    if (typeof value === "boolean") {
      parts.push(`${key}=${value}`);
      continue;
    }
    bad++;
  }
  if (bad > 0) parts.push(`bad_fields=${bad}`);
  return parts.join(" ");
}

export interface LogSink {
  (line: string): void;
  close?(): void;
}

// what the app hands each area, and closes at exit
export interface Logs extends LogFactory {
  close(): void;
}

export interface LogOptions {
  repeatWindowMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface FileSinkOptions {
  threshold?: number;
  stderr?: (line: string) => void;
}

const ROTATION_BYTES = 8 * 1024 * 1024;
const REPEAT_WINDOW_MS = 10_000;
const NO_TIME = new Date(0);

export function createFileSink(
  path: string,
  options: FileSinkOptions = {},
): LogSink {
  if (path === "off") {
    return options.stderr ?? ((line) => console.error(line));
  }

  const threshold = options.threshold ?? ROTATION_BYTES;
  mkdirSync(dirname(path), { recursive: true });
  let fd = openSync(path, "a");

  const rotate = () => {
    closeSync(fd);
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
    fd = openSync(path, "a");
  };
  const sink: LogSink = (line) => {
    if (fstatSync(fd).size >= threshold) rotate();
    writeSync(fd, `${line}\n`);
  };
  sink.close = () => closeSync(fd);
  return sink;
}

interface Event {
  level: LogLevel;
  area: string;
  msg: string;
  fields: LogFields;
  // the line without its time: what a repeat must match
  key: string;
  at: number;
}

export function createLogs(
  write: LogSink = (line) => console.error(line),
  now: () => Date = () => new Date(),
  options: LogOptions = {},
): Logs {
  const repeatWindow = options.repeatWindowMs ?? REPEAT_WINDOW_MS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();
      return timer;
    });
  const clearTimer =
    options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as Timer));
  let previous: Event | null = null;
  let repeats = 0;
  let timer: unknown = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const flush = () => {
    cancelTimer();
    if (previous !== null && repeats > 0) {
      const { level, area, msg, fields } = previous;
      write(format(now(), area, level, msg, { ...fields, repeated: repeats }));
    }
    previous = null;
    repeats = 0;
  };
  const schedule = (milliseconds: number) => {
    if (timer !== null) return;
    timer = setTimer(flush, milliseconds);
  };
  const emit = (
    area: string,
    level: LogLevel,
    msg: string,
    fields: LogFields = {},
  ) => {
    const current = now();
    const at = current.getTime();
    const key = format(NO_TIME, area, level, msg, fields);
    if (
      previous !== null &&
      previous.key === key &&
      at - previous.at < repeatWindow
    ) {
      repeats++;
      schedule(repeatWindow - (at - previous.at));
      return;
    }
    flush();
    write(format(current, area, level, msg, fields));
    previous = { level, area, msg, fields, key, at };
  };

  const logs = (area: string): Log => ({
    info: (msg, fields) => emit(area, "info", msg, fields),
    warn: (msg, fields) => emit(area, "warn", msg, fields),
    error: (msg, fields) => emit(area, "error", msg, fields),
  });
  return Object.assign(logs, {
    close: () => {
      flush();
      write.close?.();
    },
  });
}

export const silent: Log = {
  info() {},
  warn() {},
  error() {},
};

export function scrubErrors(log: Log, values: () => string[]): Log {
  const scrub = (fields?: LogFields): LogFields | undefined => {
    if (typeof fields?.error !== "string") return fields;
    let error = fields.error;
    for (const value of values().sort((a, b) => b.length - a.length)) {
      if (value !== "") error = error.replaceAll(value, "[key]");
    }
    return { ...fields, error: cut(error) };
  };
  const write = (level: LogLevel) => (msg: string, fields?: LogFields) =>
    log[level](msg, scrub(fields));
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

function cleanUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    } catch {
      return raw;
    }
  });
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

function firstLine(message: string): string {
  return cleanUrls(message.split(LINE_BREAK, 1)[0] ?? "");
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) return "exception";
  const constructorName = error.constructor.name;
  const name = error.name === "Error" ? constructorName : error.name;
  return ERROR_NAMES.has(name) ? name : "exception";
}

function sourceStack(error: Error): string | undefined {
  const frames: string[] = [];
  // the message heads the stack and may span lines; frames follow it
  const skip = error.message.split("\n").length;
  for (const line of error.stack?.split("\n").slice(skip) ?? []) {
    // absolute under `bun test`, relative in a binary built with
    // --sourcemap, which is the only way a binary names its sources
    const found = line.match(
      /(?:\(|\s)(?:file:\/\/)?([^\s()]*src\/[^\s():]+):(\d+):\d+/,
    );
    if (found === null) continue;
    const path = `/${found[1]!}`;
    const server = path.lastIndexOf("/src/server/");
    const source = path.lastIndexOf("/src/");
    if (server >= 0) frames.push(`${path.slice(server + 12)}:${found[2]}`);
    else if (source >= 0) frames.push(`${path.slice(source + 5)}:${found[2]}`);
    if (frames.length === 5) break;
  }
  return frames.length > 0 ? frames.join(" ") : undefined;
}

export function errorFields(error: unknown, stack = true): LogFields {
  const fields: LogFields = { error_type: errorType(error) };
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (message) fields.error = firstLine(message);
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "string" && ERROR_CODE.test(value.code)) {
      fields.error_code = value.code;
    }
    if (typeof value.status === "number" && Number.isFinite(value.status)) {
      fields.status = value.status;
    }
    if (typeof value.retry === "boolean") fields.retry = value.retry;
  }
  if (stack && error instanceof Error) fields.stack = sourceStack(error);
  return fields;
}

export async function rotateStopped(
  path: string,
  threshold = ROTATION_BYTES,
): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (size < threshold) return false;
  rmSync(`${path}.1`, { force: true });
  renameSync(path, `${path}.1`);
  return true;
}
