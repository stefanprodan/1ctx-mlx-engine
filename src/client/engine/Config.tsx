// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Configuration section: one row per concern, the label in the gutter
// and the controls inline, sized to what they hold. A blank field means
// the engine's own default and its placeholder names that default. The
// foot holds Apply and Revert, or Install before there is a service.

import type { EngineState, KvQuant, LogLevel } from "../../shared/engine.ts";
import { abbreviateHome } from "../../shared/paths.ts";
import { confirm } from "../shell/Confirm.tsx";
import { type Form, HOST_NOTES, KV_QUANTS, LOG_LEVELS } from "./config.ts";
import { Dirs, describedBy, Flag, Row, Text } from "./Fields.tsx";
import { lockedWhy } from "./release.ts";
import {
  applyConfig,
  changed,
  edit,
  footError,
  form,
  install,
  issues,
  locked,
  revert,
} from "./state.ts";

async function onApply() {
  const { ok } = await confirm(
    [
      "Apply the configuration? mlx-serve restarts, and the first request after it comes back cold-loads.",
    ],
    "Apply",
  );
  if (ok) void applyConfig();
}

function Foot({ engine }: { engine: EngineState }) {
  const managed = engine.mode === "managed";
  const dirty = changed.value.size > 0;
  const off = locked.value;
  if (managed) {
    return (
      <div class="apply">
        <span class={`what${footError.value ? " bad" : ""}`} role="status">
          {footError.value ??
            (dirty ? "Applying restarts mlx-serve." : "No changes.")}
        </span>
        <span class="grow" />
        <span class="btns">
          <button
            type="button"
            class="btn"
            disabled={off || !dirty}
            onClick={revert}
          >
            Revert
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={off || !dirty}
            onClick={() => void onApply()}
          >
            Apply
          </button>
        </span>
      </div>
    );
  }
  // Before there is a service there is nothing to apply to: Install is
  // what consumes the form.
  const tag = engine.offered?.tag ?? null;
  const why =
    footError.value ??
    engine.refusal ??
    (tag ? "Install will use these settings." : "No release to install.");
  return (
    <div class="apply">
      <span
        class={`what${footError.value ? " bad" : ""}`}
        role="status"
        id="install-why"
      >
        {why}
      </span>
      <span class="grow" />
      <span class="btns">
        <button
          type="button"
          class="btn primary"
          aria-describedby="install-why"
          disabled={off || tag === null || engine.refusal !== null}
          onClick={() => tag && void install(tag)}
        >
          Install
        </button>
      </span>
    </div>
  );
}

export function ConfigHead({ engine }: { engine: EngineState | null }) {
  const managed = engine?.mode === "managed";
  const op = engine?.operation ?? null;
  // applied, edited and read-only all presume something to apply to
  const pill = !managed
    ? null
    : op
      ? { cls: "pill", text: "read-only" }
      : changed.value.size > 0
        ? { cls: "pill warn", text: "edited" }
        : { cls: "pill live", text: "applied" };
  return (
    <div class="shead">
      <h2>Configuration</h2>
      {pill && <span class={pill.cls}>{pill.text}</span>}
      {/* in text, not a title: a disabled control is not focusable, so
          its tooltip never opens */}
      {op && <span class="hint">{lockedWhy(op)}</span>}
    </div>
  );
}

