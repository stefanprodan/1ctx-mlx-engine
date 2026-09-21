// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Reading a checkpoint's spec from --model-dir: config.json, the
// generation config, the model card and the safetensors headers, never a
// tensor. The directory is found the way a delete finds it (a plain repo
// id inside the root, no symlinked directory) and only regular files are
// read. A model is read once, then again only when its config or its file
// list changes.

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { PART_SUFFIX } from "./hub.ts";
import { realModelDir } from "./remove.ts";
import {
  countParams,
  type DiskSpec,
  type Header,
  parseConfig,
  parseGeneration,
  parseLicense,
} from "./spec.ts";

// a header is JSON a few hundred KB long; anything past this is not one,
// and a checkpoint's headers together stay under the second cap
const HEADER_MAX = 64 * 2 ** 20;
const HEADERS_MAX = 256 * 2 ** 20;
// a config is a few KB, the card's front matter is at its top
const JSON_MAX = 4 * 2 ** 20;
const README_MAX = 64 * 1024;

type Stat = Awaited<ReturnType<typeof lstat>>;

// a regular file's stat, null for anything else (a symlink included)
async function regular(path: string): Promise<Stat | null> {
  return lstat(path).then(
    (s) => (s.isFile() ? s : null),
    () => null,
  );
}

async function json(path: string): Promise<unknown | null> {
  const st = await regular(path);
  if (!st || st.size > JSON_MAX) return null;
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

// the 8-byte little-endian length, then exactly that many bytes of JSON;
// with the length, which the checkpoint's budget counts
export async function readHeader(
  path: string,
  max = HEADER_MAX,
): Promise<{ header: Header; bytes: number } | null> {
  const file = Bun.file(path);
  try {
    const head = new DataView(await file.slice(0, 8).arrayBuffer());
    if (head.byteLength < 8) return null;
    const length = head.getBigUint64(0, true);
    if (length === 0n || length > BigInt(Math.min(max, HEADER_MAX))) {
      return null;
    }
    const n = Number(length);
    const body = await file.slice(8, 8 + n).arrayBuffer();
    if (body.byteLength !== n) return null;
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === "object" && parsed !== null
      ? { header: parsed, bytes: n }
      : null;
  } catch {
    return null;
  }
}

export class SpecReader {
  private readonly cache = new Map<string, { key: string; spec: DiskSpec }>();
  // a read in flight, shared by the requests that ask meanwhile
  private readonly pending = new Map<string, Promise<DiskSpec | null>>();

  constructor(private readonly modelDir: string) {}

  // null when the model is not under --model-dir or has no readable config
  read(id: string): Promise<DiskSpec | null> {
    const running = this.pending.get(id);
    if (running) return running;
    const next = this.load(id).finally(() => this.pending.delete(id));
    this.pending.set(id, next);
    return next;
  }

  private async load(id: string): Promise<DiskSpec | null> {
    const dir = await realModelDir(this.modelDir, id);
    if (dir === null) return this.drop(id);
    const configPath = join(dir, "config.json");
    const config = await regular(configPath);
    if (!config) return this.drop(id);
    const names = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".safetensors") && !f.endsWith(PART_SUFFIX))
      .sort();
    // every file read has its size and time in the key: a revision that
    // rewrites a file under the same name is read again
    const stamp = async (name: string) => {
      const st = await regular(join(dir, name));
      return st ? `${name}@${st.size}@${st.mtimeMs}` : `${name}@-`;
    };
    const key = [
      `${config.size}@${config.mtimeMs}`,
      ...(await Promise.all(
        ["generation_config.json", "README.md", ...names].map(stamp),
      )),
    ].join(",");
    const hit = this.cache.get(id);
    if (hit?.key === key) return hit.spec;

    const body = await json(configPath);
    if (body === null) return this.drop(id);
    const parsed = parseConfig(body);
    const generation = await json(join(dir, "generation_config.json"));
    const readme = join(dir, "README.md");
    const license = (await regular(readme))
      ? parseLicense(await Bun.file(readme).slice(0, README_MAX).text())
      : null;
    const headers: Header[] = [];
    let complete = names.length > 0;
    let budget = HEADERS_MAX;
    for (const name of names) {
      const path = join(dir, name);
      const read = (await regular(path))
        ? await readHeader(path, budget)
        : null;
      if (read === null) {
        complete = false;
        break;
      }
      headers.push(read.header);
      budget -= read.bytes;
    }
    // a count over some of the files would be a wrong number, not a partial one
    const counted = complete ? countParams(headers, parsed) : null;
    const spec: DiskSpec = {
      config: parsed,
      generation: generation === null ? null : parseGeneration(generation),
      license,
      params: counted?.params ?? null,
      activeParams: counted?.activeParams ?? null,
      files: names.length,
      addedAt: Math.round(Number(config.mtimeMs)),
    };
    this.cache.set(id, { key, spec });
    return spec;
  }

  private drop(id: string): null {
    this.cache.delete(id);
    return null;
  }
}
