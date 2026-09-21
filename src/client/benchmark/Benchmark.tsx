// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The two Benchmark pages: Run, where a scripted agent session runs
// against a model and the runs compare, and the Scorecard, the fastest
// model at a preset. They measure the engine, never the answers.

import { computed, effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Confirm } from "../shell/Confirm.tsx";
import { Pill } from "../shell/Pill.tsx";
import { benchmark, benchmarksChanged, listen } from "../store.ts";
import { Run } from "./Run.tsx";
import { Runs } from "./Runs.tsx";
import { comparable, versus } from "./report.ts";
import { Scorecard } from "./Scorecard.tsx";
import { fetchRuns, runs, picked as ticked } from "./state.ts";
import "./benchmark.css";

// the run's id, not its progress: every turn replaces the progress object
const activeId = computed(() => benchmark.value?.benchmark.id ?? null);

// The list is read again whenever it can have changed: a run started or
// ended, in this tab, another one or a script, and every snapshot, which
// is what a tab gets when its socket comes back (a phone drops it when
// the screen locks, and the run's last message with it).
function useRuns() {
  useEffect(() => {
    const stop = effect(() => {
      benchmarksChanged.value;
      activeId.value;
      fetchRuns();
    });
    const unlisten = listen((message) => {
      if (message.type === "snapshot") fetchRuns();
    });
    return () => {
      stop();
      unlisten();
    };
  }, []);
}

export function BenchmarkRun() {
  useRuns();
  const [first, second] = ticked.value.map((id) =>
    runs.value.find((b) => b.id === id),
  );
  const hint =
    !first || !second
      ? "Tick two runs to compare."
      : comparable(first, second)
        ? versus(second, first)
        : "These two ran different workloads.";
  return (
    <>
      <div class="shead">
        <h2>Benchmark</h2>
        {/* the page's first head, which carries the connection on every page */}
        <Pill />
      </div>
      <Run />
      <div class="shead">
        <h2>Runs</h2>
        <span class="grow" />
        <span class="hint">{hint}</span>
      </div>
      <Runs />
      <Confirm />
    </>
  );
}

export function BenchmarkScorecard() {
  useRuns();
  return <Scorecard />;
}
