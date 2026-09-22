// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  EngineConfig,
  InstallRecord,
  OperationKind,
  ServiceBody,
  ServiceState,
} from "../../../shared/engine.ts";
import { describeError } from "../../lib/fetch.ts";
import { errorFields } from "../../lib/log.ts";
import type { LaunchdInfo } from "../../service/launchd.ts";
import type { PlistSpec } from "../../service/plist.ts";
import { configToArgs } from "../config.ts";
import type { EngineJournal } from "../store.ts";
import {
  EngineManagerError,
  engineLog,
  launchdDeps,
  launchdLog,
  MANAGED_LABEL,
  type ManagerContext,
  plist,
  SERVICE_SETTLE_READS,
  VERIFY_POLL_MS,
  versionDir,
} from "./context.ts";

type RestoreJournal = (
  context: ManagerContext,
  journal: EngineJournal,
  previous: InstallRecord | null,
) => Promise<boolean>;

type Prune = (context: ManagerContext) => Promise<void>;

export async function defaultPortProbe(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void Bun.connect({
      hostname: host === "0.0.0.0" ? "127.0.0.1" : host,
      port,
      socket: {
        open(socket) {
          // answer first: end() runs the close handler synchronously,
          // which would report a port that just accepted us as free
          finish(true);
          socket.end();
        },
        data() {},
        close() {
          finish(false);
        },
        error() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}

export async function defaultSpawn(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function serviceState(
  info: LaunchdInfo | null,
  readAt: number,
): ServiceState {
  if (info?.state === "running") {
    return {
      state: "running",
      pid: info.pid,
      lastExitCode: info.lastExitCode,
      readAt,
    };
  }
  return {
    state:
      info && info.lastExitCode !== null && info.lastExitCode !== 0
        ? "crashed"
        : "stopped",
    pid: info?.pid ?? null,
    lastExitCode: info?.lastExitCode ?? null,
    readAt,
  };
}

export async function service(context: ManagerContext, op: ServiceBody["op"]) {
  const path = plist(context);
  if (op === "start") {
    await context.bootstrapFn(path, launchdDeps(context));
  } else if (op === "stop") {
    await context.bootoutFn(MANAGED_LABEL, launchdDeps(context));
  } else {
    await context.kickstartFn(MANAGED_LABEL, launchdDeps(context));
  }
  await refreshService(context);
  // bootstrap answers before launchd has spawned the job, so a read
  // right behind it still says "not running" about an engine that
  // is up a moment later
  for (
    let attempt = 0;
    op !== "stop" &&
    context.cachedService?.state !== "running" &&
    attempt < SERVICE_SETTLE_READS;
    attempt++
  ) {
    await context.sleep(VERIFY_POLL_MS);
    await refreshService(context);
  }
}

export async function activate(
  context: ManagerContext,
  record: InstallRecord,
  config: EngineConfig,
  kind: "install" | "upgrade",
  prune: Prune,
  restoreJournal: RestoreJournal,
) {
  const previous = context.deps.store.installs();
  try {
    // Before the swap, so a crash after it still knows what the job was
    // started from: the reconcile commits this row.
    context.deps.store.setPending(config);
    await reloadConfig(context, record, config, kind);
    context.deps.store.setInstalls(record, previous.active);
    context.deps.store.setApplied(config);
    context.deps.store.setPending(null);
    context.deps.store.setManaged(true);
    context.deps.store.setJournal(null);
    await prune(context);
    context.deps.log.info("operation done", { op: kind, tag: record.tag });
  } catch (error) {
    // A Cancel caught before the journal row: the job was never
    // touched, so there is nothing to restore and nothing failed.
    const cancelled =
      context.abort?.signal.aborted === true &&
      context.operation?.phase !== "restarting";
    if (cancelled) {
      context.deps.store.setPending(null);
      throw error;
    }
    await activationFailure(
      context,
      kind,
      record.tag,
      error,
      previous.active,
      config,
      restoreJournal,
    );
    throw error;
  }
}

export async function reloadConfig(
  context: ManagerContext,
  record: InstallRecord,
  config: EngineConfig,
  kind: OperationKind,
) {
  for (const directory of config.modelDirs) {
    await mkdir(directory, { recursive: true });
  }
  await mkdir(dirname(launchdLog(context)), { recursive: true });
  const value = spec(context, record, config);
  await context.reloadFn(value, {
    ...launchdDeps(context),
    path: plist(context),
    home: context.home,
    onBeforeBootout: async (previous) => {
      // the last moment a Cancel can still mean "nothing happened"
      if (context.abort?.signal.aborted) {
        throw new EngineManagerError(409, "cancelled");
      }
      await markLog(context);
      context.setPhase(
        "restarting",
        context.operation?.totalBytes ?? 0,
        context.operation?.totalBytes ?? 0,
      );
      context.deps.store.setJournal({
        op: kind,
        tag: record.tag,
        step: "reload",
        previousPlist: previous ? new TextDecoder().decode(previous) : null,
        at: context.now(),
      });
    },
  });
  if (
    !(await verify(context, join(versionDir(context, record.tag), "mlx-serve")))
  ) {
    throw new Error(`mlx-serve ${record.version} failed verification`);
  }
  await refreshService(context);
}

export async function verify(
  context: ManagerContext,
  binary: string,
): Promise<boolean> {
  const started = context.now();
  while (context.now() - started <= context.verifyTimeoutMs) {
    const first = await context.printFn(MANAGED_LABEL, launchdDeps(context));
    if (
      first?.state === "running" &&
      first.program === binary &&
      first.pid !== null
    ) {
      await context.sleep(context.verifyStableMs);
      const second = await context.printFn(MANAGED_LABEL, launchdDeps(context));
      if (
        second?.state === "running" &&
        second.program === binary &&
        second.pid === first.pid &&
        (await context.deps.health())
      ) {
        context.cachedService = serviceState(second, context.now());
        return true;
      }
    }
    await context.sleep(VERIFY_POLL_MS);
  }
  await refreshService(context);
  return false;
}

export async function activationFailure(
  context: ManagerContext,
  kind: OperationKind,
  tag: string | null,
  error: unknown,
  previous: InstallRecord | null,
  config: EngineConfig,
  restoreJournal: RestoreJournal,
) {
  let outcome = "nothing is serving";
  // Read before the rollback: the restored engine writes its own start
  // banner to the same file and would push the reason out of the tail.
  const tail = await logTail(context);
  // no journal: the failure came before the job was touched
  let restored = true;
  try {
    const journal = context.deps.store.journal();
    if (journal) restored = await restoreJournal(context, journal, previous);
    if (previous) {
      const serving = journal
        ? restored
        : await verify(
            context,
            join(versionDir(context, previous.tag), "mlx-serve"),
          );
      if (serving) {
        outcome =
          kind === "rollback" || kind === "apply"
            ? `still on ${previous.version}, serving again`
            : `rolled back to ${previous.version}, serving again`;
      }
    } else {
      context.deps.store.setManaged(false);
      context.deps.store.setInstalls(null, null);
      context.deps.store.setApplied(null);
    }
  } catch (rollbackError) {
    restored = false;
    context.deps.log.error("rollback failed", {
      op: kind,
      ...errorFields(rollbackError),
    });
  }
  // Only a tree this operation staged is discarded. A failed rollback
  // was heading for the previous build, which is still the backup the
  // page offers: deleting it would leave a Rollback button over nothing.
  const staged = kind === "install" || kind === "upgrade";
  if (staged && tag && (!previous || tag !== previous.tag)) {
    await rm(versionDir(context, tag), { recursive: true, force: true });
  }
  context.deps.store.setPending(null);
  // An unrestored engine keeps its journal row: the next start tries
  // again, which is all that stands between this and an engine that
  // stays down.
  if (restored) context.deps.store.setJournal(null);
  context.failure = {
    kind,
    tag,
    message: describeError(error),
    outcome,
    logTail: tail,
    at: context.now(),
  };
  context.deps.log.error("operation failed", {
    op: kind,
    tag: tag ?? undefined,
    restored,
    ...errorFields(error),
  });
  void config;
}

export function spec(
  context: ManagerContext,
  record: InstallRecord,
  config: EngineConfig,
): PlistSpec {
  const directory = versionDir(context, record.tag);
  const binary = join(directory, "mlx-serve");
  return {
    label: MANAGED_LABEL,
    programArguments: [
      binary,
      ...configToArgs(config, engineLog(context, config.port)),
    ],
    workingDirectory: context.home,
    environmentVariables: {
      HOME: context.home,
      PATH: `/usr/bin:/bin:${directory}`,
    },
    runAtLoad: true,
    keepAlive: true,
    throttleInterval: 10,
    processType: "Interactive",
    standardOutPath: launchdLog(context),
    standardErrorPath: launchdLog(context),
  };
}

export async function refreshService(context: ManagerContext) {
  const info = await context.printFn(MANAGED_LABEL, launchdDeps(context));
  context.cachedService = serviceState(info, context.now());
}

// Where the engine's launchd log ended when the swap began: a failure
// tails only what the failed job wrote, not the banner of the run
// before it. The reload may rotate the file, which resets the mark.
export async function markLog(context: ManagerContext) {
  try {
    context.logMark = (await stat(launchdLog(context))).size;
  } catch {
    context.logMark = 0;
  }
}

export async function logTail(context: ManagerContext): Promise<string> {
  try {
    const bytes = await readFile(launchdLog(context));
    const from = context.logMark <= bytes.length ? context.logMark : 0;
    const lines = new TextDecoder().decode(bytes.subarray(from)).split("\n");
    // a crash loop says the same thing every ten seconds; once is
    // enough
    return lines
      .filter((line, i) => line !== "" && line !== lines[i - 2])
      .filter((line, i, kept) => line !== kept[i - 1])
      .slice(-20)
      .join("\n");
  } catch {
    return "";
  }
}
