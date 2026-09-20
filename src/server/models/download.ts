// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The model downloader: downloads a Hugging Face repo into the model directory,
// one download at a time, from a queue that survives restarts through the
// DownloadStore. Every file streams into <file>.1ctx-part and resumes with
// a Range request after a cut, a retry or a restart; the hash is computed
// while writing (the existing part first, on a resume) and checked against
// the Hub's LFS sha256 before the rename. Progress reaches every tab on /ws.
//
// The engine is not involved in the download. After a download the runner asks
// it to rescan its model directory (mlx-serve answers /v1/models/rescan
// before its model-load step, like /v1/models; verified in src/server.zig)
// so the new checkpoint shows in the list without an engine restart.

import { mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Download } from "../../shared/downloads.ts";
import type { Engine } from "../engine/types.ts";
import { diskSpace } from "../host/info.ts";
import {
  DOWNLOAD_DISK_MARGIN,
  DOWNLOAD_STALL_MS,
  describeError as describe,
} from "../lib/fetch.ts";
import type { Log } from "../lib/log.ts";
import { DownloadError } from "./error.ts";
import {
  fetchRepo,
  HubError,
  PART_SUFFIX,
  parseRepoId,
  resolveUrl,
} from "./hub.ts";
import type { DownloadFile, DownloadStore } from "./store.ts";
import { fetchFile, hashOf, sizeOf } from "./transfer.ts";

const RETRY_DELAY_MS = 2000;
const PROGRESS_EVERY_MS = 500;
const WRITE_EVERY_MS = 1000;
const SPEED_WINDOW_MS = 5000;
const DISK_MARGIN = DOWNLOAD_DISK_MARGIN;
const STALL_MS = DOWNLOAD_STALL_MS;

export type DownloaderDeps = {
  store: DownloadStore;
  modelDir: string;
  token: string | null;
  engine: Engine;
  refreshModels: () => Promise<unknown>;
  log: Log;
  // why nothing may start now (a benchmark is measuring), null when it may
  blocked?: () => string | null;
  now?: () => number;
  // tests: a fake Hub, no wait between retries
  hub?: string;
  retryDelayMs?: number;
  stallMs?: number;
  freeSpace?: (path: string) => number | null;
};

type Active = {
  id: number;
  controller: AbortController;
  // resolves when run() has written the final status
  settled: Promise<void>;
  settle: () => void;
  // the user asked for the stop (a shutdown is not a cancel)
  cancelled: boolean;
  bytesDone: number;
  file: string | null;
  window: { t: number; bytes: number }[];
  publishedAt: number;
  writtenAt: number;
};

export class Downloader {
  private active: Active | null = null;
  private readonly queue: number[] = [];
  private stopping = false;
  // repos whose listing is being fetched: a second start of one is a 409
  private readonly starting = new Set<string>();
  private readonly listeners = new Set<(download: Download) => void>();
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly stallMs: number;
  private readonly freeSpace: (path: string) => number | null;

  constructor(private readonly deps: DownloaderDeps) {
    this.now = deps.now ?? Date.now;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
    this.stallMs = deps.stallMs ?? STALL_MS;
    this.freeSpace = deps.freeSpace ?? ((p) => diskSpace(p)?.free ?? null);
  }

