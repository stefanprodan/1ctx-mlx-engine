// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readBody, StallError } from "../../../src/server/lib/fetch.ts";

// a body that sends `chunks` and then, unless `end`, stays open and silent
function body(chunks: number, end: boolean) {
  let cancelled = false;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks) {
        controller.enqueue(new Uint8Array(4).fill(sent++));
      } else if (end) {
        controller.close();
      } else {
        return new Promise(() => {});
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

describe("readBody", () => {
  test("hands every chunk over until the end", async () => {
    const { stream } = body(3, true);
    const seen: number[] = [];
    await readBody(stream, new AbortController().signal, 1_000, (chunk) => {
      seen.push(chunk[0] ?? -1);
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  test("cancels a body that goes silent", async () => {
    const { stream, cancelled } = body(1, false);
    let count = 0;
    const read = readBody(stream, new AbortController().signal, 50, () => {
      count++;
    });
    await expect(read).rejects.toBeInstanceOf(StallError);
    expect(count).toBe(1);
    expect(cancelled()).toBe(true);
  });

  test("an abort ends a pending read with the signal's reason", async () => {
    const { stream, cancelled } = body(1, false);
    const controller = new AbortController();
    const reason = new Error("stop");
    const read = readBody(stream, controller.signal, 10_000, () => {
      // the next read is pending on a silent body when the abort lands
      setTimeout(() => controller.abort(reason), 20);
    });
    await expect(read).rejects.toBe(reason);
    expect(cancelled()).toBe(true);
  });

  test("a slow chunk handler is not a stall", async () => {
    const { stream } = body(2, true);
    let count = 0;
    await readBody(stream, new AbortController().signal, 30, async () => {
      count++;
      await Bun.sleep(80);
    });
    expect(count).toBe(2);
  });

  test("lets go of the body when it ends", async () => {
    const { stream } = body(1, true);
    await readBody(stream, new AbortController().signal, 1_000, () => {});
    expect(stream.locked).toBe(false);
  });

  // The old loop raced each read against one pending promise, and every
  // race kept its chunk reachable: the whole body stayed in memory.
  test("keeps no chunk once it is handed over", async () => {
    const size = 1024 * 1024;
    const chunks = 512;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < chunks) controller.enqueue(new Uint8Array(size).fill(1));
        else controller.close();
      },
    });
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    await readBody(stream, new AbortController().signal, 10_000, () => {
      if (sent % 64 === 0) {
        Bun.gc(true);
        peak = Math.max(peak, process.memoryUsage().rss);
      }
    });
    expect(peak - before).toBeLessThan((size * chunks) / 4);
  });

  test("a chunk handler that throws cancels the body", async () => {
    const { stream, cancelled } = body(3, false);
    const read = readBody(stream, new AbortController().signal, 10_000, () => {
      throw new Error("too big");
    });
    await expect(read).rejects.toThrow("too big");
    expect(cancelled()).toBe(true);
  });
});
