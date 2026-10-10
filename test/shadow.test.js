import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentETA, MODEL_VERSION } from '../src/generic/tracker.js';
import { empiricalConditional, captureShadow, SHADOW_VERSION } from '../src/generic/shadow.js';
import { compareDatabase } from '../src/generic/compare.js';
import { forecastRun } from '../src/core/estimator.js';
import { afterCleanup } from '../test-support/cleanup.js';

// All data and clocks below are synthetic. Chronological replay validates the
// capture/comparison contract, never real-world prediction effectiveness.
const START = 1_800_000_000_000, MINUTE = 60_000;
const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-shadow-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  let now = START;
  const tracker = new AgentETA({ filename, clock: () => now });
  afterCleanup(t, () => tracker.close());
  const run = (id, options = {}) => {
    const r = { id, profile: 'synthetic', task_class: 'coding', status: 'succeeded',
      started_at: START, finished_at: START + 5 * MINUTE, active_ms: 5 * MINUTE, history_eligible: 1, ...options };
    tracker.db.prepare(`INSERT INTO agentwhen_runs (id, profile, task_class, status, started_at, finished_at,
      active_ms, last_seen, history_eligible) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.profile, r.task_class, r.status, r.started_at, r.finished_at, r.active_ms, r.started_at, r.history_eligible);
    return r;
  };
  const receipt = (r, { active = MINUTE, history = [3, 4, 5], state = 'experimental', mutate = () => {}, columns = {} } = {}) => {
    const at = new Date(r.started_at + active).toISOString();
    const numeric = state === 'experimental';
    const payload = { schema: 'agentwhen.status/1', runId: r.id, profile: r.profile, taskClass: r.task_class,
      status: state === 'paused' ? 'paused' : 'running', estimateStatus: state,
      startedAt: new Date(r.started_at).toISOString(), finishedAt: null, estimatedAt: at, observedAt: at,
      activeMinutes: Math.round(active / MINUTE * 1000) / 1000, historyCount: history.length,
      historyEligible: true, modelVersion: MODEL_VERSION,
      remainingMinutes: numeric ? { p20: 1, p50: 2, p80: 3 } : null,
      baselineRemainingMinutes: numeric ? 3 : null, baselineVersion: 'cohort-median-minus-elapsed/1',
      ...captureShadow(history.map(actualMinutes => ({ actualMinutes })), active, at, state) };
    mutate(payload);
    const json = JSON.stringify(payload);
    const row = { id: `eta-fc-${createHash('sha256').update(json).digest('hex')}`, run_id: r.id,
      estimated_at: r.started_at + active, active_ms: active, estimate_status: state,
      model_version: MODEL_VERSION, payload_json: json, ...columns };
    tracker.db.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.run_id, row.estimated_at, row.active_ms, row.estimate_status, row.model_version, row.payload_json);
    return row;
  };
  return { dir, filename, tracker, run, receipt, advance: ms => { now += ms; }, report: () => compareDatabase(filename) };
}

test('empirical residual quantiles are hand-calculated and do not mutate history', () => {
  const history = [9, 2, 5, 3];
  assert.deepEqual(empiricalConditional(history, MINUTE), {
    state: 'experimental', conditionalCount: 4, remainingMinutes: { p20: 1, p50: 2, p80: 8 } });
  assert.deepEqual(history, [9, 2, 5, 3]);
  assert.deepEqual(empiricalConditional([2, 3, 4], 0).remainingMinutes, { p20: 2, p50: 3, p80: 4 });
});

test('sparse tails and primary abstentions never manufacture zero or optimistic numbers', () => {
  for (const history of [[], [1, 2, 3], [5, 6]]) {
    const result = empiricalConditional(history, 3 * MINUTE);
    assert.equal(result.state, 'insufficient_tail');
    assert.equal(result.remainingMinutes, null);
  }
  for (const state of ['cold_start', 'paused', 'stale', 'observation_gap']) {
    const result = empiricalConditional([5, 6, 7], MINUTE, state);
    assert.equal(result.state, state);
    assert.equal(result.remainingMinutes, null);
  }
  assert.throws(() => empiricalConditional([NaN], 0), /INVALID_SHADOW_INPUT/);
});

test('tracker freezes the same capped cohort and time without changing displayed primary values', t => {
  const f = fixture(t);
  for (let i = 0; i < 205; i++) f.run(`history-${i}`, { profile: 'default', task_class: 'other',
    started_at: START - 1_000_000, finished_at: START - 300_000 + i * 1000, active_ms: (2 + i / 1000) * MINUTE });
  for (const [id, options] of [
    ['future', { finished_at: START + 1000 }], ['failed', { status: 'failed' }],
    ['gap', { history_eligible: 0 }], ['profile', { profile: 'other' }], ['class', { task_class: 'review' }],
  ]) f.run(id, { profile: 'default', task_class: 'other', started_at: START - 1_000_000,
    finished_at: START - 1, active_ms: 10 * MINUTE, ...options });
  const primary = f.tracker.start();
  const payload = JSON.parse(f.tracker.db.prepare('SELECT payload_json FROM eta_forecasts WHERE id = ?').get(primary.forecastId).payload_json);
  const durations = Array.from({ length: 200 }, (_, i) => (2 + (204 - i) / 1000) * MINUTE / MINUTE);
  assert.deepEqual(payload.comparisonInputs.historyMinutes, durations);
  assert.equal(payload.shadow.estimatedAt, primary.estimatedAt);
  assert.equal(payload.shadow.activeMs, 0);
  assert.equal(payload.shadow.historyCount, 200);
  assert.equal(payload.shadow.conditionalCount, 200);
  const expected = forecastRun({ state: { status: 'running', activeElapsedMs: 0, taskClass: 'other', steps: [] },
    history: durations.map(actualMinutes => ({ actualMinutes, taskClass: 'other' })), now: new Date(START), seed: primary.runId });
  assert.deepEqual(primary.remainingMinutes, { p20: expected.lowerMinutes, p50: expected.p50Minutes, p80: expected.p80Minutes });
  assert.equal(f.tracker.status(primary.runId).forecastId, primary.forecastId);
  assert.equal(Object.hasOwn(primary, 'shadow'), false);
});

test('chronological controlled replay saves candidates before outcomes and preserves them after future runs', t => {
  const f = fixture(t);
  const complete = ticks => {
    const run = f.tracker.start();
    for (let i = 0; i < ticks; i++) { f.advance(30_000); f.tracker.ping(run.runId); }
    f.tracker.finish(run.runId);
    return run.runId;
  };
  for (const ticks of [4, 6, 8]) complete(ticks);
  const target = f.tracker.start();
  for (let i = 0; i < 2; i++) { f.advance(30_000); f.tracker.ping(target.runId); }
  const before = f.tracker.db.prepare('SELECT * FROM eta_forecasts WHERE run_id = ? ORDER BY rowid').all(target.runId);
  assert.equal(f.tracker.get(target.runId).finished_at, null);
  f.advance(30_000); f.tracker.finish(target.runId);
  const pair = f.report().landmarks[0].groups.flatMap(g => g.pairs).find(p => p.runId === target.runId);
  assert.equal(pair.candidateP50Minutes, 2);
  assert.equal(pair.actualRemainingMinutes, 0.5);
  assert.equal(f.report().promotionEligible, false);
  assert.deepEqual(f.tracker.db.prepare('SELECT * FROM eta_forecasts WHERE run_id = ? ORDER BY rowid').all(target.runId), before);
  complete(1);
  assert.deepEqual(f.report().landmarks[0].groups.flatMap(g => g.pairs).find(p => p.runId === target.runId), pair);
});

test('three-way metrics use the identical paired rows and known errors', t => {
  const f = fixture(t);
  f.receipt(f.run('a'));
  f.receipt(f.run('b', { active_ms: 4 * MINUTE }), { mutate: p => { p.remainingMinutes = { p20: 0, p50: 1, p80: 3 }; } });
  const report = f.report();
  const group = report.landmarks[0].groups[0];
  assert.equal(group.n, 2);
  assert.equal(group.primary.meanAbsoluteErrorMinutes, 2);
  assert.equal(group.primary.severeUnderestimateRate, 0.5);
  assert.equal(group.candidate.meanAbsoluteErrorMinutes, 0.5);
  assert.equal(group.candidate.medianAbsoluteErrorMinutes, 0.5);
  assert.equal(group.candidate.p80Coverage, 1);
  assert.equal(group.candidate.meanIntervalWidthMinutes, 2);
  assert.equal(group.medianBaseline.meanAbsoluteErrorMinutes, 0.5);
  assert.equal(group.candidateMinusPrimary.meanAbsoluteErrorDifferenceMinutes, -1.5);
  assert.deepEqual(group.candidateMinusPrimary.bootstrap95, { lower: -2, upper: -1, resamples: 2000, unit: 'run' });
  assert.equal(group.candidateMinusMedianBaseline.meanAbsoluteErrorDifferenceMinutes, 0);
  assert.deepEqual(group.pairs.map(p => p.runId), ['a', 'b']);
  assert.deepEqual(f.report(), report);
  assert.equal(report.promotionEligible, false); // Even a favorable synthetic interval cannot promote.
});

test('empty and singleton comparisons retain honest evidence states', t => {
  const f = fixture(t);
  assert.equal(f.report().landmarks[0].evidenceStatus, 'no_scorable_pairs');
  assert.equal(f.report().landmarks[0].candidateAvailability.numericRate, null);
  f.receipt(f.run('single'));
  const group = f.report().landmarks[0].groups[0];
  assert.equal(group.evidenceStatus, 'single_run_only');
  assert.equal(group.candidateMinusPrimary.bootstrap95, null);
});

test('legacy and early sparse receipts cannot be replaced by later numeric candidates', t => {
  const f = fixture(t);
  const legacy = f.run('legacy');
  const first = f.receipt(legacy, { mutate: p => { delete p.shadow; delete p.comparisonInputs; } });
  f.receipt(legacy, { active: MINUTE + 1000 });
  const sparse = f.run('sparse');
  f.receipt(sparse, { history: [0.1, 0.2, 2] });
  f.receipt(sparse, { active: MINUTE + 1000 });
  const report = f.report().landmarks[0];
  assert.equal(report.pairedRuns, 0);
  assert.deepEqual(report.candidateAvailability.counts, { numeric: 0, abstained: 1, missing: 1, invalid: 0 });
  assert.equal(report.candidateAvailability.reasons.insufficient_tail, 1);
  assert.equal(report.candidateAvailability.reasons.missing_shadow, 1);
  assert.equal(report.selections[0].forecastId, first.id);
});

test('failed/cancelled/gap outcomes stay in availability but not paired accuracy', t => {
  const f = fixture(t);
  for (const status of ['failed', 'cancelled']) f.receipt(f.run(status, { status }));
  f.receipt(f.run('gap', { history_eligible: 0 }));
  for (const state of ['cold_start', 'paused', 'stale', 'observation_gap']) f.receipt(f.run(state), { state });
  f.run('missing');
  f.run('pending', { status: 'running', finished_at: null });
  const report = f.report();
  assert.equal(report.population.pendingRuns, 1);
  const point = report.landmarks[0];
  assert.equal(point.candidateAvailability.denominator, 8);
  assert.deepEqual(point.candidateAvailability.counts, { numeric: 3, abstained: 4, missing: 1, invalid: 0 });
  assert.equal(point.pairedRuns, 0);
  assert.equal(point.accuracyExclusions.outcome_failed, 1);
  assert.equal(point.accuracyExclusions.outcome_cancelled, 1);
  assert.equal(point.accuracyExclusions.observation_gap_outcome, 1);
});

test('corrupt primary/input/time/support/quantile records cannot enter the comparison', t => {
  const f = fixture(t);
  const edits = [p => { p.comparisonInputs.historyMinutes[0] = 100; },
    p => { p.shadow.estimatedAt = new Date(START + 9 * MINUTE).toISOString(); },
    p => { p.shadow.conditionalCount = 99; }, p => { p.shadow.remainingMinutes.p80 = 0; },
    p => { delete p.comparisonInputs; }];
  edits.forEach((mutate, i) => f.receipt(f.run(`bad-${i}`), { mutate }));
  f.receipt(f.run('bad-hash'), { columns: { id: 'invalid' } });
  const point = f.report().landmarks[0];
  assert.equal(point.candidateAvailability.counts.invalid, 6);
  assert.equal(point.pairedRuns, 0);
  assert.equal(point.candidateAvailability.reasons.invalid_primary_receipt, 1);
});

test('workflow and model/baseline versions are separated on the intersection', t => {
  const f = fixture(t);
  f.receipt(f.run('normal'));
  f.receipt(f.run('profile', { profile: 'separate' }));
  f.receipt(f.run('class', { task_class: 'review' }));
  f.receipt(f.run('baseline'), { mutate: p => { p.baselineVersion = 'median/2'; } });
  f.receipt(f.run('model'), { mutate: p => { p.modelVersion = 'primary/2'; }, columns: { model_version: 'primary/2' } });
  const point = f.report().landmarks[0];
  assert.equal(point.pairedRuns, 5);
  assert.equal(point.groups.length, 5);
  assert.ok(point.groups.every(g => g.n === 1 && g.candidateVersion === SHADOW_VERSION));
});

test('CLI comparison is deterministic and read-only; missing data is not created or backfilled', t => {
  const f = fixture(t);
  f.receipt(f.run('scored'));
  const before = readFileSync(f.filename), wal = readFileSync(`${f.filename}-wal`);
  const run = path => spawnSync(process.execPath, ['--no-warnings', cli, 'compare', '--db', path], { encoding: 'utf8' });
  const output = run(f.filename);
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), f.report());
  assert.equal(run(f.filename).stdout, output.stdout);
  assert.deepEqual(readFileSync(f.filename), before);
  assert.deepEqual(readFileSync(`${f.filename}-wal`), wal);
  const missing = join(f.dir, 'missing', 'runs.sqlite');
  assert.equal(run(missing).status, 1);
  assert.equal(existsSync(join(f.dir, 'missing')), false);
  f.tracker.db.exec('DROP TABLE eta_forecasts');
  assert.equal(f.report().journal, 'missing_journal');
  assert.equal(f.report().landmarks[0].pairedRuns, 0);
});
