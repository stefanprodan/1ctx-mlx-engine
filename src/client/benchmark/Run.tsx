// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import {
  BENCHMARK_PRESETS,
  type BenchmarkPreset,
} from "../../shared/benchmark.ts";
import { orderModels } from "../format.ts";
import { confirm } from "../shell/Confirm.tsx";
import { Select } from "../shell/Select.tsx";
import { benchmark, busy, connected, models, snapshot } from "../store.ts";
import { modelName, progressCopy } from "./report.ts";
import { cancelRun, failure, startRun } from "./state.ts";

const PRESETS: Record<BenchmarkPreset, string> = {
  "20K": "5 agent turns with tool calls and prompts 10K → 20K tokens",
  "40K": "8 agent turns with tool calls and prompts 15K → 40K tokens",
  "60K": "10 agent turns with tool calls and prompts 20K → 60K tokens",
};

// Why the button is off, in the server's own terms; null when it is not.
function refusal(): string | null {
  const engine = snapshot.value?.engine;
  if (!engine) return null;
  if (!engine.local) return "Only on the host the engine runs on.";
  if (engine.mode !== "managed") return "Only on an engine installed here.";
  if (!engine.capabilities.includes("benchmark")) return "Not on this engine.";
  return null;
}

// The top card: what to run, or how far the run is.
export function Run() {
  const list = orderModels(models.value);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preset, setPreset] = useState<BenchmarkPreset>("40K");
  const model = list.find((m) => m.id === chosen)?.id ?? list[0]?.id;
  const running = benchmark.value;
  const off = refusal();

  if (running) {
    const copy = progressCopy(running);
    return (
      <section class="card bench-run">
        <div class="bench-line">
          <span class="bench-model" title={running.benchmark.model}>
            {modelName(running.benchmark.model)}
          </span>
          <span class="grow" />
          <button
            type="button"
            class="btn danger"
            onClick={() => void cancelRun(running.benchmark.id)}
          >
            Cancel
          </button>
        </div>
        <div class="bar">
          <div class="fill" style={{ width: `${copy.fraction * 100}%` }} />
        </div>
        <p class="bench-note">{copy.text}</p>
      </section>
    );
  }

  const start = async () => {
    if (!model) return;
    const answer = await confirm(
      [
        "Benchmark ",
        { code: modelName(model) },
        "? The engine restarts three times, every model is unloaded and " +
          "the SSD cache is deleted.",
      ],
      "Run",
    );
    if (answer.ok) void startRun(model, preset);
  };

  return (
    <section class="card bench-run">
      <div class="bench-line">
        <Select
          name="model"
          label="Model"
          value={model ?? ""}
          options={list.map((m) => m.id)}
          disabled={list.length === 0}
          onChange={setChosen}
        />
        <div class="seg">
          {BENCHMARK_PRESETS.map((p) => (
            <button
              type="button"
              key={p}
              class={p === preset ? "active" : undefined}
              title={PRESETS[p]}
              onClick={() => setPreset(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <span class="grow" />
        <button
          type="button"
          class="btn primary"
          disabled={
            !model || off !== null || busy.value !== null || !connected.value
          }
          onClick={() => void start()}
        >
          Run
        </button>
      </div>
      {/* the progress bar's place, so the card keeps its height */}
      <div class="bar off" />
      <p class="bench-note">
        {failure.value ? (
          <span class="warn">{failure.value}</span>
        ) : (
          (off ?? PRESETS[preset])
        )}
      </p>
    </section>
  );
}
