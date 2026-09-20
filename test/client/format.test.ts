// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  count,
  DASH,
  diskSize,
  gb,
  num,
  orderModels,
  size,
  sizeText,
} from "../../src/ui/format.ts";

describe("format", () => {
  test("gb is binary and dashes a missing value", () => {
    expect(gb(96 * 2 ** 30)).toBe("96.0");
    expect(gb(96 * 2 ** 30, 0)).toBe("96");
    expect(gb(null)).toBe(DASH);
    expect(gb(undefined)).toBe(DASH);
    // whole GB from 10 up, a decimal below, MB under one: a 320 MB
    // checkpoint must not read "0 GB"
    expect(sizeText(38.2 * 2 ** 30)).toBe("38 GB");
    expect(sizeText(10 * 2 ** 30)).toBe("10 GB");
    expect(sizeText(2.1 * 2 ** 30)).toBe("2.1 GB");
    expect(sizeText(320 * 2 ** 20)).toBe("320 MB");
    expect(size(0)).toEqual({ value: "0", unit: "GB" });
  });

  test("diskSize is decimal, as Finder labels it", () => {
    expect(diskSize(994_662_584_320)).toBe("995 GB");
    expect(diskSize(2_000_000_000_000)).toBe("2.0 TB");
  });

  test("num and count", () => {
    expect(num(null)).toBe(DASH);
    expect(num(12.345, 1)).toBe("12.3");
    expect(count(999)).toBe("999");
    expect(count(12_345)).toBe("12.3K");
    expect(count(1_234_567)).toBe("1.23M");
  });
});

describe("orderModels", () => {
  test("daily driver first, then by id, residency ignored", () => {
    const list = [
      { id: "b/two", loaded: true },
      { id: "a/one", loaded: false },
      { id: "c/three", loaded: false, favorite: true },
    ];
    expect(orderModels(list).map((m) => m.id)).toEqual([
      "c/three",
      "a/one",
      "b/two",
    ]);
    expect(list.map((m) => m.id)).toEqual(["b/two", "a/one", "c/three"]);
  });
});
