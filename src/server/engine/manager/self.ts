// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { DEV_VERSION, type SelfState } from "../../../shared/engine.ts";
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
  const check = publicCheck(context.deps.store.releaseCheck(SELF_REPO));
  return {
    version: context.deps.version,
    startedAt: context.startedAt,
    rssBytes:
      context.deps.probes.processMemory(process.pid)?.footprint ??
      process.memoryUsage.rss(),
    cpuPct,
    check,
    offered: selfOffered(context, check),
  };
}

// the newer build of this program on offer; a build from source is
// offered none. Without selfState's side effect on the CPU window, for
// the snapshot every page reads.
export function selfOffered(
  context: ManagerContext,
  check = publicCheck(context.deps.store.releaseCheck(SELF_REPO)),
) {
  return context.deps.version === DEV_VERSION
    ? null
    : offered(check.releases, false, context.deps.version);
}

export type { CpuReading } from "./context.ts";
