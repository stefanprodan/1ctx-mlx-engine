// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Models page: the form that downloads a repo from the Hugging Face
// Hub with the downloads under it, then every model the engine lists on
// the grid, a row opening to what the engine and the checkpoint say of it,
// with the buttons the Overview's models card has.

import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ActionName } from "../../shared/actions.ts";
import type { Download } from "../../shared/downloads.ts";
import { type Capability, isChat } from "../../shared/models.ts";
import { sizeText } from "../format.ts";
import { DownloadIcon, Trash } from "../icons.tsx";
import { runAction } from "../monitor/actions.ts";
import { visibleDownloads } from "../monitor/download.ts";
import { Event } from "../monitor/Event.tsx";
import {
  GridCard,
  type GridColumn,
  GridDetail,
  GridFind,
  GridNote,
  GridRow,
  GridTable,
} from "../shell/Grid.tsx";
import {
  absent,
  busy,
  connected,
  downloads,
  follow,
  listen,
  models,
  sample,
  snapshot,
} from "../store.ts";
import { controlDownload, startDownload } from "./downloads.ts";
import { modelGroups } from "./groups.ts";
import {
  capabilityTags,
  downloadLine,
  downloadPct,
  type Filter,
  figures,
  filterLabel,
  filtersFor,
  joinRows,
  kindTag,
  type ModelRow,
  matchingModels,
  metaLine,
  modelName,
  modelOwner,
  quant,
} from "./spec.ts";
import { fetchSpecs, specs } from "./state.ts";
import "./models.css";

const COLUMNS: GridColumn[] = [
  { key: "params", label: "Params", wide: true },
  { key: "context", label: "Context" },
  { key: "size", label: "Size" },
];

const GLYPH = {
  play: "M5 3l9 5-9 5z",
  stop: "M4 4h8v8H4z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
  star: "M8 1.6l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.9l-4 2.1.8-4.5L1.5 6.3 6 5.7z",
};

const modelQuery = signal("");
const modelFilter = signal<Filter>("all");

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);

