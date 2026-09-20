// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The mlx-serve section head: the state pill and the service buttons.
// There are buttons only for a job mlx-spy wrote; an engine that is
// remote, unmanaged or not installed has nothing here to press.

import type { EngineState } from "../../engine/manage.ts";
import type { Sample } from "../../sample.ts";
import { confirm } from "../shell/Confirm.tsx";
import { isStopped, servicePill } from "./release.ts";
import { locked, service, uninstall } from "./state.ts";

async function ask(text: string, label: string, then: () => unknown) {
  const { ok } = await confirm([text], label);
  if (ok) void then();
}

const COLD = "The first request after it comes back cold-loads.";

export function ServiceHead({
  engine,
  s,
}: {
  engine: EngineState | null;
  s: Sample | null;
}) {
  if (!engine) {
    return (
      <div class="shead">
        <h2>mlx-serve</h2>
        <span class="pill">connecting</span>
      </div>
    );
  }
  const pill = servicePill(engine, s);
  const off = locked.value;
  const stopped = isStopped(engine, s);
  return (
    <div class="shead">
      <h2>mlx-serve</h2>
      <span class={pill.cls}>{pill.text}</span>
      <span class="grow" />
      {engine.mode === "managed" && (
        <span class="btns">
          {stopped ? (
            <button
              type="button"
              class="btn"
              disabled={off}
              onClick={() => void service("start")}
            >
              Start
            </button>
          ) : (
            <>
              <button
                type="button"
                class="btn"
                disabled={off}
                onClick={() =>
                  void ask(
                    "Stop mlx-serve? It stays down until Start or the next login.",
                    "Stop",
                    () => service("stop"),
                  )
                }
              >
                Stop
              </button>
              <button
                type="button"
                class="btn"
                disabled={off}
                onClick={() =>
                  void ask(`Restart mlx-serve? ${COLD}`, "Restart", () =>
                    service("restart"),
                  )
                }
              >
                Restart
              </button>
            </>
          )}
          <button
            type="button"
            class="btn danger"
            disabled={off}
            onClick={() =>
              void ask(
                "Uninstall mlx-serve? The service and the installed builds are removed. Models, caches and logs stay.",
                "Uninstall",
                uninstall,
              )
            }
          >
            Uninstall
          </button>
        </span>
      )}
    </div>
  );
}
