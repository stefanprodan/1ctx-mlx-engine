// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelPath, removeModel } from "../../../src/server/models/remove.ts";

const dir = async () => {
  const root = await mkdtemp(join(tmpdir(), "1ctx-remove-"));
  for (const id of ["owner/one", "owner/two", "other/three"]) {
    const d = join(root, ...id.split("/"));
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "model.safetensors"), "weights");
  }
  return root;
};

describe("modelPath", () => {
  test("a model id is its directory under the model directory", () => {
    expect(modelPath("/models", "owner/name")).toBe("/models/owner/name");
    expect(modelPath("/models/", "owner/name")).toBe("/models/owner/name");
  });

  test("anything that is not a plain repo id is refused", () => {
    for (const id of [
      "",
      "name",
      "owner/name/extra",
      "../name",
      "owner/..",
      "../../etc/passwd",
      "/etc/passwd",
      "owner//name",
      "https://huggingface.co/owner/name",
    ]) {
      expect(modelPath("/models", id)).toBeNull();
    }
  });
});

describe("removeModel", () => {
  test("the model goes, an emptied owner directory with it", async () => {
    const root = await dir();
    expect(await removeModel(root, "other/three")).toBe(true);
    expect((await readdir(root)).sort()).toEqual(["owner"]);
  });

  test("an owner directory with another model stays", async () => {
    const root = await dir();
    expect(await removeModel(root, "owner/one")).toBe(true);
    expect(await readdir(join(root, "owner"))).toEqual(["two"]);
  });

  test("nothing there, nothing removed", async () => {
    const root = await dir();
    expect(await removeModel(root, "owner/missing")).toBe(false);
    expect(await removeModel(root, "owner/name/extra")).toBe(false);
    expect((await readdir(root)).sort()).toEqual(["other", "owner"]);
  });

  test("a symlinked owner or model directory is not followed", async () => {
    const root = await dir();
    const outside = await dir();
    // <root>/linked -> <outside>/owner, so linked/one is outside the root
    await symlink(join(outside, "owner"), join(root, "linked"));
    expect(await removeModel(root, "linked/one")).toBe(false);
    // <root>/other/away -> <outside>/other/three
    await symlink(join(outside, "other", "three"), join(root, "other", "away"));
    expect(await removeModel(root, "other/away")).toBe(false);
    expect(await readdir(join(outside, "owner", "one"))).toEqual([
      "model.safetensors",
    ]);
    expect(await readdir(join(outside, "other", "three"))).toEqual([
      "model.safetensors",
    ]);
  });
});