  onEvent(fn: (download: Download) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // The downloads, newest first, the running one with its speed.
  list(): Download[] {
    return this.deps.store.list().map((download) => this.stamp(download));
  }

  get(id: number): Download | null {
    const download = this.deps.store.get(id);
    return download ? this.stamp(download) : null;
  }

  running(): Download | null {
    return this.active ? this.get(this.active.id) : null;
  }

  // Downloads left queued or running by the previous process continue.
  resume() {
    for (const download of this.deps.store.unfinished()) {
      this.deps.store.setStatus(download.id, "queued");
      this.queue.push(download.id);
      this.deps.log(`download ${download.repo}: resuming`);
    }
    this.kick();
  }

  // A repo id or Hub URL → the queued download. The same repo again resumes
  // its failed or cancelled download; one still queued or running is a 409.
  async start(input: string): Promise<Download> {
    const repo = parseRepoId(input);
    if (!repo) {
      throw new DownloadError(400, "repo must be <owner>/<name> or a Hub URL");
    }
    const blocked = this.deps.blocked?.();
    if (blocked) throw new DownloadError(409, blocked);
    const open = this.deps.store.findOpen(repo);
    if (
      this.starting.has(repo) ||
      open?.status === "queued" ||
      open?.status === "running"
    ) {
      throw new DownloadError(409, `${repo} is already downloading`);
    }
    if (open) {
      const download = this.deps.store.setStatus(open.id, "queued")!;
      this.queue.push(download.id);
      this.publish(download);
      this.kick();
      return download;
    }
    let listing: Awaited<ReturnType<typeof fetchRepo>>;
    this.starting.add(repo);
    try {
      listing = await fetchRepo(
        repo,
        this.deps.token,
        undefined,
        this.deps.hub,
      );
    } catch (err) {
      if (err instanceof HubError)
        throw new DownloadError(err.status, err.message);
      throw new DownloadError(502, describe(err));
    } finally {
      this.starting.delete(repo);
    }
    const dir = join(this.deps.modelDir, ...repo.split("/"));
    const download = this.deps.store.create(
      repo,
      listing.revision,
      dir,
      listing.files,
    );
    this.deps.log(
      `download ${repo}: queued, ${listing.files.length} files, ${Math.round(download.bytesTotal / 1024 ** 2)} MB`,
    );
    this.queue.push(download.id);
    this.publish(download);
    this.kick();
    return download;
  }

  // Stops the download; its parts stay for a later resume. Answers once the
  // row says so, after the abort has unwound the download.
  async cancel(id: number): Promise<Download> {
    const download = this.deps.store.get(id);
    if (!download) throw new DownloadError(404, "Download not found");
    const active = this.active;
    if (active?.id === id) {
      active.cancelled = true;
      active.controller.abort();
      await active.settled;
      return this.deps.store.get(id)!;
    }
    const at = this.queue.indexOf(id);
    if (at !== -1) {
      this.queue.splice(at, 1);
      const cancelled = this.deps.store.setStatus(id, "cancelled")!;
      this.publish(cancelled);
      return cancelled;
    }
    throw new DownloadError(409, `${download.repo} is not downloading`);
  }

  // Deletes the download: a running one is stopped first, then its files go,
  // finished or partial, and the record with them.
  async remove(id: number): Promise<void> {
    const download = this.deps.store.get(id);
    if (!download) throw new DownloadError(404, "Download not found");
    if (download.status === "queued" || download.status === "running") {
      await this.cancel(id);
    }
    const parents = new Set<string>();
    for (const file of this.deps.store.files(id)) {
      const dest = destOf(download.dir, file.path);
      if (!dest) continue;
      await rm(dest + PART_SUFFIX, { force: true });
      await rm(dest, { force: true });
      parents.add(dirname(dest));
    }
    // the repo's own subdirectories, deepest first, then up to the root
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      await pruneEmpty(parent, this.deps.modelDir);
    }
    await pruneEmpty(download.dir, this.deps.modelDir);
    this.deps.store.remove(id);
    this.deps.log(`download ${download.repo}: deleted`);
  }

  // The process is leaving: the running download keeps its status so the next
  // process resumes it.
  shutdown() {
    this.stopping = true;
    this.active?.controller.abort();
  }

  private kick() {
    if (this.active || this.stopping) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    void this.run(id);
  }

  private async run(id: number) {
    const download = this.deps.store.setStatus(id, "running");
    if (!download) return this.kick();
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active: Active = {
      id,
      controller: new AbortController(),
      settled,
      settle,
      cancelled: false,
      bytesDone: download.bytesDone,
      file: null,
      window: [],
      publishedAt: 0,
      writtenAt: 0,
    };
    this.active = active;
    this.publish(download);
    try {
      await this.transfer(download, active);
      this.deps.store.progress(id, active.bytesDone, null);
      const done = this.deps.store.setStatus(id, "done")!;
      this.deps.log(`download ${download.repo}: done`);
      this.active = null;
      this.publish(done);
      await this.announce(download.repo);
    } catch (err) {
      this.deps.store.progress(id, active.bytesDone, null);
      if (this.stopping && !active.cancelled) {
        // left "running": the next process resumes it
      } else if (active.controller.signal.aborted) {
        this.publish(this.deps.store.setStatus(id, "cancelled")!);
        this.deps.log(`download ${download.repo}: cancelled`);
      } else {
        const message = describe(err);
        this.publish(this.deps.store.setStatus(id, "failed", message)!);
        this.deps.log(`download ${download.repo}: failed: ${message}`);
      }
    } finally {
      this.active = null;
      active.settle();
      this.kick();
    }
  }

