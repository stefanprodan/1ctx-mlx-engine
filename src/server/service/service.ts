// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Options, optionsToArgs, parseCli } from "../cli.ts";
import { parseLaunchdArgs } from "../engine/config.ts";
import { macosVersion, osMajor } from "../host/info.ts";
import { tailscaleAddress } from "../lib/net.ts";
import {
  bootout,
  bootstrap,
  isLoaded,
  type LaunchdInfo,
  print as printLaunchd,
  reload,
} from "./launchd.ts";
import { agentBinary, type PlistSpec, plistPath } from "./plist.ts";

export const SERVICE_LABEL = "com.stefanprodan.1ctx-mlx-engine";
const SERVICE_PORT = 11235;
const HEALTH_ATTEMPTS = 60;

export class ServiceError extends Error {}

export interface ServiceFiles {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
}

export interface ServiceLaunchd {
  isLoaded(label: string): Promise<boolean>;
  reload(spec: PlistSpec, path: string): Promise<void>;
  bootout(label: string): Promise<void>;
  bootstrap(path: string): Promise<void>;
  print(label: string): Promise<LaunchdInfo | null>;
}

export interface ServiceDeps {
  home?: string;
  execPath?: string;
  uid?: number;
  osVersion?: () => string | null;
  defaultHostname?: () => string;
  write?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  probe?: (url: string) => Promise<string | null>;
  files?: ServiceFiles;
  launchd?: ServiceLaunchd;
}

