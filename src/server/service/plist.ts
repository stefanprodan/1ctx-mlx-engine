// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export interface PlistSpec {
  label: string;
  programArguments: string[];
  environmentVariables?: Record<string, string>;
  workingDirectory?: string;
  runAtLoad?: boolean;
  keepAlive?: boolean;
  processType?: string;
  throttleInterval?: number;
  standardOutPath?: string;
  standardErrorPath?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function key(name: string): string {
  return `  <key>${name}</key>`;
}

function stringValue(value: string): string {
  return `  <string>${escapeXml(value)}</string>`;
}

function booleanValue(value: boolean): string {
  return `  <${value ? "true" : "false"}/>`;
}

export function renderPlist(spec: PlistSpec): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    key("Label"),
    stringValue(spec.label),
    key("ProgramArguments"),
    "  <array>",
    ...spec.programArguments.map(
      (argument) => `    <string>${escapeXml(argument)}</string>`,
    ),
    "  </array>",
  ];

  if (spec.workingDirectory !== undefined) {
    lines.push(key("WorkingDirectory"), stringValue(spec.workingDirectory));
  }
  if (spec.environmentVariables !== undefined) {
    lines.push(key("EnvironmentVariables"), "  <dict>");
    for (const [name, value] of Object.entries(spec.environmentVariables)) {
      lines.push(
        `    <key>${escapeXml(name)}</key>`,
        `    <string>${escapeXml(value)}</string>`,
      );
    }
    lines.push("  </dict>");
  }
  if (spec.runAtLoad !== undefined) {
    lines.push(key("RunAtLoad"), booleanValue(spec.runAtLoad));
  }
  if (spec.keepAlive !== undefined) {
    lines.push(key("KeepAlive"), booleanValue(spec.keepAlive));
  }
  if (spec.throttleInterval !== undefined) {
    lines.push(
      key("ThrottleInterval"),
      `  <integer>${spec.throttleInterval}</integer>`,
    );
  }
  if (spec.processType !== undefined) {
    lines.push(key("ProcessType"), stringValue(spec.processType));
  }
  if (spec.standardOutPath !== undefined) {
    lines.push(key("StandardOutPath"), stringValue(spec.standardOutPath));
  }
  if (spec.standardErrorPath !== undefined) {
    lines.push(key("StandardErrorPath"), stringValue(spec.standardErrorPath));
  }

  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

export function plistPath(label: string, home: string): string {
  return `${home.replace(/\/$/, "")}/Library/LaunchAgents/${label}.plist`;
}

export function agentBinary(execPath: string): string {
  const match = /^(.*)\/Cellar\/mlx-spy\/[^/]+\/bin\/mlx-spy$/.exec(execPath);
  return match ? `${match[1]}/opt/mlx-spy/bin/mlx-spy` : execPath;
}
