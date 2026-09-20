// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import type { Benchmark } from "../../shared/benchmark.ts";
import { DASH, sizeText } from "../format.ts";
import { Copy, Trash } from "../icons.tsx";
import { busy } from "../store.ts";
import {
  COLUMNS,
  comparable,
  delta,
  deltaCopy,
  modelName,
  report,
  statusCopy,
  statusDetail,
  value,
} from "./report.ts";
import {
  details,
  fetchDetail,
  picked,
  removeRun,
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
      <td class="pick">
        <input
          type="checkbox"
          name={`compare-${run.id}`}
          aria-label="Compare"
          checked={ticked}
          disabled={run.summary === null}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(run.id)}
        />
      </td>
      <td class="run">
        {/* the grid lives inside: a cell that is a grid drops out of the row */}
        <div class="run-cell">
          <span class="chev" />
          <span class="name" title={run.model}>
            {modelName(run.model)}
          </span>
          <span class="meta">
            <span class="day">{fmtDay.format(run.startedAt)}, </span>
            {fmtTime.format(run.startedAt)}
            <span class="preset"> · {run.preset}</span>
            {note && (
              <span class="note" title={statusDetail(run) ?? undefined}>
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
  const s = run.summary;
  const facts: [string, string][] = [
    ["Model", run.model + (run.quantization ? ` (${run.quantization})` : "")],
    ["Context", s?.contextTokens ? `${s.contextTokens} tokens` : DASH],
    ["Engine", `mlx-serve ${run.engineVersion ?? DASH}`],
    ["Preset", `${run.preset}, ${run.turns} turns x ${run.repetitions}`],
    ["Cache", value(s?.cachePct, "%")],
    ["Warm latency", value(s?.warmLatencyMs, "ms")],
    ["Decode, first turn", value(s?.decodeFirstTps, "tok/s")],
    ["Decode, last turn", value(s?.decodeLastTps, "tok/s")],
    [
      "Spread",
      s?.decodeTps.spreadPct == null
        ? DASH
        : `±${s.decodeTps.spreadPct.toFixed(1)}% decode`,
    ],
    [
      "Memory, peak",
      run.peakMemoryBytes ? sizeText(run.peakMemoryBytes) : DASH,
    ],
    [
      "MLX active, peak",
      run.peakActiveBytes ? sizeText(run.peakActiveBytes) : DASH,
    ],
    ["Script", run.scriptHash],
  ];
  const why = statusDetail(run);
  if (why) facts.splice(1, 0, [run.error ? "Error" : "Suspect", why]);
  return (
    <tr class="detail">
      <td colSpan={COLUMNS.length + 2}>
        <div class="dgrid">
          {facts.map(([label, text]) => (
            <div class="d" key={label}>
              <span class="k">{label}</span>
              <span class="v">{text}</span>
            </div>
          ))}
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
  const list = runs.value;
  const [open, setOpen] = useState<number | null>(null);
  const [first, second] = picked.value;
  const baseline = list.find((b) => b.id === first) ?? null;

  const toggle = (id: number) => {
    setOpen((current) => (current === id ? null : id));
    if (!details.value[id]) fetchDetail(id);
  };

  return (
    <section class="card requests">
      <table id="benchmarks" hidden={list.length === 0}>
        <thead>
          <tr>
            <th class="pick" />
            <th class="run">Model</th>
            {COLUMNS.map((column) => (
              <th class={`fig ${column.key}`} key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((run) => (
            <>
              <RunRow
                key={run.id}
                run={run}
                baseline={
                  run.id === second && baseline && comparable(run, baseline)
                    ? baseline
                    : null
                }
                open={open === run.id}
                onToggle={() => toggle(run.id)}
              />
              {open === run.id && <Detail key={`d${run.id}`} run={run} />}
            </>
          ))}
        </tbody>
      </table>
      <p class="blank" hidden={list.length > 0}>
        No runs yet.
      </p>
    </section>
  );
}