const defaultFiles: ServiceFiles = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  read: async (path) => {
    try {
      return new Uint8Array(await readFile(path));
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

async function defaultProbe(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function resolveDeps(deps: ServiceDeps) {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const launchdDeps = { uid };
  return {
    home: deps.home ?? homedir(),
    execPath: deps.execPath ?? process.execPath,
    osVersion: deps.osVersion ?? macosVersion,
    defaultHostname:
      deps.defaultHostname ?? (() => tailscaleAddress() ?? "127.0.0.1"),
    write: deps.write ?? ((line: string) => console.log(line)),
    sleep:
      deps.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    probe: deps.probe ?? defaultProbe,
    files: deps.files ?? defaultFiles,
    launchd:
      deps.launchd ??
      ({
        isLoaded: (label) => isLoaded(label, launchdDeps),
        reload: (spec, path) => reload(spec, { ...launchdDeps, path }),
        bootout: (label) => bootout(label, launchdDeps),
        bootstrap: (path) => bootstrap(path, launchdDeps),
        print: (label) => printLaunchd(label, launchdDeps),
      } satisfies ServiceLaunchd),
  };
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.some(
    (argument) => argument === flag || argument.startsWith(`${flag}=`),
  );
}

function installOptions(argv: string[], home: string): Options {
  if (argv.includes("--once")) {
    throw new ServiceError("--once is not valid for service install");
  }
  const result = parseCli(argv);
  if (result.kind === "error") throw new ServiceError(result.message);
  if (result.kind !== "run") {
    throw new ServiceError("service install expects runtime flags");
  }
  const options = { ...result.options };
  if (!hasFlag(argv, "--db")) {
    options.dbPath = join(home, ".1ctx-mlx-engine", "engine.db");
  }
  if (!hasFlag(argv, "--model-dir")) {
    options.modelDir = join(home, ".1ctx-mlx-engine", "models");
  }
  if (!hasFlag(argv, "--log-file")) {
    options.logFile = join(home, ".1ctx-mlx-engine", "1ctx-mlx-engine.log");
  }
  return options;
}

function serviceSpec(
  options: Options,
  home: string,
  execPath: string,
): PlistSpec {
  const crashLog = join(home, ".1ctx-mlx-engine", "launchd.log");
  return {
    label: SERVICE_LABEL,
    programArguments: [agentBinary(execPath), ...optionsToArgs(options)],
    workingDirectory: join(home, ".1ctx-mlx-engine"),
    environmentVariables: {
      HOME: home,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    },
    runAtLoad: true,
    keepAlive: true,
    throttleInterval: 5,
    standardOutPath: crashLog,
    standardErrorPath: crashLog,
  };
}

function serviceUrl(options: Options, defaultHostname: string): string {
  let hostname = options.listen?.hostname ?? defaultHostname;
  if (hostname === "0.0.0.0" || hostname === "::") hostname = "127.0.0.1";
  if (hostname.includes(":")) hostname = `[${hostname}]`;
  return `http://${hostname}:${options.listen?.port ?? SERVICE_PORT}`;
}

async function waitForService(
  url: string,
  resolved: ReturnType<typeof resolveDeps>,
): Promise<string> {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
    const version = await resolved.probe(`${url}/api/snapshot`);
    if (version !== null) return version;
    await resolved.sleep(1_000);
  }
  throw new ServiceError(`1ctx-mlx-engine did not answer at ${url}`);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function optionsFromPlist(bytes: Uint8Array | null): Options | null {
  if (bytes === null) return null;
  const args = parseLaunchdArgs(decode(bytes)).slice(1);
  const result = parseCli(args);
  return result.kind === "run" ? result.options : null;
}

async function install(argv: string[], deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const version = resolved.osVersion();
  if (version === null || (osMajor(version) ?? 0) < 26) {
    throw new ServiceError(
      `macOS 26 or newer is required; found ${version ?? "unknown"}`,
    );
  }

  const restart = argv.includes("--restart");
  const flags = argv.filter((argument) => argument !== "--restart");
  const options = installOptions(flags, resolved.home);
  const path = plistPath(SERVICE_LABEL, resolved.home);
  if ((await resolved.launchd.isLoaded(SERVICE_LABEL)) && !restart) {
    throw new ServiceError("service is running; use install --restart");
  }

  await resolved.files.mkdir(join(resolved.home, ".1ctx-mlx-engine"));
  await resolved.launchd.reload(
    serviceSpec(options, resolved.home, resolved.execPath),
    path,
  );
  const url = serviceUrl(options, resolved.defaultHostname());
  const runningVersion = await waitForService(url, resolved);
  resolved.write(`1ctx-mlx-engine ${runningVersion} up at ${url}`);
}

async function start(deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const path = plistPath(SERVICE_LABEL, resolved.home);
  const bytes = await resolved.files.read(path);
  if (bytes === null) throw new ServiceError("service is not installed");
  if (await resolved.launchd.isLoaded(SERVICE_LABEL)) {
    throw new ServiceError("service is already running");
  }
  const options = optionsFromPlist(bytes);
  if (options === null) throw new ServiceError("service plist is invalid");
  await resolved.launchd.bootstrap(path);
  const url = serviceUrl(options, resolved.defaultHostname());
  const version = await waitForService(url, resolved);
  resolved.write(`1ctx-mlx-engine ${version} up at ${url}`);
}

async function stop(deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  await resolved.launchd.bootout(SERVICE_LABEL);
  resolved.write(`stopped ${SERVICE_LABEL}`);
}

async function restart(deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const path = plistPath(SERVICE_LABEL, resolved.home);
  const bytes = await resolved.files.read(path);
  const options = optionsFromPlist(bytes);
  if (options === null) throw new ServiceError("service is not installed");
  await resolved.launchd.bootout(SERVICE_LABEL);
  await resolved.launchd.bootstrap(path);
  const url = serviceUrl(options, resolved.defaultHostname());
  const version = await waitForService(url, resolved);
  resolved.write(`1ctx-mlx-engine ${version} up at ${url}`);
}

async function status(deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const path = plistPath(SERVICE_LABEL, resolved.home);
  const bytes = await resolved.files.read(path);
  const arguments_ = bytes ? parseLaunchdArgs(decode(bytes)) : [];
  const options = optionsFromPlist(bytes);
  const info = await resolved.launchd.print(SERVICE_LABEL);
  const url = options ? serviceUrl(options, resolved.defaultHostname()) : null;
  const version =
    info && url ? await resolved.probe(`${url}/api/snapshot`) : null;
  const lines = [
    `label: ${SERVICE_LABEL}`,
    `state: ${info?.state ?? (bytes ? "stopped" : "not installed")}`,
    `pid: ${info?.pid ?? "-"}`,
    `binary: ${info?.program ?? arguments_[0] ?? "-"}`,
    `version: ${version ?? "-"}`,
    `url: ${url ?? "-"}`,
  ];
  resolved.write(lines.join("\n"));
}

async function uninstall(purge: boolean, deps: ServiceDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const path = plistPath(SERVICE_LABEL, resolved.home);
  const bytes = await resolved.files.read(path);
  const options = optionsFromPlist(bytes);
  await resolved.launchd.bootout(SERVICE_LABEL);
  await resolved.files.remove(path);
  await resolved.files.remove(`${path}.tmp`);

  if (purge) {
    const dbPath =
      options?.dbPath ?? join(resolved.home, ".1ctx-mlx-engine", "engine.db");
    const logPath =
      options?.logFile ??
      join(resolved.home, ".1ctx-mlx-engine", "1ctx-mlx-engine.log");
    for (const candidate of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
      if (candidate !== ":memory:") await resolved.files.remove(candidate);
    }
    const crashLog = join(resolved.home, ".1ctx-mlx-engine", "launchd.log");
    for (const candidate of [
      logPath,
      `${logPath}.1`,
      crashLog,
      `${crashLog}.1`,
    ]) {
      if (candidate !== "off" && candidate !== "off.1") {
        await resolved.files.remove(candidate);
      }
    }
  }
  resolved.write(
    `uninstalled ${SERVICE_LABEL}${purge ? " and purged data" : ""}`,
  );
}

export async function runService(
  argv: string[],
  deps: ServiceDeps = {},
): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "install") return install(rest, deps);
  if (command === "status" && rest.length === 0) return status(deps);
  if (command === "start" && rest.length === 0) return start(deps);
  if (command === "stop" && rest.length === 0) return stop(deps);
  if (command === "restart" && rest.length === 0) return restart(deps);
  if (command === "uninstall") {
    if (rest.length === 0) return uninstall(false, deps);
    if (rest.length === 1 && rest[0] === "--purge") {
      return uninstall(true, deps);
    }
  }
  throw new ServiceError(
    "usage: 1ctx-mlx-engine service install|status|start|stop|restart|uninstall",
  );
}
