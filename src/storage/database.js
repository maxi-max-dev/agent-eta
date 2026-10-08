import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { sanitizeWorksetEvent, worksetEventPayload } from '../scopes/contract.js';
import { createWorksetState, reduceWorksetEvent } from '../scopes/projection.js';

const SCHEMA_VERSION = 7;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const WORKSET_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const SAFE_SCOPE_ATOM = /^[a-z][a-z0-9_]{0,63}$/;
const WORKSET_SOURCE_KINDS = new Set([
  'controlled_wrapper',
  'codex_goal_shadow',
  'explicit_project_shadow',
]);
const WORKSET_SOURCE_STATUSES = new Set([
  'contract_only',
  'verified_structural',
  'quarantined',
]);

function safeWorksetSource(input, worksetType) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WORKSET_INVALID_SOURCE');
  }
  const allowed = new Set([
    'provider',
    'sourceKind',
    'sourceStatus',
    'taskClass',
    'eligibleLargeTask',
  ]);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.size || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('WORKSET_INVALID_SOURCE_FIELDS');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('WORKSET_SOURCE_ACCESSOR_FIELD');
    }
  }
  if (input.provider !== 'codex') throw new TypeError('WORKSET_INVALID_SOURCE_PROVIDER');
  if (!WORKSET_SOURCE_KINDS.has(input.sourceKind)) {
    throw new TypeError('WORKSET_INVALID_SOURCE_KIND');
  }
  if (!WORKSET_SOURCE_STATUSES.has(input.sourceStatus)) {
    throw new TypeError('WORKSET_INVALID_SOURCE_STATUS');
  }
  if (typeof input.taskClass !== 'string' || !SAFE_SCOPE_ATOM.test(input.taskClass)) {
    throw new TypeError('WORKSET_INVALID_SOURCE_TASK_CLASS');
  }
  if (input.eligibleLargeTask !== null && typeof input.eligibleLargeTask !== 'boolean') {
    throw new TypeError('WORKSET_INVALID_SOURCE_ELIGIBILITY');
  }
  if (input.sourceKind === 'codex_goal_shadow' && worksetType !== 'task') {
    throw new TypeError('WORKSET_GOAL_SOURCE_REQUIRES_TASK');
  }
  if (input.sourceKind === 'explicit_project_shadow' && worksetType !== 'project') {
    throw new TypeError('WORKSET_PROJECT_SOURCE_REQUIRES_PROJECT');
  }
  if (input.sourceKind === 'controlled_wrapper' && input.sourceStatus !== 'contract_only') {
    throw new TypeError('WORKSET_CONTROLLED_SOURCE_CONTRACT_ONLY');
  }
  if (
    (input.sourceKind === 'codex_goal_shadow' || input.sourceKind === 'explicit_project_shadow')
    && !['verified_structural', 'quarantined'].includes(input.sourceStatus)
  ) {
    throw new TypeError('WORKSET_SHADOW_SOURCE_STATUS_INVALID');
  }
  return Object.freeze({
    provider: input.provider,
    sourceKind: input.sourceKind,
    sourceStatus: input.sourceStatus,
    taskClass: input.taskClass,
    eligibleLargeTask: input.eligibleLargeTask,
  });
}

function worksetEventPriority(kind) {
  return ({
    workset_declared: 0,
    workset_revised: 1,
    workset_status_changed: 2,
    workset_heartbeat: 3,
    workset_succeeded: 9,
    workset_failed: 9,
    workset_cancelled: 9,
  })[kind] ?? 8;
}

function compareWorksetEventOrder(left, right) {
  return Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || worksetEventPriority(left.kind) - worksetEventPriority(right.kind)
    || left.event_id.localeCompare(right.event_id);
}

function worksetStateSignature(state) {
  return {
    worksetId: state.worksetId,
    worksetType: state.worksetType,
    status: state.status,
    revision: state.revision,
    worksetClosed: state.worksetClosed,
    ownerTerminal: state.ownerTerminal,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    activeElapsedMs: state.activeElapsedMs,
    activeSinceAt: state.activeSinceAt,
    lastOccurredAt: state.lastOccurredAt,
    members: normalizedWorksetMembers(state.members ?? []),
    seenEventIds: [...new Set(state.seenEventIds ?? [])].toSorted(),
    lastEventId: state.lastEventId,
    reasonCode: state.reasonCode,
  };
}

function iso(value, code) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(code);
  return new Date(value).toISOString();
}

function normalizedWorksetMembers(members) {
  if (!Array.isArray(members)) throw new TypeError('WORKSET_MEMBERS_REQUIRED');
  return members.map((member) => ({
    memberId: member.memberId,
    childType: member.childType,
    childId: member.childId,
    orderIndex: Number(member.orderIndex),
    executionGroup: member.executionGroup ?? null,
    attachedAt: iso(member.attachedAt, 'WORKSET_INVALID_MEMBER_TIME'),
    detachedAt: member.detachedAt === null ? null : iso(member.detachedAt, 'WORKSET_INVALID_MEMBER_TIME'),
  })).toSorted((left, right) =>
    left.orderIndex - right.orderIndex || String(left.memberId).localeCompare(String(right.memberId)));
}

function storedMemberProjection(rows) {
  return rows.map((row) => ({
    memberId: row.member_id,
    childType: row.child_type,
    childId: row.child_type === 'run' ? row.child_run_id : row.child_workset_id,
    orderIndex: Number(row.order_index),
    executionGroup: row.execution_group ?? null,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at ?? null,
  })).toSorted((left, right) =>
    left.orderIndex - right.orderIndex || String(left.memberId).localeCompare(String(right.memberId)));
}

function finiteNullable(value, code) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(code);
  return Number(value);
}

