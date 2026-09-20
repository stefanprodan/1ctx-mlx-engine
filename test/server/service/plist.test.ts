// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  agentBinary,
  type PlistSpec,
  plistPath,
  renderPlist,
} from "../../../src/server/service/plist.ts";

const spy: PlistSpec = {
  label: "com.example.spy&watch",
  programArguments: ["/opt/mlx-spy", "--engine", "http://host/?a=1&b=<2>"],
  runAtLoad: true,
  keepAlive: true,
  standardOutPath: "/tmp/out.log",
  standardErrorPath: "/tmp/error.log",
};

const engine: PlistSpec = {
  label: "com.example.engine",
  programArguments: ["/opt/mlx-serve", "--serve"],
  environmentVariables: { HOME: "/Users/a&b", PATH: "/usr/bin:/bin" },
  workingDirectory: "/Users/a&b",
  runAtLoad: true,
  keepAlive: true,
  processType: "Interactive",
  throttleInterval: 10,
  standardOutPath: "/tmp/launchd.log",
  standardErrorPath: "/tmp/launchd.log",
};

describe("renderPlist", () => {
  test("renders and XML-escapes the mlx-spy agent", () => {
    const xml = renderPlist(spy);
    expect(xml).toContain("<string>com.example.spy&amp;watch</string>");
    expect(xml).toContain("http://host/?a=1&amp;b=&lt;2&gt;");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  test("renders the general keys needed by the engine agent", () => {
    const xml = renderPlist(engine);
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<string>/Users/a&amp;b</string>");
    expect(xml).toContain("<key>WorkingDirectory</key>");
    expect(xml).toContain("<key>ProcessType</key>");
    expect(xml).toContain("<integer>10</integer>");
    expect(xml.match(/<key>Standard(?:Out|Error)Path<\/key>/g)).toHaveLength(2);
  });
});

describe("plist paths", () => {
  test("builds a user LaunchAgents path", () => {
    expect(plistPath("com.example.spy", "/Users/test/")).toBe(
      "/Users/test/Library/LaunchAgents/com.example.spy.plist",
    );
  });

  test("maps any Homebrew Cellar prefix to opt", () => {
    expect(agentBinary("/opt/homebrew/Cellar/mlx-spy/1.2.3/bin/mlx-spy")).toBe(
      "/opt/homebrew/opt/mlx-spy/bin/mlx-spy",
    );
    expect(agentBinary("/custom/brew/Cellar/mlx-spy/2/bin/mlx-spy")).toBe(
      "/custom/brew/opt/mlx-spy/bin/mlx-spy",
    );
    expect(agentBinary("/Users/test/.mlx-spy/bin/mlx-spy")).toBe(
      "/Users/test/.mlx-spy/bin/mlx-spy",
    );
    expect(agentBinary("/opt/homebrew/bin/mlx-spy")).toBe(
      "/opt/homebrew/bin/mlx-spy",
    );
  });
});
