// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { abbreviateHome, expandHome } from "../../src/shared/paths.ts";

test("abbreviates and expands only the home prefix", () => {
  expect(abbreviateHome("/Users/x/models", "/Users/x")).toBe("~/models");
  expect(abbreviateHome("/Users/xy/models", "/Users/x")).toBe(
    "/Users/xy/models",
  );
  expect(expandHome("~/models", "/Users/x")).toBe("/Users/x/models");
  expect(expandHome("/Volumes/models", "/Users/x")).toBe("/Volumes/models");
});
