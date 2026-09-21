// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { BENCHMARK_PRESETS, type Benchmark } from "../../shared/benchmark.ts";
import { Copy, Trash } from "../icons.tsx";
import {
  GridCard,
  type GridColumn,
  GridDetail,
  GridFind,
  GridNote,
  GridRow,
  GridTable,
} from "../shell/Grid.tsx";
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

// a phone keeps the two rates; the opened row has the rest
const GRID: GridColumn[] = COLUMNS.map((c) => ({
  key: c.key,
  label: c.label,
  wide: c.key === "coldLatencyMs" || c.key === "warmPrefillTps",
}));

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
  const figures = Object.fromEntries(
    COLUMNS.map((column) => {
      const figure = run.summary?.[column.key];
      const change = baseline
        ? deltaCopy(delta(figure, baseline.summary?.[column.key]), column)
        : null;
      return [
        column.key,
        {
          value: value(figure, column.unit),
          under: change && (
            <span class={`delta ${change.tone}`}>{change.text}</span>
          ),
        },
      ];
    }),
  );
  return (
    <GridRow
      open={open}
      onToggle={onToggle}
      name={modelName(run.model)}
      title={run.model}
      flagged={run.status !== "done" || run.suspect.length > 0}
      columns={GRID}
      figures={figures}
      meta={
        <>
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
        </>
      }
      end={
        <input
          type="checkbox"
          name={`compare-${run.id}`}
          aria-label="Compare"
          checked={ticked}
          disabled={run.status !== "done"}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(run.id)}
        />
      }
    />
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
    <GridDetail
      span={COLUMNS.length + 2}
      name={run.model}
      tag={run.quantization}
      why={why && `${run.error ? "Error" : "Suspect"}: ${why}`}
      groups={detailGroups(run)}
      foot={
        <>
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
        </>
      }
    >
      {args && (
        <div class="dargs">
          <h3>Engine arguments</h3>
          <code>{args}</code>
        </div>
      )}
    </GridDetail>
  );
}

export function Runs() {
  const all = runs.value;
  const query = runQuery.value.trim();
  const preset = runPreset.value;
  const list = matching(all, query, preset);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [first, second] = picked.value;
  // the baseline stays one when a search hides its row
  const baseline = all.find((b) => b.id === first) ?? null;

  // a deleted run takes its open state with it
  useEffect(() => {
    const ids = new Set(all.map((b) => b.id));
    setOpen((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [all]);

  const toggle = (id: number) => {
    const opening = !open.has(id);
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // one read while its run went on holds the turns it had then
    if (opening && details.value[id]?.benchmark.status !== "done") {
      fetchDetail(id);
    }
  };

  return (
    <GridCard>
      <GridFind
        name="run-search"
        placeholder="Search models"
        query={runQuery.value}
        onQuery={(q) => {
          runQuery.value = q;
        }}
        filtersLabel="Preset"
        filters={[null, ...BENCHMARK_PRESETS].map((p) => ({
          label: p ?? "All",
          on: p === preset,
          onPick: () => {
            runPreset.value = p;
          },
        }))}
        hidden={all.length === 0}
      />
      <GridTable
        id="benchmarks"
        name="Model"
        columns={GRID}
        end
        hidden={all.length === 0}
      >
        {list.map((run) => (
          <Fragment key={run.id}>
            <RunRow
              run={run}
              baseline={
                run.id === second && baseline && comparable(run, baseline)
                  ? baseline
                  : null
              }
              open={open.has(run.id)}
              onToggle={() => toggle(run.id)}
            />
            {open.has(run.id) && <Detail run={run} />}
          </Fragment>
        ))}
      </GridTable>
      <GridNote hidden={list.length > 0}>
        {all.length === 0 ? "No runs yet." : noMatchCopy(query, preset)}
      </GridNote>
    </GridCard>
  );
}
