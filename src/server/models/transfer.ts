// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One file of a model download: resume the .part with a Range request,
// hash while writing, retry what is worth retrying, verify, rename. The
// queue in download.ts decides which file is next and owns the progress.

import { open, rename, rm, stat, truncate } from "node:fs/promises";
import {
  abortPromise as aborted,
  describeError as describe,
  fetchRedirected,
  sleepWithSignal as sleep,
} from "../lib/fetch.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { DownloadError } from "./error.ts";
import { hubHeaders, PART_SUFFIX } from "./hub.ts";
import type { DownloadFile } from "./store.ts";

const RETRIES = 5;
const HASH_CHUNK = 4 * 1024 * 1024;

// a failure worth another attempt at the same file (the .part is kept)
class Retryable extends Error {}

export type TransferDeps = {
  token: string | null;
  log: Log;
  retryDelayMs: number;
  stallMs: number;
};

export type TransferJob = {
  url: string;
  file: DownloadFile;
  dest: string;
  signal: AbortSignal;
  // the download's bytes before this file
  base: number;
};

// the download's byte count moved; `tick` when it is worth publishing
export type Moved = (bytesDone: number, tick: boolean) => void;

// One file, with its retries. `moved` reports the download's byte count:
// the finished files so far (`base`) plus the part in flight.
export async function fetchFile(
  deps: TransferDeps,
  job: TransferJob,
  moved: Moved,
) {
  const { file, dest, signal } = job;
  if (file.size === 0) {
    await Bun.write(dest, "");
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await stream(deps, job, moved);
      return;
    } catch (err) {
      if (signal.aborted) throw err;
      if (!(err instanceof Retryable) || attempt >= RETRIES) throw err;
      deps.log.warn("file retry", {
        file: file.path,
        attempt,
        retries: RETRIES - 1,
        ...errorFields(err, false),
      });
      await sleep(deps.retryDelayMs * attempt, signal);
    }
  }
}

// One attempt at a file: resume the .part, verify, rename.
async function stream(deps: TransferDeps, job: TransferJob, moved: Moved) {
  const { url, file, dest, signal, base } = job;
  const part = dest + PART_SUFFIX;
  let have = (await sizeOf(part)) ?? 0;
  let hasher = file.sha256 ? new Bun.CryptoHasher("sha256") : null;
  // a part longer than the file is not this file: start over
  if (have > file.size) {
    await truncate(part, 0);
    have = 0;
  }
  if (have > 0 && hasher) await hashFile(part, hasher, signal);
  moved(base + have, false);
  if (have < file.size) {
    const res = await request(deps.token, url, have, signal);
    // a 206 must continue where the part ends; a 200 to a range request
    // means the server ignored it and what we have is worthless
    const contentRange = res.headers.get("content-range") ?? "";
    if (
      have > 0 &&
      (res.status === 200 ||
        (res.status === 206 && !contentRange.startsWith(`bytes ${have}-`)))
    ) {
      if (res.status === 206) {
        await res.body?.cancel();
        throw new Retryable(`unexpected range: ${contentRange || "none"}`);
      }
      await truncate(part, 0);
      have = 0;
      moved(base, false);
      if (hasher) hasher = new Bun.CryptoHasher("sha256");
    } else if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel();
      throw statusError(res.status);
    }
    if (!res.body) throw new Retryable("empty body");
    const handle = await open(part, "a");
    // a body that stalls is dropped, and the retry resumes the part
    const stall = new AbortController();
    let timer = setTimeout(() => stall.abort(), deps.stallMs);
    const onAbort = () => stall.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const reader = res.body.getReader();
      // once per file, not per chunk: each call adds a listener that
      // stays until the signal is collected, and a checkpoint is
      // hundreds of thousands of chunks
      const stalled = aborted(stall.signal);
      stalled.catch(() => undefined);
      while (true) {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) break;
        const chunk = next.value;
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), deps.stallMs);
        if (have + chunk.byteLength > file.size) {
          // more than the file: not this file
          await reader.cancel().catch(() => {});
          await handle.close();
          await truncate(part, 0);
          throw new Retryable(`got more than ${file.size} bytes`);
        }
        await handle.write(chunk);
        hasher?.update(chunk);
        have += chunk.byteLength;
        moved(base + have, true);
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (stall.signal.aborted) {
        await res.body.cancel().catch(() => {});
        throw new Retryable(`no data for ${Math.round(deps.stallMs / 1000)} s`);
      }
      throw err instanceof Retryable ? err : new Retryable(describe(err));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      await handle.close().catch(() => {});
    }
  }
  if (have !== file.size) {
    throw new Retryable(`got ${have} of ${file.size} bytes`);
  }
  if (hasher && file.sha256) {
    const digest = hasher.digest("hex");
    if (digest !== file.sha256) {
      // the bytes are wrong, not missing: no resume, the file starts over
      await rm(part, { force: true });
      throw new Error(`${file.path}: sha256 mismatch`);
    }
  }
  await rename(part, dest);
}

// Redirects are followed by hand: the Hub answers with a 307 to a signed
// CDN URL, and the bearer must not travel to another host.
async function request(
  token: string | null,
  url: string,
  from: number,
  signal: AbortSignal,
): Promise<Response> {
  const headers = hubHeaders(token);
  if (from > 0) headers.range = `bytes=${from}-`;
  try {
    return await fetchRedirected(url, { headers, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Retryable(describe(error));
  }
}

export async function sizeOf(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

export async function hashOf(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  await hashFile(path, hasher, signal);
  return hasher.digest("hex");
}

async function hashFile(
  path: string,
  hasher: Bun.CryptoHasher,
  signal: AbortSignal,
) {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(HASH_CHUNK);
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK, null);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

function statusError(status: number): Error {
  if (status === 401 || status === 403) {
    return new DownloadError(403, "gated or private repo, add hf.key");
  }
  if (status === 404)
    return new DownloadError(404, "file not found on the Hub");
  if (status === 416) return new Retryable("range refused");
  return new Retryable(`HTTP ${status}`);
}
