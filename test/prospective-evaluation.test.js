import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentETA, MODEL_VERSION } from '../src/generic/tracker.js';
import { evaluateDatabase } from '../src/generic/evaluate.js';
import { afterCleanup } from '../test-support/cleanup.js';

// Every clock, outcome and prediction in this file is synthetic. These fixtures
// verify arithmetic and selection, not real-world model performance.
const START = 1_800_000_000_000;
const MINUTE = 60_000;
const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-evaluation-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  new AgentETA({ filename }).close();
  const db = new DatabaseSync(filename);
  afterCleanup(t, () => db.close());
  const run = (id, options = {}) => {
    const row = { id, profile: 'synthetic', task_class: 'coding', status: 'succeeded', started_at: START,
      active_ms: 5 * MINUTE, history_eligible: 1, ...options };
    if (!Object.hasOwn(options, 'finished_at')) row.finished_at = ['running', 'paused'].includes(row.status)
      ? null : row.started_at + row.active_ms;
    db.prepare(`INSERT INTO agentwhen_runs (id, profile, task_class, status, started_at, finished_at,
      active_ms, last_seen, history_eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.profile, row.task_class, row.status, row.started_at, row.finished_at,
        row.active_ms, row.finished_at ?? row.started_at, row.history_eligible);
    return row;
  };
  const receipt = (row, { active = MINUTE, at = row.started_at + active, state = 'experimental', payload = {}, columns = {} } = {}) => {
    const numeric = state === 'experimental';
    const value = { schema: 'agentwhen.status/1', runId: row.id, profile: row.profile, taskClass: row.task_class,
      status: state === 'paused' ? 'paused' : 'running', estimateStatus: state,
      startedAt: new Date(row.started_at).toISOString(), finishedAt: null,
      estimatedAt: new Date(at).toISOString(), observedAt: new Date(at).toISOString(),
      activeMinutes: Math.round(active / MINUTE * 1000) / 1000, historyCount: 3,
      historyEligible: !['stale', 'observation_gap'].includes(state), modelVersion: MODEL_VERSION,
      remainingMinutes: numeric ? { p20: 1, p50: 2, p80: 3 } : null,
      baselineRemainingMinutes: numeric ? 3 : null, baselineVersion: 'cohort-median-minus-elapsed/1', ...payload };
    const json = JSON.stringify(value);
    const record = { id: `eta-fc-${createHash('sha256').update(json).digest('hex')}`, run_id: row.id,
      estimated_at: at, active_ms: active, estimate_status: state, model_version: MODEL_VERSION, payload_json: json, ...columns };
    db.prepare(`INSERT INTO eta_forecasts (id, run_id, estimated_at, active_ms, estimate_status, model_version, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.run_id, record.estimated_at, record.active_ms,
      record.estimate_status, record.model_version, record.payload_json);
    return record;
  };
  return { dir, filename, db, run, receipt, report: () => evaluateDatabase(filename) };
}

test('empty data is deterministic, explicit and contains no fabricated precision', t => {
  const f = fixture(t);
  const report = f.report();
  assert.deepEqual(f.report(), report);
  assert.equal(report.population.totalRuns, 0);
  assert.equal(report.provenance, 'supplied_receipts_not_independently_verified');
  for (const landmark of report.landmarks) {
    assert.equal(landmark.evidenceStatus, 'no_scorable_pairs');
    assert.equal(landmark.availability.numericRate, null);
    assert.deepEqual(landmark.groups, []);
  }
});

test('hand-calculated paired errors, strict severe threshold, coverage and run bootstrap', t => {
  const f = fixture(t);
  f.receipt(f.run('a'));
  f.receipt(f.run('b', { active_ms: 4 * MINUTE }), { payload: { remainingMinutes: { p20: 0, p50: 1, p80: 3 } } });
  const group = f.report().landmarks[0].groups[0];
  assert.equal(group.n, 2);
  assert.deepEqual(group.model, { meanAbsoluteErrorMinutes: 2, medianAbsoluteErrorMinutes: 2,
    severeUnderestimateCount: 1, severeUnderestimateRate: 0.5, p80CoverageCount: 1,
    p80Coverage: 0.5, meanIntervalWidthMinutes: 2.5 });
  assert.equal(group.baseline.meanAbsoluteErrorMinutes, 0.5);
  assert.equal(group.baseline.medianAbsoluteErrorMinutes, 0.5);
  assert.equal(group.baseline.severeUnderestimateCount, 0);
  assert.equal(group.pairedMeanAbsoluteErrorDifferenceMinutes, 1.5);
  assert.deepEqual(group.pairedDifferenceBootstrap95, { lower: 1, upper: 2, resamples: 2000, unit: 'run' });
  assert.deepEqual(f.report().landmarks[0].groups[0], group);
});

