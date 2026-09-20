// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  agentBinary,
  type PlistSpec,
  plistPath,
  renderPlist,
} from "../../../src/server/service/plist.ts";

const self: PlistSpec = {
  label: "com.example.self&watch",
  programArguments: [
    "/opt/1ctx-mlx-engine",
    "--engine",
    "http://host/?a=1&b=<2>",
  ],
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
  test("renders and XML-escapes the 1ctx-mlx-engine agent", () => {
    const xml = renderPlist(self);
    expect(xml).toContain("<string>com.example.self&amp;watch</string>");
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
    expect(plistPath("com.example.self", "/Users/test/")).toBe(
      "/Users/test/Library/LaunchAgents/com.example.self.plist",
    );
  });

  test("maps any Homebrew Cellar prefix to opt", () => {
    expect(
      agentBinary(
        "/opt/homebrew/Cellar/1ctx-mlx-engine/1.2.3/bin/1ctx-mlx-engine",
      ),
    ).toBe("/opt/homebrew/opt/1ctx-mlx-engine/bin/1ctx-mlx-engine");
    expect(
      agentBinary("/custom/brew/Cellar/1ctx-mlx-engine/2/bin/1ctx-mlx-engine"),
    ).toBe("/custom/brew/opt/1ctx-mlx-engine/bin/1ctx-mlx-engine");
    expect(
      agentBinary("/Users/test/.1ctx-mlx-engine/bin/1ctx-mlx-engine"),
    ).toBe("/Users/test/.1ctx-mlx-engine/bin/1ctx-mlx-engine");
    expect(agentBinary("/opt/homebrew/bin/1ctx-mlx-engine")).toBe(
      "/opt/homebrew/bin/1ctx-mlx-engine",
    );
  });
});
