// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  downloadDot,
  downloadMeta,
  downloadPct,
  downloadState,
  eta,
  visibleDownloads,
} from "../../src/client/monitor/download.ts";
import type { Download } from "../../src/shared/downloads.ts";

const GB = 2 ** 30;

function download(over: Partial<Download> = {}): Download {
  return {
    id: 1,
    repo: "org/model",
    revision: "abc",
    dir: "/models/org/model",
    status: "running",
    bytesTotal: 16.7 * GB,
    bytesDone: 3.2 * GB,
    filesTotal: 10,
    filesDone: 2,
    file: "model.safetensors",
    error: null,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    speedBps: 48 * 2 ** 20,
    ...over,
  };
}

describe("download row copy", () => {
  test("meta: bytes, speed and the time left while running", () => {
    expect(downloadMeta(download())).toBe(
      "3.2 / 16.7 GB · 48 MB/s · 5 min left",
    );
    expect(downloadMeta(download({ speedBps: null }))).toBe("3.2 / 16.7 GB");
    expect(downloadMeta(download({ speedBps: 0 }))).toBe("3.2 / 16.7 GB");
    expect(downloadMeta(download({ status: "queued" }))).toBe("16.7 GB");
    expect(
      downloadMeta(download({ status: "done", bytesDone: 16.7 * GB })),
    ).toBe("16.7 GB");
    expect(downloadMeta(download({ status: "failed" }))).toBe("3.2 / 16.7 GB");
    expect(downloadMeta(download({ status: "cancelled" }))).toBe(
      "3.2 / 16.7 GB",
    );
  });

  test("eta reads as seconds, minutes or hours", () => {
    expect(eta(0.2)).toBe("1 s");
    expect(eta(42)).toBe("42 s");
    expect(eta(130)).toBe("2 min");
    expect(eta(3600 * 2 + 60 * 5)).toBe("2 h 5 min");
  });

  test("state, dot and share", () => {
    expect(downloadState(download())).toBe("downloading");
    expect(downloadState(download({ status: "queued" }))).toBe("queued");
    expect(downloadDot(download())).toBe("loading");
    expect(downloadDot(download({ status: "failed" }))).toBe("error");
    expect(downloadDot(download({ status: "done" }))).toBe("ready");
    expect(downloadDot(download({ status: "cancelled" }))).toBe("");
    expect(downloadPct(download())).toBeCloseTo(19.16, 1);
    expect(downloadPct(download({ bytesTotal: 0 }))).toBe(0);
    expect(downloadPct(download({ bytesDone: 99 * GB }))).toBe(100);
  });

  test("a finished download the engine lists is not shown twice", () => {
    const done = download({ id: 2, status: "done" });
    const other = download({ id: 3, status: "done", repo: "org/other" });
    const running = download();
    expect(
      visibleDownloads([running, done, other], [{ id: "org/model" }]),
    ).toEqual([running, other]);
    expect(visibleDownloads([done], [])).toEqual([done]);
  });
});
