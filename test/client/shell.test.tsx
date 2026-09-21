// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell components rendered to a string, without a DOM: the class
// names and structure the stylesheets depend on, and the signals they read.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Footer } from "../../src/client/shell/Footer.tsx";
import { Head } from "../../src/client/shell/Head.tsx";
import { Pill } from "../../src/client/shell/Pill.tsx";
import { Rail, Strip, UserMenu } from "../../src/client/shell/Rail.tsx";
import {
  busy,
  connection,
  engineMode,
  type Page,
  snapshot,
} from "../../src/client/store.ts";
import type { Snapshot } from "../../src/shared/socket.ts";

describe("shell", () => {
  test("the rail lights the page on screen, Monitor over its two", () => {
    const overview = render(<Rail page="monitor" />);
    expect(overview).toContain(
      '<a href="/" class="rail-sub rail-sub-on" aria-current="page">',
    );
    expect(overview).toContain('<a href="/requests" class="rail-sub">');
    expect(overview).toContain('<a href="/engine" class="rail-item">');
    expect(overview).toContain('<a href="/benchmark" class="rail-item">');
    expect(overview).toContain(
      '<div class="rail-item rail-label rail-in"><svg',
    );
    expect(overview).toContain('<span class="rail-word">MLX</span>');
    expect(overview).toContain('aria-label="Hide the menu"');
    expect(overview).toContain(
      '<span class="avatar">AD</span><span class="rail-user-name">Admin</span>',
    );
    expect(overview).not.toContain('class="rail-menu"');
    expect(overview).not.toContain('class="pill');

    const requests = render(<Rail page="requests" />);
    expect(requests).toContain(
      '<a href="/requests" class="rail-sub rail-sub-on" aria-current="page">',
    );
    expect(requests).toContain('class="rail-item rail-label rail-in"');

    const engine = render(<Rail page="engine" />);
    expect(engine).toContain(
      '<a href="/engine" class="rail-item rail-item-on" aria-current="page">',
    );
    expect(engine).toContain('<div class="rail-item rail-label"><svg');
    expect(engine.match(/aria-current/g)).toHaveLength(1);
    expect(render(<Rail page="benchmark" />)).toContain(
      '<a href="/benchmark" class="rail-item rail-item-on" aria-current="page">',
    );
  });

  test("the strip names every page and lights the one on screen", () => {
    const html = render(<Strip page="requests" />);
    expect(html).toContain('aria-label="Show the menu"');
    const names = [
      ...html.matchAll(/<a href="([^"]+)"[^>]*aria-label="([^"]+)"/g),
    ];
    expect(names.map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "/ Overview",
      "/requests Requests",
      "/engine Engine",
      "/benchmark Benchmark",
    ]);
    expect(html).toContain(
      '<a href="/requests" class="strip-icon strip-icon-on" title="Requests" aria-label="Requests" aria-current="page">',
    );
    // Monitor's pages above the rule, the rest below
    expect(html.indexOf('href="/requests"')).toBeLessThan(
      html.indexOf("strip-rule"),
    );
    expect(html.indexOf("strip-rule")).toBeLessThan(
      html.indexOf('href="/engine"'),
    );
  });

  test("the head names the page, under Monitor for its two", () => {
    const crumb = (page: Page) =>
      render(<Head page={page} />)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(crumb("monitor")).toBe("Monitor / Overview");
    expect(crumb("requests")).toBe("Monitor / Requests");
    expect(crumb("engine")).toBe("Engine");
    expect(crumb("benchmark")).toBe("Benchmark");
    expect(render(<Head page="engine" />)).toContain(
      '<span class="crumb-page">Engine</span>',
    );
  });

  test("the user menu restarts a local engine and links the source", () => {
    const close = () => {};
    engineMode.value = "managed";
    busy.value = null;
    snapshot.value = {
      engine: { local: true, capabilities: ["restart"] },
    } as unknown as Snapshot;
    const on = render(<UserMenu close={close} />);
    expect(on).toContain(
      '<button type="button" class="rail-menu-item" role="menuitem"><svg',
    );
    expect(on).toContain("<span>Restart engine</span>");
    expect(on).toContain(
      '<a class="rail-menu-item" role="menuitem" href="https://github.com/stefanprodan/1ctx-mlx-engine" target="_blank" rel="noopener">',
    );
    expect(on).toContain("<span>Source code</span>");

    busy.value = "load";
    expect(render(<UserMenu close={close} />)).toContain(
      'role="menuitem" disabled><svg',
    );
    busy.value = null;

    snapshot.value = {
      engine: { local: false, capabilities: ["restart"] },
    } as unknown as Snapshot;
    expect(render(<UserMenu close={close} />)).toContain(
      'disabled title="restarts the engine service, local engine only"',
    );

    engineMode.value = "absent";
    expect(render(<UserMenu close={close} />)).toContain(
      'disabled title="mlx-serve is not installed"',
    );
    engineMode.value = null;
    snapshot.value = null;
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
