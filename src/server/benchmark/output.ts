// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: whether a turn's answer looks like a model that does not work. The
// run measures the engine and never checks an answer, but a broken quant or
// a wrong tokenizer still decodes at full speed, and its numbers would pass
// for a working model's. Four signs need no reference answer: tokens
// generated and no text at all, text that does not decode, noise, and a
// loop.

import { deflateSync } from "node:zlib";

// fewer generated tokens than this and an empty answer is a model that
// stopped, which "little was generated" already covers
const EMPTY_MIN_TOKENS = 8;

// U+FFFD is what bytes that are not UTF-8 decode to: token ids read through
// the wrong vocabulary. A few can be a split multi-byte character.
const REPLACEMENT_SHARE = 0.05;
const REPLACEMENT_MIN_CHARS = 32;

// Deflate finds repeats within 32 KB. At the length of a turn (256 tokens,
// about 1 KB) answers from a working model kept 45 to 57% of their size, a
// markdown table 47%, the most repetitive (a struct counting its fields in
// comments) 34%. A paragraph said three times keeps 24%, a sentence loop 9%,
// a word loop 2%. Under this many bytes the header dominates and the ratio
// says nothing.
const LOOP_RATIO = 0.25;
const LOOP_MIN_BYTES = 400;

// Noise is the other end: Qwen2.5-0.5B at 2 bits wrote a soup of scripts
// and fragments that kept 83 to 88% of its size, with 1 to 3% of it U+FFFD.
// Compression alone cannot tell it from a base64 blob (78%), and Chinese
// prose kept 67%, but neither has a character that did not decode. So:
// barely compressible, and at least one U+FFFD.
const NOISE_RATIO = 0.75;

// The session asks for English. Letters outside the Latin alphabet over
// this share of all letters are another language (a Qwen drifting into
// Chinese) or noise; a Greek mu or pi in a unit or a formula stays under it.
// Symbols, emoji, arrows and accented Latin letters are not letters of
// another script and never count.
const FOREIGN_SHARE = 0.05;
const FOREIGN_MIN_LETTERS = 20;
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

export function notEnglish(output: string): boolean {
  let letters = 0;
  let foreign = 0;
  for (const ch of output) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (!LATIN.test(ch)) foreign++;
  }
  return letters >= FOREIGN_MIN_LETTERS && foreign / letters > FOREIGN_SHARE;
}

export function looksBroken(output: string, predictedN: number): boolean {
  if (output.trim() === "") return predictedN >= EMPTY_MIN_TOKENS;
  // a turn cut at its token limit mid-character ends in U+FFFD; that one is
  // the limit's, not the model's
  const body = output.replace(/\uFFFD+\s*$/u, "");
  let bad = 0;
  for (const ch of body) if (ch === "\uFFFD") bad++;
  if (
    output.length >= REPLACEMENT_MIN_CHARS &&
    bad / output.length > REPLACEMENT_SHARE
  ) {
    return true;
  }
  const share = compressedShare(output);
  return share < LOOP_RATIO || (bad > 0 && share > NOISE_RATIO && share < 1);
}

// the deflated size over the raw size, 1 for a text too short to judge
export function compressedShare(output: string): number {
  const raw = new TextEncoder().encode(output);
  if (raw.length < LOOP_MIN_BYTES) return 1;
  return deflateSync(raw).length / raw.length;
}
