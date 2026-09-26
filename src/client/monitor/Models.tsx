// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per model: a state dot and the id split at its last slash, the
// size and context in dim text, the engine's state word, icon buttons.
// Activity is engine-wide (the engine does not say which model is busy)
// and lives in the section head, see Monitor.tsx.

import type { VNode } from "preact";
import type { ActionName } from "../../shared/actions.ts";
import {
  type Capability,
  isChat,
  type ModelInfo,
} from "../../shared/models.ts";
import type { Snapshot } from "../../shared/socket.ts";
import { modelSize, orderModels } from "../format.ts";
import { Trash } from "../icons.tsx";
import { context, kindTag } from "../models/spec.ts";
import { absent, busy, downloads, follow } from "../store.ts";
import { runAction } from "./actions.ts";
import { DownloadRow } from "./Download.tsx";
import { visibleDownloads } from "./download.ts";

const ICON = {
  play: "M5 3l9 5-9 5z",
  stop: "M4 4h8v8H4z",
  star: "M8 1.6l2 4.1 4.5.6-3.3 3.2.8 4.5L8 11.9l-4 2.1.8-4.5L1.5 6.3 6 5.7z",
};

function dotFor(state: string) {
  switch (state) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "evicting":
      return "evicting";
    case "error":
    case "failed":
      return "error";
    default:
      return "";
  }
}

function IconButton({
  label,
  glyph,
  icon,
  action,
  model,
  cls = "",
  disabled = false,
}: {
  label: string;
  glyph?: string;
  // an icon component for the buttons whose glyph is shared with another
  // table (the trash, which a download row has too)
  icon?: VNode;
  action: ActionName;
  model: string;
  cls?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      class={`ibtn ${cls}`.trim()}
      title={label}
      aria-label={label}
      disabled={disabled || busy.value !== null}
      onClick={() => void runAction(action, model)}
    >
      {icon ?? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={glyph} />
        </svg>
      )}
    </button>
  );
}

// Icon buttons with the action as tooltip and label: delete in the column
// the download rows put it in, the favorite star on every model, then load
// for an unloaded one or unload for a resident one. Delete is for a model
// on this host, and only while it is not resident: the weights are mapped
// into the engine until it is unloaded. A deleted model stays listed until
// the engine restarts (a rescan only adds), so its row keeps the buttons in
// place, disabled, the star included (the delete took the mark off).
function Buttons({
  m,
  can,
  local,
}: {
  m: ModelInfo;
  can: (c: Capability) => boolean;
  local: boolean;
}) {
  return (
    <td class="act">
      {local && (
        <IconButton
          label={
            m.deleted
              ? "Deleted"
              : m.loaded
                ? "Unload before deleting"
                : "Delete"
          }
          icon={<Trash />}
          action="delete"
          model={m.id}
          cls="trash danger"
          disabled={m.loaded || m.deleted}
        />
      )}
      {m.favorite ? (
        <IconButton
          label="Daily driver"
          glyph={ICON.star}
          action="favorite"
          model={m.id}
          cls="on"
        />
      ) : isChat(m) ? (
        <IconButton
          label={m.deleted ? "Deleted" : "Mark as daily driver"}
          glyph={ICON.star}
          action="favorite"
          model={m.id}
          disabled={m.deleted}
        />
      ) : (
        // the daily driver is a chat model; the column keeps its width
        <span class="ibtn-gap" />
      )}
      {m.loaded
        ? can("unload") && (
            <IconButton
              label="Unload"
              glyph={ICON.stop}
              action="unload"
              model={m.id}
              cls="danger"
            />
          )
        : can("load") && (
            <IconButton
              label={m.deleted ? "Deleted, gone at the next restart" : "Load"}
              glyph={ICON.play}
              action="load"
              model={m.id}
              disabled={m.deleted}
            />
          )}
    </td>
  );
}

export function Models({ snap }: { snap: Snapshot | null }) {
  const models = orderModels(snap?.models ?? []);
  const can = (c: Capability) => snap?.engine.capabilities.includes(c) ?? false;
  // the files are this host's, so a remote engine's models are not deletable
  const local = snap?.engine.local ?? false;
  // rows sit on top: a running one is the row that changes
  const rows = visibleDownloads(downloads.value, models);
  // the list is empty while the engine is unreachable (the sampler drops
  // it) or when it really lists nothing; one sentence either way
  const none =
    snap?.sample && !snap.sample.engineUp
      ? "Engine unreachable."
      : "No models found.";
  const blank = models.length === 0 && rows.length === 0;
  return (
    <section class="card models">
      <table id="models">
        <tbody>
          {rows.map((p) => (
            <DownloadRow key={`download-${p.id}`} p={p} />
          ))}
          {models.map((m) => {
            const slash = m.id.lastIndexOf("/");
            const facts = [
              modelSize(m.loaded ? m.bytesResident : m.bytesOnDisk),
            ];
            // the window the process serves, once /props has said it
            const ctx = m.runtime?.context ?? m.contextLength;
            if (ctx != null) facts.push(`${context(ctx)} ctx`);
            const kind = kindTag(m.capabilities);
            return (
              <tr
                key={m.id}
                class={m.loaded ? "ready" : m.deleted ? "deleted" : undefined}
              >
                <td class="name" title={m.id}>
                  <div>
                    <span class={`dot ${dotFor(m.state)}`} />
                    <span class="owner">
                      {slash > 0 ? `${m.id.slice(0, slash)}/` : ""}
                    </span>
                    {/* model ids are Hugging Face repo ids */}
                    <a
                      class="model"
                      href={`https://huggingface.co/${m.id}`}
                      target="_blank"
                      rel="noopener"
                    >
                      {m.id.slice(slash + 1)}
                    </a>
                    {kind && <span class="kind">{kind}</span>}
                  </div>
                </td>
                <td class="meta">{facts.join(" · ")}</td>
                <td
                  class={`state ${m.state}`}
                  title={
                    m.deleted
                      ? "Its files are gone. The engine drops it at the next restart."
                      : m.state === "error" && m.error
                        ? `Load failed: ${m.error}`
                        : undefined
                  }
                >
                  {m.state}
                </td>
                <Buttons m={m} can={can} local={local} />
              </tr>
            );
          })}
        </tbody>
      </table>
      {absent.value ? (
        // a bare host: the one sentence says what to do about it
        <p class="blank" hidden={!blank}>
          mlx-serve is not installed.{" "}
          <a href="/server" onClick={(e) => follow(e, "/server")}>
            Install
          </a>
        </p>
      ) : (
        <p class="blank" hidden={!blank}>
          {none}
        </p>
      )}
    </section>
  );
}
