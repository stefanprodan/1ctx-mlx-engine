// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The operation row: what is being done, the phase, and Cancel while it
// can still mean something. Once the swap begins the only ways out are
// forward or the rollback, and neither is a button.

import type { Operation } from "../../server/engine/manage.ts";
import {
  cancellable,
  operationTitle,
  phaseLine,
  progressPct,
} from "./release.ts";
import { cancel } from "./state.ts";

export function Progress({ op }: { op: Operation }) {
  const transfers = op.kind === "install" || op.kind === "upgrade";
  return (
    <div class="notice work">
      <span class="what">{operationTitle(op)}</span>
      {op.tag && <span class="ver">{op.tag.replace(/^v/, "")}</span>}
      <span class="grow" />
      {transfers && (
        <span class="btns">
          <button
            type="button"
            class="btn danger"
            disabled={!cancellable(op)}
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        </span>
      )}
      <div class="prog">
        <div class="sub">{phaseLine(op)}</div>
        <div class="bar">
          <div class="fill" style={{ width: `${progressPct(op)}%` }} />
        </div>
      </div>
    </div>
  );
}
