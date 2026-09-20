// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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

export interface Log {
  (message: string): void;
  warn(message: string): void;
  error(message: string): void;
  flush?(): void;
  close?(): void;
}

export interface LogSink {
  (line: string): void;
  close?(): void;
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

type Level = "info" | "warn" | "error";

const ROTATION_BYTES = 8 * 1024 * 1024;
const REPEAT_WINDOW_MS = 10_000;

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

export function createLog(
  write: LogSink = (line) => console.error(line),
  now: () => Date = () => new Date(),
  options: LogOptions = {},
): Log {
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
  let previous: { level: Level; message: string; at: number } | null = null;
  let repeats = 0;
  let timer: unknown = null;

  const line = (level: Level, message: string) => {
    write(`${now().toISOString()} ${level} ${message}`);
  };
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const flush = () => {
    cancelTimer();
    if (previous !== null && repeats > 0) {
      line(previous.level, `${previous.message} (repeated ${repeats} times)`);
    }
    previous = null;
    repeats = 0;
  };
  const schedule = (milliseconds: number) => {
    if (timer !== null) return;
    timer = setTimer(flush, milliseconds);
  };
  const emit = (level: Level, message: string) => {
    const current = now();
    const currentMs = current.getTime();
    if (
      previous !== null &&
      previous.level === level &&
      previous.message === message &&
      currentMs - previous.at < repeatWindow
    ) {
      repeats++;
      schedule(repeatWindow - (currentMs - previous.at));
      return;
    }
    flush();
    write(`${current.toISOString()} ${level} ${message}`);
    previous = { level, message, at: currentMs };
  };

  const log = Object.assign((message: string) => emit("info", message), {
    warn: (message: string) => emit("warn", message),
    error: (message: string) => emit("error", message),
    flush,
    close: () => {
      flush();
      write.close?.();
    },
  });
  return log;
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
