// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The calls behind a download's buttons, for the Models page and the
// Overview's rows alike. The server owns the download; the rows follow
// the /ws download messages through the store, and a call's answer is
// applied at once so this tab does not wait for the push.

import { signal } from "@preact/signals";
import type { Download } from "../../shared/downloads.ts";
import { confirm } from "../shell/Confirm.tsx";
import { applyDownload, downloads } from "../store.ts";

// the last download that failed to start or to be controlled from this tab,
// for the event line
export const downloadError = signal<{
  t: number;
  repo: string;
  text: string;
} | null>(null);

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as
    | Download
    | { ok: true }
    | { error: string };
  if (!res.ok) {
    throw new Error((data as { error: string }).error ?? `HTTP ${res.status}`);
  }
  return data;
}

// null once the download is queued, else what the server refused it for
export async function startDownload(repo: string): Promise<string | null> {
  try {
    applyDownload((await call("/api/downloads", "POST", { repo })) as Download);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function controlDownload(
  p: Download,
  what: "cancel" | "retry" | "remove",
) {
  try {
    if (what === "cancel") {
      applyDownload(
        (await call(`/api/downloads/${p.id}/cancel`, "POST", {})) as Download,
      );
    } else if (what === "retry") {
      applyDownload(
        (await call("/api/downloads", "POST", { repo: p.repo })) as Download,
      );
    } else {
      // the files go too, whatever the state: a delete is a delete
      const a = await confirm(
        ["Are you sure you want to delete ", { code: p.repo }, "?"],
        "Delete",
      );
      if (!a.ok) return;
      await call(`/api/downloads/${p.id}`, "DELETE");
      downloads.value = downloads.value.filter((x) => x.id !== p.id);
    }
  } catch (err) {
    downloadError.value = {
      t: Date.now(),
      repo: p.repo,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}
