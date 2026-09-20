// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The host facts that reach the page.

export type DiskDir = {
  path: string;
  bytes: number; // allocated bytes, like du
  modelId: string | null; // filled by the log tail (milestone 6)
};

export type HostInfo = {
  hostname: string;
  os: string; // "macOS 26.6.2 (25G83)", or the kernel release elsewhere
  chip: string | null; // "Apple M5 Max"
  cpuCores: number;
  perfCores: number | null;
  effCores: number | null;
  gpuCores: number | null;
  memTotal: number;
  diskPath: string; // the volume reported by diskSpace()
};

export type DiskSpace = { total: number; free: number };
