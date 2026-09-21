// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. The rail, the page
// head, the footer and the page are Preact roots. The socket opens last,
// once every subscriber is in place.

import { effect } from "@preact/signals";
import { render } from "preact";
import { Benchmark } from "./benchmark/Benchmark.tsx";
import { Engine } from "./engine/Engine.tsx";
import { Monitor } from "./monitor/Monitor.tsx";
import { Requests } from "./requests/Requests.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Head } from "./shell/Head.tsx";
import { Side } from "./shell/Rail.tsx";
import { drawerOpen, narrow, watchWidth } from "./shell/shell.ts";
import { connect, pageOf } from "./store.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const page = pageOf(location.pathname);
watchWidth();
// the page under the open drawer is inert, set as the drawer opens or
// closes, so a dialog the menu opens after closing it takes the focus
effect(() => {
  $("main").inert = narrow.value && drawerOpen.value;
});
render(<Side page={page} />, $("rail"));
render(<Head page={page} />, $("head"));
render(<Footer />, $("foot"));
if (page === "requests") {
  document.title = "1ctx-mlx-engine · requests";
  $("view-monitor").hidden = true;
  $("view-requests").hidden = false;
  render(<Requests />, $("view-requests"));
} else if (page === "engine") {
  document.title = "1ctx-mlx-engine · engine";
  $("view-monitor").hidden = true;
  $("view-engine").hidden = false;
  render(<Engine />, $("view-engine"));
} else if (page === "benchmark") {
  document.title = "1ctx-mlx-engine · benchmark";
  $("view-monitor").hidden = true;
  $("view-benchmark").hidden = false;
  render(<Benchmark />, $("view-benchmark"));
} else {
  render(<Monitor />, $("view-monitor"));
}
connect();
