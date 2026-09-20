// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// mlx-spy's own section: what is running, what it costs and the update
// line. Its job is always on the host serving this page, so it is gated
// by the manager's lock and never by where mlx-serve is.

import type { SpyState } from "../../shared/engine.ts";
import { DASH, duration, num } from "../format.ts";
import { Copy } from "../icons.tsx";
import { confirm } from "../shell/Confirm.tsx";
import { locked, restartSpy } from "./state.ts";

export const BREW_UPGRADE = "brew upgrade stefanprodan/tap/mlx-spy";

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
    ["Restart mlx-spy? The page reconnects when it is back."],
    "Restart",
  );
  if (ok) void restartSpy();
}

export function SpyHead({ spy, now }: { spy: SpyState | null; now: number }) {
  return (
    <div class="shead">
      <h2>mlx-spy</h2>
      {spy ? (
        <span class="pill live">up {duration(now - spy.startedAt)}</span>
      ) : (
        <span class="pill">connecting</span>
      )}
      <span class="grow" />
      <span class="btns">
        <button
          type="button"
          class="btn"
          disabled={!spy || locked.value}
          onClick={() => void onRestart()}
        >
          Restart
        </button>
      </span>
    </div>
  );
}

export function Spy({ spy }: { spy: SpyState | null }) {
  const offered = spy?.offered ?? null;
  return (
    <section class="card">
      <div class="facts">
        <dl>
          <dt>Version</dt>
          <dd class={spy ? undefined : "none"}>
            {spy?.version ?? DASH}
            {spy && <small>{spy.brew ? "from the tap" : "dev build"}</small>}
          </dd>
        </dl>
        <dl>
          <dt>Resources</dt>
          <Resources
            bytes={spy?.rssBytes ?? null}
            cpuPct={spy?.cpuPct ?? null}
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
