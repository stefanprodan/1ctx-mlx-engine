// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Release, ReleaseCheck } from "../../shared/engine.ts";

export const ENGINE_ASSET = "mlx-serve-bin-macos-arm64.tar.gz";
export const SELF_ASSET = "1ctx-mlx-engine_darwin_arm64.tar.gz";
const TIMEOUT_MS = 3000;

export type ReleaseAsset = {
  downloadUrl: string;
  sha256: string;
};

export type ReleaseDetails = Release & {
  asset: ReleaseAsset | null;
};

export type CachedReleaseCheck = Omit<ReleaseCheck, "releases"> & {
  releases: ReleaseDetails[];
};

type GithubAsset = {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
};

type GithubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
};

export type ParsedTag = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseTag(tag: string): ParsedTag | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => part === "")) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNumber = /^\d+$/.test(a);
  const bNumber = /^\d+$/.test(b);
  if (aNumber && bNumber) return Number(a) - Number(b);
  if (aNumber !== bNumber) return aNumber ? -1 : 1;
  return a.localeCompare(b);
}

export function compareTags(a: string, b: string): number {
  const left = parseTag(a);
  const right = parseTag(b);
  if (!left || !right) throw new TypeError("invalid release tag");
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const compared = compareIdentifier(left.prerelease[i], right.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isNewer(candidate: string, active: string): boolean {
  try {
    return compareTags(candidate, active) > 0;
  } catch {
    return false;
  }
}

export function coreVersion(tag: string): string | null {
  const parsed = parseTag(tag);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
}

export function isSafeTag(
  tag: string,
  listed?: readonly Pick<Release, "tag">[],
): boolean {
  if (tag === "." || tag === ".." || tag.includes("/") || tag.includes("\\")) {
    return false;
  }
  if (!parseTag(tag)) return false;
  return listed === undefined || listed.some((release) => release.tag === tag);
}

export function pickAsset(
  release: GithubRelease,
  assetName = ENGINE_ASSET,
): { bytes: number; asset: ReleaseAsset } | null {
  const assets = Array.isArray(release.assets)
    ? (release.assets as GithubAsset[])
    : [];
  const raw = assets.find((asset) => asset?.name === assetName);
  if (!raw) return null;
  const digest =
    typeof raw.digest === "string"
      ? /^sha256:([0-9a-f]{64})$/i.exec(raw.digest)
      : null;
  if (
    typeof raw.size !== "number" ||
    !Number.isFinite(raw.size) ||
    raw.size < 0 ||
    typeof raw.browser_download_url !== "string" ||
    !digest
  ) {
    return null;
  }
  return {
    bytes: raw.size,
    asset: {
      downloadUrl: raw.browser_download_url,
      sha256: digest[1].toLowerCase(),
    },
  };
}

export function parseReleases(
  body: unknown,
  assetName = ENGINE_ASSET,
): ReleaseDetails[] {
  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const releases: ReleaseDetails[] = [];
  for (const raw of value as GithubRelease[]) {
    if (raw?.draft === true || typeof raw?.tag_name !== "string") continue;
    if (!isSafeTag(raw.tag_name)) continue;
    const selected = pickAsset(raw, assetName);
    releases.push({
      tag: raw.tag_name,
      version: raw.tag_name.replace(/^v/, ""),
      prerelease: raw.prerelease === true,
      publishedAt: typeof raw.published_at === "string" ? raw.published_at : "",
      assetBytes: selected?.bytes ?? 0,
      asset: selected?.asset ?? null,
    });
  }
  return releases.sort((a, b) => compareTags(b.tag, a.tag));
}

export function offered(
  releases: readonly Release[],
  preReleases: boolean,
  activeTag: string | null,
): Release | null {
  const allowed = releases
    .filter((release) => preReleases || !release.prerelease)
    .filter((release) => parseTag(release.tag) !== null)
    .toSorted((a, b) => compareTags(b.tag, a.tag));
  const newest = allowed[0] ?? null;
  if (!newest || (activeTag !== null && !isNewer(newest.tag, activeTag))) {
    return null;
  }
  return newest;
}

export function parseVersionOutput(output: string): {
  version: string | null;
  mlx: string | null;
} {
  const version = /^mlx-serve\s+(\S+)\s*$/m.exec(output)?.[1] ?? null;
  const mlx = /^mlx\s+(\S+)\s*$/m.exec(output)?.[1] ?? null;
  return { version, mlx };
}

export type FetchReleasesOptions = {
  token?: string | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  assetName?: string;
};

export async function fetchReleases(
  repo: string,
  options: FetchReleasesOptions = {},
): Promise<ReleaseDetails[]> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "1ctx-mlx-engine",
    "x-github-api-version": "2022-11-28",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetchFn(
    `https://api.github.com/repos/${repo}/releases?per_page=5`,
    { headers, signal },
  );
  if (!response.ok) {
    throw new Error(`github.com: HTTP ${response.status}`);
  }
  return parseReleases(await response.json(), options.assetName);
}
