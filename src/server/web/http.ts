// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What every route shares: the JSON answer, the refusal that carries a
// status, the bounded body read and the same-origin check.

const MAX_BODY_BYTES = 256 * 1024;

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

export const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function body(
  req: Request,
  empty = false,
): Promise<Record<string, unknown>> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new HttpError(400, "body must be at most 256 KB");
  }
  if (!req.body) {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(400, "body must be at most 256 KB");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") {
    if (empty) return {};
    throw new HttpError(400, "body must be a JSON object");
  }
  try {
    return object(JSON.parse(text));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body is not JSON");
  }
}

export function stringField(
  value: Record<string, unknown>,
  name: string,
  required = false,
): string | undefined {
  const field = value[name];
  if (field === undefined && !required) return undefined;
  if (typeof field !== "string" || (required && field === "")) {
    throw new HttpError(400, `${name} must be a string`);
  }
  return field;
}
