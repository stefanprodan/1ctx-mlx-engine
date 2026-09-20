// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The benchmark runs over the History db handle: one row per run, holding
// the run as the page reads it, and one row per measured turn.

import type { Database } from "bun:sqlite";
import {
  type Benchmark,
  type BenchmarkTurn,
  SUSPECT_REASONS,
} from "../../shared/benchmark.ts";

type RunRow = { id: number; record: string };

type TurnRow = {
  repetition: number;
  turn: number;
  prompt_n: number;
  cached_n: number;
  prompt_ms: number;
  predicted_n: number;
  predicted_ms: number;
  tokenize_ms: number;
  finish_reason: string | null;
};

// A stored run keeps the reasons of the build that made it; one this build
// no longer has would reach the page as a flag nobody can explain.
function read(row: RunRow): Benchmark {
  const benchmark = JSON.parse(row.record) as Benchmark;
  const known = SUSPECT_REASONS as readonly string[];
  return {
    ...benchmark,
    id: row.id,
    suspect: (benchmark.suspect ?? []).filter((r) => known.includes(r)),
  };
}

export class BenchmarkStore {
  constructor(private readonly db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      record TEXT NOT NULL
    )`);
    // the handle has foreign keys on: deleting a run takes its turns along
    this.db.run(`CREATE TABLE IF NOT EXISTS benchmark_turns (
      benchmark_id INTEGER NOT NULL
        REFERENCES benchmarks(id) ON DELETE CASCADE,
      repetition INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      prompt_n INTEGER NOT NULL,
      cached_n INTEGER NOT NULL,
      prompt_ms REAL NOT NULL,
      predicted_n INTEGER NOT NULL,
      predicted_ms REAL NOT NULL,
      tokenize_ms REAL NOT NULL,
      finish_reason TEXT,
      PRIMARY KEY (benchmark_id, repetition, turn)
    )`);
  }

  // A run this program did not finish can never finish: nothing resumes it.
  interruptRunning(now: number): number {
    const rows = this.db
      .query("SELECT id, record FROM benchmarks WHERE status = 'running'")
      .all() as RunRow[];
    for (const row of rows) {
      const benchmark = JSON.parse(row.record) as Benchmark;
      this.save({
        ...benchmark,
        id: row.id,
        status: "interrupted",
        finishedAt: now,
      });
    }
    return rows.length;
  }

  create(benchmark: Omit<Benchmark, "id">): Benchmark {
    const row = this.db
      .query(
        `INSERT INTO benchmarks (status, started_at, record)
         VALUES (?, ?, '{}') RETURNING id`,
      )
      .get(benchmark.status, benchmark.startedAt) as { id: number };
    return this.save({ ...benchmark, id: row.id });
  }

  save(benchmark: Benchmark): Benchmark {
    this.db
      .query("UPDATE benchmarks SET status = ?, record = ? WHERE id = ?")
      .run(benchmark.status, JSON.stringify(benchmark), benchmark.id);
    return benchmark;
  }

  // the last turn and the final status land together or not at all
  finish(benchmark: Benchmark): Benchmark {
    return this.db.transaction(() => this.save(benchmark))();
  }

  addTurn(id: number, t: BenchmarkTurn) {
    this.db
      .query(
        `INSERT OR REPLACE INTO benchmark_turns VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.repetition,
        t.turn,
        t.promptN,
        t.cachedN,
        t.promptMs,
        t.predictedN,
        t.predictedMs,
        t.tokenizeMs,
        t.finishReason,
      );
  }

  get(id: number): Benchmark | null {
    const row = this.db
      .query("SELECT id, record FROM benchmarks WHERE id = ?")
      .get(id) as RunRow | null;
    return row ? read(row) : null;
  }

  list(): Benchmark[] {
    const rows = this.db
      .query(
        "SELECT id, record FROM benchmarks ORDER BY started_at DESC, id DESC",
      )
      .all() as RunRow[];
    return rows.map(read);
  }

  turns(id: number): BenchmarkTurn[] {
    const rows = this.db
      .query(
        `SELECT repetition, turn, prompt_n, cached_n, prompt_ms, predicted_n,
                predicted_ms, tokenize_ms, finish_reason
         FROM benchmark_turns WHERE benchmark_id = ?
         ORDER BY repetition, turn`,
      )
      .all(id) as TurnRow[];
    return rows.map((r) => ({
      repetition: r.repetition,
      turn: r.turn,
      promptN: r.prompt_n,
      cachedN: r.cached_n,
      promptMs: r.prompt_ms,
      predictedN: r.predicted_n,
      predictedMs: r.predicted_ms,
      tokenizeMs: r.tokenize_ms,
      finishReason: r.finish_reason,
    }));
  }

  remove(id: number): boolean {
    return (
      this.db.query("DELETE FROM benchmarks WHERE id = ?").run(id).changes > 0
    );
  }
}
