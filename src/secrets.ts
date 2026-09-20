// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The key files in the user's mlx-spy state directory, or .preview/secrets/
// when running from source. Only the Hugging Face token lives there; a
// missing file means anonymous downloads.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function secretsDirFor(
  main: string,
  _execPath: string,
  home: string,
): string {
  return main.endsWith(".ts")
    ? resolve(dirname(main), "../.preview/secrets")
    : resolve(home, ".mlx-spy/secrets");
}

export function secretsDir(): string {
  return secretsDirFor(Bun.main, process.execPath, homedir());
}

function keyError(path: string, message: string): never {
  throw new Error(`key file ${path}: ${message}`);
}

export function loadKey(path: string): string | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return keyError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!stat.isFile()) return keyError(path, "not a regular file");
  if (stat.size > 4096) return keyError(path, "must be at most 4 KB");
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    return keyError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (value === "") return keyError(path, "must not be empty");
  if (!/^[\x20-\x7e]+$/u.test(value)) {
    return keyError(path, "must contain printable ASCII only");
  }
  return value;
}