test('single run is descriptive without a confidence interval; frozen zero baseline is valid', t => {
  const f = fixture(t);
  f.receipt(f.run('one'), { payload: { baselineRemainingMinutes: 0 } });
  const group = f.report().landmarks[0].groups[0];
  assert.equal(group.n, 1);
  assert.equal(group.evidenceStatus, 'single_run_only');
  assert.equal(group.pairedDifferenceBootstrap95, null);
  assert.equal(group.baseline.meanAbsoluteErrorMinutes, 4);
});

test('fixed windows, inclusive tolerance, exact-finish boundary and repeated polling', t => {
  const f = fixture(t);
  const long = f.run('long', { active_ms: 11 * MINUTE });
  const chosen = f.receipt(long);
  for (let second = 1; second < 30; second++) f.receipt(long, { active: MINUTE + second * 1000 });
  f.receipt(long, { active: 5 * MINUTE + 30_000 });
  f.receipt(long, { active: 10 * MINUTE + 30_001 });
  f.receipt(f.run('before-window'), { active: MINUTE - 1 });
  f.run('equal-finish', { active_ms: MINUTE });
  const report = f.report();
  assert.equal(report.landmarks[0].pairedRuns, 1);
  assert.equal(report.landmarks[0].groups[0].pairs[0].forecastId, chosen.id);
  assert.equal(report.landmarks[0].availability.counts.missing, 1);
  assert.equal(report.landmarks[0].availability.notReached, 1);
  assert.equal(report.landmarks[1].pairedRuns, 1);
  assert.equal(report.landmarks[2].pairedRuns, 0);
  assert.equal(report.landmarks[2].availability.counts.missing, 1);
});

test('earlier abstention wins over later numeric forecasts, including timestamp ties', t => {
  const f = fixture(t);
  const a = f.run('a');
  const b = f.run('b');
  f.receipt(a, { state: 'cold_start' });
  f.receipt(a, { active: MINUTE + 1000 });
  f.receipt(b, { state: 'paused' });
  f.receipt(b);
  const report = f.report().landmarks[0];
  assert.equal(report.pairedRuns, 0);
  assert.equal(report.availability.counts.cold_start, 1);
  assert.equal(report.availability.counts.paused, 1);
  assert.equal(report.availability.abstentionRate, 1);
});

test('failed/cancelled/gap outcomes remain in availability; open runs remain pending', t => {
  const f = fixture(t);
  for (const status of ['failed', 'cancelled']) f.receipt(f.run(status, { status }));
  f.receipt(f.run('gap-after-prediction', { history_eligible: 0 }));
  for (const state of ['stale', 'observation_gap', 'paused', 'cold_start']) f.receipt(f.run(state), { state });
  f.run('missing');
  f.run('pending', { status: 'running' });
  f.run('waiting', { status: 'paused' });
  f.run('short-failure', { status: 'failed', active_ms: 1000 });
  const report = f.report();
  assert.equal(report.population.pendingRuns, 2);
  assert.deepEqual(report.population.outcomes, { succeeded: 6, failed: 2, cancelled: 1, running: 1, paused: 1, unknown: 0 });
  const point = report.landmarks[0];
  assert.equal(point.availability.denominator, 8);
  assert.deepEqual(point.availability.outcomes, { succeeded: 6, failed: 1, cancelled: 1 });
  assert.equal(point.availability.observationGapOutcomes, 1);
  assert.equal(point.availability.numericRate, 3 / 8);
  assert.equal(point.availability.abstentionRate, 4 / 8);
  assert.equal(point.availability.missingRate, 1 / 8);
  assert.equal(point.pairedRuns, 0);
  assert.equal(point.accuracyExclusions.outcome_failed, 1);
  assert.equal(point.accuracyExclusions.outcome_cancelled, 1);
  assert.equal(point.accuracyExclusions.observation_gap_outcome, 1);
});

test('malformed and post-outcome receipts cannot be cherry-picked away or scored', t => {
  const f = fixture(t);
  const corrupt = f.run('corrupt');
  f.receipt(corrupt, { columns: { payload_json: '{invalid' } });
  f.receipt(corrupt, { active: MINUTE + 1000 });
  f.receipt(f.run('late'), { at: START + 6 * MINUTE });
  f.receipt(f.run('hash'), { columns: { id: 'not-the-hash' } });
  f.receipt(f.run('observed-in-future'), { payload: { observedAt: new Date(START + 2 * MINUTE).toISOString() } });
  f.receipt(f.run('column-active-mismatch'), { columns: { active_ms: MINUTE + 1 } });
  f.receipt(f.run('bad-quantiles'), { payload: { remainingMinutes: { p20: 4, p50: 2, p80: 3 } } });
  const report = f.report().landmarks[0];
  assert.equal(report.pairedRuns, 0);
  assert.equal(report.availability.counts.invalid, 6);
  assert.equal(report.accuracyExclusions.invalid_json, 1);
  assert.equal(report.accuracyExclusions.noncausal_timing, 2);
  assert.equal(report.accuracyExclusions.hash_mismatch, 1);
  assert.equal(report.accuracyExclusions.noncausal_observation, 1);
  assert.equal(report.accuracyExclusions.invalid_numeric_forecast, 1);
});

