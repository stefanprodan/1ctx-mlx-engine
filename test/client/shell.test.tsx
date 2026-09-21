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
  updateNote,
  updates,
} from "../../src/client/store.ts";
import type { Snapshot } from "../../src/shared/socket.ts";

describe("shell", () => {
  test("the rail lights the page on screen, a section over its pages", () => {
    const overview = render(<Rail page="monitor" />);
    expect(overview).toContain(
      '<a href="/" class="rail-sub rail-sub-on" aria-current="page">',
    );
    expect(overview).toContain('<a href="/requests" class="rail-sub">');
    expect(overview).toContain('<a href="/models" class="rail-sub">');
    expect(overview).toContain('<a href="/server" class="rail-sub">');
    expect(overview).toContain('<a href="/benchmark" class="rail-sub">');
    expect(overview).toContain(
      '<a href="/benchmark/scorecard" class="rail-sub">',
    );
    // Monitor lit, Engine and Benchmark not
    expect(overview).toContain(
      '<div class="rail-item rail-label rail-in"><svg',
    );
    expect(overview).toContain("<span>Monitor</span>");
    expect(overview.match(/rail-label/g)).toHaveLength(3);
    expect(overview.match(/rail-in/g)).toHaveLength(1);
    // the order: Monitor's two, Engine's two, Benchmark's two
    const hrefs = [...overview.matchAll(/<a href="([^"]+)" class="rail-/g)].map(
      (m) => m[1],
    );
    expect(hrefs).toEqual([
      "/",
      "/requests",
      "/models",
      "/server",
      "/benchmark",
      "/benchmark/scorecard",
    ]);
    expect(overview.indexOf("<span>Benchmark</span>")).toBeLessThan(
      overview.indexOf('href="/benchmark"'),
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

    const server = render(<Rail page="server" />);
    expect(server).toContain(
      '<a href="/server" class="rail-sub rail-sub-on" aria-current="page">',
    );
    expect(server.match(/rail-in/g)).toHaveLength(1);
    expect(server.indexOf("rail-in")).toBeLessThan(
      server.indexOf("<span>Models</span>"),
    );
    expect(server.match(/aria-current/g)).toHaveLength(1);
    expect(render(<Rail page="models" />)).toContain(
      '<a href="/models" class="rail-sub rail-sub-on" aria-current="page">',
    );
    const runs = render(<Rail page="run" />);
    expect(runs).toContain(
      '<a href="/benchmark" class="rail-sub rail-sub-on" aria-current="page">',
    );
    expect(runs.match(/rail-in/g)).toHaveLength(1);
    expect(runs.indexOf("rail-in")).toBeGreaterThan(
      runs.indexOf("<span>Engine</span>"),
    );
    expect(render(<Rail page="scorecard" />)).toContain(
      '<a href="/benchmark/scorecard" class="rail-sub rail-sub-on" aria-current="page">',
    );
  });

  test("a newer build puts a pill on Server, a dot in the strip", () => {
    updates.value = { engine: null, self: null };
    expect(render(<Rail page="monitor" />)).not.toContain("rail-new");
    expect(render(<Strip page="monitor" />)).not.toContain("strip-new");
    updates.value = { engine: "26.9.5", self: null };
    const rail = render(<Rail page="monitor" />);
    expect(rail).toContain(
      '<a href="/server" class="rail-sub" title="mlx-serve 26.9.5 available"><svg',
    );
    expect(rail).toContain(
      '<span>Server</span><span class="rail-new">new</span></a>',
    );
    expect(rail.match(/rail-new/g)).toHaveLength(1);
    const strip = render(<Strip page="monitor" />);
    expect(strip).toContain(
      'title="Server: mlx-serve 26.9.5 available" aria-label="Server, mlx-serve 26.9.5 available"',
    );
    expect(strip.match(/strip-new/g)).toHaveLength(1);
    updates.value = null;
  });

  test("the pill's note names what is on offer", () => {
    expect(updateNote(null)).toBeNull();
    expect(updateNote({ engine: null, self: null })).toBeNull();
    expect(updateNote({ engine: null, self: "1.2.0" })).toBe(
      "1ctx-mlx-engine 1.2.0 available",
    );
    expect(updateNote({ engine: "26.9.5", self: "1.2.0" })).toBe(
      "mlx-serve 26.9.5 and 1ctx-mlx-engine 1.2.0 available",
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
      "/models Models",
      "/server Server",
      "/benchmark Run",
      "/benchmark/scorecard Scorecard",
    ]);
    expect(html).toContain(
      '<a href="/requests" class="strip-icon strip-icon-on" title="Requests" aria-label="Requests" aria-current="page">',
    );
    // a rule between the groups: Monitor's, Engine's, Benchmark's
    expect(html.match(/strip-rule/g)).toHaveLength(2);
    const at = (s: string) => html.indexOf(s);
    expect(at('href="/requests"')).toBeLessThan(at("strip-rule"));
    expect(at("strip-rule")).toBeLessThan(at('href="/models"'));
    expect(at('href="/server"')).toBeLessThan(html.lastIndexOf("strip-rule"));
    expect(html.lastIndexOf("strip-rule")).toBeLessThan(
      at('href="/benchmark"'),
    );
  });

  test("the head names the page under 1ctx and its section", () => {
    const crumb = (page: Page) =>
      render(<Head page={page} />)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(crumb("monitor")).toBe("1ctx / Monitor / Overview");
    expect(crumb("requests")).toBe("1ctx / Monitor / Requests");
    expect(crumb("models")).toBe("1ctx / Engine / Models");
    expect(crumb("server")).toBe("1ctx / Engine / Server");
    expect(crumb("run")).toBe("1ctx / Benchmark / Run");
    expect(crumb("scorecard")).toBe("1ctx / Benchmark / Scorecard");
    expect(render(<Head page="server" />)).toContain(
      '<span class="crumb-page">Server</span>',
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
