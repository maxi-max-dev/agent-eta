import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentETA } from '../src/generic/tracker.js';
import { afterCleanup } from '../test-support/cleanup.js';

const AT = 1_800_000_000_000;
const query = 'SELECT * FROM agentwhen_runs ORDER BY started_at DESC, rowid DESC LIMIT 50';

test('existing portable store gains the list index without changing rows, receipts or tie order', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-list-upgrade-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'legacy.sqlite');
  // Pre-index portable schema; include insertion-order ties and a legacy raw receipt.
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE agentwhen_runs (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, task_class TEXT NOT NULL,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    active_ms REAL NOT NULL DEFAULT 0, active_since INTEGER,
    last_seen INTEGER NOT NULL, history_eligible INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE eta_forecasts (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, estimated_at INTEGER NOT NULL,
    active_ms REAL NOT NULL, estimate_status TEXT NOT NULL,
    model_version TEXT NOT NULL, payload_json TEXT NOT NULL);`);
  const insert = legacy.prepare('INSERT INTO agentwhen_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 90; i++) {
    const at = AT + (i % 7) * 1000; // Deliberately not insertion-time order.
    insert.run(`aw-synthetic-${i}`, 'synthetic', 'coding', 'succeeded', at, at + 30000,
      30000, null, at + 30000, 1);
  }
  legacy.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('raw-legacy-receipt', 'aw-synthetic-0', AT, 0, 'cold_start', 'legacy', '{ "original": true }');
  const snapshot = db => ({ runs: db.prepare('SELECT rowid, * FROM agentwhen_runs ORDER BY rowid').all(),
    forecasts: db.prepare('SELECT rowid, * FROM eta_forecasts ORDER BY rowid').all() });
  const before = snapshot(legacy);
  const expected = legacy.prepare(query).all().map(row => row.id);
  legacy.close();
  const tracker = new AgentETA({ filename, clock: () => AT + 100000 });
  try {
    assert.deepEqual(snapshot(tracker.db), before);
    assert.deepEqual(tracker.list().map(row => row.runId), expected);
    assert.deepEqual(snapshot(tracker.db), before); // Terminal refresh creates no new receipts.
    const plan = tracker.db.prepare('EXPLAIN QUERY PLAN ' + query).all().map(row => row.detail).join('\n');
    assert.match(plan, /USING INDEX agentwhen_started/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  } finally { tracker.close(); }
  const reopened = new AgentETA({ filename, clock: () => AT + 100000 });
  try { assert.deepEqual(snapshot(reopened.db), before); }
  finally { reopened.close(); }
});

test('indexed refresh preserves the 50-run cutoff, forecasts and observation semantics', t => {
  const tracker = new AgentETA({ filename: ':memory:', clock: () => AT });
  afterCleanup(t, () => tracker.close());
  const insert = tracker.db.prepare('INSERT INTO agentwhen_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 70; i++) {
    const at = AT - 120000 + Math.floor(i / 3) * 1000;
    insert.run(`aw-synthetic-history-${i}`, 'synthetic', 'coding', 'succeeded', at, at + 30000,
      30000, null, at + 30000, 1);
  }
  const active = [
    ['numeric', 'synthetic', 'running', AT - 10000, 1],
    ['cold', 'new-profile', 'running', AT - 10000, 1],
    ['paused', 'synthetic', 'paused', AT - 10000, 1],
    ['stale', 'synthetic', 'running', AT - 61000, 1],
    ['gap', 'synthetic', 'running', AT - 10000, 0],
  ];
  for (const [id, profile, status, lastSeen, eligible] of active) {
    insert.run(`aw-synthetic-${id}`, profile, 'coding', status, AT - 90000, null,
      1000, status === 'running' ? AT - 90000 : null, lastSeen, eligible);
  }
  // Independent table-scan oracle ignores every index but retains the contract's ordering.
  const expectedRows = tracker.db.prepare(query.replace('agentwhen_runs', 'agentwhen_runs NOT INDEXED')).all();
  const expected = expectedRows.map(row => tracker.project(row, AT));
  const beforeRuns = tracker.db.prepare('SELECT rowid, * FROM agentwhen_runs ORDER BY rowid').all();
  const beforeReceipts = tracker.db.prepare('SELECT rowid, * FROM eta_forecasts ORDER BY rowid').all();
  const actual = tracker.list();
  assert.equal(actual.length, 50);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.slice(0, 5).map(row => row.estimateStatus),
    ['observation_gap', 'stale', 'paused', 'cold_start', 'experimental']);
  assert.ok(actual[4].remainingMinutes);
  assert.ok(actual.slice(0, 4).every(row => row.remainingMinutes === null));
  assert.deepEqual(tracker.db.prepare('SELECT rowid, * FROM agentwhen_runs ORDER BY rowid').all(), beforeRuns);
  assert.deepEqual(tracker.db.prepare('SELECT rowid, * FROM eta_forecasts ORDER BY rowid').all(), beforeReceipts);
});