test('missing baselines are excluded and versions/profiles/classes never silently pool', t => {
  const f = fixture(t);
  f.receipt(f.run('missing-baseline'), { payload: { baselineRemainingMinutes: null } });
  f.receipt(f.run('default'));
  f.receipt(f.run('profile', { profile: 'separate' }));
  f.receipt(f.run('class', { task_class: 'research' }));
  f.receipt(f.run('model'), { payload: { modelVersion: 'future/2' }, columns: { model_version: 'future/2' } });
  f.receipt(f.run('baseline-version'), { payload: { baselineVersion: 'baseline/2' } });
  const report = f.report().landmarks[0];
  assert.equal(report.availability.counts.experimental, 6);
  assert.equal(report.accuracyExclusions.missing_baseline, 1);
  assert.equal(report.pairedRuns, 5);
  assert.equal(report.groups.length, 5);
  assert.ok(report.groups.every(group => group.n === 1));
});

test('invalid outcomes and orphan receipts are visible without polluting accuracy', t => {
  const f = fixture(t);
  const row = f.run('bad', { active_ms: 5 * MINUTE, finished_at: START + MINUTE });
  f.receipt(row);
  f.receipt({ ...row, id: 'orphan' });
  const report = f.report();
  assert.equal(report.population.invalidRuns, 1);
  assert.equal(report.population.orphanReceipts, 1);
  assert.equal(report.landmarks[0].pairedRuns, 0);
});

test('real tracker API receipts stay frozen when future history arrives (synthetic clock)', t => {
  const f = fixture(t);
  let now = START;
  const tracker = new AgentETA({ filename: f.filename, clock: () => now });
  afterCleanup(t, () => tracker.close());
  const advance = (id, steps) => {
    for (let i = 0; i < steps; i++) { now += 30_000; tracker.ping(id); }
  };
  for (const steps of [4, 6, 8]) {
    const { runId } = tracker.start(); advance(runId, steps); tracker.finish(runId);
  }
  const { runId } = tracker.start();
  advance(runId, 3); tracker.finish(runId);
  const saved = f.db.prepare('SELECT * FROM eta_forecasts WHERE run_id = ? ORDER BY rowid').all(runId);
  const pair = f.report().landmarks[0].groups.flatMap(group => group.pairs).find(p => p.runId === runId);
  assert.ok(pair);
  assert.equal(pair.baselineMinutes, 2);
  const future = tracker.start(); advance(future.runId, 1); tracker.finish(future.runId);
  assert.deepEqual(f.db.prepare('SELECT * FROM eta_forecasts WHERE run_id = ? ORDER BY rowid').all(runId), saved);
  const after = f.report().landmarks[0].groups.flatMap(group => group.pairs).find(p => p.runId === runId);
  assert.deepEqual(after, pair);
  assert.equal(after.actualRemainingMinutes, 0.5);
});

test('CLI is read-only, stable and does not create a missing database', t => {
  const f = fixture(t);
  f.receipt(f.run('one'));
  f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = readFileSync(f.filename);
  const rowsBefore = f.db.prepare('SELECT COUNT(*) AS n FROM eta_forecasts').get().n;
  const run = db => spawnSync(process.execPath, ['--no-warnings', cli, 'evaluate', '--db', db], { encoding: 'utf8' });
  const first = run(f.filename);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), f.report());
  assert.equal(run(f.filename).stdout, first.stdout);
  assert.deepEqual(readFileSync(f.filename), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM eta_forecasts').get().n, rowsBefore);
  const missing = join(f.dir, 'missing', 'runs.sqlite');
  const error = run(missing);
  assert.equal(error.status, 1);
  assert.match(JSON.parse(error.stderr).error, /DATABASE_NOT_FOUND/);
  assert.equal(existsSync(join(f.dir, 'missing')), false);
});

test('legacy databases report missing journal; unsupported schemas are errors, never migrations', t => {
  const f = fixture(t);
  f.run('legacy');
  f.db.exec('DROP TABLE eta_forecasts');
  const legacy = f.report();
  assert.equal(legacy.journal, 'missing_journal');
  assert.equal(legacy.landmarks[0].availability.counts.missing, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'eta_forecasts'").get().n, 0);
  f.db.exec('ALTER TABLE agentwhen_runs RENAME COLUMN active_ms TO unknown_column');
  assert.throws(() => f.report(), /UNSUPPORTED_DATABASE_SCHEMA/);
});
