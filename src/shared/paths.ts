// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// launchd does not expand ~, so the config holds absolute paths; the page
// shows and accepts the short form because the prefix is the same on
// every row and says nothing.
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function expandHome(path: string, home: string): string {
  const p = path.trim();
  if (p === "~") return home;
  return p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
}
