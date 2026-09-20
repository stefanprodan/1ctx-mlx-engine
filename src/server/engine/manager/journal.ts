// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EnginePageState, InstallRecord } from "../../../shared/engine.ts";
import { describeError } from "../../lib/fetch.ts";
import type { EngineJournal } from "../store.ts";
import {
  launchdDeps,
  MANAGED_LABEL,
  type ManagerContext,
  plist,
  versionDir,
} from "./context.ts";
import { record } from "./stage.ts";
import { refreshService, verify } from "./swap.ts";

export async function reconcile(
  context: ManagerContext,
): Promise<EnginePageState> {
  const journal = context.deps.store.journal();
  if (!journal || !context.deps.local) {
    // launchd's view is cached, and the cache starts empty: read it once
    // here, or a job that is stopped or crash-looping reads as nothing
    // until the next operation. At start, never on the sampler's path.
    if (context.deps.local && context.deps.store.managed()) {
      await refreshService(context).catch(() => undefined);
      return context.publish();
    }
    return context.pageState();
  }
  context.deps.log.warn(
    `engine ${journal.op}: reconciling ${journal.step} for ${journal.tag ?? "configuration"}`,
  );
  const installs = context.deps.store.installs();
  const target = journal.tag ? versionDir(context, journal.tag) : null;
  const active = installs.active;
  // The verification can take a minute. It holds the lock and shows as
  // the swap it is finishing, so the page is locked and 1ctx-mlx-engine serves
  // meanwhile: a monitor that stays dark because the engine is in
  // trouble is the wrong way round.
  context.operation = {
    kind: journal.op,
    tag: journal.tag,
    phase: "restarting",
    doneBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
  };
  context.publish();
  try {
    await context.deps.lock.run("reconcile", () =>
      reconcileJournal(context, journal, target, active),
    );
  } catch (error) {
    context.deps.log.error(
      `engine ${journal.op}: reconcile failed: ${describeError(error)}`,
    );
  } finally {
    context.operation = null;
  }
  await refreshService(context).catch(() => undefined);
  return context.publish();
}

export async function reconcileJournal(
  context: ManagerContext,
  journal: EngineJournal,
  target: string | null,
  active: InstallRecord | null,
) {
  if (journal.op === "uninstall") {
    await removeEverything(context);
    context.deps.log("engine uninstall: reconciled forward");
    return;
  }
  {
    const info = await context.printFn(MANAGED_LABEL, launchdDeps(context));
    const newJob =
      target !== null &&
      info?.program === join(target, "mlx-serve") &&
      (await verify(context, join(target, "mlx-serve")));
    if (newJob && journal.tag) {
      const value = await record(context, journal.tag);
      if (journal.op === "rollback") {
        context.deps.store.setInstalls(value, null);
      } else if (journal.tag !== active?.tag) {
        context.deps.store.setInstalls(value, active);
      }
      // else an Apply or a Restart: the same build, so the slots stay.
      // Writing it as "record over active" would make one tree both
      // active and previous, and the next Rollback would delete the
      // running one.
      if (context.deps.store.config().pending) {
        context.deps.store.commitPending();
      }
      context.deps.store.setManaged(true);
      context.deps.store.setJournal(null);
      context.deps.log(`engine ${journal.op}: reconciled forward`);
    } else {
      const restored = await restoreJournal(context, journal, active);
      if (!restored) {
        throw new Error("the previous mlx-serve did not come back");
      }
      // The tree an unfinished install or upgrade was heading for is
      // nobody's now. A rollback's target is the previous build, which
      // stays.
      const staged = journal.op === "install" || journal.op === "upgrade";
      if (staged && target !== null && journal.tag !== active?.tag) {
        await rm(target, { recursive: true, force: true });
      }
      context.deps.store.setPending(null);
      context.deps.store.setJournal(null);
      context.deps.log(`engine ${journal.op}: reconciled by rollback`);
    }
    await prune(context);
  }
}

// True when what ran before is back and verified. The journal row is
// the only way to try again, so it is cleared on true and on nothing
// else.
export async function restoreJournal(
  context: ManagerContext,
  journal: EngineJournal,
  previous: InstallRecord | null,
): Promise<boolean> {
  await context.bootoutFn(MANAGED_LABEL, launchdDeps(context));
  if (journal.previousPlist === null) {
    // nothing ran before: gone is the restored state
    await rm(plist(context), { force: true });
    return true;
  }
  await context.atomicWriteFn(
    plist(context),
    journal.previousPlist,
    launchdDeps(context),
  );
  await context.bootstrapFn(plist(context), launchdDeps(context));
  if (!previous) return true;
  return verify(context, join(versionDir(context, previous.tag), "mlx-serve"));
}

export async function prune(context: ManagerContext) {
  // Two trees at most, whatever interrupted what: anything under
  // versions/ that is neither slot is removed.
  const { active, previous } = context.deps.store.installs();
  const keep = new Set([active?.tag, previous?.tag]);
  let names: string[] = [];
  try {
    names = await readdir(join(context.root, "versions"));
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    await rm(join(context.root, "versions", name), {
      recursive: true,
      force: true,
    });
  }
}

export async function removeEverything(context: ManagerContext) {
  await context.bootoutFn(MANAGED_LABEL, launchdDeps(context));
  await rm(plist(context), { force: true });
  await rm(join(context.root, "versions"), { recursive: true, force: true });
  await rm(join(context.root, "downloads"), { recursive: true, force: true });
  context.deps.store.setManaged(false);
  context.deps.store.setInstalls(null, null);
  context.deps.store.setApplied(null);
  context.deps.store.setPending(null);
  context.deps.store.setJournal(null);
  context.cachedService = null;
}

export async function removeActive(context: ManagerContext) {
  const active = context.active;
  if (!active) return;
  await Promise.all([
    rm(active.part, { force: true }),
    rm(active.archive, { force: true }),
    rm(active.temporary, { recursive: true, force: true }),
    rm(active.staged, { recursive: true, force: true }),
  ]);
}
