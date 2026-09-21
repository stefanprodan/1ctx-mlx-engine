// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { TEST_HOST, testServer } from "./serve.ts";

const TESTS = join(import.meta.dir, "..");

test("a test server listens on 127.0.0.1, where the tests connect", async () => {
  const server = testServer(() => new Response("ok"));
  try {
    expect(server.hostname).toBe(TEST_HOST);
    const answer = await fetch(`http://${TEST_HOST}:${server.port}/`);
    expect(await answer.text()).toBe("ok");
  } finally {
    await server.stop(true);
  }
});

test("no test starts a server of its own", async () => {
  const bare: string[] = [];
  const files = await readdir(TESTS, { recursive: true });
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    const path = join(TESTS, file);
    if (path === join(import.meta.dir, "serve.ts")) continue;
    if (path === import.meta.path) continue;
    const text = await readFile(path, "utf8");
    if (text.includes("Bun.serve(")) bare.push(relative(TESTS, path));
  }
  expect(bare).toEqual([]);
});
