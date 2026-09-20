// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Configuration form's rows: a labelled row with its refusal, a text
// input, a flag and the model directories. Config.tsx lays them out.

import type { ComponentChildren } from "preact";
import type { ConfigField } from "../../shared/engine.ts";
import { Trash } from "../icons.tsx";
import { type Form, MAX_MODEL_DIRS } from "./config.ts";
import { changed, edit, form, issues } from "./state.ts";

type TextField = {
  [K in keyof Form]: Form[K] extends string ? K : never;
}[keyof Form] &
  ConfigField;

// the refusal under a row, named so its control can point at it: without
// the link a screen reader hears "invalid" and never the reason
const badId = (field: ConfigField) => `cfg-bad-${field}`;
export const describedBy = (field: ConfigField) =>
  issues.value.some((i) => i.field === field) ? badId(field) : undefined;

export function Row({
  id,
  label,
  fields,
  children,
}: {
  id: string;
  label: string;
  fields: ConfigField[];
  children: ComponentChildren;
}) {
  const bad = issues.value.filter((i) => fields.includes(i.field));
  return (
    <div class="setting">
      <span class="k" id={id}>
        {label}
      </span>
      <fieldset class="v" aria-labelledby={id}>
        {children}
        {bad.map((i) => (
          <small
            class="bad"
            id={badId(i.field)}
            key={`${i.field}:${i.message}`}
          >
            {i.message}
          </small>
        ))}
      </fieldset>
    </div>
  );
}

export function Text({
  field,
  label,
  unit,
  width,
  placeholder,
  off,
  numeric = false,
}: {
  field: TextField;
  label: string;
  unit: string;
  width: string;
  placeholder?: string;
  off: boolean;
  numeric?: boolean;
}) {
  const f = form.value;
  if (!f) return null;
  const invalid = issues.value.some((i) => i.field === field);
  return (
    <span class="pair">
      <input
        type="text"
        name={field}
        inputMode={numeric ? "decimal" : undefined}
        class={`${width}${changed.value.has(field) ? " changed" : ""}`}
        value={f[field]}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy(field)}
        disabled={off}
        spellcheck={false}
        autocomplete="off"
        onInput={(ev) =>
          edit({ [field]: ev.currentTarget.value } as Partial<Form>)
        }
      />
      <small>{unit}</small>
    </span>
  );
}

export function Flag({
  field,
  label,
  off,
}: {
  field: "mtp" | "pld" | "noVision";
  label: string;
  off: boolean;
}) {
  const f = form.value;
  if (!f) return null;
  return (
    <label class={`flag${changed.value.has(field) ? " changed" : ""}`}>
      <input
        type="checkbox"
        name={field}
        class="box"
        checked={f[field]}
        disabled={off}
        onChange={(ev) =>
          edit({ [field]: ev.currentTarget.checked } as Partial<Form>)
        }
      />{" "}
      {label}
    </label>
  );
}

export function Dirs({ pinned, off }: { pinned: string; off: boolean }) {
  const f = form.value;
  if (!f) return null;
  const set = (at: number, value: string) =>
    edit({ modelDirs: f.modelDirs.map((d, i) => (i === at ? value : d)) });
  const bad = issues.value.some((i) => i.field === "modelDirs");
  return (
    <>
      <span class="dirs">
        {f.modelDirs.map((dir, i) => {
          // mlx-spy's own directory stays: a config without it makes
          // every finished download invisible to the engine. The absent
          // button is the signal; it carries no badge.
          const own = i === f.modelDirs.indexOf(pinned);
          return (
            <span class="dir" key={i}>
              <input
                type="text"
                name={`modelDir${i}`}
                class={`path${
                  changed.value.has(`modelDirs.${i}`) ? " changed" : ""
                }`}
                value={dir}
                readOnly={own}
                disabled={off}
                aria-label={`Model directory ${i + 1}`}
                aria-invalid={bad ? "true" : undefined}
                aria-describedby={describedBy("modelDirs")}
                spellcheck={false}
                autocomplete="off"
                onInput={(ev) => set(i, ev.currentTarget.value)}
              />
              {!own && (
                <button
                  type="button"
                  class="ibtn danger"
                  title="Remove"
                  aria-label={`Remove model directory ${i + 1}`}
                  disabled={off}
                  onClick={() =>
                    edit({
                      modelDirs: f.modelDirs.filter((_, at) => at !== i),
                    })
                  }
                >
                  <Trash />
                </button>
              )}
            </span>
          );
        })}
      </span>
      <button
        type="button"
        class="btn"
        disabled={off || f.modelDirs.length >= MAX_MODEL_DIRS}
        onClick={() => edit({ modelDirs: [...f.modelDirs, ""] })}
      >
        Add directory
      </button>
      <small>created if missing</small>
    </>
  );
}
