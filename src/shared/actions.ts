// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The actions POST /api/actions/<name> takes and the log row each leaves.

export const ACTION_NAMES = [
  "load",
  "unload",
  "default",
  "free",
  "diskClear",
  "historyClear",
  "requestsClear",
  "favorite",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export function isActionName(v: string): v is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(v);
}

// one row of the action log, also pushed to the dashboard
export type ActionEvent = {
  t: number;
  action: ActionName;
  model: string | null;
  ok: boolean;
  ms: number;
  detail: string;
};
