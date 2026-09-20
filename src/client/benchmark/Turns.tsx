// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import type { BenchmarkTurn } from "../../shared/benchmark.ts";
import { DASH } from "../format.ts";

const rate = (tokens: number, ms: number) =>
  tokens > 0 && ms > 0 ? Math.round((tokens * 1000) / ms).toString() : DASH;

// The raw turns of a run, as the engine stated them: the place to see which
// turn paid for a cache miss.
export function Turns({ turns }: { turns: BenchmarkTurn[] }) {
  const reps = [...new Set(turns.map((t) => t.repetition))];
  const [chosen, setChosen] = useState(reps[0] ?? 1);
  const rep = reps.includes(chosen) ? chosen : (reps[0] ?? 1);
  return (
    <>
      <div class="turns-head">
        <span class="k">Repetition</span>
        <div class="seg">
          {reps.map((r) => (
            <button
              type="button"
              key={r}
              class={r === rep ? "active" : undefined}
              onClick={() => setChosen(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <TurnsTable turns={turns.filter((t) => t.repetition === rep)} />
    </>
  );
}

function TurnsTable({ turns }: { turns: BenchmarkTurn[] }) {
  return (
    <table class="turns">
      <thead>
        <tr>
          <th>Turn</th>
          <th>Prompt</th>
          <th>Cached</th>
          <th>Prefill</th>
          <th class="wide">Prefill tok/s</th>
          <th class="gen">Generated</th>
          <th class="wide">Decode tok/s</th>
          <th class="wide">Finish</th>
        </tr>
      </thead>
      <tbody>
        {turns.map((t) => (
          <tr key={`${t.repetition}:${t.turn}`}>
            <td class="num">{t.turn}</td>
            <td class="num">{t.promptN}</td>
            <td class="num">
              {t.cachedN}
              <span class="rate">
                {" "}
                ·{" "}
                {t.promptN > 0 ? Math.round((t.cachedN / t.promptN) * 100) : 0}%
              </span>
            </td>
            <td class="num">{Math.round(t.promptMs)} ms</td>
            <td class="num wide">
              {rate(Math.max(t.promptN - t.cachedN, 0), t.promptMs)}
            </td>
            <td class="num gen">{t.predictedN}</td>
            <td class="num wide">{rate(t.predictedN, t.predictedMs)}</td>
            <td class={`num wide${t.finishReason === "length" ? "" : " warn"}`}>
              {t.finishReason ?? DASH}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
