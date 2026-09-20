// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { EngineConfig, InstallRecord, OperationKind } from "./manage.ts";
import type { CachedReleaseCheck } from "./release.ts";

export type EngineJournal = {
  op: OperationKind;
  tag: string | null;
  step: string;
  previousPlist: string | null;
  at: number;
};

export type StoredConfig = {
  applied: EngineConfig | null;
  pending: EngineConfig | null;
};

export type StoredInstalls = {
  active: InstallRecord | null;
  previous: InstallRecord | null;
};

type ValueRow = { value: string | null };
type ConfigRow = { applied: string | null; pending: string | null };
type InstallRow = { slot: "active" | "previous"; record: string };

function decode<T>(value: string | null | undefined): T | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class EngineStore {
  constructor(private readonly db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      applied TEXT,
      pending TEXT
    )`);
    this.db.run("INSERT OR IGNORE INTO engine_config (id) VALUES (1)");
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pre_releases INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run("INSERT OR IGNORE INTO engine_settings (id) VALUES (1)");
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_ownership (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      managed INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run("INSERT OR IGNORE INTO engine_ownership (id) VALUES (1)");
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_installs (
      slot TEXT PRIMARY KEY CHECK (slot IN ('active', 'previous')),
      record TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_journal (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS engine_release_checks (
      repo TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }

  config(): StoredConfig {
    const row = this.db
      .query("SELECT applied, pending FROM engine_config WHERE id = 1")
      .get() as ConfigRow;
    return {
      applied: decode<EngineConfig>(row.applied),
      pending: decode<EngineConfig>(row.pending),
    };
  }

  setApplied(config: EngineConfig | null) {
    this.db
      .query("UPDATE engine_config SET applied = $value WHERE id = 1")
      .run({ value: config === null ? null : JSON.stringify(config) });
  }

  setPending(config: EngineConfig | null) {
    this.db
      .query("UPDATE engine_config SET pending = $value WHERE id = 1")
      .run({ value: config === null ? null : JSON.stringify(config) });
  }

  commitPending(): EngineConfig | null {
    this.db.run(
      "UPDATE engine_config SET applied = pending, pending = NULL WHERE id = 1",
    );
    return this.config().applied;
  }

  preReleases(): boolean {
    const row = this.db
      .query("SELECT pre_releases AS value FROM engine_settings WHERE id = 1")
      .get() as { value: number };
    return row.value === 1;
  }

  setPreReleases(value: boolean) {
    this.db
      .query("UPDATE engine_settings SET pre_releases = $value WHERE id = 1")
      .run({ value: value ? 1 : 0 });
  }

  managed(): boolean {
    const row = this.db
      .query("SELECT managed AS value FROM engine_ownership WHERE id = 1")
      .get() as { value: number };
    return row.value === 1;
  }

  setManaged(value: boolean) {
    this.db
      .query("UPDATE engine_ownership SET managed = $value WHERE id = 1")
      .run({ value: value ? 1 : 0 });
  }

  installs(): StoredInstalls {
    const rows = this.db
      .query("SELECT slot, record FROM engine_installs")
      .all() as InstallRow[];
    const find = (slot: InstallRow["slot"]) =>
      decode<InstallRecord>(rows.find((row) => row.slot === slot)?.record);
    return { active: find("active"), previous: find("previous") };
  }

  setInstalls(active: InstallRecord | null, previous: InstallRecord | null) {
    const replace = this.db.query(
      `INSERT OR REPLACE INTO engine_installs (slot, record)
       VALUES ($slot, $record)`,
    );
    const remove = this.db.query(
      "DELETE FROM engine_installs WHERE slot = $slot",
    );
    this.db.transaction(() => {
      for (const [slot, record] of [
        ["active", active],
        ["previous", previous],
      ] as const) {
        if (record === null) remove.run({ slot });
        else replace.run({ slot, record: JSON.stringify(record) });
      }
    })();
  }

  journal(): EngineJournal | null {
    const row = this.db
      .query("SELECT value FROM engine_journal WHERE id = 1")
      .get() as ValueRow | null;
    return decode<EngineJournal>(row?.value);
  }

  setJournal(value: EngineJournal | null) {
    if (value === null) {
      this.db.run("DELETE FROM engine_journal WHERE id = 1");
      return;
    }
    this.db
      .query(
        `INSERT OR REPLACE INTO engine_journal (id, value)
         VALUES (1, $value)`,
      )
      .run({ value: JSON.stringify(value) });
  }

  releaseCheck(repo: string): CachedReleaseCheck | null {
    const row = this.db
      .query("SELECT value FROM engine_release_checks WHERE repo = $repo")
      .get({ repo }) as ValueRow | null;
    return decode<CachedReleaseCheck>(row?.value);
  }

  setReleaseCheck(repo: string, check: CachedReleaseCheck | null) {
    if (check === null) {
      this.db
        .query("DELETE FROM engine_release_checks WHERE repo = $repo")
        .run({ repo });
      return;
    }
    this.db
      .query(
        `INSERT OR REPLACE INTO engine_release_checks (repo, value)
         VALUES ($repo, $value)`,
      )
      .run({ repo, value: JSON.stringify(check) });
  }
}
