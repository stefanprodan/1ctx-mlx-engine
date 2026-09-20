// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { parseLaunchdArgs } from "../engine/config.ts";
import { rotateStopped } from "../lib/log.ts";
import {
  plistPath as defaultPlistPath,
  type PlistSpec,
  renderPlist,
} from "./plist.ts";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Spawn = (argv: string[]) => Promise<SpawnResult>;

export interface LaunchdInfo {
  state: string | null;
  pid: number | null;
  program: string | null;
  lastExitCode: number | null;
}

export interface LaunchdFiles {
  mkdir(path: string): Promise<void>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface LaunchdDeps {
  spawn?: Spawn;
  uid?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  files?: LaunchdFiles;
  // is this pid still a process; injected so tests never signal one
  alive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is somebody else's live process; only ESRCH means gone
    return (error as { code?: string }).code === "EPERM";
  }
}

export interface ReloadDeps extends LaunchdDeps {
  home?: string;
  path?: string;
  rotationThreshold?: number;
  onBeforeBootout?: (previousPlist: Uint8Array | null) => void | Promise<void>;
  rotate?: (path: string, threshold?: number) => Promise<boolean>;
}

const WAIT_MS = 60_000;
const POLL_MS = 1_000;
const BOOTSTRAP_RETRY_MS = 1_000;
const LAUNCHD_LOG_LIMIT = 8 * 1024 * 1024;

async function bunSpawn(argv: string[]): Promise<SpawnResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const defaultFiles: LaunchdFiles = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  write: async (path, data) => {
    await writeFile(path, data);
  },
  read: async (path) => new Uint8Array(await readFile(path)),
  rename,
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

function dependencies(deps: LaunchdDeps) {
  return {
    spawn: deps.spawn ?? bunSpawn,
    uid: deps.uid ?? process.getuid?.() ?? 0,
    sleep:
      deps.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    now: deps.now ?? (() => Date.now()),
    files: deps.files ?? defaultFiles,
  };
}

function target(label: string, uid: number): string {
  return `gui/${uid}/${label}`;
}

function failure(argv: string[], result: SpawnResult): Error {
  const detail = result.stderr || result.stdout || `exit ${result.code}`;
  return new Error(`${argv.join(" ")}: ${detail}`);
}

