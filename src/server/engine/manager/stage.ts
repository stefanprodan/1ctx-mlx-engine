// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import type { InstallRecord } from "../../../shared/engine.ts";
import {
  abortPromise,
  DOWNLOAD_DISK_MARGIN,
  describeError,
  fetchRedirected,
  sleepWithSignal,
} from "../../lib/fetch.ts";
import {
  coreVersion,
  ENGINE_ASSET,
  isSafeTag,
  parseVersionOutput,
  type ReleaseDetails,
} from "../release.ts";
import {
  type ActiveDownload,
  ENGINE_REPO,
  EngineManagerError,
  EXPECTED_TOP,
  HASH_CHUNK,
  type ManagerContext,
  PROGRESS_EVERY_MS,
  RETRIES,
  versionDir,
} from "./context.ts";

export function release(context: ManagerContext, tag: string): ReleaseDetails {
  const releases = context.deps.store.releaseCheck(ENGINE_REPO)?.releases ?? [];
  if (!isSafeTag(tag, releases)) {
    throw new EngineManagerError(400, "release tag is not offered");
  }
  const value = releases.find((item) => item.tag === tag)!;
  if (!value.asset) {
    throw new EngineManagerError(409, `${tag} has no ${ENGINE_ASSET} asset`);
  }
  return value;
}

export async function stage(
  context: ManagerContext,
  value: ReleaseDetails,
): Promise<InstallRecord> {
  const asset = value.asset!;
  const downloads = join(context.root, "downloads");
  const versions = join(context.root, "versions");
  await mkdir(downloads, { recursive: true });
  await mkdir(versions, { recursive: true });
  const archive = join(downloads, `${value.tag}.tar.gz`);
  const active: ActiveDownload = {
    controller: new AbortController(),
    part: `${archive}.part`,
    archive,
    temporary: join(versions, `${value.tag}.tmp`),
    staged: join(versions, `${value.tag}.staged`),
    startedAt: context.now(),
    publishedAt: 0,
  };
  context.active = active;
  const free = context.freeSpace(context.root);
  if (free !== null && free < value.assetBytes + DOWNLOAD_DISK_MARGIN) {
    throw new Error(`not enough disk: ${Math.round(free / 1024 ** 3)} GB free`);
  }
  context.setPhase("downloading", 0, value.assetBytes);
  await download(context, value, active);
  context.setPhase("verifying", value.assetBytes, value.assetBytes);
  const digest = await hash(context, active.archive, active.controller.signal);
  if (digest !== asset.sha256) throw new Error(`${value.tag}: sha256 mismatch`);
  context.setPhase("unpacking", value.assetBytes, value.assetBytes);
  await rm(active.temporary, { recursive: true, force: true });
  await rm(active.staged, { recursive: true, force: true });
  const bytes = await readFile(active.archive);
  const bundle = new Bun.Archive(bytes);
  const entries = await bundle.files();
  if (active.controller.signal.aborted) {
    throw active.controller.signal.reason ?? new Error("cancelled");
  }
  const tops = new Set<string>();
  for (const path of entries.keys()) {
    const top = path.replace(/^\.\//, "").split("/")[0];
    if (top) tops.add(top);
  }
  if (
    tops.size !== 1 ||
    !tops.has(EXPECTED_TOP) ||
    !entries.has(`${EXPECTED_TOP}/mlx-serve`)
  ) {
    throw new Error(
      `unexpected archive top directory: ${[...tops].join(", ") || "empty"}`,
    );
  }
  await mkdir(active.temporary, { recursive: true });
  await bundle.extract(active.temporary);
  if (active.controller.signal.aborted) {
    throw active.controller.signal.reason ?? new Error("cancelled");
  }
  await rename(join(active.temporary, EXPECTED_TOP), active.staged);
  await rm(active.temporary, { recursive: true, force: true });
  const binary = join(active.staged, "mlx-serve");
  const result = await context.spawn([binary, "--version"]);
  if (active.controller.signal.aborted) {
    throw active.controller.signal.reason ?? new Error("cancelled");
  }
  if (result.code !== 0) {
    throw new Error(
      `mlx-serve --version failed: ${result.stderr || result.code}`,
    );
  }
  const parsed = parseVersionOutput(`${result.stdout}\n${result.stderr}`);
  const expected = coreVersion(value.tag);
  if (
    !expected ||
    !parsed.version ||
    (parsed.version !== expected && coreVersion(parsed.version) !== expected)
  ) {
    throw new Error(
      `version mismatch: expected ${expected ?? value.tag}, got ${parsed.version ?? "none"}`,
    );
  }
  const final = versionDir(context, value.tag);
  await rm(final, { recursive: true, force: true });
  await rename(active.staged, final);
  await rm(active.archive, { force: true });
  return {
    tag: value.tag,
    version: value.version,
    mlx: parsed.mlx,
    installedAt: context.now(),
  };
}

export async function download(
  context: ManagerContext,
  value: ReleaseDetails,
  active: ActiveDownload,
) {
  const signal = active.controller.signal;
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadAttempt(context, value, active);
      await rename(active.part, active.archive);
      return;
    } catch (error) {
      if (signal.aborted || attempt >= RETRIES) throw error;
      context.deps.log.warn(
        `engine download ${value.tag}: ${describeError(error)}; retry ${attempt} of ${RETRIES - 1}`,
      );
      await sleepWithSignal(context.retryDelayMs * attempt, signal);
    }
  }
}

