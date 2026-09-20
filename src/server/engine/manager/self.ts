// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SelfState } from "../../../shared/engine.ts";
import { offered } from "../release.ts";
import { type CpuReading, type ManagerContext, SELF_REPO } from "./context.ts";
import { publicCheck } from "./poll.ts";

export function cpuPercent(
  previous: CpuReading | null,
  current: CpuReading,
): number {
  if (!previous || current.at <= previous.at) return 0;
  const used =
    current.userMicros +
    current.systemMicros -
    previous.userMicros -
    previous.systemMicros;
  if (used <= 0) return 0;
  return (used / ((current.at - previous.at) * 1_000)) * 100;
}

export function selfState(context: ManagerContext): SelfState {
  const at = context.now();
  const usage = (context.deps.cpuUsage ?? process.cpuUsage)();
  const current: CpuReading = {
    at,
    userMicros: usage.user,
    systemMicros: usage.system,
  };
  const cpuPct = cpuPercent(context.cpuPrevious, current);
  context.cpuPrevious = current;
  const path = context.deps.execPath ?? process.execPath ?? Bun.main;
  const check = publicCheck(context.deps.store.releaseCheck(SELF_REPO));
  const development = context.deps.version === "v0.0.0-dev";
  return {
    version: context.deps.version,
    // The formula's own directories, not the prefix: from source the
    // executable is bun, which brew installed too.
    brew:
      !development &&
      (path.includes("/Cellar/1ctx-mlx-engine/") ||
        path.includes("/opt/1ctx-mlx-engine/")),
    startedAt: context.startedAt,
    rssBytes:
      context.deps.probes.processMemory(process.pid)?.footprint ??
      process.memoryUsage.rss(),
    cpuPct,
    check,
    offered: development
      ? null
      : offered(check.releases, false, context.deps.version),
  };
}

export type { CpuReading } from "./context.ts";
