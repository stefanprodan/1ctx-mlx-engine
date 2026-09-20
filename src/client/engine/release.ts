// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The copy of the release row and of the section pills. Pure.

import type {
  EngineState,
  Operation,
  Release,
  ReleaseCheck,
} from "../../shared/engine.ts";
import type { Sample } from "../../shared/sample.ts";
import { duration } from "../format.ts";

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

export function releaseNote(release: Release): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
  }).format(new Date(release.publishedAt));
  const size = release.assetBytes > 0 ? `${mb(release.assetBytes)} MB, ` : "";
  return `${size}${day}${release.prerelease ? ", pre-release" : ""}`;
}

const VERBS: Partial<Record<Operation["kind"], string>> = {
  install: "Installing",
  upgrade: "Upgrading to",
  apply: "Applying the configuration",
  rollback: "Rolling back to",
  start: "Starting mlx-serve",
  stop: "Stopping mlx-serve",
  restart: "Restarting mlx-serve",
  uninstall: "Uninstalling mlx-serve",
};

export const operationTitle = (op: Operation) => VERBS[op.kind] ?? op.kind;

export function phaseLine(op: Operation): string {
  if (op.phase === "downloading") {
    const total = op.totalBytes > 0 ? ` of ${mb(op.totalBytes)} MB` : "";
    const rate = op.bytesPerSecond > 0 ? `, ${mb(op.bytesPerSecond)} MB/s` : "";
    return `downloading, ${mb(op.doneBytes)}${total}${rate}`;
  }
  return op.phase === "restarting" ? "restarting mlx-serve" : op.phase;
}

// the swap has no byte count: the bar is full and Cancel is off
export function progressPct(op: Operation): number {
  if (op.phase !== "downloading") return 100;
  if (op.totalBytes <= 0) return 0;
  return Math.min(100, (op.doneBytes / op.totalBytes) * 100);
}

export const cancellable = (op: Operation) =>
  (op.kind === "install" || op.kind === "upgrade") && op.phase !== "restarting";

// What the row says when it has no release to offer.
export function idleLine(check: ReleaseCheck, managed: boolean): string {
  if (check.error) return "Release check failed";
  if (check.checkedAt === null) return "Checking for releases";
  if (check.releases.length === 0) return "No releases found";
  return managed ? "Up to date" : "No release to install";
}

export type PillCopy = { cls: string; text: string };

// launchd's answer is cached from the last operation; the sampler looks
// every second. When the sampler sees the engine answering, a cached
// "stopped" is stale, and the pill, the buttons and the resources line
// must all follow the same verdict or the page contradicts itself.
export const isStopped = (engine: EngineState, s: Sample | null) =>
  engine.mode === "managed" &&
  engine.service?.state === "stopped" &&
  !(s?.engineUp ?? false);

// The mlx-serve pill. A managed job says what launchd says; everything
// else says what the sampler sees.
export function servicePill(engine: EngineState, s: Sample | null): PillCopy {
  if (engine.operation?.phase === "restarting") {
    return { cls: "pill warn", text: "restarting" };
  }
  if (engine.mode === "remote") return { cls: "pill", text: "remote" };
  if (engine.mode === "unmanaged") return { cls: "pill", text: "unmanaged" };
  if (engine.mode === "absent") {
    return { cls: "pill err", text: "not installed" };
  }
  const svc = engine.service;
  if (svc?.state === "crashed") {
    const code = svc.lastExitCode === null ? "" : `, exit ${svc.lastExitCode}`;
    return { cls: "pill err", text: `crashed${code}` };
  }
  if (isStopped(engine, s)) return { cls: "pill", text: "stopped" };
  if (s?.engineUp) {
    return {
      cls: "pill live",
      text:
        s.engineStartedAt == null
          ? "up"
          : `up ${duration(s.t - s.engineStartedAt)}`,
    };
  }
  return { cls: "pill", text: s ? "starting" : "connecting" };
}

const LOCKED: Partial<Record<Operation["kind"], string>> = {
  install: "installed",
  upgrade: "upgraded",
  apply: "reconfigured",
  rollback: "rolled back",
  start: "started",
  stop: "stopped",
  restart: "restarted",
  uninstall: "uninstalled",
};

export const lockedWhy = (op: Operation) =>
  `locked while mlx-serve is being ${LOCKED[op.kind] ?? "changed"}`;
