#!/usr/bin/env bun

// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { AppError, runApp } from "./app.ts";
import { HELP, parseCli, VERSION } from "./cli.ts";
import { runService, ServiceError } from "./service.ts";

export { VERSION };

const result = parseCli(Bun.argv.slice(2));

if (result.kind === "help") {
  console.log(result.text);
} else if (result.kind === "version") {
  console.log(VERSION);
} else if (result.kind === "error") {
  console.error(`error: ${result.message}\n\n${HELP}`);
  process.exitCode = 1;
} else if (result.kind === "service") {
  try {
    await runService(result.argv);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  try {
    const exitCode = await runApp(result.options);
    if (exitCode !== undefined) process.exitCode = exitCode;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