  private async transfer(download: Download, active: Active) {
    const files = this.deps.store.files(download.id);
    // what is left: finished files count, and so do files already whole on
    // disk (a download of a model that was there before)
    let bytesDone = 0;
    const todo: DownloadFile[] = [];
    const signal = active.controller.signal;
    for (const file of files) {
      const dest = destOf(download.dir, file.path);
      if (!dest) throw new Error(`refusing path ${file.path}`);
      const onDisk = (await sizeOf(dest)) === file.size;
      // a file the record calls done must still be there whole; a file
      // that is there but not on record (a model that was there before,
      // an earlier removed download) must also match the Hub's hash
      if (
        onDisk &&
        (file.done ||
          !file.sha256 ||
          (await hashOf(dest, signal)) === file.sha256)
      ) {
        if (!file.done) this.deps.store.fileDone(download.id, file.path);
        bytesDone += file.size;
        continue;
      }
      if (file.done) this.deps.store.fileUndone(download.id, file.path);
      todo.push(file);
    }
    active.bytesDone = bytesDone;
    // statfs needs the directory to exist
    await mkdir(this.deps.modelDir, { recursive: true });
    const free = this.freeSpace(this.deps.modelDir);
    const left = download.bytesTotal - bytesDone;
    if (free !== null && free < left + DISK_MARGIN) {
      throw new Error(
        `not enough disk: ${Math.round(free / 1024 ** 3)} GB free, ${Math.ceil(left / 1024 ** 3)} GB to download`,
      );
    }
    for (const file of todo) {
      const dest = destOf(download.dir, file.path)!;
      await mkdir(dirname(dest), { recursive: true });
      active.file = file.path;
      const url = resolveUrl(
        download.repo,
        download.revision,
        file.path,
        this.deps.hub,
      );
      await fetchFile(
        {
          token: this.deps.token,
          log: this.deps.log,
          retryDelayMs: this.retryDelayMs,
          stallMs: this.stallMs,
        },
        { url, file, dest, signal, base: active.bytesDone },
        (done, tick) => {
          active.bytesDone = done;
          if (tick) this.tick(active.id, active, false);
        },
      );
      this.deps.store.fileDone(download.id, file.path);
      active.file = null;
      this.tick(download.id, active, true);
    }
  }

  // Progress to the tabs twice a second and to the database once a second;
  // a change of state goes out at once.
  private tick(id: number, active: Active, force: boolean) {
    const t = this.now();
    active.window.push({ t, bytes: active.bytesDone });
    while (
      active.window.length > 1 &&
      t - active.window[0].t > SPEED_WINDOW_MS
    ) {
      active.window.shift();
    }
    if (force || t - active.writtenAt >= WRITE_EVERY_MS) {
      active.writtenAt = t;
      this.deps.store.progress(id, active.bytesDone, active.file);
    }
    if (force || t - active.publishedAt >= PROGRESS_EVERY_MS) {
      active.publishedAt = t;
      const download = this.deps.store.get(id);
      if (download) this.publish(this.stamp(download));
    }
  }

  private stamp(download: Download): Download {
    const active = this.active;
    if (!active || active.id !== download.id || download.status !== "running") {
      return download;
    }
    const first = active.window[0];
    const last = active.window.at(-1);
    const speed =
      first && last && last.t > first.t
        ? ((last.bytes - first.bytes) * 1000) / (last.t - first.t)
        : null;
    return {
      ...download,
      bytesDone: active.bytesDone,
      file: active.file,
      speedBps: speed,
    };
  }

  private async announce(repo: string) {
    try {
      if (this.deps.engine.capabilities().has("rescan")) {
        await this.deps.engine.rescan?.();
      }
      await this.deps.refreshModels();
    } catch (err) {
      this.deps.log(`download ${repo}: engine rescan failed: ${describe(err)}`);
    }
  }

  private publish(download: Download) {
    for (const listener of this.listeners) {
      try {
        listener(download);
      } catch (err) {
        this.deps.log(`download listener failed: ${describe(err)}`);
      }
    }
  }
}

// ---------- helpers ----------

// The file's place under the download's directory, or null when the stored
// path would leave it.
export function destOf(dir: string, path: string): string | null {
  const dest = resolve(dir, path);
  const root = resolve(dir);
  return dest.startsWith(root + sep) ? dest : null;
}

// Removes the model directory and its owner directory when empty, up to
// the model root, so a removed partial download leaves nothing behind.
async function pruneEmpty(dir: string, root: string) {
  let current = resolve(dir);
  const top = resolve(root);
  while (current.startsWith(top + sep)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
