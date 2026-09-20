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

export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
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
