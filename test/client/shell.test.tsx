// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell components rendered to a string, without a DOM: the class
// names and structure style.css depends on, and the signals they read.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Footer } from "../../src/client/shell/Footer.tsx";
import { Header } from "../../src/client/shell/Header.tsx";
import { Pill } from "../../src/client/shell/Pill.tsx";
import { connection, snapshot } from "../../src/client/store.ts";
import type { Snapshot } from "../../src/shared/socket.ts";

describe("shell", () => {
  test("header marks the current page and carries no pill", () => {
    const monitor = render(<Header page="monitor" />);
    expect(monitor).toContain('<div class="wordmark"><svg class="mark"');
    expect(monitor).toContain('<a href="/" class="active">Monitor</a>');
    expect(monitor).toContain('<a href="/requests">Requests</a>');
    expect(monitor).toContain('<a href="/engine">Engine</a>');
    expect(monitor).not.toContain('class="pill');
    const requests = render(<Header page="requests" />);
    expect(requests).toContain(
      '<a href="/requests" class="active">Requests</a>',
    );
    expect(requests).not.toContain('class="pill');
    expect(render(<Header page="engine" />)).toContain(
      '<a href="/engine" class="active">Engine</a>',
    );
  });

  test("pill follows the connection signal", () => {
    connection.value = "connecting";
    expect(render(<Pill />)).toBe('<span class="pill">connecting</span>');
    connection.value = "live";
    expect(render(<Pill />)).toBe('<span class="pill live">live</span>');
    connection.value = "reconnecting";
    expect(render(<Pill />)).toBe('<span class="pill err">reconnecting</span>');
  });

  test("footer shows the version once the snapshot is in", () => {
    snapshot.value = null;
    expect(render(<Footer />)).toContain(">1ctx-mlx-engine</a>");
    snapshot.value = {
      version: "v0.0.0-dev",
      events: [],
    } as Partial<Snapshot> as Snapshot;
    expect(render(<Footer />)).toContain(">1ctx-mlx-engine v0.0.0-dev</a>");
    expect(render(<Footer />)).toContain('class="footlink"');
  });
});
