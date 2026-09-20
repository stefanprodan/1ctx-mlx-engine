// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// 1ctx-mlx-engine's own section: what is running, what it costs and the update
// line. Its job is always on the host serving this page, so it is gated
// by the manager's lock and never by where mlx-serve is.

import type { SelfState } from "../../shared/engine.ts";
import { DASH, duration, num } from "../format.ts";
import { Copy } from "../icons.tsx";
import { confirm } from "../shell/Confirm.tsx";
import { locked, restartSelf } from "./state.ts";

export const BREW_UPGRADE = "brew upgrade stefanprodan/tap/1ctx-mlx-engine";

const mem = (bytes: number) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GB`
    : `${Math.round(bytes / 2 ** 20)} MB`;

export function Resources({
  bytes,
  cpuPct,
}: {
  bytes: number | null;
  cpuPct: number | null;
}) {
  if (bytes === null && cpuPct === null) return <dd class="none">{DASH}</dd>;
  return (
    <dd class="mono">
      {bytes === null ? DASH : mem(bytes)} <small>MEM</small> /{" "}
      {cpuPct === null ? DASH : `${num(cpuPct, 1)}%`} <small>CPU</small>
    </dd>
  );
}

async function onRestart() {
  const { ok } = await confirm(
    ["Restart 1ctx-mlx-engine? The page reconnects when it is back."],
    "Restart",
  );
  if (ok) void restartSelf();
}

export function SelfHead({
  self,
  now,
}: {
  self: SelfState | null;
  now: number;
}) {
  return (
    <div class="shead">
      <h2>1ctx-mlx-engine</h2>
      {self ? (
        <span class="pill live">up {duration(now - self.startedAt)}</span>
      ) : (
        <span class="pill">connecting</span>
      )}
      <span class="grow" />
      <span class="btns">
        <button
          type="button"
          class="btn"
          disabled={!self || locked.value}
          onClick={() => void onRestart()}
        >
          Restart
        </button>
      </span>
    </div>
  );
}

export function Self({ self }: { self: SelfState | null }) {
  const offered = self?.offered ?? null;
  return (
    <section class="card">
      <div class="facts">
        <dl>
          <dt>Version</dt>
          <dd class={self ? undefined : "none"}>
            {self?.version ?? DASH}
            {self && <small>{self.brew ? "from the tap" : "dev build"}</small>}
          </dd>
        </dl>
        <dl>
          <dt>Resources</dt>
          <Resources
            bytes={self?.rssBytes ?? null}
            cpuPct={self?.cpuPct ?? null}
          />
        </dl>
      </div>
      {offered && (
        <div class="notice">
          <span class="what">Update available</span>
          <span class="ver">{offered.tag}</span>
          <span class="grow" />
          <code class="cmd">{BREW_UPGRADE}</code>
          <button
            type="button"
            class="ibtn"
            title="Copy"
            aria-label="Copy the brew command"
            onClick={() => void navigator.clipboard?.writeText(BREW_UPGRADE)}
          >
            <Copy />
          </button>
        </div>
      )}
    </section>
  );
}
