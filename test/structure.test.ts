// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The layout rules over src/, and every fixture tree under
// test/fixtures/structure/ rejected for the rule its name starts with.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  check,
  LINE_EXEMPTIONS,
  type Rule,
  specifiers,
  UNLAYERED,
} from "./structure.ts";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "structure");

describe("the layout", () => {
  test("src/ follows the rules", () => {
    expect(check(join(ROOT, "src"))).toEqual([]);
  });

  test("every exemption says why", () => {
    for (const why of [
      ...Object.values(LINE_EXEMPTIONS),
      ...Object.values(UNLAYERED),
    ]) {
      expect(why.length).toBeGreaterThan(10);
    }
  });

  test("reads every import form and skips comments", () => {
    const source = [
      'import a from "./a.ts";',
      'import type { B } from "./b.ts";',
      'import "./c.css";',
      'export { d } from "./d.ts";',
      'const e = await import("./e.ts");',
      'import {\n  f,\n} from "./f.ts";',
      '// import g from "./g.ts";',
      'import h from "preact";',
      'import i, { j } from "./i.ts";',
      'export * from "./k.ts";',
      'await import("./l.ts", { with: { type: "json" } });',
    ].join("\n");
    expect(specifiers(source).sort()).toEqual(
      [
        "./a.ts",
        "./b.ts",
        "./c.css",
        "./d.ts",
        "./e.ts",
        "./f.ts",
        "./i.ts",
        "./k.ts",
        "./l.ts",
      ].sort(),
    );
  });

  for (const name of readdirSync(FIXTURES).sort()) {
    const rule = name.split("-")[0] as Rule;
    test(`fixture ${name} is rejected for ${rule}`, () => {
      const violations = check(join(FIXTURES, name));
      // for that rule and nothing else, so a fixture cannot pass by accident
      expect(violations.length).toBeGreaterThan(0);
      expect(new Set(violations.map((v) => v.rule))).toEqual(new Set([rule]));
    });
  }
});
