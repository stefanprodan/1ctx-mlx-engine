// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { BENCHMARK_PRESETS } from "../../shared/benchmark.ts";
import { Pill } from "../shell/Pill.tsx";
import { models, snapshot } from "../store.ts";
import { COLUMNS, modelName, statusCopy, value } from "./report.ts";
import { Scatter } from "./Scatter.tsx";
import { dots } from "./scatter.ts";
import { scorecard } from "./scorecard.ts";
import { runs, runsLoaded, scorePreset } from "./state.ts";
import "./scorecard.css";

// Which model is fastest at a preset, without reading the runs table: the
// newest finished run of each model the engine lists, ranked by decode, a
// bar under each figure for how close it comes to the best.
export function Scorecard() {
  const preset = scorePreset.value;
  const present = new Set(models.value.map((m) => m.id));
  const rows = scorecard(runs.value, preset, present);
  const plotted = dots(
    rows.map((r) => r.run),
    [...present],
  );
  return (
    <>
      <div class="shead">
        <h2>Scorecard</h2>
        {/* the page's first head, which carries the connection on every page */}
        <Pill />
        <span class="grow" />
        <div class="seg">
          {BENCHMARK_PRESETS.map((p) => (
            <button
              type="button"
              key={p}
              class={p === preset ? "active" : undefined}
              onClick={() => {
                scorePreset.value = p;
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <section class="card requests">
        <table id="scorecard" hidden={rows.length === 0}>
          <thead>
            <tr>
              <th class="run">Model</th>
              {COLUMNS.map((column) => (
                <th class={`fig ${column.key}`} key={column.key}>
                  {column.label}
                </th>
              ))}
              <th class="pick" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, rank, cells }) => {
              const note = statusCopy(run);
              return (
                <tr key={run.id}>
                  <td class="run">
                    <span class="rank">{rank ?? ""}</span>
                    <span class="name" title={run.model}>
                      {modelName(run.model)}
                    </span>
                    {note && <span class="note"> · {note}</span>}
                  </td>
                  {cells.map((cell, c) => (
                    <td
                      class={`num fig ${cell.key}${cell.best ? " best" : ""}`}
                      key={cell.key}
                    >
                      {value(run.summary?.[cell.key], COLUMNS[c]!.unit)}
                      <span class="track">
                        <span
                          class="fill"
                          style={{ width: `${(cell.share ?? 0) * 100}%` }}
                        />
                      </span>
                    </td>
                  ))}
                  <td class="pick" />
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* kept in its place but unsaid until the runs and the models are
            both known: before that it would say nothing ran */}
        <p
          class={`blank${runsLoaded.value && snapshot.value ? "" : " unknown"}`}
          hidden={rows.length > 0}
        >
          No models with a run at {preset}.
        </p>
      </section>
      {plotted.length > 0 && (
        <>
          <div class="shead">
            <h2>Wait and decode</h2>
          </div>
          <Scatter dots={plotted} />
        </>
      )}
    </>
  );
}
