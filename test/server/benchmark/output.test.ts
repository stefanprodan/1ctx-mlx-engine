// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  compressedShare,
  looksBroken,
  notEnglish,
} from "../../../src/server/benchmark/output.ts";
import broken from "../../fixtures/broken-output.json";

// Answers from mlx-community/Qwen3.5-0.8B-4bit at 256 tokens, abridged to
// what a turn writes: prose, a list, YAML, a tool call.
const WORKING = [
  "To find the ten largest files under a directory, combine find with sort. " +
    "The find command lists every regular file with its size in bytes, sort " +
    "orders them numerically in reverse, and head keeps the first ten. On " +
    "macOS the stat flags differ from GNU, so use -f %z instead of -c %s. " +
    "If the tree is large, add -xdev to stay on one filesystem, and send " +
    "errors to /dev/null so directories you cannot read do not clutter it.",
  "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  labels:\n" +
    "    app: api\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n" +
    "      app: api\n  template:\n    metadata:\n      labels:\n        app: api\n" +
    "    spec:\n      containers:\n        - name: api\n" +
    "          image: ghcr.io/example/api:1.4.2\n          ports:\n" +
    "            - containerPort: 8080\n          resources:\n" +
    "            limits:\n              memory: 256Mi\n",
  'read {"path":"clusters/prod/apps/podinfo/release.yaml"}',
];

test("a working model's answers pass", () => {
  for (const text of WORKING) {
    expect(looksBroken(text, 256)).toBe(false);
  }
});

test("no text is broken only when tokens were generated", () => {
  expect(looksBroken("", 256)).toBe(true);
  expect(looksBroken("  \n", 64)).toBe(true);
  // stopped at once: "little was generated" says it
  expect(looksBroken("", 2)).toBe(false);
});

test("text that does not decode is broken", () => {
  expect(looksBroken("ok ��� ".repeat(12), 256)).toBe(true);
  // a split multi-byte character now and then is not
  expect(looksBroken(`${WORKING[0]}�`, 256)).toBe(false);
});

test("a loop is broken, from a word to a paragraph said three times", () => {
  const paragraph =
    "The reconciler reads the chart, renders the manifests and applies " +
    "them to the cluster. Then it waits for the rollout of every " +
    "deployment and reports the status back on the object. It retries on " +
    "failure with a backoff. ";
  for (const loop of [
    "the ".repeat(300),
    "The reconciler applies the chart. ".repeat(30),
    paragraph.repeat(3),
  ]) {
    expect(looksBroken(loop, 256)).toBe(true);
  }
  // said twice can be a model quoting itself
  expect(looksBroken(paragraph.repeat(2), 256)).toBe(false);
});

test("noise is broken: a 2-bit Qwen2.5-0.5B, recorded", () => {
  for (const text of broken.outputs) {
    expect(looksBroken(text, 256)).toBe(true);
  }
});

test("text that barely compresses is not noise without a bad character", () => {
  // random bytes as base64, the least compressible text a model writes
  const blob = Buffer.from(
    Array.from({ length: 768 }, (_, i) => (i * 7919 + 13) % 251),
  ).toString("base64");
  expect(compressedShare(blob)).toBeGreaterThan(0.7);
  expect(looksBroken(blob, 256)).toBe(false);
  // a working answer cut mid-character at the token limit
  expect(looksBroken(`${WORKING[0]}\uFFFD`, 256)).toBe(false);
  // nor a blob cut the same way: the last character is the limit's
  expect(looksBroken(`${blob}\uFFFD`, 256)).toBe(false);
  // one inside is the model's
  expect(
    looksBroken(`${blob.slice(0, 500)}\uFFFD${blob.slice(500)}`, 256),
  ).toBe(true);
});

test("too short to judge a loop", () => {
  expect(compressedShare("ok ".repeat(100))).toBe(1);
  expect(looksBroken("ok ".repeat(100), 256)).toBe(false);
});

test("English stays English with symbols, emoji and accents", () => {
  for (const text of [
    ...WORKING,
    "Done ✅ the rollout moved api → v1.4.2 “as planned” … see café-api 🚀",
    "Decode took 42 μs per token, about π times faster than before.",
    "Résumé of the naïve approach: it déjà-vu retries the Helm release.",
  ]) {
    expect(notEnglish(text)).toBe(false);
  }
});

test("another script is not English", () => {
  for (const text of [
    "Kubernetes（K8s）中的 Deployment（部署）是构建一个应用的核心资源，它负责滚动更新镜像。",
    "Git で Merge と Rebase の違いを説明します。どちらも履歴を統合します。",
    "Развертывание обновляет образ постепенно, заменяя старые поды новыми.",
    // an English answer that drifts into Chinese halfway
    "The Deployment replaces pods one by one. 然后它等待新的副本就绪再继续下一个。",
  ]) {
    expect(notEnglish(text)).toBe(true);
  }
  // the recorded noise is mostly Han
  for (const text of broken.outputs) expect(notEnglish(text)).toBe(true);
});

test("too few letters to judge a language", () => {
  expect(notEnglish("好")).toBe(false);
  expect(notEnglish('read {"path":"a.yaml"}')).toBe(false);
});
