// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. The rail, the page
// head, the page and the confirm dialog are Preact roots, and each follows
// the page signal: a click in the rail swaps the page under the same
// document. The socket opens last, once every subscriber is in place.

import { effect } from "@preact/signals";
import { render } from "preact";
import { BenchmarkRun, BenchmarkScorecard } from "./benchmark/Benchmark.tsx";
import { fetchRuns } from "./benchmark/state.ts";
import { Engine } from "./engine/Engine.tsx";
import { Monitor, trackMonitor } from "./monitor/Monitor.tsx";
import { fetchRequests, Requests } from "./requests/Requests.tsx";
import { Confirm } from "./shell/Confirm.tsx";
import { Footer } from "./shell/Footer.tsx";
import { Head } from "./shell/Head.tsx";
import { Side } from "./shell/Rail.tsx";
import { closeDrawer, drawerOpen, narrow, watchWidth } from "./shell/shell.ts";
import { connect, type Page, page, pageOf } from "./store.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const TITLE: Record<Page, string> = {
  monitor: "1ctx-mlx-engine",
  requests: "1ctx-mlx-engine · requests",
  engine: "1ctx-mlx-engine · engine",
  run: "1ctx-mlx-engine · benchmark",
  scorecard: "1ctx-mlx-engine · scorecard",
};

function Current() {
  const p = page.value;
  if (p === "requests") return <Requests />;
  if (p === "engine") return <Engine />;
  if (p === "run") return <BenchmarkRun />;
  if (p === "scorecard") return <BenchmarkScorecard />;
  return <Monitor />;
}

// the version and the credits close the Overview alone; the other pages
// end with their last card
function View() {
  return (
    <>
      <Current />
      {page.value === "monitor" && (
        <footer>
          <Footer />
        </footer>
      )}
    </>
  );
}

const RailRoot = () => <Side page={page.value} />;
const HeadRoot = () => <Head page={page.value} />;

page.value = pageOf(location.pathname);
// back and forward land on a page, like a link in the drawer does
addEventListener("popstate", () => {
  closeDrawer();
  page.value = pageOf(location.pathname);
});
watchWidth();
// the page under the open drawer is inert, set as the drawer opens or
// closes, so a dialog the menu opens after closing it takes the focus
effect(() => {
  $("main").inert = narrow.value && drawerOpen.value;
});
effect(() => {
  document.title = TITLE[page.value];
});
render(<RailRoot />, $("rail"));
render(<HeadRoot />, $("head"));
// one dialog for every page and the rail's menu, outside #main so the
// drawer's inert never reaches it
render(<Confirm />, $("dialogs"));
// before the socket, so its first snapshot reaches the Overview's tiles
trackMonitor();
render(<View />, $("view"));
connect();
// the lists the other pages open with, read once now so that a first
// visit shows them at once instead of an empty table; each page reads
// its own again as it opens (the Overview's hour is loaded by its
// tracking)
fetchRuns();
fetchRequests();
