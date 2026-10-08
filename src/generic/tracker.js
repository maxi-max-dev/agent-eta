import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { forecastRun } from '../core/estimator.js';

export const STALE_AFTER_MS = 60_000;
export const MIN_HISTORY = 3;
export const TASK_CLASSES = ['coding', 'research', 'review', 'writing', 'other'];
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function defaultDatabasePath() {
  return process.env.AGENTWHEN_DB || resolve('.agentwhen', 'runs.sqlite');
}

/** Local, opt-in metadata only. No prompts, commands, outputs or provider logs. */
export class AgentWhen {
  constructor({ filename = defaultDatabasePath(), clock = () => Date.now() } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
    this.clock = clock;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agentwhen_runs (
        id TEXT PRIMARY KEY, profile TEXT NOT NULL, task_class TEXT NOT NULL,
        status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        active_ms REAL NOT NULL DEFAULT 0, active_since INTEGER,
        last_seen INTEGER NOT NULL, history_eligible INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS agentwhen_cohort
        ON agentwhen_runs(profile, task_class, status, finished_at);
    `);
  }

  close() { this.db.close(); }

  now() {
    const value = Number(this.clock());
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid clock');
    return value;
  }

  start({ profile = 'default', taskClass = 'other' } = {}) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profile)) throw new Error('Profile must be a lowercase identifier (1–40 characters)');
    if (!TASK_CLASSES.includes(taskClass)) throw new Error(`Class must be one of: ${TASK_CLASSES.join(', ')}`);
    const now = this.now();
    const id = `aw-${randomUUID()}`;
    this.db.prepare(`INSERT INTO agentwhen_runs
      (id, profile, task_class, status, started_at, active_since, last_seen)
      VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(id, profile, taskClass, now, now, now);
    return this.status(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM agentwhen_runs WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown run ID');
    return row;
  }

  /** A read recomputes the estimate but never pretends to observe the agent. */
  status(id) { return this.project(this.get(id), this.now()); }

  list() {
    const now = this.now();
    return this.db.prepare('SELECT * FROM agentwhen_runs ORDER BY started_at DESC, rowid DESC LIMIT 50')
      .all().map(row => this.project(row, now));
  }

  ping(id) { return this.change(id, 'ping'); }
  pause(id) { return this.change(id, 'pause'); }
  resume(id) { return this.change(id, 'resume'); }
  finish(id, outcome = 'succeeded') {
    if (!TERMINAL.has(outcome)) throw new Error('Outcome must be succeeded, failed or cancelled');
    return this.change(id, outcome);
  }

  change(id, action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.get(id);
      const now = Math.max(this.now(), row.last_seen);
      // First terminal result wins, including duplicate or late deliveries.
      if (!TERMINAL.has(row.status)) {
        const active = row.active_ms + (row.status === 'running' ? Math.max(0, now - row.active_since) : 0);
        const eligible = row.history_eligible && !(row.status === 'running' && now - row.last_seen > STALE_AFTER_MS);
        let status = row.status;
        if (action === 'pause') status = 'paused';
        if (action === 'resume') status = 'running';
        if (TERMINAL.has(action)) status = action;
        this.db.prepare(`UPDATE agentwhen_runs SET status = ?, active_ms = ?, active_since = ?,
          last_seen = ?, finished_at = ?, history_eligible = ? WHERE id = ?`)
          .run(status, active, status === 'running' ? now : null, now,
            TERMINAL.has(status) ? now : null, Number(eligible), id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.status(id);
  }

  project(row, at) {
    const now = Math.max(at, row.last_seen);
    const activeMs = row.active_ms + (row.status === 'running' ? Math.max(0, now - row.active_since) : 0);
    const history = this.db.prepare(`SELECT active_ms FROM agentwhen_runs
      WHERE profile = ? AND task_class = ? AND status = 'succeeded'
        AND history_eligible = 1 AND active_ms > 0 AND finished_at <= ? AND id != ?
      ORDER BY finished_at DESC, rowid DESC LIMIT 200`)
      .all(row.profile, row.task_class, now, row.id)
      .map(item => ({ actualMinutes: item.active_ms / 60_000, taskClass: row.task_class }));
    const stale = row.status === 'running' && now - row.last_seen > STALE_AFTER_MS;
    let estimateStatus = TERMINAL.has(row.status) ? 'terminal'
      : row.status === 'paused' ? 'paused' : stale ? 'stale'
        : history.length < MIN_HISTORY ? 'cold_start' : 'experimental';
    let remaining = null;
    if (estimateStatus === 'experimental') {
      const forecast = forecastRun({
        state: { status: 'running', activeElapsedMs: activeMs, taskClass: row.task_class, steps: [] },
        history, now: new Date(now), seed: row.id,
      });
      remaining = { p20: forecast.lowerMinutes, p50: forecast.p50Minutes, p80: forecast.p80Minutes };
    }
    return {
      schema: 'agentwhen.status/1', runId: row.id, profile: row.profile,
      taskClass: row.task_class, status: row.status, estimateStatus,
      activeMinutes: Math.round(activeMs / 60_000 * 1000) / 1000,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      observedAt: new Date(row.last_seen).toISOString(), estimatedAt: new Date(now).toISOString(),
      historyCount: history.length, minimumHistory: MIN_HISTORY,
      historyEligible: Boolean(row.history_eligible) && !stale,
      remainingMinutes: remaining, calibrated: false,
    };
  }
}
