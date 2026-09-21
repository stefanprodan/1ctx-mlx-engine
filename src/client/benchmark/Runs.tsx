// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { BENCHMARK_PRESETS, type Benchmark } from "../../shared/benchmark.ts";
import { Close, Copy, Search, Trash } from "../icons.tsx";
import { busy } from "../store.ts";
import {
  COLUMNS,
  comparable,
  delta,
  deltaCopy,
  detailGroups,
  matching,
  modelName,
  noMatchCopy,
  report,
  statusCopy,
  statusDetail,
  tuningArgs,
  value,
} from "./report.ts";
import {
  details,
  fetchDetail,
  picked,
  removeRun,
  runPreset,
  runQuery,
  runs,
  togglePick,
} from "./state.ts";
import { Turns } from "./Turns.tsx";

const fmtDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const fmtTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function RunRow({
  run,
  baseline,
  open,
  onToggle,
}: {
  run: Benchmark;
  // the first ticked run, when this one is the second and they compare
  baseline: Benchmark | null;
  open: boolean;
  onToggle: () => void;
}) {
  const ticked = picked.value.includes(run.id);
  const note = statusCopy(run);
  const rowClass = [
    open ? "open" : "",
    run.status === "done" && run.suspect.length === 0 ? "" : "flagged",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <tr class={rowClass || undefined} onClick={onToggle}>
      <td class="run">
        {/* the grid lives inside: a cell that is a grid drops out of the row */}
        <div class="run-cell">
          <span class="chev" />
          <span class="name" title={run.model}>
            {modelName(run.model)}
          </span>
          <span class="meta">
            <span class="when">
              <span class="day">{fmtDay.format(run.startedAt)}, </span>
              {fmtTime.format(run.startedAt)}
            </span>
            <span class="preset">{run.preset}</span>
            {note && (
              <span
                class={`note ${run.status}`}
                title={statusDetail(run) ?? undefined}
              >
                {" "}
                · {note}
              </span>
            )}
          </span>
        </div>
      </td>
      {COLUMNS.map((column) => {
        const figure = run.summary?.[column.key];
        const change = baseline
          ? deltaCopy(delta(figure, baseline.summary?.[column.key]), column)
          : null;
        return (
          <td class={`num fig ${column.key}`} key={column.key}>
            {value(figure, column.unit)}
            {change && (
              <span class={`delta ${change.tone}`}>{change.text}</span>
            )}
          </td>
        );
      })}
      <td class="pick">
        <input
          type="checkbox"
          name={`compare-${run.id}`}
          aria-label="Compare"
          checked={ticked}
          disabled={run.status !== "done"}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(run.id)}
        />
      </td>
    </tr>
  );
}

function Detail({ run }: { run: Benchmark }) {
  const detail = details.value[run.id];
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!detail) return;
    void navigator.clipboard
      .writeText(report(detail.benchmark, detail.turns))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  };
  const why = statusDetail(run);
  const args = tuningArgs(run.engineArgs).join(" ");
  return (
    <tr class="detail">
      <td colSpan={COLUMNS.length + 2}>
        <div class="dpanel">
          <div class="dhead">
            <span class="dmodel">{run.model}</span>
            {run.quantization && <span class="dquant">{run.quantization}</span>}
          </div>
          {why && (
            <p class="dwhy">
              {run.error ? "Error" : "Suspect"}: {why}
            </p>
          )}
          <div class="dgroups">
            {detailGroups(run).map((group) => (
              <section class="dgroup" key={group.title}>
                <h3>{group.title}</h3>
                <dl>
                  {group.rows.map((row) => (
                    <div class="drow" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.value}
                        {row.unit && <span class="dim"> {row.unit}</span>}
                        {row.spread && <span class="dim"> {row.spread}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {args && (
            <div class="dargs">
              <h3>Engine arguments</h3>
              <code>{args}</code>
            </div>
          )}
        </div>
        {detail && detail.turns.length > 0 && <Turns turns={detail.turns} />}
        <div class="btns bench-foot">
          <button type="button" class="btn" disabled={!detail} onClick={copy}>
            <Copy />
            {copied ? "Copied" : "Copy report"}
          </button>
          <button
            type="button"
            class="btn danger"
            disabled={busy.value === "benchmark" && run.status === "running"}
            onClick={() => void removeRun(run.id)}
          >
            <Trash />
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

export function Runs() {
  const all = runs.value;
  const query = runQuery.value.trim();
  const preset = runPreset.value;
  const list = matching(all, query, preset);
  const [open, setOpen] = useState<number | null>(null);
  const [first, second] = picked.value;
  // the baseline stays one when a search hides its row
  const baseline = all.find((b) => b.id === first) ?? null;

  const toggle = (id: number) => {
    setOpen((current) => (current === id ? null : id));
    // one read while its run went on holds the turns it had then
    if (details.value[id]?.benchmark.status !== "done") fetchDetail(id);
  };

  return (
    <section class="card requests">
      {/* the card's head band, as 1ctx draws a list's search: shown while
          a search hides every row, with the table's head, so it stays */}
      <div class="runs-find" hidden={all.length === 0}>
        <label class="runs-q">
          <Search />
          <input
            type="search"
            name="run-search"
            placeholder="Search models"
            aria-label="Search models"
            autocomplete="off"
            spellcheck={false}
            value={runQuery.value}
            onInput={(e) => {
              runQuery.value = e.currentTarget.value;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") runQuery.value = "";
            }}
          />
          {/* ours, not the native one, which shows only with the focus */}
          <button
            type="button"
            class="runs-clear"
            aria-label="Clear search"
            hidden={query === ""}
            onClick={() => {
              runQuery.value = "";
            }}
          >
            <Close />
          </button>
        </label>
        <nav class="runs-presets" aria-label="Preset">
          {[null, ...BENCHMARK_PRESETS].map((p) => (
            <button
              type="button"
              key={p ?? "all"}
              class={p === preset ? "on" : undefined}
              aria-pressed={p === preset}
              onClick={() => {
                runPreset.value = p;
              }}
            >
              {p ?? "All"}
            </button>
          ))}
        </nav>
      </div>
      <table id="benchmarks" hidden={all.length === 0}>
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
          {list.map((run) => (
            <Fragment key={run.id}>
              <RunRow
                run={run}
                baseline={
                  run.id === second && baseline && comparable(run, baseline)
                    ? baseline
                    : null
                }
                open={open === run.id}
                onToggle={() => toggle(run.id)}
              />
              {open === run.id && <Detail run={run} />}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p class="blank" hidden={list.length > 0}>
        {all.length === 0 ? "No runs yet." : noMatchCopy(query, preset)}
      </p>
    </section>
  );
}