export async function downloadAttempt(
  context: ManagerContext,
  value: ReleaseDetails,
  active: ActiveDownload,
) {
  const signal = active.controller.signal;
  let have = await fileSize(active.part);
  if (have > value.assetBytes) {
    await truncate(active.part, 0);
    have = 0;
  }
  const headers = new Headers({ "user-agent": "mlx-spy" });
  if (context.deps.token)
    headers.set("authorization", `Bearer ${context.deps.token}`);
  if (have > 0) headers.set("range", `bytes=${have}-`);
  const response = await fetchRedirected(value.asset!.downloadUrl, {
    fetch: context.fetch,
    headers,
    signal,
  });
  if (have > 0 && response.status === 200) {
    await truncate(active.part, 0);
    have = 0;
  } else if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`download: HTTP ${response.status}`);
  }
  const expected = value.assetBytes - have;
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== expected) {
    await response.body?.cancel();
    throw new Error(
      `download declared ${declared} bytes, expected ${expected}`,
    );
  }
  if (!response.body) throw new Error("download returned an empty body");
  const handle = await open(active.part, have > 0 ? "a" : "w");
  const stall = new AbortController();
  const onAbort = () => stall.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let timer = setTimeout(() => stall.abort(), context.stallMs);
  let cancelRead: () => Promise<void> = async () => {};
  try {
    const reader = response.body.getReader();
    // once per download, not per chunk: each call adds a listener that
    // stays until the signal is collected
    const stalled = abortPromise(stall.signal);
    stalled.catch(() => undefined);
    // whatever ends the loop, a read still pending is let go of
    cancelRead = () => reader.cancel().catch(() => undefined);
    while (true) {
      const next = await Promise.race([reader.read(), stalled]);
      if (next.done) break;
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), context.stallMs);
      if (have + next.value.byteLength > value.assetBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`download exceeded ${value.assetBytes} bytes`);
      }
      await handle.write(next.value);
      have += next.value.byteLength;
      progress(context, have, value.assetBytes, active);
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (stall.signal.aborted) {
      throw new Error(`download sent no data for ${context.stallMs / 1_000} s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await cancelRead();
    signal.removeEventListener("abort", onAbort);
    await handle.close();
  }
  if (have !== value.assetBytes) {
    throw new Error(`download got ${have} of ${value.assetBytes} bytes`);
  }
}

export function progress(
  context: ManagerContext,
  done: number,
  total: number,
  active: ActiveDownload,
) {
  const now = context.now();
  if (now - active.publishedAt < PROGRESS_EVERY_MS && done !== total) return;
  active.publishedAt = now;
  const elapsed = Math.max(1, now - active.startedAt);
  if (context.operation) {
    context.operation = {
      ...context.operation,
      doneBytes: done,
      totalBytes: total,
      bytesPerSecond: (done * 1_000) / elapsed,
    };
    context.publish();
  }
}

export async function hash(
  _context: ManagerContext,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(HASH_CHUNK);
    while (true) {
      if (signal.aborted) throw signal.reason;
      const result = await file.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hasher.update(buffer.subarray(0, result.bytesRead));
    }
  } finally {
    await file.close();
  }
  return hasher.digest("hex");
}

export async function record(
  context: ManagerContext,
  tag: string,
): Promise<InstallRecord> {
  const result = await context.spawn([
    join(versionDir(context, tag), "mlx-serve"),
    "--version",
  ]);
  if (result.code !== 0) throw new Error(`cannot read ${tag} version`);
  const parsed = parseVersionOutput(`${result.stdout}\n${result.stderr}`);
  const expected = coreVersion(tag);
  if (!parsed.version || coreVersion(parsed.version) !== expected) {
    throw new Error(`${tag} version does not match its binary`);
  }
  return {
    tag,
    version: tag.replace(/^v/, ""),
    mlx: parsed.mlx,
    installedAt: context.now(),
  };
}

export async function fileSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
