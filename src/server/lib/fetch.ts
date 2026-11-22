// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export const DOWNLOAD_DISK_MARGIN = 1024 ** 3;
export const DOWNLOAD_STALL_MS = 60_000;
export const MAX_DOWNLOAD_REDIRECTS = 5;

export type RedirectOptions = {
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  signal: AbortSignal;
  maxRedirects?: number;
};

// Redirects are followed here so credentials can be stripped before a CDN
// sees a request. Native redirect handling does not expose that boundary.
export async function fetchRedirected(
  url: string,
  options: RedirectOptions,
): Promise<Response> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? MAX_DOWNLOAD_REDIRECTS;
  let current = new URL(url);
  let headers = new Headers(options.headers);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetchFn(current, {
      headers,
      signal: options.signal,
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("redirect without location");
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      headers = new Headers(headers);
      headers.delete("authorization");
    }
    current = next;
  }
  throw new Error("too many redirects");
}

// The body sent nothing for the stall timeout and was cancelled.
export class StallError extends Error {}

// Reads a body to its end, one chunk at a time into `onChunk`. A body that
// sends nothing for `stallMs` while a read waits is cancelled with a
// StallError (a slow `onChunk`, a disk write, is not a stall), an abort of
// `signal` cancels it with the signal's reason, and whatever ends the loop
// cancels a read still pending. A stall is never a Promise.race of each
// read against one long-lived promise: every race leaves a reaction on that
// promise holding its read's chunk until it settles, which kept a whole
// download in memory (5 GB of footprint for a 5 GB file).
export async function readBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  stallMs: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  let stalled = false;
  // a cancel resolves the read in flight as done, which ends the loop
  const cancel = () => void reader.cancel().catch(() => undefined);
  const onStall = () => {
    stalled = true;
    cancel();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    while (true) {
      timer = setTimeout(onStall, stallMs);
      const next = await reader.read();
      clearTimeout(timer);
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (stalled) {
        throw new StallError(`no data for ${Math.round(stallMs / 1_000)} s`);
      }
      if (next.done) return;
      await onChunk(next.value);
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    // not awaited: a stream whose cancel never settles must not hold the
    // caller, and its file handle, open
    cancel();
    try {
      reader.releaseLock();
    } catch {
      // a read still pending on a stream that ignored the cancel
    }
  }
}

export function sleepWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
