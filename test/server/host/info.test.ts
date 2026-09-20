// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { osMajor } from "../../../src/server/host/info.ts";

describe("osMajor", () => {
  test.each([
    ["26.6.2", 26],
    ["26.6", 26],
    ["26", 26],
    ["", null],
  ])("parses %s", (version, expected) => {
    expect(osMajor(version)).toBe(expected);
  });

  test("accepts the display value read by hostInfo", () => {
    expect(osMajor("macOS 26.6.2 (25G83)")).toBe(26);
    expect(osMajor("no version")).toBeNull();
  });
});
