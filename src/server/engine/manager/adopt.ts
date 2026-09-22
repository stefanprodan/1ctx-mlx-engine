// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Taking back our own engine when the database that said so is gone (wiped,
// or a new one): the LaunchAgent under our label, running a build from our
// engine directory, is ours whatever the database says. Another agent's
// plist, the brew one or anyone's, is never read here: only the managed
// label's, and only when its program is inside our versions directory and
// says the version its directory is named for.

import { access, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { errorFields } from "../../lib/log.ts";
import { argsToConfig, DEFAULTS, parseLaunchdArgs } from "../config.ts";
import { isSafeTag } from "../release.ts";
import { type ManagerContext, plist, versionDir } from "./context.ts";
import { record } from "./stage.ts";

// The tag of the build a program path runs, when the path is
// <root>/versions/<tag>/mlx-serve for a tag that could have been ours.
// Pure, exported for tests.
export function adoptedTag(root: string, program: string): string | null {
  const prefix = join(root, "versions") + sep;
  if (!program.startsWith(prefix)) return null;
  const [tag, binary, ...rest] = program.slice(prefix.length).split(sep);
  if (!tag || binary !== "mlx-serve" || rest.length > 0) return null;
  return isSafeTag(tag) ? tag : null;
}

// True when it adopted. Nothing is written unless every check passed.
export async function adopt(context: ManagerContext): Promise<boolean> {
  const { store, local } = context.deps;
  if (!local || store.managed() || store.journal()) return false;
  const path = plist(context);
  const xml = await readFile(path, "utf8").catch(() => null);
  if (xml === null) return false;
  const [program, ...args] = parseLaunchdArgs(xml);
  const tag = program ? adoptedTag(context.root, program) : null;
  if (!tag || program !== join(versionDir(context, tag), "mlx-serve")) {
    return false;
  }
  if (
    !(await access(program).then(
      () => true,
      () => false,
    ))
  )
    return false;
  const config = argsToConfig(
    args,
    DEFAULTS(
      context.deps.pinnedModelDir,
      context.deps.engineUrl,
      context.deps.listenHost,
    ),
  );
  if (!config) {
    context.deps.log.warn("adopt skipped", { reason: "unreadable arguments" });
    return false;
  }
  // the binary states its version, as it did at install
  const installed = await record(context, tag).catch((error) => {
    context.deps.log.warn("adopt skipped", {
      tag,
      reason: "version check failed",
      ...errorFields(error, false),
    });
    return null;
  });
  if (!installed) return false;
  const since = await stat(path).then(
    (s) => s.mtimeMs,
    () => installed.installedAt,
  );
  store.setInstalls({ ...installed, installedAt: since }, null);
  store.setApplied(config);
  store.setManaged(true);
  context.deps.log.info("adopted", { tag });
  return true;
}
