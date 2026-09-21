// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Engine page: 1ctx-mlx-engine first (short, never gated on where mlx-serve
// is), then mlx-serve, then its configuration. The manager pushes its
// state on /ws when it changes; the resources line is the one thing that
// moves without an operation, so the page asks again every few seconds.

import { useEffect } from "preact/hooks";
import { listen, sample, snapshot } from "../store.ts";
import { Build } from "./Build.tsx";
import { Config, ConfigHead } from "./Config.tsx";
import { Self, SelfHead } from "./Self.tsx";
import { ServiceHead } from "./Service.tsx";
import { engine, pageError, pushPageState, refresh, self } from "./state.ts";
import "./engine.css";

const REFRESH_MS = 5000;

export function Engine() {
  useEffect(() => {
    void refresh();
    const stop = listen((msg) => {
      if (msg.type === "engine") pushPageState(msg.data);
      // 1ctx-mlx-engine came back (its own Restart, or a deploy): ask again
      else if (msg.type === "snapshot") void refresh();
    });
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  const s = sample.value;
  const snap = snapshot.value;
  const e = engine.value;
  return (
    <>
      {pageError.value && (
        <div class="notice bad top" role="alert">
          <span class="what">{pageError.value}</span>
          <span class="grow" />
          <span class="btns">
            <button
              type="button"
              class="btn"
              onClick={() => {
                pageError.value = null;
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      )}
      <SelfHead self={self.value} now={s?.t ?? Date.now()} />
      <Self self={self.value} />
      <ServiceHead engine={e} s={s} />
      <Build
        engine={e}
        s={s}
        url={snap?.engine.url ?? null}
        sampledVersion={snap?.engine.version ?? null}
      />
      <ConfigHead engine={e} />
      <Config engine={e} />
    </>
  );
}