function DownloadForm() {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const repo = text.trim();
    if (repo === "" || sending) return;
    setSending(true);
    const refused = await startDownload(repo);
    setSending(false);
    setError(refused ?? "");
    if (refused === null) setText("");
  };
  return (
    <form class="dl-form" onSubmit={(e) => void submit(e)}>
      <label class="dl-field">
        <span class="lbl">Repository</span>
        <input
          type="text"
          name="repo"
          placeholder="owner/name or huggingface.co URL"
          autocomplete="off"
          spellcheck={false}
          value={text}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError("");
          }}
        />
      </label>
      <button
        type="submit"
        class="btn primary"
        disabled={text.trim() === "" || sending}
      >
        <DownloadIcon />
        Download
      </button>
      {error && (
        <p class="dl-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

const DOT: Partial<Record<Download["status"], string>> = {
  running: "loading",
  failed: "error",
  done: "ready",
};

function DownloadLine({ p }: { p: Download }) {
  const line = downloadLine(p);
  const active = p.status === "queued" || p.status === "running";
  return (
    <li class={`dl-row ${p.status}`}>
      <div class="dl-name" title={p.file ? `${p.repo}: ${p.file}` : p.repo}>
        <span class={`dot ${DOT[p.status] ?? ""}`} />
        <span class="owner">{modelOwner(p.repo)}/</span>
        <a
          class="model"
          href={`https://huggingface.co/${p.repo}`}
          target="_blank"
          rel="noopener"
        >
          {modelName(p.repo)}
        </a>
      </div>
      <span class="dl-meta" title={line.meta || undefined}>
        {line.meta}
      </span>
      <span class="dl-end">{line.end}</span>
      <span class="dl-act">
        <button
          type="button"
          class="ibtn trash danger"
          title="Delete"
          aria-label="Delete"
          onClick={() => void controlDownload(p, "remove")}
        >
          <Trash />
        </button>
        {active ? (
          <button
            type="button"
            class="ibtn"
            title="Pause"
            aria-label="Pause"
            onClick={() => void controlDownload(p, "cancel")}
          >
            <Glyph d={GLYPH.pause} />
          </button>
        ) : (
          p.status !== "done" && (
            <button
              type="button"
              class="ibtn"
              title="Resume"
              aria-label="Resume"
              onClick={() => void controlDownload(p, "retry")}
            >
              <Glyph d={GLYPH.play} />
            </button>
          )
        )}
      </span>
      <div class="bar" hidden={p.status !== "running"}>
        <span class="fill" style={{ width: `${downloadPct(p)}%` }} />
      </div>
    </li>
  );
}

// The opened row's buttons, under the Overview's rules: delete for a model
// on this host that is not resident, the star, then load or unload as the
// engine allows. A deleted model keeps its buttons, disabled.
function Foot({ row }: { row: ModelRow }) {
  const m = row.info;
  const snap = snapshot.value;
  const can = (c: Capability) => snap?.engine.capabilities.includes(c) ?? false;
  const local = snap?.engine.local ?? false;
  const off = busy.value !== null;
  const run = (action: ActionName) => () => void runAction(action, m.id);
  return (
    <div class="btns model-foot">
      <a
        class="btn"
        href={`https://huggingface.co/${m.id}`}
        target="_blank"
        rel="noopener"
      >
        Model card
      </a>
      <span class="grow" />
      {local && (
        <button
          type="button"
          class="btn danger"
          disabled={off || m.loaded || m.deleted}
          title={
            m.deleted
              ? "Deleted"
              : m.loaded
                ? "Unload before deleting"
                : undefined
          }
          onClick={run("delete")}
        >
          <Trash />
          Delete
        </button>
      )}
      {/* the daily driver is a chat model; a star set before still comes off */}
      {(isChat(m) || m.favorite) && (
        <button
          type="button"
          class={`btn${m.favorite ? " fav" : ""}`}
          disabled={off || (m.deleted && !m.favorite)}
          onClick={run("favorite")}
        >
          <Glyph d={GLYPH.star} />
          {m.favorite ? "Daily driver" : "Mark as daily driver"}
        </button>
      )}
      {m.loaded
        ? can("unload") && (
            <button
              type="button"
              class="btn danger"
              disabled={off}
              onClick={run("unload")}
            >
              <Glyph d={GLYPH.stop} />
              Unload
            </button>
          )
        : can("load") && (
            <button
              type="button"
              class="btn primary"
              disabled={off || m.deleted}
              title={
                m.deleted ? "Deleted, gone at the next restart" : undefined
              }
              onClick={run("load")}
            >
              <Glyph d={GLYPH.play} />
              Load
            </button>
          )}
    </div>
  );
}

function Detail({ row }: { row: ModelRow }) {
  const s = row.spec;
  const tags = capabilityTags(s);
  // the list's rows change only with the residency picture; the runtime
  // /props states moves with memory, so it is read off the live sample
  const runtime =
    sample.value?.models.find((m) => m.id === s.id)?.runtime ?? null;
  return (
    <GridDetail
      span={COLUMNS.length + 1}
      name={s.id}
      tag={quant(s)}
      groups={modelGroups(s, runtime)}
      foot={<Foot row={row} />}
    >
      {(tags.length > 0 || s.inputs.length > 0) && (
        <div class="mcaps">
          <h3>Capabilities</h3>
          <div class="mtags">
            {tags.map((c) => (
              <span class="mtag" key={c}>
                {c}
              </span>
            ))}
            {tags.length > 0 && s.inputs.length > 0 && <span class="msep" />}
            {s.inputs.map((i) => (
              <span class="mtag input" key={i}>
                {i}
              </span>
            ))}
          </div>
        </div>
      )}
    </GridDetail>
  );
}

export function Models() {
  const live = models.value;
  const all = joinRows(live, specs.value);
  const query = modelQuery.value;
  const filter = modelFilter.value;
  const shown = matchingModels(all, query, filter);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // The list changes only when its picture does (a load, a delete, the
  // rescan after a download), and each change asks for the specs again,
  // as does a download that finished: it may have replaced the files of
  // a model already listed. A snapshot reads them again (the server came
  // back), unless it is the socket's first, which the list change covers.
  const done = downloads.value.filter((d) => d.status === "done").length;
  useEffect(() => {
    // before the socket's first snapshot the list is empty: its arrival
    // is the read
    if (connected.value) fetchSpecs();
  }, [live, done]);
  useEffect(() => {
    let first = !connected.value;
    return listen((msg) => {
      if (msg.type !== "snapshot") return;
      if (!first) fetchSpecs();
      first = false;
    });
  }, []);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // a deleted model is listed until the engine restarts, but not on disk
  const onDisk = live.filter((m) => !m.deleted);
  const total = onDisk.reduce((n, m) => n + m.bytesOnDisk, 0);
  const rows = visibleDownloads(downloads.value, live);
  const snap = snapshot.value;
  // the line in the card when no row shows, one sentence for each reason
  const none =
    all.length > 0
      ? "No models match."
      : snap?.sample && !snap.sample.engineUp
        ? "Engine unreachable."
        : "No models yet.";
  return (
    <>
      <div class="shead">
        <h2>Download</h2>
      </div>
      <section class="card dl-card">
        <DownloadForm />
        {rows.length > 0 && (
          <ul class="dl-list">
            {rows.map((p) => (
              <DownloadLine key={p.id} p={p} />
            ))}
          </ul>
        )}
      </section>
      <div class="shead">
        <h2>Models</h2>
        {onDisk.length > 0 && (
          <span class="hint">
            {onDisk.length} on disk · {sizeText(total)}
          </span>
        )}
      </div>
      <GridCard>
        <GridFind
          name="model-search"
          placeholder="Search models"
          query={query}
          onQuery={(q) => {
            modelQuery.value = q;
          }}
          filtersLabel="Filters"
          filters={filtersFor(all).map((f) => ({
            label: filterLabel(f),
            on: f === filter,
            onPick: () => {
              modelFilter.value = f;
            },
          }))}
          hidden={all.length === 0}
        />
        <GridTable
          id="model-list"
          name="Model"
          columns={COLUMNS}
          hidden={all.length === 0}
        >
          {shown.map((row) => {
            const { info, spec } = row;
            const f = figures(spec);
            const meta = metaLine(row);
            return (
              <Fragment key={info.id}>
                <GridRow
                  open={open.has(info.id)}
                  onToggle={() => toggle(info.id)}
                  name={modelName(info.id)}
                  title={info.id}
                  columns={COLUMNS}
                  figures={{
                    params: { value: f.params },
                    context: { value: f.context },
                    size: { value: f.size },
                  }}
                  meta={
                    <>
                      {info.favorite && (
                        <span class="mfav" title="Daily driver">
                          <Glyph d={GLYPH.star} />
                        </span>
                      )}
                      {kindTag(info.capabilities) && (
                        <>
                          <span class="mkind">
                            {kindTag(info.capabilities)}
                          </span>{" "}
                        </>
                      )}
                      {meta.text}
                      {meta.state && (
                        <span class={`mstate ${meta.state.tone}`}>
                          {" "}
                          · {meta.state.word}
                        </span>
                      )}
                    </>
                  }
                />
                {open.has(info.id) && <Detail row={row} />}
              </Fragment>
            );
          })}
        </GridTable>
        {absent.value && all.length === 0 ? (
          <GridNote>
            mlx-serve is not installed.{" "}
            <a href="/server" onClick={(e) => follow(e, "/server")}>
              Install
            </a>
          </GridNote>
        ) : (
          <GridNote hidden={shown.length > 0}>{none}</GridNote>
        )}
      </GridCard>
      <Event />
    </>
  );
}
