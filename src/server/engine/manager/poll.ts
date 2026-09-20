// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ReleaseCheck } from "../../../shared/engine.ts";
import { describeError } from "../../lib/fetch.ts";
import {
  type CachedReleaseCheck,
  ENGINE_ASSET,
  fetchReleases,
  SPY_ASSET,
} from "../release.ts";
import { ENGINE_REPO, type ManagerContext, SPY_REPO } from "./context.ts";
import { refreshService } from "./swap.ts";

export const CHECK_AFTER_MS = 5_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1_000;

export function publicCheck(check: CachedReleaseCheck | null): ReleaseCheck {
  return {
    releases:
      check?.releases.map(({ asset: _asset, ...release }) => release) ?? [],
    checkedAt: check?.checkedAt ?? null,
    error: check?.error ?? null,
  };
}

export function schedulePoll(
  context: ManagerContext,
  delay: number,
  check: () => Promise<unknown>,
) {
  if (context.stopped) return;
  const set = context.deps.setTimeout ?? setTimeout;
  context.pollTimer = set(() => {
    context.pollTimer = null;
    void check().finally(() => schedulePoll(context, CHECK_EVERY_MS, check));
  }, delay);
}

export async function checkRepo(
  context: ManagerContext,
  repo: string,
  assetName: string,
) {
  const previous = context.deps.store.releaseCheck(repo);
  try {
    const releases = await fetchReleases(repo, {
      token: context.deps.token,
      fetch: context.fetch,
      assetName,
    });
    context.deps.store.setReleaseCheck(repo, {
      releases,
      checkedAt: context.now(),
      error: null,
    });
  } catch (error) {
    context.deps.store.setReleaseCheck(repo, {
      releases: previous?.releases ?? [],
      checkedAt: context.now(),
      error: describeError(error),
    });
  }
}

export async function publicCheckRepos(context: ManagerContext) {
  await Promise.all([
    checkRepo(context, ENGINE_REPO, ENGINE_ASSET),
    checkRepo(context, SPY_REPO, SPY_ASSET),
  ]);
  if (context.deps.store.managed()) await refreshService(context);
  return context.publish();
}
