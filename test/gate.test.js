import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentETA, MODEL_VERSION } from '../src/generic/tracker.js';
import { captureShadow } from '../src/generic/shadow.js';
import { createGatePlan, validateGatePlan, readGatePlan, assessGateDatabase } from '../src/generic/gate.js';
import { afterCleanup } from '../test-support/cleanup.js';

// Every sample is synthetic. Even the all-targets-met fixture is not real evidence.
const MIN = 60_000, NOW = 1_800_000_000_000, START = NOW + 60 * MIN, END = START + 60 * MIN;
const iso = n => new Date(n).toISOString();
const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-gate-')), filename = join(dir, 'runs.sqlite');
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const tracker = new AgentETA({ filename });
  afterCleanup(t, () => tracker.close());
  const options = { profile: 'synthetic', taskClass: 'coding', holdoutStart: iso(START), holdoutEnd: iso(END) };
  const plan = createGatePlan(filename, options, () => NOW);
  const run = (id, { start = START, minutes = 25, status = 'succeeded', profile = 'synthetic', taskClass = 'coding',
    history = [25, 25, 25], state = 'experimental', primaryError, mutate = () => {}, receipts = true } = {}) => {
    const finished = ['running', 'paused'].includes(status) ? null : start + minutes * MIN;
    tracker.db.prepare(`INSERT INTO agentwhen_runs (id, profile, task_class, status, started_at, finished_at,
      active_ms, history_eligible, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, profile, taskClass, status, start, finished, minutes * MIN, start);
    if (!receipts) return;
    for (const active of [1, 5, 10]) {
      const at = iso(start + active * MIN), numeric = state === 'experimental';
      const actual = minutes - active;
      const payload = { schema: 'agentwhen.status/1', runId: id, profile, taskClass, status: 'running', estimateStatus: state,
        startedAt: iso(start), finishedAt: null, estimatedAt: at, observedAt: at, activeMinutes: active,
        historyCount: history.length, historyEligible: true, modelVersion: MODEL_VERSION,
        remainingMinutes: numeric ? { p20: 0, p50: primaryError === undefined ? 5 : actual - primaryError, p80: 35 } : null,
        baselineRemainingMinutes: numeric ? primaryError === undefined ? 6 : actual - primaryError : null,
        baselineVersion: 'cohort-median-minus-elapsed/1',
        ...captureShadow(history.map(actualMinutes => ({ actualMinutes })), active * MIN, at, state) };
      mutate(payload, active);
      const json = JSON.stringify(payload), hash = createHash('sha256').update(json).digest('hex');
      tracker.db.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(`eta-fc-${hash}`, id, start + active * MIN, active * MIN, payload.estimateStatus, payload.modelVersion, json);
    }
  };
  return { dir, filename, tracker, options, plan, run,
    assess: (now = END + 60 * MIN) => assessGateDatabase(filename, plan, () => now) };
}
function checks(report, section = 'overall') { return report.evaluations.flatMap(point => point[section].checks); }

test('fresh gate plans freeze scope, versions, targets and future-only boundaries', t => {
  const f = fixture(t);
  assert.equal(validateGatePlan(f.plan), f.plan);
  assert.equal(f.plan.thresholds.minimumPairs, 30);
  assert.equal(f.plan.thresholds.minimumLongPairs, 10);
  assert.equal(f.plan.versions.candidate, 'empirical-conditional/1');
  assert.throws(() => createGatePlan(f.filename, { ...f.options, profile: '' }, () => NOW), /INVALID_GATE_SCOPE/);
  assert.throws(() => createGatePlan(f.filename, { ...f.options, taskClass: 'invalid' }, () => NOW), /INVALID_GATE_SCOPE/);
  assert.throws(() => createGatePlan(f.filename, f.options, () => START), /INVALID_COHORT_WINDOW/);
  for (const field of ['scope', 'versions', 'thresholds', 'cohortPlan']) {
    const altered = structuredClone(f.plan);
    altered[field].extra = true;
    assert.throws(() => validateGatePlan(altered), /INVALID_GATE_PLAN/);
  }
  const weakened = structuredClone(f.plan);
  weakened.thresholds.minimumPairs = 1;
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const { id, ...body } = weakened;
  weakened.id = `eta-gate-${createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')}`;
  assert.throws(() => validateGatePlan(weakened), /INVALID_GATE_PLAN/);
});

test('window and pending guards withhold accuracy, including a run that crosses window end', t => {
  const f = fixture(t);
  f.run('pending', { start: END - MIN, minutes: 0, status: 'running', receipts: false });
  let result = f.assess(END - 1);
  assert.equal(result.status, 'awaiting_window');
  assert.equal(Object.hasOwn(result, 'comparison'), false);
  result = f.assess(END);
  assert.equal(result.status, 'awaiting_outcomes');
  assert.equal(Object.hasOwn(result, 'evaluations'), false);
  f.tracker.db.prepare("UPDATE agentwhen_runs SET status='succeeded', active_ms=?, finished_at=? WHERE id='pending'")
    .run(25 * MIN, END + 24 * MIN);
  result = f.assess(END + 25 * MIN);
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.population.scopedRuns, 1);
  assert.equal(result.comparison.population.closedRuns, 1);
});

