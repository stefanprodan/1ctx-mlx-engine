// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ExclusiveLock, LockBusyError } from "../src/lock.ts";

describe("ExclusiveLock", () => {
  test("refuses a second holder while the first is running", async () => {
    const lock = new ExclusiveLock();
    let release!: () => void;
    const first = lock.run(
      "actions",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Bun.sleep(0);

    expect(lock.running()).toBe("actions");
    await expect(lock.run("manager", async () => {})).rejects.toEqual(
      new LockBusyError("actions"),
    );

    release();
    await first;
    expect(lock.running()).toBeNull();
  });

  test("releases after success and failure", async () => {
    const lock = new ExclusiveLock();
    await expect(lock.run("success", async () => 1)).resolves.toBe(1);
    expect(lock.running()).toBeNull();

    await expect(
      lock.run("failure", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(lock.running()).toBeNull();
    await expect(lock.run("next", async () => 2)).resolves.toBe(2);
  });
});
