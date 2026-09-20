// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  limitsFromArgs,
  parseLaunchdArgs,
  parseSize,
} from "../../src/engine/config.ts";
import { parseProps } from "../../src/engine/mlxserve.ts";
import propsFixture from "../fixtures/props.json";

describe("launch configuration", () => {
  const GiB = 1024 ** 3;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ddalcu.mlx-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/mlx-serve</string>
    <string>--serve</string>
    <string>--model-dir</string>
    <string>/Users/x/models &amp; more</string>
    <string>--prefix-cache-mem</string>
    <string>16GB</string>
    <string>--prefix-cache-disk</string>
    <string>50GB</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/bin</string></dict>
</dict>
</plist>`;

  test("parseSize follows the engine's grammar", () => {
    expect(parseSize("16GB")).toBe(16 * GiB);
    expect(parseSize("512mb")).toBe(512 * 1024 ** 2);
    expect(parseSize("8KB")).toBe(8192);
    expect(parseSize("4096")).toBe(4096);
    expect(parseSize("off")).toBe(0);
    expect(parseSize("0")).toBe(0);
    expect(parseSize("16 GB")).toBe(16 * GiB);
    expect(parseSize("lots")).toBeNull();
    expect(parseSize("GB")).toBeNull();
  });

  test("parseLaunchdArgs reads only ProgramArguments", () => {
    const args = parseLaunchdArgs(plist);
    expect(args[0]).toBe("/opt/homebrew/bin/mlx-serve");
    expect(args).toContain("/Users/x/models & more");
    expect(args).not.toContain("/usr/bin");
    expect(parseLaunchdArgs("<plist/>")).toEqual([]);
  });

  test("limitsFromArgs takes the flags, with the engine's defaults", () => {
    expect(limitsFromArgs(parseLaunchdArgs(plist))).toEqual({
      hotBytes: 16 * GiB,
      diskBytes: 50 * GiB,
    });
    expect(limitsFromArgs(["mlx-serve", "--serve"])).toEqual({
      hotBytes: 2 * GiB,
      diskBytes: 0,
    });
    expect(limitsFromArgs(["--prefix-cache-mem=4GB"]).hotBytes).toBe(4 * GiB);
    expect(limitsFromArgs(["--prefix-cache-disk", "off"]).diskBytes).toBe(0);
    // a malformed value keeps the default rather than poisoning the tile
    expect(limitsFromArgs(["--prefix-cache-mem", "big"]).hotBytes).toBe(
      2 * GiB,
    );
  });

  test("the recorded budgets are the ones the plist asks for", () => {
    // the two sources must agree, or the tiles would move when the engine
    // answers instead of the plist
    const props = parseProps(propsFixture);
    expect(props.limits).toEqual(
      limitsFromArgs([
        "--prefix-cache-mem",
        "16GB",
        "--prefix-cache-disk",
        "50GB",
      ]),
    );
  });
});