function safeWorksetForecast(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WORKSET_INVALID_FORECAST');
  }
  const allowed = new Set([
    'mode',
    'status',
    'evidence',
    'lowerMinutes',
    'p50Minutes',
    'p80Minutes',
    'upperMinutes',
    'resumeLowerMinutes',
    'resumeUpperMinutes',
    'reasonCode',
    'worksetRevision',
    'jointP80Claimed',
    'raw',
  ]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('WORKSET_INVALID_FORECAST_FIELDS');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('WORKSET_FORECAST_ACCESSOR_FIELD');
    }
  }
  for (const key of ['mode', 'status', 'evidence', 'reasonCode']) {
    if (typeof input[key] !== 'string' || !SAFE_SCOPE_ATOM.test(input[key])) {
      throw new TypeError('WORKSET_INVALID_FORECAST_ATOM');
    }
  }
  if (!Number.isInteger(input.worksetRevision) || input.worksetRevision < 1) {
    throw new TypeError('WORKSET_INVALID_FORECAST_REVISION');
  }
  if (typeof input.jointP80Claimed !== 'boolean') {
    throw new TypeError('WORKSET_INVALID_FORECAST_CLAIM');
  }
  if (input.raw === null || typeof input.raw !== 'object' || Array.isArray(input.raw)) {
    throw new TypeError('WORKSET_INVALID_FORECAST_RAW');
  }
  const allowedRaw = new Set([
    'ownerTerminal',
    'blockingClockEta',
    'aggregationUsed',
    'unfinishedMemberCount',
    'parallelGroupCount',
    'upperBoundKind',
  ]);
  const raw = {};
  for (const key of Reflect.ownKeys(input.raw)) {
    if (typeof key !== 'string' || !allowedRaw.has(key)) {
      throw new TypeError('WORKSET_INVALID_FORECAST_RAW_FIELD');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input.raw, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError('WORKSET_FORECAST_RAW_ACCESSOR_FIELD');
    }
    const value = input.raw[key];
    if (typeof value === 'string') {
      if (!SAFE_SCOPE_ATOM.test(value)) throw new TypeError('WORKSET_INVALID_FORECAST_RAW_VALUE');
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) throw new TypeError('WORKSET_INVALID_FORECAST_RAW_VALUE');
    } else if (typeof value !== 'boolean') {
      throw new TypeError('WORKSET_INVALID_FORECAST_RAW_VALUE');
    }
    raw[key] = value;
  }
  const safe = {
    mode: input.mode,
    status: input.status,
    evidence: input.evidence,
    lowerMinutes: finiteNullable(input.lowerMinutes, 'WORKSET_INVALID_FORECAST_RANGE'),
    p50Minutes: finiteNullable(input.p50Minutes, 'WORKSET_INVALID_FORECAST_RANGE'),
    p80Minutes: finiteNullable(input.p80Minutes, 'WORKSET_INVALID_FORECAST_RANGE'),
    upperMinutes: finiteNullable(input.upperMinutes, 'WORKSET_INVALID_FORECAST_RANGE'),
    resumeLowerMinutes: finiteNullable(
      input.resumeLowerMinutes,
      'WORKSET_INVALID_FORECAST_RANGE',
    ),
    resumeUpperMinutes: finiteNullable(
      input.resumeUpperMinutes,
      'WORKSET_INVALID_FORECAST_RANGE',
    ),
    reasonCode: input.reasonCode,
    worksetRevision: input.worksetRevision,
    jointP80Claimed: input.jointP80Claimed,
    raw: Object.freeze(raw),
  };
  if (safe.lowerMinutes !== null && safe.p50Minutes !== null && safe.lowerMinutes > safe.p50Minutes) {
    throw new TypeError('WORKSET_INVALID_FORECAST_RANGE');
  }
  if (safe.p50Minutes !== null && safe.p80Minutes !== null && safe.p50Minutes > safe.p80Minutes) {
    throw new TypeError('WORKSET_INVALID_FORECAST_RANGE');
  }
  if (
    safe.resumeLowerMinutes !== null
    && safe.resumeUpperMinutes !== null
    && safe.resumeLowerMinutes > safe.resumeUpperMinutes
  ) {
    throw new TypeError('WORKSET_INVALID_FORECAST_RANGE');
  }
  return Object.freeze(safe);
}

function awaitingWorksetForecast(revision) {
  return safeWorksetForecast({
    mode: 'workset_unknown',
    status: 'unknown',
    evidence: 'unavailable',
    lowerMinutes: null,
    p50Minutes: null,
    p80Minutes: null,
    upperMinutes: null,
    reasonCode: 'awaiting_forecast',
    worksetRevision: Number(revision),
    jointP80Claimed: false,
    raw: {},
  });
}

export class AgentEtaDatabase {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.transactionDepth = 0;
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_json TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_time ON events(run_id, occurred_at, event_id);

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        provider TEXT,
        model_family TEXT,
        project_id TEXT,
        task_class TEXT,
        user_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
        initial_forecast_minutes REAL,
        model_self_eta_minutes REAL,
        initial_steps INTEGER,
        final_steps INTEGER,
        outcome_minutes REAL,
        is_history INTEGER NOT NULL DEFAULT 0,
        history_source TEXT,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_history_time ON runs(is_history, finished_at);

      CREATE TABLE IF NOT EXISTS plan_steps (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        label TEXT NOT NULL,
        class TEXT NOT NULL,
        status TEXT NOT NULL,
        prior_minutes REAL,
        started_at TEXT,
        completed_at TEXT,
        actual_minutes REAL,
        step_json TEXT NOT NULL,
        PRIMARY KEY (run_id, revision, step_id)
      );

      CREATE TABLE IF NOT EXISTS forecast_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        event_id TEXT,
        observed_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        forecast_status TEXT NOT NULL,
        p50_minutes REAL,
        p80_minutes REAL,
        lower_minutes REAL,
        displayed_headline TEXT NOT NULL,
        displayed_range TEXT NOT NULL,
        reason TEXT NOT NULL,
        forecast_json TEXT NOT NULL,
        display_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS forecast_run_time ON forecast_snapshots(run_id, snapshot_id);

