// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A model download as the routes and the socket report it.

export type DownloadStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type Download = {
  id: number;
  repo: string;
  revision: string;
  dir: string;
  status: DownloadStatus;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  // the file in flight, null between files and when not running
  file: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  // bytes per second over the last seconds; only while running, never stored
  speedBps: number | null;
};
