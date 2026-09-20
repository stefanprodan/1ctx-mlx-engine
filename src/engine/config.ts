// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheLimits } from "./types.ts";

// mlx-serve's own size grammar (parseSizeArg in main.zig): <n>{KB,MB,GB},
// a bare number of bytes, or "0"/"off". Binary units, as the engine uses.
export function parseSize(s: string): number | null {
  const v = s.trim();
  if (v === "off" || v === "0") return 0;
  const m = /^(\d+)\s*(KB|MB|GB|B)?$/i.exec(v);
  if (!m) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit] ?? 1;
  return Number(m[1]) * mult;
}

// The <string> children of the ProgramArguments array in a launchd plist.
// The plist is our own XML file, so a scan for the array after the key is
// enough; a binary plist yields no arguments.
export function parseLaunchdArgs(xml: string): string[] {
  const key = xml.indexOf("<key>ProgramArguments</key>");
  if (key === -1) return [];
  const start = xml.indexOf("<array>", key);
  const end = xml.indexOf("</array>", start);
  if (start === -1 || end === -1) return [];
  const body = xml.slice(start, end);
  return [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

// Hot budget defaults to 2 GB and the SSD tier to off, as in mlx-serve.
export function limitsFromArgs(args: string[]): CacheLimits {
  const limits: CacheLimits = { hotBytes: 2 * 1024 ** 3, diskBytes: 0 };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s);
    if (name !== "--prefix-cache-mem" && name !== "--prefix-cache-disk") {
      continue;
    }
    const raw = inline ?? args[++i];
    const bytes = raw === undefined ? null : parseSize(raw);
    if (bytes === null) continue;
    if (name === "--prefix-cache-mem") limits.hotBytes = bytes;
    else limits.diskBytes = bytes;
  }
  return limits;
}

// The budgets are launch flags on the local engine's LaunchAgent.
export function cacheLimits(serviceLabel: string): CacheLimits | null {
  const plist = join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${serviceLabel}.plist`,
  );
  try {
    const args = parseLaunchdArgs(readFileSync(plist, "utf8"));
    return args.length ? limitsFromArgs(args) : null;
  } catch {
    return null;
  }
}
