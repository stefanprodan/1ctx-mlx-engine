// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export interface Log {
  (message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type Level = "info" | "warn" | "error";

export function createLog(
  write: (line: string) => void = (line) => console.error(line),
  now: () => Date = () => new Date(),
): Log {
  const emit = (level: Level, message: string) => {
    write(`${now().toISOString()} ${level} ${message}`);
  };
  return Object.assign((message: string) => emit("info", message), {
    warn: (message: string) => emit("warn", message),
    error: (message: string) => emit("error", message),
  });
}
