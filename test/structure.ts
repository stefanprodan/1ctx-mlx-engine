// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The layout rules over a src/ tree. check() returns one violation per
// broken rule and file; the test runs it over src/ and over each fixture
// under test/fixtures/structure/, which must be rejected for the rule its
// name starts with.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Rule = "boundary" | "web" | "cycle" | "lines" | "extension" | "css";
export type Violation = { rule: Rule; file: string; detail: string };

export const MAX_LINES = 500;
// path relative to src/ -> why it may be longer
export const LINE_EXEMPTIONS: Record<string, string> = {};
export const LAYER_LINE = "@layer tokens, base, pages;";
const TOKENS = "client/style/tokens.css";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

// Relative specifiers of static, type-only, side-effect and dynamic
// imports, and of re-exports. Comments go first so a commented-out import
// is not an edge.
export function specifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) out.push(match[1]);
  }
  return out.filter((spec) => spec.startsWith("."));
}

const top = (file: string) => file.split("/")[0];

function boundary(file: string, target: string): string | null {
  const from = top(file);
  const to = top(target);
  if (target.startsWith("..")) return null; // package.json and the like
  if (from === "shared" && to !== "shared")
    return "shared/ imports only shared/";
  if (from === "client" && to === "server")
    return "client/ never imports server/";
  if (from === "server" && to === "client" && file !== "server/app.ts") {
    return "only server/app.ts imports client/, for the page";
  }
  return null;
}

// web/ is the outermost server area: it may import every other one, and
// only the wiring may import it.
function web(file: string, target: string): string | null {
  if (!file.startsWith("server/")) return null;
  if (file.startsWith("server/web/") || file === "server/app.ts") return null;
  if (target.startsWith("server/web/"))
    return "only app.ts imports server/web/";
  if (target === "server/app.ts" || target === "main.ts") {
    return "nothing imports the entry points";
  }
  return null;
}

function cycles(graph: Map<string, string[]>): string[][] {
  const found: string[][] = [];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) {
        found.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }
  return found;
}

export function check(src: string): Violation[] {
  const out: Violation[] = [];
  const graph = new Map<string, string[]>();
  for (const path of walk(src)) {
    const file = relative(src, path);
    const code = /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts");
    const css = file.endsWith(".css");
    if (!code && !css) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n").length - 1;
    if (lines > MAX_LINES && !(file in LINE_EXEMPTIONS)) {
      out.push({ rule: "lines", file, detail: `${lines} lines` });
    }
    if (css) {
      if (!source.startsWith(LAYER_LINE)) {
        out.push({ rule: "css", file, detail: `must open with ${LAYER_LINE}` });
      }
      if (file !== TOKENS && /:root\s*\{[^}]*--[\w-]+\s*:/.test(source)) {
        out.push({ rule: "css", file, detail: `tokens belong to ${TOKENS}` });
      }
      continue;
    }
    const edges: string[] = [];
    for (const spec of specifiers(source)) {
      const resolved = resolve(dirname(path), spec);
      const target = relative(src, resolved);
      if (!/\.[a-z]+$/.test(spec)) {
        out.push({ rule: "extension", file, detail: spec });
        continue;
      }
      const crossed = boundary(file, target);
      if (crossed) out.push({ rule: "boundary", file, detail: crossed });
      const outer = web(file, target);
      if (outer) out.push({ rule: "web", file, detail: `${spec}: ${outer}` });
      if (/\.(ts|tsx)$/.test(target) && existsSync(resolved))
        edges.push(target);
    }
    graph.set(file, edges);
  }
  for (const cycle of cycles(graph)) {
    out.push({ rule: "cycle", file: cycle[0], detail: cycle.join(" -> ") });
  }
  return out;
}
