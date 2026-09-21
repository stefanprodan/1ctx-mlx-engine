// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Model downloads in 1ctx-mlx-engine's SQLite database: one row per download
// and one per file of it. The rows are the resume state: a runner that starts
// again reads which files are done, sizes the .part of the one that was
// running, and continues. Bytes done are written from the runner about once a
// second, so a crash loses at most that.

import type { Database } from "bun:sqlite";
import type { Download, DownloadStatus } from "../../shared/downloads.ts";
import type { HubFile } from "./hub.ts";

export type DownloadFile = HubFile & {
  downloadId: number;
  done: boolean;
};

type DownloadRow = {
  id: number;
  repo: string;
  revision: string;
  dir: string;
  status: DownloadStatus;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  file: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

type FileRow = {
  downloadId: number;
  path: string;
  size: number;
  sha256: string | null;
  done: number;
};

const COLUMNS = `id, repo, revision, dir, status,
  bytes_total AS bytesTotal, bytes_done AS bytesDone,
  files_total AS filesTotal, files_done AS filesDone,
  file, error, created_at AS createdAt, updated_at AS updatedAt,
  finished_at AS finishedAt`;

export const DOWNLOADS_LISTED = 20;

export class DownloadStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      revision TEXT NOT NULL,
      dir TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_total INTEGER NOT NULL DEFAULT 0,
      bytes_done INTEGER NOT NULL DEFAULT 0,
      files_total INTEGER NOT NULL DEFAULT 0,
      files_done INTEGER NOT NULL DEFAULT 0,
      file TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS download_files (
      download_id INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (download_id, path)
    )`);
  }

  private toDownload(row: DownloadRow): Download {
    return { ...row, speedBps: null };
  }

  // Newest first, the last DOWNLOADS_LISTED.
  list(): Download[] {
    const rows = this.db
      .query(`SELECT ${COLUMNS} FROM downloads ORDER BY id DESC LIMIT $n`)
      .all({ n: DOWNLOADS_LISTED }) as DownloadRow[];
    return rows.map((row) => this.toDownload(row));
  }

  get(id: number): Download | null {
    const row = this.db
      .query(`SELECT ${COLUMNS} FROM downloads WHERE id = $id`)
      .get({ id }) as DownloadRow | null;
    return row ? this.toDownload(row) : null;
  }

  // The download for a repo that is not finished (there is one at most): a
  // second request for the same repo resumes it instead of starting over.
  findOpen(repo: string): Download | null {
    const row = this.db
      .query(
        `SELECT ${COLUMNS} FROM downloads WHERE repo = $repo COLLATE NOCASE AND status <> 'done'
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ repo }) as DownloadRow | null;
    return row ? this.toDownload(row) : null;
  }

  // The newest finished download of a repo: the revision on disk, and when.
  lastDone(repo: string): Download | null {
    const row = this.db
      .query(
        `SELECT ${COLUMNS} FROM downloads WHERE repo = $repo COLLATE NOCASE AND status = 'done'
         ORDER BY id DESC LIMIT 1`,
      )
      .get({ repo }) as DownloadRow | null;
    return row ? this.toDownload(row) : null;
  }

  // Downloads that were running or waiting when the process stopped.
  unfinished(): Download[] {
    const rows = this.db
      .query(
        `SELECT ${COLUMNS} FROM downloads WHERE status IN ('queued', 'running')
         ORDER BY id`,
      )
      .all() as DownloadRow[];
    return rows.map((row) => this.toDownload(row));
  }

  create(
    repo: string,
    revision: string,
    dir: string,
    files: HubFile[],
  ): Download {
    const t = this.now();
    const insert = this.db.query(
      `INSERT INTO downloads (repo, revision, dir, status, bytes_total, files_total,
         created_at, updated_at)
       VALUES ($repo, $revision, $dir, 'queued', $bytes, $files, $t, $t)`,
    );
    const insertFile = this.db.query(
      `INSERT INTO download_files (download_id, path, size, sha256) VALUES
       ($downloadId, $path, $size, $sha256)`,
    );
    const id = this.db.transaction(() => {
      const result = insert.run({
        repo,
        revision,
        dir,
        bytes: files.reduce((n, f) => n + f.size, 0),
        files: files.length,
        t,
      });
      const downloadId = Number(result.lastInsertRowid);
      for (const f of files) {
        insertFile.run({
          downloadId,
          path: f.path,
          size: f.size,
          sha256: f.sha256,
        });
      }
      return downloadId;
    })();
    return this.get(id)!;
  }

  files(downloadId: number): DownloadFile[] {
    const rows = this.db
      .query(
        `SELECT download_id AS downloadId, path, size, sha256, done FROM download_files
         WHERE download_id = $downloadId ORDER BY rowid`,
      )
      .all({ downloadId }) as FileRow[];
    return rows.map((row) => ({ ...row, done: row.done === 1 }));
  }

  setStatus(
    id: number,
    status: DownloadStatus,
    error: string | null = null,
  ): Download | null {
    const t = this.now();
    const finished =
      status === "done" || status === "failed" || status === "cancelled";
    this.db
      .query(
        `UPDATE downloads SET status = $status, error = $error, updated_at = $t,
           finished_at = CASE WHEN $finished THEN $t ELSE NULL END,
           file = CASE WHEN $finished THEN NULL ELSE file END
         WHERE id = $id`,
      )
      .run({ id, status, error, t, finished: finished ? 1 : 0 });
    return this.get(id);
  }

  // The bytes so far (the finished files plus the part in flight) and the
  // file in flight.
  progress(id: number, bytesDone: number, file: string | null) {
    this.db
      .query(
        `UPDATE downloads SET bytes_done = $bytesDone, file = $file, updated_at = $t
         WHERE id = $id`,
      )
      .run({ id, bytesDone, file, t: this.now() });
  }

  fileDone(id: number, path: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE download_files SET done = 1 WHERE download_id = $id AND path = $path",
        )
        .run({ id, path });
      this.db
        .query(
          `UPDATE downloads SET files_done = (SELECT count(*) FROM download_files
             WHERE download_id = $id AND done = 1), updated_at = $t
           WHERE id = $id`,
        )
        .run({ id, t: this.now() });
    })();
  }

  // The file on record as done is not there anymore: it goes again.
  fileUndone(id: number, path: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "UPDATE download_files SET done = 0 WHERE download_id = $id AND path = $path",
        )
        .run({ id, path });
      this.db
        .query(
          `UPDATE downloads SET files_done = (SELECT count(*) FROM download_files
             WHERE download_id = $id AND done = 1), updated_at = $t
           WHERE id = $id`,
        )
        .run({ id, t: this.now() });
    })();
  }

  remove(id: number): boolean {
    const result = this.db
      .query("DELETE FROM downloads WHERE id = $id")
      .run({ id });
    return result.changes > 0;
  }

  // Every record of a repo, however it ended: the model it downloaded has
  // been deleted, so there is nothing left to resume or to show. The rows
  // are counted first: a cascade into download_files counts as a change too.
  removeRepo(repo: string): number {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          "SELECT count(*) AS n FROM downloads WHERE repo = $repo COLLATE NOCASE",
        )
        .get({ repo }) as { n: number };
      if (row.n > 0) {
        this.db
          .query("DELETE FROM downloads WHERE repo = $repo COLLATE NOCASE")
          .run({ repo });
      }
      return row.n;
    })();
  }
}
