// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Benchmark page: run a scripted agent session against a model and
// compare the runs. It measures the engine, never the answers.

import { effect } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Confirm } from "../shell/Confirm.tsx";
import { Pill } from "../shell/Pill.tsx";
import { benchmarksEnded } from "../store.ts";
import { Run } from "./Run.tsx";
import { Runs } from "./Runs.tsx";
import { comparable } from "./report.ts";
import { fetchRuns, runs, picked as ticked } from "./state.ts";
import "./benchmark.css";

export function Benchmark() {
  // read again whenever a run ends, in this tab or another
  useEffect(
    () =>
      effect(() => {
        benchmarksEnded.value;
        fetchRuns();
      }),
    [],
  );

  const [first, second] = ticked.value.map((id) =>
    runs.value.find((b) => b.id === id),
  );
  const hint =
    !first || !second
      ? "Tick two runs to compare."
      : comparable(first, second)
        ? "The second ticked run against the first."
        : "These two ran different workloads.";
  return (
    <>
      <div class="shead">
        <h2>Benchmark</h2>
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
