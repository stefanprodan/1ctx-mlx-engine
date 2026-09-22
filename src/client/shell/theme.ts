// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The colour theme: light or dark. Until the user flips the switch in
// the rail's menu the theme follows the system and moves with it. A
// flip away from the system is kept in localStorage and wins from then
// on; a flip back to it forgets the choice, so the system leads again.
// The inline script in index.html sets the same attribute before the
// first paint, so a kept choice never flashes the other theme; this
// module takes over from it and keeps the browser's bar in the page
// colour.

import { signal } from "@preact/signals";

export type Theme = "light" | "dark";

export const THEME_KEY = "theme";
const LIGHT = "(prefers-color-scheme: light)";

export const resolveTheme = (
  stored: string | null,
  systemLight: boolean,
): Theme =>
  stored === "light" || stored === "dark"
    ? stored
    : systemLight
      ? "light"
      : "dark";

// the choice for this tab when storage refuses it, so a blocked or full
// storage still keeps a flip until the page reloads
let unsaved: Theme | null = null;

const kept = (): string | null => {
  if (unsaved !== null) return unsaved;
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};

const systemLight = (): boolean =>
  typeof matchMedia !== "undefined" && matchMedia(LIGHT).matches;

export const theme = signal<Theme>(resolveTheme(kept(), systemLight()));

function apply(next: Theme): void {
  theme.value = next;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = next;
  const page = getComputedStyle(root).getPropertyValue("--bg").trim();
  const bar = document.querySelector('meta[name="theme-color"]');
  if (page && bar) bar.setAttribute("content", page);
}

export function setTheme(next: Theme): void {
  const system = next === resolveTheme(null, systemLight());
  unsaved = null;
  try {
    if (system) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    if (!system) unsaved = next;
  }
  apply(next);
}

export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

// follows the system while nothing is kept
export function watchTheme(): void {
  apply(resolveTheme(kept(), systemLight()));
  if (typeof matchMedia === "undefined") return;
  matchMedia(LIGHT).addEventListener("change", () => {
    if (kept() === null) apply(resolveTheme(null, systemLight()));
  });
}