function parseInteger(output: string, name: string): number | null {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(-?\\d+)\\s*$`, "im").exec(
    output,
  );
  return match ? Number(match[1]) : null;
}

export function parseLaunchdPrint(output: string): LaunchdInfo {
  const state = /^\s*state\s*=\s*([^\s]+)\s*$/im.exec(output)?.[1] ?? null;
  const program =
    /^\s*program\s*=\s*(.+?)\s*$/im.exec(output)?.[1]?.replace(/^"|"$/g, "") ??
    null;
  return {
    state,
    pid: parseInteger(output, "pid"),
    program,
    lastExitCode: parseInteger(output, "last exit code"),
  };
}

export async function print(
  label: string,
  deps: LaunchdDeps = {},
): Promise<LaunchdInfo | null> {
  const resolved = dependencies(deps);
  const argv = ["launchctl", "print", target(label, resolved.uid)];
  const result = await resolved.spawn(argv);
  if (result.code !== 0) return null;
  return parseLaunchdPrint(result.stdout);
}

export async function isLoaded(
  label: string,
  deps: LaunchdDeps = {},
): Promise<boolean> {
  return (await print(label, deps)) !== null;
}

// Gone means both: launchd has dropped the label, and the process it ran
// has exited. launchd forgets the job while mlx-serve is still shutting
// down and holding the port, and a bootstrap into that window fails.
export async function waitForExit(
  label: string,
  deps: LaunchdDeps = {},
  pid: number | null = null,
): Promise<void> {
  const resolved = dependencies(deps);
  const alive = deps.alive ?? processAlive;
  const gone = async () =>
    !(await isLoaded(label, deps)) && (pid === null || !alive(pid));
  const started = resolved.now();
  while (resolved.now() - started < WAIT_MS) {
    if (await gone()) return;
    await resolved.sleep(POLL_MS);
  }
  if (await gone()) return;
  throw new Error(`timed out waiting for ${label} to exit`);
}

export async function bootout(
  label: string,
  deps: LaunchdDeps = {},
): Promise<void> {
  const resolved = dependencies(deps);
  if (!(await isLoaded(label, deps))) return;
  // read before the bootout: afterwards launchd no longer knows the pid
  const pid = (await print(label, deps))?.pid ?? null;
  const argv = ["launchctl", "bootout", target(label, resolved.uid)];
  const result = await resolved.spawn(argv);
  if (result.code !== 0) throw failure(argv, result);
  await waitForExit(label, deps, pid);
}

export async function bootstrap(
  path: string,
  deps: LaunchdDeps = {},
): Promise<void> {
  const resolved = dependencies(deps);
  const argv = ["launchctl", "bootstrap", `gui/${resolved.uid}`, path];
  let result = await resolved.spawn(argv);
  if (
    result.code !== 0 &&
    `${result.stdout}\n${result.stderr}`.includes("Bootstrap failed: 5")
  ) {
    await resolved.sleep(BOOTSTRAP_RETRY_MS);
    result = await resolved.spawn(argv);
  }
  if (result.code !== 0) throw failure(argv, result);
}

export async function kickstart(
  label: string,
  deps: LaunchdDeps = {},
): Promise<void> {
  const resolved = dependencies(deps);
  const argv = ["launchctl", "kickstart", "-k", target(label, resolved.uid)];
  const result = await resolved.spawn(argv);
  if (result.code !== 0) throw failure(argv, result);
}

export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  deps: Pick<LaunchdDeps, "files"> = {},
): Promise<void> {
  const files = deps.files ?? defaultFiles;
  const staged = `${path}.atomic.tmp`;
  await files.mkdir(dirname(path));
  try {
    await files.write(staged, data);
    await files.rename(staged, path);
  } catch (error) {
    await files.remove(staged).catch(() => undefined);
    throw error;
  }
}

export async function reload(
  spec: PlistSpec,
  deps: ReloadDeps = {},
): Promise<void> {
  const resolved = dependencies(deps);
  const path =
    deps.path ?? defaultPlistPath(spec.label, deps.home ?? homedir());
  const staged = `${path}.tmp`;
  const rendered = renderPlist(spec);
  let previous: Uint8Array | null = null;

  try {
    await resolved.files.mkdir(dirname(path));
    await resolved.files.write(staged, rendered);
    const bytes = await resolved.files.read(staged);
    const decoded = new TextDecoder().decode(bytes);
    if (decoded !== rendered) {
      throw new Error(`staged plist did not read back intact: ${staged}`);
    }
    const parsed = parseLaunchdArgs(decoded);
    if (
      parsed.length !== spec.programArguments.length ||
      parsed.some(
        (argument, index) => argument !== spec.programArguments[index],
      )
    ) {
      throw new Error(`staged plist has invalid ProgramArguments: ${staged}`);
    }
    try {
      previous = await resolved.files.read(path);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      previous = null;
    }
  } catch (error) {
    await resolved.files.remove(staged).catch(() => undefined);
    throw error;
  }

  await deps.onBeforeBootout?.(previous);
  await bootout(spec.label, deps);
  await resolved.files.rename(staged, path);

  const rotate = deps.rotate ?? rotateStopped;
  const paths = new Set(
    [spec.standardOutPath, spec.standardErrorPath].filter(
      (value): value is string => value !== undefined,
    ),
  );
  for (const logPath of paths) {
    await rotate(logPath, deps.rotationThreshold ?? LAUNCHD_LOG_LIMIT);
  }
  await bootstrap(path, deps);
}