test('all favorable synthetic targets still require independent review and cannot promote a model', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.run(`r-${i}`);
  const result = f.assess();
  assert.equal(result.status, 'numeric_targets_met_pending_review');
  assert.equal(result.promotionEligible, false);
  assert.equal(result.defaultModelChanged, false);
  assert.equal(result.independentReviewRequired, true);
  for (const point of result.evaluations) {
    assert.equal(point.overall.pairedRuns, 30);
    assert.equal(point.longRuns.pairedRuns, 30);
  }
  assert.ok([...checks(result), ...checks(result, 'longRuns')].every(c => c.result === 'met'));
  assert.equal(result.comparison.landmarks[0].groups[0].candidate.meanAbsoluteErrorMinutes, 0);
});

test('MAE target is inclusive at 90 percent and a worse result cannot pass by matching coverage', t => {
  const at = fixture(t), worse = fixture(t);
  for (let i = 0; i < 30; i++) {
    at.run(`r-${i}`, { history: [34, 34, 34], primaryError: 10 });
    worse.run(`r-${i}`, { history: [34.01, 34.01, 34.01], primaryError: 10 });
  }
  assert.equal(at.assess().status, 'numeric_targets_met_pending_review');
  const result = worse.assess();
  assert.equal(result.status, 'targets_not_met');
  assert.ok(checks(result).filter(c => c.name === 'mae_vs_primary').every(c => c.result === 'not_met'));
});

test('availability targets include inherited abstention and sparse tails at the exact 80 percent and 5 point boundaries', t => {
  const f = fixture(t);
  for (let i = 0; i < 32; i++) f.run(`numeric-${i}`);
  for (let i = 0; i < 2; i++) f.run(`tail-${i}`, { history: [0.5, 1, 2] });
  for (let i = 0; i < 6; i++) f.run(`cold-${i}`, { history: [], state: 'cold_start' });
  let result = f.assess();
  assert.equal(result.status, 'numeric_targets_met_pending_review');
  assert.equal(result.comparison.landmarks[0].candidateAvailability.numericRate, 0.8);
  assert.equal(result.comparison.landmarks[0].primaryAvailability.numericRate, 0.85);
  f.run('one-more-tail', { history: [0.5, 1, 2] });
  result = f.assess();
  assert.equal(result.status, 'targets_not_met');
  assert.ok(checks(result).some(c => c.name === 'numeric_rate' && c.result === 'not_met'));
});

test('empty, too-small and missing long-run cohorts remain insufficient; missing metrics never pass as zero', t => {
  const empty = fixture(t), small = fixture(t), short = fixture(t);
  assert.equal(empty.assess().status, 'insufficient_evidence');
  assert.ok(checks(empty.assess()).some(c => c.result === 'not_evaluable' && c.value === null));
  for (let i = 0; i < 29; i++) small.run(`r-${i}`);
  assert.equal(small.assess().status, 'insufficient_evidence');
  for (let i = 0; i < 30; i++) short.run(`r-${i}`, { minutes: 15, history: [15, 15, 15] });
  const result = short.assess();
  assert.equal(result.status, 'insufficient_evidence');
  assert.ok(result.evaluations.every(p => p.overall.pairedRuns === 30 && p.longRuns.pairedRuns === 0));
});

test('wide intervals, low coverage and severe underestimation each have explicit failed checks', t => {
  const wide = fixture(t), low = fixture(t);
  for (let i = 0; i < 30; i++) {
    wide.run(`r-${i}`, { history: [25, 25, 100] });
    low.run(`r-${i}`, { history: [11, 11, 11] });
  }
  const wideResult = wide.assess(), lowResult = low.assess();
  assert.equal(wideResult.status, 'targets_not_met');
  assert.ok(checks(wideResult).some(c => c.name === 'interval_width' && c.result === 'not_met'));
  assert.equal(lowResult.status, 'targets_not_met');
  assert.ok(checks(lowResult).some(c => c.name === 'p80_coverage' && c.result === 'not_met'));
  assert.ok(checks(lowResult).some(c => c.name === 'severe_vs_primary' && c.result === 'not_met'));
});

test('zero primary error, width and severe count do not manufacture a relative improvement', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.run(`r-${i}`, { primaryError: 0, mutate: (p, active) => {
    p.remainingMinutes = { p20: 25 - active, p50: 25 - active, p80: 25 - active };
  } });
  const result = f.assess();
  assert.equal(result.status, 'targets_not_met');
  assert.ok(checks(result).filter(c => ['interval_width', 'severe_vs_primary'].includes(c.name)).every(c => c.limit === 0 && c.result === 'met'));
  assert.ok(checks(result).filter(c => c.name === 'paired_mae_upper_vs_primary').every(c => c.value === 0 && c.result === 'not_met'));
});