      CREATE TABLE IF NOT EXISTS calibration_state (
        scope_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        multiplier REAL NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, metric)
      );

      CREATE TABLE IF NOT EXISTS replay_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        fixture_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        run_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coverage_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        since_at TEXT,
        until_at TEXT,
        session_count INTEGER NOT NULL,
        plan_session_count INTEGER NOT NULL,
        plan_coverage REAL NOT NULL,
        live_read_only INTEGER NOT NULL,
        simulated INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS live_watch_state (
        provider TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        running INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        last_scan_at TEXT,
        last_success_at TEXT,
        last_change_at TEXT,
        cursor_at TEXT,
        poll_interval_ms INTEGER NOT NULL,
        scan_count INTEGER NOT NULL DEFAULT 0,
        imported_events INTEGER NOT NULL DEFAULT 0,
        saved_forecasts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reporter_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        reported_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        task_class TEXT NOT NULL,
        eligible_large_task INTEGER NOT NULL,
        model_self_eta_minutes REAL,
        plan_present INTEGER NOT NULL,
        plan_step_count INTEGER NOT NULL,
        plan_adherence TEXT NOT NULL,
        report_json TEXT NOT NULL,
        UNIQUE(run_id, reported_at)
      );
      CREATE INDEX IF NOT EXISTS reporter_run_time
        ON reporter_observations(run_id, reported_at, observation_id);

      CREATE TABLE IF NOT EXISTS worksets (
        workset_id TEXT PRIMARY KEY,
        workset_type TEXT NOT NULL CHECK (workset_type IN ('task', 'project')),
        status TEXT NOT NULL CHECK (status IN (
          'pending', 'running', 'needs_input', 'waiting_provider', 'blocked',
          'paused', 'succeeded', 'failed', 'cancelled'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        workset_closed INTEGER NOT NULL CHECK (workset_closed IN (0, 1)),
        owner_terminal INTEGER NOT NULL CHECK (owner_terminal IN (0, 1)),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_elapsed_ms >= 0),
        outcome_minutes REAL,
        updated_at TEXT NOT NULL,
        CHECK (
          (owner_terminal = 0 AND finished_at IS NULL AND outcome_minutes IS NULL
            AND status NOT IN ('succeeded', 'failed', 'cancelled'))
          OR
          (owner_terminal = 1 AND finished_at IS NOT NULL AND outcome_minutes IS NOT NULL
            AND outcome_minutes >= 0 AND status IN ('succeeded', 'failed', 'cancelled'))
        )
      );
      CREATE INDEX IF NOT EXISTS worksets_type_status_updated
        ON worksets(workset_type, status, updated_at);

      CREATE TABLE IF NOT EXISTS workset_sources (
        workset_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'codex'),
        source_kind TEXT NOT NULL CHECK (source_kind IN (
          'controlled_wrapper', 'codex_goal_shadow', 'explicit_project_shadow'
        )),
        source_status TEXT NOT NULL CHECK (source_status IN (
          'contract_only', 'verified_structural', 'quarantined'
        )),
        task_class TEXT NOT NULL,
        eligible_large_task INTEGER CHECK (eligible_large_task IN (0, 1)),
        first_received_at TEXT NOT NULL,
        last_received_at TEXT NOT NULL,
        FOREIGN KEY(workset_id) REFERENCES worksets(workset_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workset_sources_cohort
        ON workset_sources(source_kind, source_status, task_class, workset_id);

      CREATE TABLE IF NOT EXISTS codex_goal_receipts (
        receipt_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        first_received_at TEXT NOT NULL,
        last_received_at TEXT NOT NULL,
        first_ingest_mode TEXT NOT NULL DEFAULT 'backfill' CHECK (
          first_ingest_mode IN ('backfill', 'live')
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'goal_active', 'goal_blocked', 'goal_completed', 'goal_absent'
        )),
        fingerprint TEXT NOT NULL,
        workset_id TEXT,
        applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
        censored INTEGER NOT NULL DEFAULT 0 CHECK (censored IN (0, 1)),
        quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1)),
        CHECK (NOT (applied = 1 AND censored = 1)),
        CHECK (workset_id IS NULL OR workset_id LIKE 'task-workset-%')
      );
      CREATE INDEX IF NOT EXISTS codex_goal_receipts_goal_time
        ON codex_goal_receipts(goal_id, occurred_at, receipt_id);
      CREATE INDEX IF NOT EXISTS codex_goal_receipts_disposition
        ON codex_goal_receipts(quarantined, censored, applied, kind, receipt_id);

      CREATE TABLE IF NOT EXISTS codex_goal_quarantines (
        goal_id TEXT PRIMARY KEY,
        reason_code TEXT NOT NULL CHECK (reason_code = 'goal_structure_conflict'),
        first_received_at TEXT NOT NULL,
        last_received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS codex_goal_quarantines_received
        ON codex_goal_quarantines(last_received_at, goal_id);

      CREATE TABLE IF NOT EXISTS workset_events (
        event_id TEXT PRIMARY KEY,
        workset_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(workset_id, event_id),
        FOREIGN KEY(workset_id) REFERENCES worksets(workset_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workset_events_scope_time
        ON workset_events(workset_id, occurred_at, event_id);

      CREATE TABLE IF NOT EXISTS workset_members (
        parent_workset_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        member_id TEXT NOT NULL,
        child_type TEXT NOT NULL CHECK (child_type IN ('run', 'workset')),
        child_run_id TEXT,
        child_workset_id TEXT,
        order_index INTEGER NOT NULL CHECK (order_index >= 0),
        execution_group TEXT,
        attached_at TEXT NOT NULL,
        detached_at TEXT,
        PRIMARY KEY(parent_workset_id, revision, member_id),
        UNIQUE(parent_workset_id, revision, order_index),
        FOREIGN KEY(parent_workset_id) REFERENCES worksets(workset_id) ON DELETE CASCADE,
        FOREIGN KEY(child_run_id) REFERENCES runs(run_id) ON DELETE RESTRICT,
        FOREIGN KEY(child_workset_id) REFERENCES worksets(workset_id) ON DELETE RESTRICT,
        CHECK (
          (child_type = 'run' AND child_run_id IS NOT NULL AND child_workset_id IS NULL)
          OR
          (child_type = 'workset' AND child_run_id IS NULL AND child_workset_id IS NOT NULL)
        ),
        CHECK (child_workset_id IS NULL OR child_workset_id <> parent_workset_id),
        CHECK (detached_at IS NULL OR detached_at >= attached_at)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workset_members_active_run
        ON workset_members(parent_workset_id, revision, child_run_id)
        WHERE child_type = 'run' AND detached_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS workset_members_active_workset
        ON workset_members(parent_workset_id, revision, child_workset_id)
        WHERE child_type = 'workset' AND detached_at IS NULL;
      CREATE INDEX IF NOT EXISTS workset_members_child_run
        ON workset_members(child_run_id) WHERE child_run_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS workset_members_child_workset
        ON workset_members(child_workset_id) WHERE child_workset_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS workset_forecast_snapshots (
        snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workset_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        observed_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        forecast_status TEXT NOT NULL,
        evidence TEXT NOT NULL,
        lower_minutes REAL,
        p50_minutes REAL,
        p80_minutes REAL,
        upper_minutes REAL,
        reason_code TEXT NOT NULL,
        forecast_json TEXT NOT NULL,
        UNIQUE(workset_id, event_id),
        FOREIGN KEY(workset_id, event_id)
          REFERENCES workset_events(workset_id, event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workset_forecast_scope_time
        ON workset_forecast_snapshots(workset_id, observed_at, snapshot_id);
    `);
    this.ensureColumn('runs', 'history_source', 'TEXT');
    this.ensureColumn('calibration_state', 'source', "TEXT NOT NULL DEFAULT 'unknown'");
    // Phase 7 databases created before live-vs-backfill provenance existed
    // already contain only explicit bulk replay receipts. Defaulting those
    // immutable first receipts to backfill is therefore conservative and
    // prevents historical Goal state from masquerading as realtime activity.
    this.ensureColumn(
      'codex_goal_receipts',
      'first_ingest_mode',
      "TEXT NOT NULL DEFAULT 'backfill' CHECK (first_ingest_mode IN ('backfill', 'live'))",
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS codex_goal_receipts_ingest_mode
        ON codex_goal_receipts(first_ingest_mode, applied, censored, quarantined, workset_id);
    `);
    const forecastGaps = this.db.prepare(`
      SELECT event.workset_id, event.event_id, event.revision, event.received_at
      FROM workset_events event
      LEFT JOIN workset_forecast_snapshots forecast
        ON forecast.workset_id = event.workset_id
        AND forecast.event_id = event.event_id
      WHERE forecast.snapshot_id IS NULL
    `).all();
    const insertPlaceholder = this.db.prepare(`
      INSERT INTO workset_forecast_snapshots(
        workset_id, event_id, revision, observed_at, mode, forecast_status,
        evidence, lower_minutes, p50_minutes, p80_minutes, upper_minutes,
        reason_code, forecast_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const gap of forecastGaps) {
      const placeholder = awaitingWorksetForecast(gap.revision);
      insertPlaceholder.run(
        gap.workset_id,
        gap.event_id,
        gap.revision,
        gap.received_at,
        placeholder.mode,
        placeholder.status,
        placeholder.evidence,
        null,
        null,
        null,
        null,
        placeholder.reasonCode,
        json(placeholder),
      );
    }
    this.db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
    const depth = this.transactionDepth;
    const savepoint = `agenteta_nested_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (depth === 0) {
        this.db.exec('ROLLBACK');
      } else {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  clearDemoData() {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM workset_forecast_snapshots;
        DELETE FROM workset_members;
        DELETE FROM workset_events;
        DELETE FROM codex_goal_receipts;
        DELETE FROM codex_goal_quarantines;
        DELETE FROM worksets;
        DELETE FROM events;
        DELETE FROM plan_steps;
        DELETE FROM forecast_snapshots;
        DELETE FROM calibration_state;
        DELETE FROM replay_state;
        DELETE FROM runs;
      `);
    });
  }

  clearLiveAdapterData() {
    const runIds = this.db.prepare(`
      SELECT DISTINCT run_id FROM events
      WHERE json_extract(source_json, '$.adapter') IN ('codex-jsonl', 'claude-code-jsonl')
    `).all().map((row) => row.run_id);
    const before = {
      runs: runIds.length,
      events: this.db.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE json_extract(source_json, '$.adapter') IN ('codex-jsonl', 'claude-code-jsonl')
      `).get().count,
    };
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM codex_goal_receipts;
        DELETE FROM codex_goal_quarantines;
        DELETE FROM worksets
        WHERE workset_id IN (
          SELECT workset_id FROM workset_sources
          WHERE source_kind = 'codex_goal_shadow'
        );
      `);
      const deleteForecasts = this.db.prepare('DELETE FROM forecast_snapshots WHERE run_id = ?');
      const deleteSteps = this.db.prepare('DELETE FROM plan_steps WHERE run_id = ?');
      const deleteRuns = this.db.prepare('DELETE FROM runs WHERE run_id = ?');
      for (const runId of runIds) {
        deleteForecasts.run(runId);
        deleteSteps.run(runId);
        deleteRuns.run(runId);
      }
      this.db.exec(`
        DELETE FROM events
        WHERE json_extract(source_json, '$.adapter') IN ('codex-jsonl', 'claude-code-jsonl');
        DELETE FROM calibration_state WHERE source = 'live_adapter';
      `);
    });
    return { runs: Number(before.runs), events: Number(before.events) };
  }

  resetReplayRun(runId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM plan_steps WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM forecast_snapshots WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
      this.db.exec(`
        DELETE FROM runs WHERE is_history = 1 AND history_source = 'frozen_demo';
        DELETE FROM calibration_state WHERE source IN ('frozen_demo', 'simulated_demo');
      `);
    });
  }

  insertEvent(event) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO events(
        event_id, run_id, occurred_at, observed_at, kind, provider, source_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.run_id,
      event.occurred_at,
      event.observed_at,
      event.kind,
      event.provider,
      json(event.source),
      json(event),
    );
    return result.changes === 1;
  }

  listEvents(runId) {
    return this.db.prepare(`
      SELECT payload_json FROM events WHERE run_id = ?
      ORDER BY occurred_at,
        CASE kind
          WHEN 'run_started' THEN 0
          WHEN 'plan_declared' THEN 1
          WHEN 'plan_revised' THEN 2
          WHEN 'step_started' THEN 3
          WHEN 'step_completed' THEN 4
          WHEN 'retry_started' THEN 5
          WHEN 'needs_input' THEN 6
          WHEN 'resumed' THEN 7
          WHEN 'run_succeeded' THEN 9
          WHEN 'run_failed' THEN 9
          WHEN 'run_cancelled' THEN 9
          ELSE 8
        END,
        event_id
    `).all(runId).map((row) => parse(row.payload_json));
  }

  loadEvent(eventId) {
    const row = this.db.prepare('SELECT payload_json FROM events WHERE event_id = ?').get(eventId);
    return row ? parse(row.payload_json) : null;
  }

  countEvents(runId) {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get(runId).count);
  }

  countEventsByAdapter(adapter) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE json_extract(source_json, '$.adapter') = ?
    `).get(adapter).count);
  }

  countHistory(source = null) {
    const row = source === null
      ? this.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE is_history = 1').get()
      : this.db.prepare(`
          SELECT COUNT(*) AS count FROM runs WHERE is_history = 1 AND history_source = ?
        `).get(source);
    return Number(row.count);
  }

  saveRun(state, event = null, { isHistory = false, historySource = null } = {}) {
    const provider = event?.provider ?? state.provider ?? null;
    const startedAt = state.startedAt ?? null;
    const finishedAt = state.finishedAt ?? null;
    const outcomeMinutes = startedAt && finishedAt
      ? Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 60_000)
      : null;
    const initialSteps = state.initialStepCount ?? state.initialSteps ?? (state.planRevision ? state.steps?.length : null);
    const finalSteps = state.steps?.length ?? null;
    const now = event?.observed_at ?? new Date().toISOString();

    this.db.prepare(`
      INSERT INTO runs(
        run_id, provider, model_family, project_id, task_class, user_id, status,
        started_at, finished_at, active_elapsed_ms, initial_forecast_minutes,
        model_self_eta_minutes, initial_steps, final_steps, outcome_minutes,
        is_history, history_source, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        provider = COALESCE(excluded.provider, runs.provider),
        model_family = COALESCE(excluded.model_family, runs.model_family),
        project_id = COALESCE(excluded.project_id, runs.project_id),
        task_class = COALESCE(excluded.task_class, runs.task_class),
        user_id = COALESCE(excluded.user_id, runs.user_id),
        status = excluded.status,
        started_at = COALESCE(excluded.started_at, runs.started_at),
        finished_at = excluded.finished_at,
        active_elapsed_ms = excluded.active_elapsed_ms,
        initial_forecast_minutes = COALESCE(runs.initial_forecast_minutes, excluded.initial_forecast_minutes),
        model_self_eta_minutes = COALESCE(excluded.model_self_eta_minutes, runs.model_self_eta_minutes),
        initial_steps = COALESCE(runs.initial_steps, excluded.initial_steps),
        final_steps = excluded.final_steps,
        outcome_minutes = excluded.outcome_minutes,
        is_history = MAX(runs.is_history, excluded.is_history),
        history_source = COALESCE(excluded.history_source, runs.history_source),
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(
      state.runId,
      provider,
      state.modelFamily ?? event?.data?.model_family ?? null,
      state.projectId ?? event?.data?.project_id ?? null,
      state.taskClass ?? event?.data?.task_class ?? null,
      state.userId ?? event?.data?.user_id ?? null,
      state.status ?? 'unknown',
      startedAt,
      finishedAt,
      Math.round(state.activeElapsedMs ?? 0),
      state.initialForecastMinutes ?? null,
      state.modelSelfEtaMinutes ?? event?.data?.model_self_eta_minutes ?? null,
      initialSteps,
      finalSteps,
      outcomeMinutes,
      isHistory ? 1 : 0,
      historySource,
      json(state),
      now,
    );
  }

  savePlanSteps(state) {
    if (!state.runId || !Number.isFinite(Number(state.planRevision))) return;
    const revision = Number(state.planRevision);
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO plan_steps(
        run_id, revision, step_id, label, class, status, prior_minutes,
        started_at, completed_at, actual_minutes, step_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const step of state.steps ?? []) {
      statement.run(
        state.runId,
        revision,
        step.id,
        step.label ?? step.id,
        step.class ?? 'other',
        step.status ?? 'pending',
        step.priorMinutes ?? step.prior_minutes ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.actualMinutes ?? null,
        json(step),
      );
    }
  }

  setInitialForecast(runId, minutes) {
    this.db.prepare(`
      UPDATE runs SET initial_forecast_minutes = COALESCE(initial_forecast_minutes, ?) WHERE run_id = ?
    `).run(minutes, runId);
  }

  loadRun(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (!row) return null;
    return { ...row, state: parse(row.state_json, {}) };
  }

  loadHistory({ before = null, observedBefore = null, limit = 500, source = null } = {}) {
    if (before !== null && Number.isNaN(Date.parse(before))) {
      throw new TypeError('before must be a valid timestamp');
    }
    if (observedBefore !== null && Number.isNaN(Date.parse(observedBefore))) {
      throw new TypeError('observedBefore must be a valid timestamp');
    }
    const conditions = ['runs.is_history = 1', 'runs.finished_at IS NOT NULL'];
    const parameters = [];
    if (before !== null) {
      conditions.push('runs.finished_at < ?');
      parameters.push(new Date(before).toISOString());
    }
    if (source !== null) {
      conditions.push('runs.history_source = ?');
      parameters.push(source);
    }
    if (observedBefore !== null) {
      conditions.push(`EXISTS (
        SELECT 1 FROM events terminal
        WHERE terminal.run_id = runs.run_id
          AND terminal.kind = 'run_succeeded'
          AND terminal.observed_at < ?
      )`);
      parameters.push(new Date(observedBefore).toISOString());
    }
    const rows = this.db.prepare(`
      SELECT runs.* FROM runs
      WHERE ${conditions.join(' AND ')}
      ORDER BY runs.finished_at DESC LIMIT ?
    `).all(...parameters, limit);
    return rows.map((row) => ({
      runId: row.run_id,
      provider: row.provider,
      modelFamily: row.model_family,
      projectId: row.project_id,
      taskClass: row.task_class,
      userId: row.user_id,
      actualMinutes: row.outcome_minutes,
      durationMinutes: row.outcome_minutes,
      initialForecastMinutes: row.initial_forecast_minutes,
      modelSelfEtaMinutes: row.model_self_eta_minutes,
      initialStepCount: row.initial_steps,
      finalStepCount: row.final_steps,
      finishedAt: row.finished_at,
      historySource: row.history_source,
      steps: parse(row.state_json, {}).steps ?? [],
    }));
  }

  saveForecast({ runId, eventId = null, observedAt, forecast, display }) {
    const result = this.db.prepare(`
      INSERT INTO forecast_snapshots(
        run_id, event_id, observed_at, mode, forecast_status, p50_minutes,
        p80_minutes, lower_minutes, displayed_headline, displayed_range,
        reason, forecast_json, display_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      eventId,
      observedAt,
      forecast.mode ?? 'run_fallback',
      forecast.status ?? 'forecast',
      forecast.p50Minutes ?? null,
      forecast.p80Minutes ?? null,
      forecast.lowerMinutes ?? null,
      display.headline ?? '',
      display.range ?? '',
      display.reason ?? forecast.reason ?? '',
      json(forecast),
      json(display),
    );
    return Number(result.lastInsertRowid);
  }

  listForecasts(runId) {
    return this.db.prepare(`
      SELECT * FROM forecast_snapshots WHERE run_id = ? ORDER BY snapshot_id
    `).all(runId).map((row) => ({
      ...row,
      forecast: parse(row.forecast_json, {}),
      display: parse(row.display_json, {}),
    }));
  }

  listP80CalibrationObservations({
    before,
    source = 'live_adapter',
    mode = 'run_fallback',
    limit = 500,
  } = {}) {
    if (!Number.isFinite(Date.parse(before ?? ''))) {
      throw new TypeError('before must be a valid timestamp');
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('limit must be a positive integer');
    }
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT
          runs.finished_at,
          forecasts.observed_at,
          forecasts.p80_minutes,
          forecasts.forecast_json,
          ROW_NUMBER() OVER (
            PARTITION BY forecasts.run_id
            ORDER BY forecasts.observed_at, forecasts.snapshot_id
          ) AS forecast_rank
        FROM forecast_snapshots AS forecasts
        JOIN runs ON runs.run_id = forecasts.run_id
        WHERE runs.history_source = ?
          AND runs.status = 'succeeded'
          AND runs.finished_at IS NOT NULL
          AND runs.finished_at < ?
          AND EXISTS (
            SELECT 1 FROM events terminal
            WHERE terminal.run_id = runs.run_id
              AND terminal.kind = 'run_succeeded'
              AND terminal.observed_at < ?
          )
          AND forecasts.mode = ?
      )
      WHERE forecast_rank = 1
      ORDER BY finished_at DESC
      LIMIT ?
    `).all(
      source,
      new Date(before).toISOString(),
      new Date(before).toISOString(),
      mode,
      limit,
    );

    return rows.flatMap((row) => {
      const observedAt = Date.parse(row.observed_at);
      const finishedAt = Date.parse(row.finished_at);
      const saved = parse(row.forecast_json, {});
      const rawP80 = Number(
        saved.raw?.intervalCalibration?.preCalibrationP80Minutes ?? row.p80_minutes,
      );
      if (!Number.isFinite(observedAt)
          || !Number.isFinite(finishedAt)
          || finishedAt <= observedAt
          || !Number.isFinite(rawP80)
          || rawP80 <= 0) {
        return [];
      }
      return [{
        actualRemainingMinutes: (finishedAt - observedAt) / 60_000,
        rawP80Minutes: rawP80,
      }];
    });
  }

  saveCalibration(scopeKey, metric, sampleCount, multiplier, state = {}, source = 'unknown') {
    this.db.prepare(`
      INSERT OR REPLACE INTO calibration_state(
        scope_key, metric, sample_count, multiplier, source, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, metric, sampleCount, multiplier, source, json(state), new Date().toISOString());
  }

  listCalibration() {
    return this.db.prepare('SELECT * FROM calibration_state ORDER BY scope_key, metric').all()
      .map((row) => ({ ...row, state: parse(row.state_json, {}) }));
  }

  saveCoverageSnapshot(report) {
    const result = this.db.prepare(`
      INSERT INTO coverage_snapshots(
        provider, scanned_at, since_at, until_at, session_count,
        plan_session_count, plan_coverage, live_read_only, simulated, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.provider,
      report.scannedAt,
      report.sinceAt ?? null,
      report.untilAt ?? null,
      report.sessionCount,
      report.planSessionCount,
      report.planCoverage,
      report.liveReadOnly ? 1 : 0,
      report.simulated ? 1 : 0,
      json(report),
    );
    return Number(result.lastInsertRowid);
  }

  listCoverageSnapshots(provider = null) {
    const rows = provider
      ? this.db.prepare('SELECT * FROM coverage_snapshots WHERE provider = ? ORDER BY snapshot_id').all(provider)
      : this.db.prepare('SELECT * FROM coverage_snapshots ORDER BY snapshot_id').all();
    return rows.map((row) => ({ ...row, report: parse(row.report_json, {}) }));
  }

  saveLiveWatchState(state) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO live_watch_state(
        provider, enabled, running, status, error_code, last_scan_at,
        last_success_at, last_change_at, cursor_at, poll_interval_ms,
        scan_count, imported_events, saved_forecasts, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        enabled = excluded.enabled,
        running = excluded.running,
        status = excluded.status,
        error_code = excluded.error_code,
        last_scan_at = excluded.last_scan_at,
        last_success_at = excluded.last_success_at,
        last_change_at = excluded.last_change_at,
        cursor_at = excluded.cursor_at,
        poll_interval_ms = excluded.poll_interval_ms,
        scan_count = excluded.scan_count,
        imported_events = excluded.imported_events,
        saved_forecasts = excluded.saved_forecasts,
        updated_at = excluded.updated_at
    `).run(
      state.provider,
      state.enabled ? 1 : 0,
      state.running ? 1 : 0,
      state.status,
      state.errorCode ?? null,
      state.lastScanAt ?? null,
      state.lastSuccessAt ?? null,
      state.lastChangeAt ?? null,
      state.cursorAt ?? null,
      Number(state.pollIntervalMs),
      Number(state.scanCount ?? 0),
      Number(state.importedEvents ?? 0),
      Number(state.savedForecasts ?? 0),
      state.updatedAt ?? now,
    );
  }

  loadLiveWatchState(provider = 'codex') {
    const row = this.db.prepare(
      'SELECT * FROM live_watch_state WHERE provider = ?',
    ).get(provider);
    if (!row) return null;
    return {
      provider: row.provider,
      enabled: Boolean(row.enabled),
      running: Boolean(row.running),
      status: row.status,
      errorCode: row.error_code,
      lastScanAt: row.last_scan_at,
      lastSuccessAt: row.last_success_at,
      lastChangeAt: row.last_change_at,
      cursorAt: row.cursor_at,
      pollIntervalMs: Number(row.poll_interval_ms),
      scanCount: Number(row.scan_count),
      importedEvents: Number(row.imported_events),
      savedForecasts: Number(row.saved_forecasts),
      updatedAt: row.updated_at,
    };
  }

  saveReporterObservation(report, { receivedAt = new Date().toISOString() } = {}) {
    const existing = this.db.prepare(`
      SELECT observation_id, report_json
      FROM reporter_observations
      WHERE run_id = ? AND reported_at = ?
    `).get(report.run_id, report.reported_at);
    if (existing) {
      if (json(parse(existing.report_json, {})) !== json(report)) {
        throw new Error('REPORTER_OBSERVATION_CONFLICT');
      }
      return { inserted: false, observationId: Number(existing.observation_id) };
    }

    const result = this.db.prepare(`
      INSERT INTO reporter_observations(
        run_id, provider, reported_at, received_at, task_class,
        eligible_large_task, model_self_eta_minutes, plan_present,
        plan_step_count, plan_adherence, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.run_id,
      report.provider,
      report.reported_at,
      new Date(receivedAt).toISOString(),
      report.task_class,
      report.eligible_large_task ? 1 : 0,
      report.model_self_eta_minutes,
      report.plan_present ? 1 : 0,
      report.plan_step_count,
      report.plan_adherence,
      json(report),
    );
    return { inserted: true, observationId: Number(result.lastInsertRowid) };
  }

  listReporterObservations(runId = null) {
    const rows = runId === null
      ? this.db.prepare(`
          SELECT * FROM reporter_observations
          ORDER BY reported_at, observation_id
        `).all()
      : this.db.prepare(`
          SELECT * FROM reporter_observations
          WHERE run_id = ?
          ORDER BY reported_at, observation_id
        `).all(runId);
    return rows.map((row) => ({
      observationId: Number(row.observation_id),
      receivedAt: row.received_at,
      report: parse(row.report_json, {}),
    }));
  }

  reporterStatus() {
    const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS observations,
        COUNT(DISTINCT run_id) AS reported_runs,
        SUM(CASE WHEN model_self_eta_minutes IS NOT NULL THEN 1 ELSE 0 END) AS self_eta_observations,
        SUM(CASE WHEN plan_adherence IN ('following', 'replanned', 'departed') THEN 1 ELSE 0 END) AS adherence_observations,
        MAX(reported_at) AS latest_reported_at
      FROM reporter_observations
    `).get();
    const attached = this.db.prepare(`
      SELECT COUNT(DISTINCT reporter.run_id) AS count
      FROM reporter_observations AS reporter
      WHERE EXISTS (SELECT 1 FROM runs WHERE runs.run_id = reporter.run_id)
    `).get();
    const attachedRuns = Number(attached.count);
    const reportedRuns = Number(totals.reported_runs);
    return {
      observations: Number(totals.observations),
      reportedRuns,
      attachedRuns,
      unattachedRuns: reportedRuns - attachedRuns,
      selfEtaObservations: Number(totals.self_eta_observations ?? 0),
      adherenceObservations: Number(totals.adherence_observations ?? 0),
      latestReportedAt: totals.latest_reported_at ?? null,
    };
  }

  saveWorksetSource(worksetId, input, {
    receivedAt = new Date().toISOString(),
  } = {}) {
    const workset = this.db.prepare(`
      SELECT workset_type FROM worksets WHERE workset_id = ?
    `).get(worksetId);
    if (!workset) throw new Error('WORKSET_SOURCE_SCOPE_NOT_FOUND');
    const source = safeWorksetSource(input, workset.workset_type);
    const received = iso(receivedAt, 'WORKSET_INVALID_SOURCE_TIME');
    const existing = this.db.prepare(`
      SELECT * FROM workset_sources WHERE workset_id = ?
    `).get(worksetId);
    if (existing) {
      const sameIdentity = existing.provider === source.provider
        && existing.source_kind === source.sourceKind
        && existing.task_class === source.taskClass
        && (existing.eligible_large_task === null
          ? source.eligibleLargeTask === null
          : Boolean(existing.eligible_large_task) === source.eligibleLargeTask);
      if (!sameIdentity) throw new Error('WORKSET_SOURCE_CONFLICT');
      if (
        existing.source_status !== source.sourceStatus
        && source.sourceStatus !== 'quarantined'
      ) {
        throw new Error('WORKSET_SOURCE_STATUS_CONFLICT');
      }
      const status = existing.source_status === 'quarantined'
        ? 'quarantined'
        : source.sourceStatus;
      this.db.prepare(`
        UPDATE workset_sources
        SET source_status = ?,
            last_received_at = CASE
              WHEN julianday(?) > julianday(last_received_at) THEN ?
              ELSE last_received_at
            END
        WHERE workset_id = ?
      `).run(status, received, received, worksetId);
      return { inserted: false, source: this.loadWorksetSource(worksetId) };
    }
    this.db.prepare(`
      INSERT INTO workset_sources(
        workset_id, provider, source_kind, source_status, task_class,
        eligible_large_task, first_received_at, last_received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      worksetId,
      source.provider,
      source.sourceKind,
      source.sourceStatus,
      source.taskClass,
      source.eligibleLargeTask === null ? null : source.eligibleLargeTask ? 1 : 0,
      received,
      received,
    );
    return { inserted: true, source: this.loadWorksetSource(worksetId) };
  }

  loadWorksetSource(worksetId) {
    const row = this.db.prepare(`
      SELECT * FROM workset_sources WHERE workset_id = ?
    `).get(worksetId);
    if (!row) return null;
    return {
      provider: row.provider,
      sourceKind: row.source_kind,
      sourceStatus: row.source_status,
      taskClass: row.task_class,
      eligibleLargeTask: row.eligible_large_task === null
        ? null
        : Boolean(row.eligible_large_task),
      firstReceivedAt: row.first_received_at,
      lastReceivedAt: row.last_received_at,
    };
  }

  saveCodexGoalQuarantine(goalId, {
    receivedAt = new Date().toISOString(),
  } = {}) {
    if (typeof goalId !== 'string' || !/^codex-goal-[a-f0-9]{20}$/.test(goalId)) {
      throw new TypeError('CODEX_GOAL_QUARANTINE_INVALID_ID');
    }
    const received = iso(receivedAt, 'CODEX_GOAL_QUARANTINE_INVALID_TIME');
    this.db.prepare(`
      INSERT INTO codex_goal_quarantines(
        goal_id, reason_code, first_received_at, last_received_at
      ) VALUES (?, 'goal_structure_conflict', ?, ?)
      ON CONFLICT(goal_id) DO UPDATE SET
        last_received_at = CASE
          WHEN julianday(excluded.last_received_at) > julianday(last_received_at)
            THEN excluded.last_received_at
          ELSE last_received_at
        END
    `).run(goalId, received, received);
    return this.loadCodexGoalQuarantine(goalId);
  }

  loadCodexGoalQuarantine(goalId) {
    if (typeof goalId !== 'string' || !/^codex-goal-[a-f0-9]{20}$/.test(goalId)) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT goal_id, reason_code, first_received_at, last_received_at
      FROM codex_goal_quarantines
      WHERE goal_id = ?
    `).get(goalId);
    if (!row) return null;
    return {
      goalId: row.goal_id,
      reasonCode: row.reason_code,
      firstReceivedAt: row.first_received_at,
      lastReceivedAt: row.last_received_at,
    };
  }

  saveWorksetProjection(state, inputEvent, {
    receivedAt = new Date().toISOString(),
    forecast = null,
    source = null,
  } = {}) {
    const eventPayload = worksetEventPayload(inputEvent);
    const event = sanitizeWorksetEvent(eventPayload);
    const received = iso(receivedAt, 'WORKSET_INVALID_RECEIVED_AT');
    if (
      !state
      || state.worksetId !== event.worksetId
      || state.worksetType !== event.worksetType
      || state.lastEventId !== event.eventId
      || !state.seenEventIds?.includes(event.eventId)
    ) {
      throw new TypeError('WORKSET_STATE_EVENT_MISMATCH');
    }
    if (!Number.isInteger(state.revision) || state.revision < 1) {
      throw new TypeError('WORKSET_INVALID_STATE_REVISION');
    }
    if (typeof state.worksetClosed !== 'boolean' || typeof state.ownerTerminal !== 'boolean') {
      throw new TypeError('WORKSET_INVALID_STATE_FLAGS');
    }
    const startedAt = iso(state.startedAt, 'WORKSET_INVALID_STATE_START');
    const finishedAt = state.finishedAt === null
      ? null
      : iso(state.finishedAt, 'WORKSET_INVALID_STATE_FINISH');
    if (state.ownerTerminal !== WORKSET_TERMINAL.has(state.status)) {
      throw new TypeError('WORKSET_OWNER_TERMINAL_STATUS_MISMATCH');
    }
    if (state.ownerTerminal !== (finishedAt !== null)) {
      throw new TypeError('WORKSET_OWNER_TERMINAL_TIME_MISMATCH');
    }
    if (!Number.isFinite(state.activeElapsedMs) || state.activeElapsedMs < 0) {
      throw new TypeError('WORKSET_INVALID_ACTIVE_ELAPSED');
    }
    const members = normalizedWorksetMembers(state.members);
    const suppliedForecast = forecast === null ? null : safeWorksetForecast(forecast);
    const suppliedSource = source === null ? null : safeWorksetSource(source, state.worksetType);
    if (suppliedForecast !== null && suppliedForecast.worksetRevision !== state.revision) {
      throw new TypeError('WORKSET_FORECAST_REVISION_MISMATCH');
    }
    const serializedEvent = json(eventPayload);
    const existingEvent = this.db.prepare(`
      SELECT payload_json FROM workset_events WHERE event_id = ?
    `).get(event.eventId);
    if (existingEvent) {
      if (existingEvent.payload_json !== serializedEvent) {
        throw new Error('WORKSET_EVENT_CONFLICT');
      }
      if (suppliedForecast !== null) {
        this.saveWorksetForecast({
          worksetId: event.worksetId,
          eventId: event.eventId,
          observedAt: received,
          forecast: suppliedForecast,
        });
      }
      if (suppliedSource !== null) {
        this.saveWorksetSource(event.worksetId, suppliedSource, { receivedAt: received });
      }
      return { inserted: false, workset: this.loadWorkset(event.worksetId) };
    }

    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT revision, owner_terminal FROM worksets WHERE workset_id = ?
      `).get(event.worksetId);
      if (existing?.owner_terminal) throw new Error('WORKSET_TERMINAL_IMMUTABLE');
      const storedEvents = this.db.prepare(`
        SELECT event_id, occurred_at, kind, payload_json
        FROM workset_events WHERE workset_id = ?
      `).all(event.worksetId);
      const latestStoredEvent = storedEvents.toSorted(compareWorksetEventOrder).at(-1);
      if (latestStoredEvent && compareWorksetEventOrder(eventPayload, latestStoredEvent) < 0) {
        throw new Error('WORKSET_EVENT_OUT_OF_ORDER');
      }
      const seen = new Set(state.seenEventIds ?? []);
      if (storedEvents.some((storedEvent) => !seen.has(storedEvent.event_id))) {
        throw new Error('WORKSET_STATE_MISSING_STORED_EVENT');
      }
      let replayed = createWorksetState(event.worksetId, event.worksetType);
      const canonicalEvents = storedEvents
        .map((storedEvent) => parse(storedEvent.payload_json, null))
        .filter(Boolean)
        .concat(eventPayload)
        .toSorted(compareWorksetEventOrder);
      for (const canonicalEvent of canonicalEvents) {
        replayed = reduceWorksetEvent(replayed, canonicalEvent);
      }
      const replayedSignature = worksetStateSignature(replayed);
      const suppliedSignature = worksetStateSignature(state);
      if (json(replayedSignature.members) !== json(suppliedSignature.members)) {
        throw new Error('WORKSET_REVISION_MEMBERS_CONFLICT');
      }
      if (json(replayedSignature) !== json(suppliedSignature)) {
        throw new Error('WORKSET_STATE_EVENT_MISMATCH');
      }
      if (existing && state.revision < Number(existing.revision)) {
        throw new Error('WORKSET_STALE_REVISION');
      }

      if (state.worksetType === 'project') {
        const childStatement = this.db.prepare(`
          SELECT workset_type FROM worksets WHERE workset_id = ?
        `);
        for (const member of members) {
          const child = childStatement.get(member.childId);
          if (!child || child.workset_type !== 'task') {
            throw new Error('WORKSET_PROJECT_CHILD_NOT_TASK');
          }
        }
      }

      const outcomeMinutes = finishedAt === null
        ? null
        : Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 60_000);
      this.db.prepare(`
        INSERT INTO worksets(
          workset_id, workset_type, status, revision, workset_closed,
          owner_terminal, started_at, finished_at, active_elapsed_ms,
          outcome_minutes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workset_id) DO UPDATE SET
          status = excluded.status,
          revision = excluded.revision,
          workset_closed = excluded.workset_closed,
          owner_terminal = excluded.owner_terminal,
          started_at = worksets.started_at,
          finished_at = excluded.finished_at,
          active_elapsed_ms = excluded.active_elapsed_ms,
          outcome_minutes = excluded.outcome_minutes,
          updated_at = excluded.updated_at
      `).run(
        state.worksetId,
        state.worksetType,
        state.status,
        state.revision,
        state.worksetClosed ? 1 : 0,
        state.ownerTerminal ? 1 : 0,
        startedAt,
        finishedAt,
        Math.round(state.activeElapsedMs),
        outcomeMinutes,
        received,
      );
      if (suppliedSource !== null) {
        this.saveWorksetSource(event.worksetId, suppliedSource, { receivedAt: received });
      }

      const storedMembers = storedMemberProjection(this.db.prepare(`
        SELECT * FROM workset_members
        WHERE parent_workset_id = ? AND revision = ?
        ORDER BY order_index, member_id
      `).all(state.worksetId, state.revision));
      const revisionEstablished = Boolean(this.db.prepare(`
        SELECT 1 FROM workset_events
        WHERE workset_id = ? AND revision = ?
          AND kind IN ('workset_declared', 'workset_revised')
        LIMIT 1
      `).get(state.worksetId, state.revision));
      if (revisionEstablished && json(storedMembers) !== json(members)) {
        throw new Error('WORKSET_REVISION_MEMBERS_CONFLICT');
      }
      if (!revisionEstablished) {
        const insertMember = this.db.prepare(`
          INSERT INTO workset_members(
            parent_workset_id, revision, member_id, child_type, child_run_id,
            child_workset_id, order_index, execution_group, attached_at, detached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const member of members) {
          insertMember.run(
            state.worksetId,
            state.revision,
            member.memberId,
            member.childType,
            member.childType === 'run' ? member.childId : null,
            member.childType === 'workset' ? member.childId : null,
            member.orderIndex,
            member.executionGroup,
            member.attachedAt,
            member.detachedAt,
          );
        }
      }

      this.db.prepare(`
        INSERT INTO workset_events(
          event_id, workset_id, revision, occurred_at, received_at, kind, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.worksetId,
        state.revision,
        event.occurredAt,
        received,
        event.kind,
        serializedEvent,
      );
      this.saveWorksetForecast({
        worksetId: event.worksetId,
        eventId: event.eventId,
        observedAt: received,
        forecast: awaitingWorksetForecast(state.revision),
      });
      let forecastResult = null;
      if (suppliedForecast !== null) {
        forecastResult = this.saveWorksetForecast({
          worksetId: event.worksetId,
          eventId: event.eventId,
          observedAt: received,
          forecast: suppliedForecast,
        });
      }
      return {
        inserted: true,
        forecastSaved: forecastResult !== null,
        workset: this.loadWorkset(event.worksetId),
      };
    });
  }

  loadWorkset(worksetId) {
    const row = this.db.prepare('SELECT * FROM worksets WHERE workset_id = ?').get(worksetId);
    if (!row) return null;
    return {
      worksetId: row.workset_id,
      worksetType: row.workset_type,
      status: row.status,
      revision: Number(row.revision),
      worksetClosed: Boolean(row.workset_closed),
      ownerTerminal: Boolean(row.owner_terminal),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      activeElapsedMs: Number(row.active_elapsed_ms),
      outcomeMinutes: row.outcome_minutes === null ? null : Number(row.outcome_minutes),
      updatedAt: row.updated_at,
      members: this.listWorksetMembers(worksetId, Number(row.revision)),
      source: this.loadWorksetSource(worksetId),
    };
  }

  listWorksetMembers(worksetId, revision = null) {
    const selectedRevision = revision ?? this.db.prepare(`
      SELECT revision FROM worksets WHERE workset_id = ?
    `).get(worksetId)?.revision;
    if (selectedRevision === undefined) return [];
    return storedMemberProjection(this.db.prepare(`
      SELECT * FROM workset_members
      WHERE parent_workset_id = ? AND revision = ?
      ORDER BY order_index, member_id
    `).all(worksetId, selectedRevision));
  }

  listWorksetEvents(worksetId) {
    return this.db.prepare(`
      SELECT payload_json, received_at FROM workset_events
      WHERE workset_id = ?
      ORDER BY occurred_at,
        CASE kind
          WHEN 'workset_declared' THEN 0
          WHEN 'workset_revised' THEN 1
          WHEN 'workset_status_changed' THEN 2
          WHEN 'workset_heartbeat' THEN 3
          WHEN 'workset_succeeded' THEN 9
          WHEN 'workset_failed' THEN 9
          WHEN 'workset_cancelled' THEN 9
          ELSE 8
        END,
        event_id
    `).all(worksetId).map((row) => ({
      event: parse(row.payload_json, {}),
      receivedAt: row.received_at,
    }));
  }

  saveWorksetForecast({ worksetId, eventId, observedAt, forecast }) {
    const observed = iso(observedAt, 'WORKSET_INVALID_FORECAST_TIME');
    const safe = safeWorksetForecast(forecast);
    const event = this.db.prepare(`
      SELECT revision FROM workset_events WHERE workset_id = ? AND event_id = ?
    `).get(worksetId, eventId);
    if (!event) throw new Error('WORKSET_FORECAST_EVENT_NOT_FOUND');
    if (Number(event.revision) !== safe.worksetRevision) {
      throw new Error('WORKSET_FORECAST_REVISION_MISMATCH');
    }
    const serialized = json(safe);
    const existing = this.db.prepare(`
      SELECT snapshot_id, forecast_json FROM workset_forecast_snapshots
      WHERE workset_id = ? AND event_id = ?
    `).get(worksetId, eventId);
    if (existing) {
      if (existing.forecast_json === serialized) {
        return { inserted: false, snapshotId: Number(existing.snapshot_id) };
      }
      const stored = parse(existing.forecast_json, {});
      if (stored.reasonCode !== 'awaiting_forecast') {
        throw new Error('WORKSET_FORECAST_CONFLICT');
      }
      this.db.prepare(`
        UPDATE workset_forecast_snapshots SET
          observed_at = ?,
          mode = ?,
          forecast_status = ?,
          evidence = ?,
          lower_minutes = ?,
          p50_minutes = ?,
          p80_minutes = ?,
          upper_minutes = ?,
          reason_code = ?,
          forecast_json = ?
        WHERE snapshot_id = ?
      `).run(
        observed,
        safe.mode,
        safe.status,
        safe.evidence,
        safe.lowerMinutes,
        safe.p50Minutes,
        safe.p80Minutes,
        safe.upperMinutes,
        safe.reasonCode,
        serialized,
        existing.snapshot_id,
      );
      return {
        inserted: true,
        updatedPlaceholder: true,
        snapshotId: Number(existing.snapshot_id),
      };
    }
    const result = this.db.prepare(`
      INSERT INTO workset_forecast_snapshots(
        workset_id, event_id, revision, observed_at, mode, forecast_status,
        evidence, lower_minutes, p50_minutes, p80_minutes, upper_minutes,
        reason_code, forecast_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      worksetId,
      eventId,
      safe.worksetRevision,
      observed,
      safe.mode,
      safe.status,
      safe.evidence,
      safe.lowerMinutes,
      safe.p50Minutes,
      safe.p80Minutes,
      safe.upperMinutes,
      safe.reasonCode,
      serialized,
    );
    return { inserted: true, snapshotId: Number(result.lastInsertRowid) };
  }

  listWorksetForecasts(worksetId) {
    return this.db.prepare(`
      SELECT * FROM workset_forecast_snapshots
      WHERE workset_id = ? ORDER BY observed_at, snapshot_id
    `).all(worksetId).map((row) => ({
      ...row,
      forecast: parse(row.forecast_json, {}),
    }));
  }

  saveReplayState(fixtureId, cursor, runId) {
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_state(singleton, fixture_id, cursor, run_id, updated_at)
      VALUES (1, ?, ?, ?, ?)
    `).run(fixtureId, cursor, runId ?? null, new Date().toISOString());
  }

  loadReplayState() {
    const row = this.db.prepare('SELECT * FROM replay_state WHERE singleton = 1').get();
    return row ? {
      fixtureId: row.fixture_id,
      cursor: Number(row.cursor),
      runId: row.run_id,
      updatedAt: row.updated_at,
    } : null;
  }
}