export function Config({ engine }: { engine: EngineState | null }) {
  const f = form.value;
  if (!engine || !f) return <section class="card cfg-wait" />;
  if (engine.mode === "remote") {
    return (
      <div class="locked">
        mlx-serve is on another host, so its configuration is not mlx-spy's to
        read or write.
      </div>
    );
  }
  const off = locked.value;
  const pinned = abbreviateHome(engine.pinnedModelDir, engine.home);
  const select = (field: "host" | "kvQuant" | "logLevel") =>
    `${field === "host" ? "w9" : "w7"}${
      changed.value.has(field) ? " changed" : ""
    }`;
  return (
    <section class="card">
      <Row id="cfg-listener" label="Listener" fields={["host", "port"]}>
        <span class="pair">
          <select
            name="host"
            class={select("host")}
            aria-label="Listener host"
            aria-invalid={
              issues.value.some((i) => i.field === "host") ? "true" : undefined
            }
            aria-describedby={describedBy("host")}
            value={f.host}
            disabled={off}
            onChange={(ev) =>
              edit({ host: ev.currentTarget.value as Form["host"] })
            }
          >
            <option>0.0.0.0</option>
            <option>127.0.0.1</option>
          </select>
          <small>{HOST_NOTES[f.host]}</small>
        </span>
        <Text
          field="port"
          label="Listener port"
          unit="port"
          width="w5"
          off={off}
          numeric
        />
      </Row>

      <Row id="cfg-dirs" label="Model dirs" fields={["modelDirs"]}>
        <Dirs pinned={pinned} off={off} />
      </Row>

      <Row
        id="cfg-cache"
        label="Prefix cache"
        fields={["prefixCacheMem", "prefixCacheDisk", "prefixCacheEntries"]}
      >
        <Text
          field="prefixCacheMem"
          label="Prefix cache memory per model"
          unit="memory per model"
          width="w5"
          placeholder="2GB"
          off={off}
        />
        <Text
          field="prefixCacheDisk"
          label="Prefix cache disk per model"
          unit="disk per model"
          width="w5"
          placeholder="off"
          off={off}
        />
        <Text
          field="prefixCacheEntries"
          label="Prefix cache entries"
          unit="entries, 0 off"
          width="w5"
          placeholder="32"
          off={off}
          numeric
        />
      </Row>

      <Row
        id="cfg-residency"
        label="Residency"
        fields={[
          "maxResidentModels",
          "maxResidentMem",
          "ctxSize",
          "idleEvictSeconds",
        ]}
      >
        <Text
          field="maxResidentModels"
          label="Maximum resident models"
          unit="models"
          width="w3"
          placeholder="1"
          off={off}
          numeric
        />
        <Text
          field="maxResidentMem"
          label="Maximum resident memory"
          unit="memory"
          width="w5"
          placeholder="auto"
          off={off}
        />
        <Text
          field="ctxSize"
          label="Context size"
          unit="context"
          width="w7"
          placeholder="model max"
          off={off}
          numeric
        />
        <Text
          field="idleEvictSeconds"
          label="Idle evict, seconds"
          unit="idle evict, seconds"
          width="w5"
          placeholder="off"
          off={off}
          numeric
        />
      </Row>

      <Row id="cfg-sampling" label="Sampling" fields={["temp", "topP", "topK"]}>
        <Text
          field="temp"
          label="Sampling temperature"
          unit="temp"
          width="w5"
          placeholder="model"
          off={off}
          numeric
        />
        <Text
          field="topP"
          label="Sampling top-p"
          unit="top-p"
          width="w5"
          placeholder="model"
          off={off}
          numeric
        />
        <Text
          field="topK"
          label="Sampling top-k"
          unit="top-k, 0 is off"
          width="w5"
          placeholder="model"
          off={off}
          numeric
        />
      </Row>

      <Row
        id="cfg-decoding"
        label="Decoding"
        fields={["kvQuant", "mtp", "pld", "noVision"]}
      >
        <span class="pair">
          <select
            name="kvQuant"
            class={select("kvQuant")}
            aria-label="KV cache quantization"
            value={f.kvQuant}
            disabled={off}
            onChange={(ev) =>
              edit({ kvQuant: ev.currentTarget.value as KvQuant })
            }
          >
            {KV_QUANTS.map((q) => (
              <option key={q}>{q}</option>
            ))}
          </select>
          <small>KV quant</small>
        </span>
        <Flag field="mtp" label="MTP" off={off} />
        <Flag field="pld" label="Prompt lookup" off={off} />
        <Flag field="noVision" label="No vision" off={off} />
      </Row>

      <Row id="cfg-log" label="Log level" fields={["logLevel"]}>
        <select
          name="logLevel"
          class={select("logLevel")}
          aria-label="Log level"
          value={f.logLevel}
          disabled={off}
          onChange={(ev) =>
            edit({ logLevel: ev.currentTarget.value as LogLevel })
          }
        >
          {LOG_LEVELS.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Row>

      <Row id="cfg-extra" label="Extra args" fields={["extraArgs"]}>
        <textarea
          name="extraArgs"
          class={changed.value.has("extraArgs") ? "changed" : undefined}
          aria-label="Extra arguments"
          aria-invalid={
            issues.value.some((i) => i.field === "extraArgs")
              ? "true"
              : undefined
          }
          aria-describedby={describedBy("extraArgs")}
          spellcheck={false}
          value={f.extraArgs}
          disabled={off}
          onInput={(ev) => edit({ extraArgs: ev.currentTarget.value })}
        />
        <small class="help">
          One per line, unchecked. <code>--serve</code>, <code>--metrics</code>,{" "}
          <code>--host</code>, <code>--port</code>, <code>--model-dir</code> and{" "}
          <code>--api-key</code> are refused.
        </small>
      </Row>

      <Foot engine={engine} />
    </section>
  );
}
