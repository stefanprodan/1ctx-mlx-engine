// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { LastRequest } from "../../shared/requests.ts";
import { api } from "../api.ts";
import { Trash } from "../icons.tsx";
import { runAction } from "../monitor/actions.ts";
import { RequestBar } from "../monitor/RequestBar.tsx";
import { Confirm } from "../shell/Confirm.tsx";
import {
  GridCard,
  type GridColumn,
  GridDetail,
  GridFind,
  GridNote,
  GridRow,
  GridTable,
} from "../shell/Grid.tsx";
import { Pill } from "../shell/Pill.tsx";
import { busy, listen, snapshot } from "../store.ts";
import {
  figures,
  matchingRequests,
  noRequestsCopy,
  OUTCOMES,
  type Outcome,
  outcomeLabel,
  requestGroups,
  requestTag,
  requestWhy,
  sizeLine,
} from "./list.ts";
import "./requests.css";

const fmtStamp = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const clock = (t: number) => fmtStamp.format(t);

// the runs' shape: the latency, then the two rates; a phone keeps the
// rates and the opened row has the rest
const COLUMNS: GridColumn[] = [
  { key: "ttft", label: "TTFT", wide: true },
  { key: "prefill", label: "Prefill" },
  { key: "decode", label: "Decode" },
];

const REQUESTS_SHOWN = 50;
// A completion and a cancellation can share a finish time, so the pair is
// the identity used by the server-backed list and the open-row state.
export const requestKey = (request: LastRequest) =>
  `${request.finishedAt}:${request.cancelled ? 1 : 0}`;
export const requests = signal<LastRequest[]>([]);
export const requestQuery = signal("");
export const requestOutcome = signal<Outcome | null>(null);

function fetchRequests() {
  void api<LastRequest[]>("/api/requests")
    .then((list) => {
      requests.value = list;
    })
    .catch(() => {});
}

// A sample can race the list fetch. Merge by identity and finish order so it
// cannot duplicate or misplace the newly finished request.
function noteRequest(last: LastRequest | null) {
  if (!last) return;
  const key = requestKey(last);
  if (requests.value.some((request) => requestKey(request) === key)) return;
  requests.value = [last, ...requests.value]
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, REQUESTS_SHOWN);
}

export function Requests() {
  const list = requests.value;
  const action = busy.value;
  const query = requestQuery.value;
  const outcome = requestOutcome.value;
  const shown = matchingRequests(list, query, outcome);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    document.title = "1ctx-mlx-engine · requests";
    // connect() runs after render, but an exceptionally fast first message
    // can still beat an effect scheduled after paint.
    if (snapshot.value) fetchRequests();
    return listen((message) => {
      if (message.type === "snapshot") {
        fetchRequests();
      } else if (message.type === "sample") {
        noteRequest(message.data.lastRequest);
      } else if (
        message.type === "event" &&
        message.data.ok &&
        (message.data.action === "requestsClear" ||
          message.data.action === "historyClear")
      ) {
        requests.value = [];
        setOpen(new Set());
      }
    });
  }, []);

  // Rows that age out or are wiped take their disclosure state with them.
  useEffect(() => {
    const keys = new Set(list.map(requestKey));
    setOpen((current) => {
      const next = new Set([...current].filter((key) => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [list]);

  const toggle = (key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div class="shead">
        <h2>Requests</h2>
        <Pill />
      </div>
      <section class="card" id="requests-live">
        <RequestBar />
      </section>
      <div class="shead">
        <h2>History</h2>
        <span class="grow" />
        <div class="seg">
          <button
            type="button"
            class="trash"
            title="Clear requests"
            aria-label="Clear requests"
            disabled={action !== null}
            onClick={() => void runAction("requestsClear", null)}
          >
            <Trash />
          </button>
        </div>
      </div>
      <GridCard>
        <GridFind
          name="request-search"
          placeholder="Search models"
          query={query}
          onQuery={(q) => {
            requestQuery.value = q;
          }}
          filtersLabel="Outcome"
          filters={OUTCOMES.map((o) => ({
            label: outcomeLabel(o),
            on: o === outcome,
            onPick: () => {
              requestOutcome.value = o;
            },
          }))}
          hidden={list.length === 0}
        />
        <GridTable
          id="requests"
          name="Model"
          columns={COLUMNS}
          hidden={list.length === 0}
        >
          {shown.map((request) => {
            const key = requestKey(request);
            const f = figures(request);
            return (
              <Fragment key={key}>
                <GridRow
                  open={open.has(key)}
                  onToggle={() => toggle(key)}
                  name={request.model?.split("/").pop() ?? "unknown"}
                  title={request.model ?? undefined}
                  flagged={request.cancelled}
                  columns={COLUMNS}
                  figures={{
                    ttft: { value: f.ttft },
                    prefill: { value: f.prefill },
                    decode: { value: f.decode },
                  }}
                  meta={
                    <>
                      {clock(request.finishedAt)}
                      {request.count > 1 && ` ×${request.count}`}
                      {sizeLine(request)}
                      {request.cancelled && (
                        <span class="note"> · cancelled</span>
                      )}
                    </>
                  }
                />
                {open.has(key) && (
                  <GridDetail
                    span={COLUMNS.length + 1}
                    name={request.model ?? "unknown model"}
                    tag={requestTag(request)}
                    why={requestWhy(request)}
                    groups={requestGroups(request, clock)}
                  />
                )}
              </Fragment>
            );
          })}
        </GridTable>
        <GridNote hidden={shown.length > 0}>
          {list.length === 0
            ? "No requests yet."
            : noRequestsCopy(query, outcome)}
        </GridNote>
      </GridCard>
      <Confirm />
    </>
  );
}