test('failed/cancelled and absent or corrupt receipts remain in the denominator; unrelated pending scope does not block', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.run(`r-${i}`);
  f.run('failed', { status: 'failed' });
  f.run('cancelled', { status: 'cancelled' });
  f.run('unrelated', { profile: 'other', status: 'paused', minutes: 0, receipts: false });
  let result = f.assess();
  assert.equal(result.status, 'numeric_targets_met_pending_review');
  assert.equal(result.population.outOfScopeRuns, 1);
  assert.equal(result.comparison.landmarks[0].candidateAvailability.denominator, 32);
  assert.equal(result.comparison.landmarks[0].pairedRuns, 30);
  f.run('missing', { receipts: false });
  f.run('corrupt', { mutate: p => { p.shadow.historyFingerprint = 'invalid'; } });
  result = f.assess();
  assert.equal(result.status, 'targets_not_met');
  assert.ok(checks(result).some(c => c.name === 'candidate_missing_rate' && c.result === 'not_met'));
  assert.ok(checks(result).some(c => c.name === 'candidate_invalid_rate' && c.result === 'not_met'));
});

test('different selected primary, candidate or scored baseline versions invalidate the readout', t => {
  for (const mutate of [p => { p.modelVersion = 'other/1'; }, p => { p.shadow.modelVersion = 'other/1'; },
    p => { p.baselineVersion = 'other/1'; }]) {
    const f = fixture(t);
    f.run('changed', { mutate });
    const result = f.assess();
    assert.equal(result.status, 'invalid_evidence');
    assert.equal(result.reason, 'model_version_mismatch');
    assert.equal(Object.hasOwn(result, 'comparison'), false);
  }
});

test('invalid runs and future outcomes/receipts are rejected before metrics', t => {
  for (const mode of ['invalid', 'invalid-start', 'outcome', 'receipt']) {
    const f = fixture(t);
    f.run('r');
    if (mode === 'invalid') f.tracker.db.prepare("UPDATE agentwhen_runs SET active_ms=-1 WHERE id='r'").run();
    if (mode === 'invalid-start') f.tracker.db.prepare("UPDATE agentwhen_runs SET started_at=-1 WHERE id='r'").run();
    if (mode === 'outcome') f.tracker.db.prepare("UPDATE agentwhen_runs SET finished_at=? WHERE id='r'").run(END + MIN);
    if (mode === 'receipt') f.tracker.db.prepare('UPDATE eta_forecasts SET estimated_at=?').run(END + MIN);
    const result = f.assess(END);
    assert.equal(result.status, 'invalid_evidence');
    assert.equal(Object.hasOwn(result, 'comparison'), false);
  }
});

test('assessment is deterministic with a fixed clock and leaves database/WAL bytes unchanged', t => {
  const f = fixture(t);
  f.run('r');
  const bytes = () => [f.filename, `${f.filename}-wal`].map(path => existsSync(path) ? readFileSync(path) : null);
  const before = bytes();
  assert.deepEqual(f.assess(), f.assess());
  assert.deepEqual(bytes(), before);
  const absent = join(f.dir, 'missing.sqlite');
  assert.throws(() => assessGateDatabase(absent, f.plan), /DATABASE_NOT_FOUND/);
  assert.equal(existsSync(absent), false);
  assert.throws(() => readGatePlan(join(f.dir, 'absent.json')), /GATE_PLAN_READ_FAILED/);
});

test('CLI scopes gate options, supports its legacy alias, and never treats diagnostic success as model promotion', t => {
  const f = fixture(t), planFile = join(f.dir, 'gate.json');
  const invoke = (args, binary = cli) => spawnSync(process.execPath, ['--no-warnings', binary, ...args], { cwd: f.dir, encoding: 'utf8' });
  const start = Date.now() + MIN;
  const result = invoke(['gate-plan', '--db', f.filename, '--profile', 'synthetic', '--class', 'coding',
    '--holdout-start', iso(start), '--holdout-end', iso(start + MIN)]);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(planFile, result.stdout);
  assert.equal(readGatePlan(planFile).scope.profile, 'synthetic');
  const args = ['gate', '--db', f.filename, '--plan', planFile];
  const readout = invoke(args), alias = invoke(args, fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url)));
  assert.equal(readout.status, 0, readout.stderr);
  const value = JSON.parse(readout.stdout);
  assert.equal(value.status, 'awaiting_window');
  assert.equal(value.promotionEligible, false);
  const omitTime = ({ assessedAt, ...rest }) => rest;
  assert.deepEqual(omitTime(value), omitTime(JSON.parse(alias.stdout)));
  for (const args of [['gate'], ['gate', '--plan', planFile, '--cohort', 'holdout'], ['gate-plan'],
    ['start', '--plan', planFile], ['gate', '--plan', planFile, '--profile', 'synthetic'],
    ['gate', '--plan', planFile, '--db', join(f.dir, 'missing.sqlite')]]) {
    const bad = invoke(args);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
  }
  assert.equal(existsSync(join(f.dir, '.agent-eta')), false);
  assert.equal(existsSync(join(f.dir, 'missing.sqlite')), false);
});
