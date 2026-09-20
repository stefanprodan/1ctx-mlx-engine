// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// carries the HTTP status the route should answer with
export class DownloadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
