// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKey, secretsDirFor } from "../../../src/server/lib/secrets.ts";

describe("key files", () => {
  test("loads valid keys and rejects invalid files with their paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "1ctx-mlx-engine-secrets-"));
    try {
      const missing = join(dir, "missing.key");
      expect(loadKey(missing)).toBeNull();
      const valid = join(dir, "valid.key");
      writeFileSync(valid, "secret\n");
      expect(loadKey(valid)).toBe("secret");
      const invalid = [
        ["empty.key", ""],
        ["space.key", " \n"],
        ["large.key", "x".repeat(4097)],
        ["control.key", "bad\u0001key"],
        ["unicode.key", "sécret"],
      ] as const;
      for (const [name, value] of invalid) {
        const path = join(dir, name);
        writeFileSync(path, value);
        expect(() => loadKey(path), name).toThrow(path);
      }
      const directory = join(dir, "directory.key");
      mkdirSync(directory);
      expect(() => loadKey(directory)).toThrow(directory);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves source and Homebrew secret directories", () => {
    expect(secretsDirFor("/r/src/main.ts", "/Users/x")).toBe(
      "/r/.preview/secrets",
    );
    // a compiled binary reports /$bunfs/root/<name> as Bun.main, whatever
    // Cellar version it was launched from; the keys must not follow it
    expect(secretsDirFor("/$bunfs/root/1ctx-mlx-engine", "/Users/x")).toBe(
      "/Users/x/.1ctx-mlx-engine/secrets",
    );
  });
});
