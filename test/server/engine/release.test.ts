// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  compareTags,
  coreVersion,
  ENGINE_ASSET,
  fetchReleases,
  isNewer,
  isSafeTag,
  offered,
  parseReleases,
  parseTag,
  parseVersionOutput,
  SPY_ASSET,
} from "../../src/engine/release.ts";
import releasesFixture from "../fixtures/releases.json";

describe("engine releases", () => {
  test("parses the recorded asset and skips drafts", () => {
    const releases = parseReleases(releasesFixture);
    expect(releases.map((release) => release.tag)).toEqual([
      "v26.9.5-pre-release.1",
      "v26.9.4",
      "v26.9.3",
      "v26.9.2",
      "v26.9.1",
    ]);
    expect(releases[0]).toMatchObject({
      version: "26.9.5-pre-release.1",
      prerelease: true,
      assetBytes: 72154144,
      asset: {
        downloadUrl:
          "https://github.com/ddalcu/mlx-serve/releases/download/" +
          `v26.9.5-pre-release.1/${ENGINE_ASSET}`,
        sha256:
          "64639234eb9021107e7a76837356ff13929c837c7f8d57ce61dee06ac933343a",
      },
    });
    expect(
      parseReleases([
        {
          tag_name: "v99.0.0",
          draft: true,
          prerelease: false,
          assets: [],
        },
      ]),
    ).toEqual([]);
  });

  test("uses an exact asset name and tolerates no spy asset", () => {
    const spy = parseReleases(releasesFixture, SPY_ASSET);
    expect(spy).toHaveLength(5);
    expect(spy[0]).toMatchObject({ assetBytes: 0, asset: null });
  });

  test("orders prereleases with semver precedence", () => {
    expect(compareTags("26.9.5-pre-release.1", "26.9.5")).toBeLessThan(0);
    expect(
      compareTags("26.9.5-pre-release.2", "26.9.5-pre-release.1"),
    ).toBeGreaterThan(0);
    expect(isNewer("v26.10.0", "v26.9.99")).toBeTrue();
    expect(isNewer("v26.9.4", "v26.9.5-pre-release.1")).toBeFalse();
    expect(parseTag("not-a-tag")).toBeNull();
  });

  test("offers the newest allowed release but never a downgrade", () => {
    const releases = parseReleases(releasesFixture);
    expect(offered(releases, false, null)?.tag).toBe("v26.9.4");
    expect(offered(releases, true, null)?.tag).toBe("v26.9.5-pre-release.1");
    expect(offered(releases, false, "v26.9.5-pre-release.1")).toBeNull();
    expect(offered(releases, true, "v26.9.5-pre-release.1")).toBeNull();
    expect(offered(releases, true, "v26.9.3")?.tag).toBe(
      "v26.9.5-pre-release.1",
    );
  });

  test("requires a path-safe tag from the stored release list", () => {
    const releases = parseReleases(releasesFixture);
    expect(isSafeTag("v26.9.4", releases)).toBeTrue();
    for (const tag of ["..", ".", "v26.9/4", "v26.9\\4", "v26.9.6"]) {
      expect(isSafeTag(tag, releases)).toBeFalse();
    }
  });

  test("accepts a prerelease binary reporting its core version", () => {
    const output = `[mem] MLX buffer-pool cap 8192 MB (was 124518 MB)
mlx-serve 26.9.5
mlx 0.32.2
`;
    expect(parseVersionOutput(output)).toEqual({
      version: "26.9.5",
      mlx: "0.32.2",
    });
    expect(parseVersionOutput(output).version).toBe(
      coreVersion("v26.9.5-pre-release.1"),
    );
  });

  test("fetches with a bounded API request and optional bearer", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        auth: headers.get("authorization"),
      });
      return Response.json(releasesFixture);
    }) as unknown as typeof fetch;
    const releases = await fetchReleases("ddalcu/mlx-serve", {
      token: "gh_test",
      fetch: fakeFetch,
    });
    expect(releases).toHaveLength(5);
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/ddalcu/mlx-serve/releases?per_page=5",
        auth: "Bearer gh_test",
      },
    ]);
    await fetchReleases("stefanprodan/mlx-spy", {
      assetName: SPY_ASSET,
      fetch: fakeFetch,
    });
    expect(calls[1].auth).toBeNull();
  });
});
