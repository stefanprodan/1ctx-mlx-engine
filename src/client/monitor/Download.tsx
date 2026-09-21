// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rows the Overview's models table shows while a download is queued,
// running, stopped or waiting to be listed. Downloads start on the Models
// page; the calls are models/downloads.ts.

import type { Download } from "../../shared/downloads.ts";
import { Trash } from "../icons.tsx";
import { controlDownload } from "../models/downloads.ts";
import {
  downloadDot,
  downloadMeta,
  downloadPct,
  downloadState,
} from "./download.ts";

const ICON = {
  play: "M5 3l9 5-9 5z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
};

function Icon({
  label,
  glyph,
  cls = "",
  onClick,
}: {
  label: string;
  glyph: string;
  cls?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`ibtn ${cls}`.trim()}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={glyph} />
      </svg>
    </button>
  );
}

// One row per download, shaped like a model row: the dot, the id, the bytes
// and speed, the state, the buttons; a bar under the id while it runs.
export function DownloadRow({ p }: { p: Download }) {
  const slash = p.repo.lastIndexOf("/");
  const active = p.status === "queued" || p.status === "running";
  return (
    <tr class={`download ${p.status}`} title={p.error ?? undefined}>
      <td class="name" title={p.file ? `${p.repo}: ${p.file}` : p.repo}>
        <div>
          <span class={`dot ${downloadDot(p)}`} />
          <span class="owner">{p.repo.slice(0, slash + 1)}</span>
          <a
            class="model"
            href={`https://huggingface.co/${p.repo}`}
            target="_blank"
            rel="noopener"
          >
            {p.repo.slice(slash + 1)}
          </a>
        </div>
        <div class="bar" hidden={p.status !== "running"}>
          <span class="fill" style={{ width: `${downloadPct(p)}%` }} />
        </div>
      </td>
      <td class="meta">{downloadMeta(p)}</td>
      <td class={`state ${p.status}`}>{downloadState(p)}</td>
      <td class="act">
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
          <Icon
            label="Pause"
            glyph={ICON.pause}
            onClick={() => void controlDownload(p, "cancel")}
          />
        ) : (
          p.status !== "done" && (
            <Icon
              label="Resume"
              glyph={ICON.play}
              onClick={() => void controlDownload(p, "retry")}
            />
          )
        )}
      </td>
    </tr>
  );
}
