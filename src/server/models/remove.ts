// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Deleting a model's checkpoint from the model directory, and the pruning a
// removed download does. The id comes from the engine's list but the path is
// built here from --model-dir and checked against it, so a delete never
// reaches outside the directory this program downloads into: a model the
// engine scans from somewhere else is refused, not hunted down.

import { lstat, rm, rmdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parseRepoId } from "./hub.ts";

// <modelDir>/<owner>/<name> for a model id, null when the id is not a plain
// repo id or when the path would leave the model directory. Pure, tested.
export function modelPath(modelDir: string, id: string): string | null {
  const repo = parseRepoId(id);
  if (repo === null || repo !== id) return null;
  const dir = resolve(modelDir, ...repo.split("/"));
  const root = resolve(modelDir);
  return dir.startsWith(root + sep) ? dir : null;
}

// The model's directory when it is really there: the id is one this
// program could have downloaded and neither the owner nor the model
// directory is a symlink. The path check is lexical, so a symlink would
// take a delete, or a read, outside the root.
export async function realModelDir(
  modelDir: string,
  id: string,
): Promise<string | null> {
  const dir = modelPath(modelDir, id);
  if (dir === null) return null;
  for (const path of [dirname(dir), dir]) {
    const real = await lstat(path).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!real) return null;
  }
  return dir;
}

// Deletes the model's directory and the owner directory it leaves empty.
// False when there is nothing to delete: the id is not one this program
// could have downloaded, or the checkpoint lives in another directory the
// engine scans.
export async function removeModel(
  modelDir: string,
  id: string,
): Promise<boolean> {
  const dir = await realModelDir(modelDir, id);
  if (dir === null) return false;
  await rm(dir, { recursive: true, force: true });
  await pruneEmpty(dirname(dir), modelDir);
  return true;
}

// Removes the directory and its parents up to the model root, stopping at
// the first one that is not empty, so nothing is left behind and the root
// itself stays.
export async function pruneEmpty(dir: string, root: string) {
  let current = resolve(dir);
  const top = resolve(root);
  while (current.startsWith(top + sep)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
