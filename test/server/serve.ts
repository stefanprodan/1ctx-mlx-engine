// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fake HTTP server for one test, on a random port of 127.0.0.1, which is
// where the tests connect. Bun.serve binds the IPv6 wildcard by default, and
// macOS lets that share a port number with another program's socket on
// 127.0.0.1, which then takes every connection to 127.0.0.1 on that port.
// With the ephemeral ports of the IDE, Docker and the rest on loopback, a
// test now and then talked to one of them ("download: HTTP 401", "HTTP 400",
// "download exceeded N bytes", about once in 70 runs). Bound to 127.0.0.1,
// the port is one nobody else holds there.

export const TEST_HOST = "127.0.0.1";

export function testServer(
  fetch: (
    request: Request,
    server: Bun.Server<unknown>,
  ) => Response | Promise<Response>,
): Bun.Server<unknown> {
  return Bun.serve({ hostname: TEST_HOST, port: 0, fetch });
}
