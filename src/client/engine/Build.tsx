// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mlx-serve card: the build on the left, the running service on the
// right, and one row under them that is a release, an operation or a
// failure. The row keeps its place in every state so the card's shape
// does not depend on what there is to offer.

import type { EngineState } from "../../shared/engine.ts";
import type { Sample } from "../../shared/sample.ts";
import { DASH } from "../format.ts";
import { Lock } from "../icons.tsx";
import { confirm } from "../shell/Confirm.tsx";
import { Progress } from "./Progress.tsx";
import { idleLine, isStopped, releaseNote } from "./release.ts";
import { Resources } from "./Self.tsx";
import {
  check,
  dismiss,
  footError,
  install,
  locked,
  rollback,
  setPreReleases,
  upgrade,
} from "./state.ts";

const None = () => <dd class="none">{DASH}</dd>;

async function onUpgrade(tag: string, version: string) {
  const { ok } = await confirm(
    [
      `Upgrade mlx-serve to ${version}? It keeps serving during the download, then restarts. The first request after it comes back cold-loads.`,
    ],
    "Upgrade",
  );
  if (ok) void upgrade(tag);
}

async function onRollback(version: string) {
  const { ok } = await confirm(
    [
      `Roll mlx-serve back to ${version}? It restarts, and the build it leaves is removed.`,
    ],
    "Rollback",
  );
  if (ok) void rollback();
}

function PreReleases({ engine }: { engine: EngineState }) {
  return (
    <label class="flag pre">
      <input
        type="checkbox"
        name="preReleases"
        class="box"
        checked={engine.preReleases}
        disabled={locked.value}
        onChange={(ev) => void setPreReleases(ev.currentTarget.checked)}
      />
      <span>include pre-releases</span>
    </label>
  );
}

function Failed({ engine }: { engine: EngineState }) {
  const f = engine.failure;
  if (!f) return null;
  const tag = f.tag;
  // only what a tag can restart; an Apply is retried from the form
  const retry =
    tag === null
      ? null
      : f.kind === "upgrade"
        ? () => upgrade(tag)
        : f.kind === "install"
          ? () => install(tag)
          : null;
  const what = f.tag ? `${f.kind} to ${f.tag.replace(/^v/, "")}` : f.kind;
  return (
    <div class="notice bad" role="alert">
      <span class="what">
        {what.charAt(0).toUpperCase() + what.slice(1)} failed
      </span>
      <span class="meta">{f.outcome}</span>
      <span class="grow" />
      <span class="btns">
        <button
          type="button"
          class="btn"
          disabled={locked.value}
          onClick={() => void dismiss()}
        >
          Dismiss
        </button>
        {retry && (
          <button
            type="button"
            class="btn"
            disabled={locked.value}
            onClick={() => void retry()}
          >
            Try again
          </button>
        )}
      </span>
      <div class="why">{f.message}</div>
      {f.logTail && <pre class="tail">{f.logTail}</pre>}
    </div>
  );
}

// A refused form answers in its foot, a screen below this button.
async function onInstall(tag: string) {
  await install(tag);
  if (footError.value) {
    document
      .getElementById("install-why")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function ReleaseRow({ engine }: { engine: EngineState }) {
  const managed = engine.mode === "managed";
  const r = engine.offered;
  if (!r) {
    return (
      <div class="notice">
        <span class="what">{idleLine(engine.check, managed)}</span>
        {engine.check.error && <span class="meta">{engine.check.error}</span>}
        <span class="grow" />
        <PreReleases engine={engine} />
        <span class="btns">
          <button
            type="button"
            class="btn"
            disabled={locked.value}
            onClick={() => void check()}
          >
            Check now
          </button>
        </span>
      </div>
    );
  }
  return (
    <div class="notice">
      <span class="what">
        {managed ? "Update available" : "Latest release"}
      </span>
      <span class="ver">{r.version}</span>
      <span class="meta">{releaseNote(r)}</span>
      <span class="grow" />
      <PreReleases engine={engine} />
      <span class="btns">
        {managed ? (
          <button
            type="button"
            class="btn primary"
            disabled={locked.value}
            onClick={() => void onUpgrade(r.tag, r.version)}
          >
            Upgrade
          </button>
        ) : (
          // beside the release it installs, where Upgrade will be; the
          // form below is what it uses and its foot says why it cannot
          <button
            type="button"
            class="btn primary"
            aria-describedby="install-why"
            disabled={locked.value || engine.refusal !== null}
            onClick={() => void onInstall(r.tag)}
          >
            Install
          </button>
        )}
      </span>
    </div>
  );
}

export function Build({
  engine,
  s,
  url,
  sampledVersion,
}: {
  engine: EngineState | null;
  s: Sample | null;
  // the --engine URL and the build the sampler learned from /props: all
  // there is to say about an engine 1ctx-mlx-engine did not install
  url: string | null;
  sampledVersion: string | null;
}) {
  if (!engine) {
    return (
      <section class="card">
        <div class="facts">
          <dl>
            <dt>Build</dt>
            <None />
            <dt>Previous</dt>
            <None />
          </dl>
          <dl>
            <dt>Listening</dt>
            <None />
            <dt>Resources</dt>
            <None />
          </dl>
        </div>
        <div class="notice">
          <span class="what">Checking for releases</span>
        </div>
      </section>
    );
  }
  const managed = engine.mode === "managed";
  const absent = engine.mode === "absent";
  const build = managed
    ? (engine.active?.version ?? null)
    : absent
      ? null
      : sampledVersion;
  const listening = managed
    ? `${engine.config.host}:${engine.config.port}`
    : absent || !url
      ? null
      : new URL(url).host;
  // no numbers beside a pill that says stopped or not installed
  const up = !absent && !isStopped(engine, s) && (s?.engineUp ?? false);
  // memory still answers for a remote engine (its own gauge over HTTP);
  // CPU is libproc on this host and has no remote source
  const bytes = up && s ? s.mem.procFootprint || null : null;
  const cpu = up && s && s.enginePid != null ? s.engineCpuPct : null;
  const prev = managed ? engine.previous : null;
  return (
    <section class="card">
      <div class="facts">
        <dl>
          <dt>Build</dt>
          {build ? (
            <dd>
              {build.replace(/^v/, "")}
              {managed && engine.active?.mlx && (
                <small>MLX {engine.active.mlx}</small>
              )}
            </dd>
          ) : (
            <None />
          )}
          <dt>Previous</dt>
          {prev ? (
            <dd class="mono">
              {prev.version}{" "}
              <button
                type="button"
                class="btn"
                disabled={locked.value}
                onClick={() => void onRollback(prev.version)}
              >
                Rollback
              </button>
            </dd>
          ) : (
            <None />
          )}
        </dl>
        <dl>
          <dt>Listening</dt>
          {listening ? <dd class="mono">{listening}</dd> : <None />}
          <dt>Resources</dt>
          <Resources bytes={bytes} cpuPct={cpu} />
        </dl>
      </div>
      {engine.mode === "remote" ? (
        <div class="locked">
          <Lock />
          Managing mlx-serve needs it to be on this host. This one is at{" "}
          {engine.remoteHost ?? "another host"}.
        </div>
      ) : engine.operation ? (
        <Progress op={engine.operation} />
      ) : engine.failure ? (
        <Failed engine={engine} />
      ) : (
        <ReleaseRow engine={engine} />
      )}
    </section>
  );
}
