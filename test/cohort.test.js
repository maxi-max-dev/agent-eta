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
import { compareDatabase } from '../src/generic/compare.js';
import { createCohortPlan, compareCohortDatabase, readCohortPlan, validateCohortPlan } from '../src/generic/cohort.js';
import { afterCleanup } from '../test-support/cleanup.js';

// Synthetic metadata and controlled clocks only, never real accuracy evidence.
const NOW = 1_800_000_000_000, MIN = 60_000, START = NOW + 60 * MIN, END = START + 60 * MIN;
const iso = n => new Date(n).toISOString();
const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-cohort-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  const tracker = new AgentETA({ filename });
  afterCleanup(t, () => tracker.close());
  const run = (id, started_at = NOW - 10 * MIN, active_ms = 5 * MIN, overrides = {}) => {
    const r = { id, profile: 'synthetic', task_class: 'coding', status: 'succeeded', started_at,
      finished_at: started_at + active_ms, active_ms, history_eligible: 1, ...overrides };
    tracker.db.prepare(`INSERT INTO agentwhen_runs (id, profile, task_class, status, started_at,
      finished_at, active_ms, history_eligible, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.profile, r.task_class, r.status, r.started_at, r.finished_at, r.active_ms, r.history_eligible, r.started_at);
    return r;
  };
  const receipt = (r, { active = MIN, history = [4, 5, 6], state = 'experimental' } = {}) => {
    const at = iso(r.started_at + active), numeric = state === 'experimental';
    const payload = { schema: 'agentwhen.status/1', runId: r.id, profile: r.profile, taskClass: r.task_class,
      status: 'running', estimateStatus: state, startedAt: iso(r.started_at), finishedAt: null,
      estimatedAt: at, observedAt: at, activeMinutes: Math.round(active / MIN * 1000) / 1000,
      historyCount: history.length, historyEligible: true, modelVersion: MODEL_VERSION,
      remainingMinutes: numeric ? { p20: 1, p50: 2, p80: 3 } : null,
      baselineRemainingMinutes: numeric ? 3 : null, baselineVersion: 'cohort-median-minus-elapsed/1',
      ...captureShadow(history.map(actualMinutes => ({ actualMinutes })), active, at, state) };
    const json = JSON.stringify(payload), id = `eta-fc-${createHash('sha256').update(json).digest('hex')}`;
    tracker.db.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, r.id, r.started_at + active, active, state, MODEL_VERSION, json);
    return id;
  };
  const plan = () => createCohortPlan(filename, { holdoutStart: iso(START), holdoutEnd: iso(END) }, () => NOW);
  return { dir, filename, tracker, run, receipt, plan,
    compare: (plan, cohort = 'holdout') => compareCohortDatabase(filename, plan, cohort) };
}

test('declaration only accepts strict future UTC bounds and rejects normalized invalid dates', t => {
  const f = fixture(t);
  for (const [start, end] of [[iso(NOW), iso(END)], [iso(NOW - 1), iso(END)], [iso(START), iso(START)],
    [iso(START), iso(START - 1)], ['2027-02-30T00:00:00Z', iso(END)], ['2027-02-01', iso(END)],
    ['2027-02-01T00:00:00+00:00', iso(END)], [undefined, iso(END)]]) {
    assert.throws(() => createCohortPlan(f.filename, { holdoutStart: start, holdoutEnd: end }, () => NOW), /INVALID_COHORT/);
  }
  const plan = f.plan();
  assert.equal(plan.declaredAt, iso(NOW));
  assert.deepEqual(plan.knownRunIds, []);
  assert.deepEqual(validateCohortPlan(plan), plan);
  assert.equal(f.compare(plan).comparison.population.totalRuns, 0);
  assert.equal(f.compare(plan).promotionEligible, false);
});

test('one whole run per cohort including exact boundaries, crossing runs, and pre-existing future claims', t => {
  const f = fixture(t);
  f.receipt(f.run('old'));
  f.run('pending-at-declaration', NOW - MIN, 0, { status: 'running', finished_at: null });
  f.run('known-future', START);
  f.run('known-invalid', NOW - MIN, -1);
  const plan = f.plan();
  f.tracker.db.prepare("UPDATE agentwhen_runs SET status='succeeded', active_ms=?, finished_at=? WHERE id=?")
    .run(62 * MIN, START + MIN, 'pending-at-declaration');
  f.run('before', START - 1);
  const a = f.run('at-start', START, 20 * MIN), b = f.run('crosses-end', END - 1, 20 * MIN);
  for (const r of [a, b]) for (const minutes of [1, 5, 10]) f.receipt(r, { active: minutes * MIN, history: [20, 25, 30] });
  f.run('at-end', END);
  f.run('late-backfill', NOW - 10 * MIN);
  f.run('bad-start', -1);
  const holdout = f.compare(plan), tuning = f.compare(plan, 'tuning');
  assert.deepEqual(holdout.membership.tuning.runIds, ['old']);
  assert.deepEqual(holdout.membership.holdout.runIds, ['at-start', 'crosses-end']);
  assert.deepEqual(holdout.membership.preexistingExcluded.runIds, ['known-future', 'known-invalid', 'pending-at-declaration']);
  assert.deepEqual(holdout.membership.outsideWindow.runIds, ['at-end', 'before', 'late-backfill']);
  assert.deepEqual(holdout.membership.invalidStart.runIds, ['bad-start']);
  assert.equal(Object.values(holdout.membership).reduce((n, x) => n + x.count, 0), holdout.source.runs);
  for (const point of holdout.comparison.landmarks) assert.deepEqual(point.selections.map(x => x.runId), ['at-start', 'crosses-end']);
  assert.equal(tuning.comparison.population.totalRuns, 1);
  assert.equal(tuning.comparison.landmarks[0].pairedRuns, 1);
});

test('late-added tuning receipts cannot fill missing predictions, including later numeric refreshes', t => {
  const f = fixture(t);
  const a = f.run('missing'), b = f.run('abstained');
  f.receipt(b, { history: [], state: 'cold_start' });
  const plan = f.plan(), before = f.compare(plan, 'tuning').comparison;
  f.receipt(a);
  f.receipt(b, { active: MIN + 1000 });
  const after = f.compare(plan, 'tuning');
  assert.deepEqual(after.comparison, before);
  assert.equal(after.comparison.landmarks[0].pairedRuns, 0);
  assert.equal(compareDatabase(f.filename).landmarks[0].pairedRuns, 1);
});

test('frozen run edits fail closed for both cohorts', t => {
  const f = fixture(t);
  f.receipt(f.run('old'));
  const plan = f.plan();
  f.tracker.db.prepare("UPDATE agentwhen_runs SET profile='edited' WHERE id='old'").run();
  for (const cohort of ['tuning', 'holdout']) assert.throws(() => f.compare(plan, cohort), /COHORT_TUNING_CHANGED/);
});

test('frozen receipt edit or deletion cannot be mistaken for missing predictions', t => {
  const f = fixture(t), id = f.receipt(f.run('old')), plan = f.plan();
  f.tracker.db.prepare("UPDATE eta_forecasts SET payload_json='{}' WHERE id=?").run(id);
  assert.throws(() => f.compare(plan), /COHORT_TUNING_CHANGED/);
  f.tracker.db.prepare('DELETE FROM eta_forecasts WHERE id=?').run(id);
  assert.throws(() => f.compare(plan), /COHORT_TUNING_CHANGED/);
});

test('deleted known pending runs and a different source are rejected', t => {
  const f = fixture(t);
  f.run('pending', NOW - MIN, 0, { status: 'paused', finished_at: null });
  const plan = f.plan();
  f.tracker.db.prepare("DELETE FROM agentwhen_runs WHERE id='pending'").run();
  assert.throws(() => f.compare(plan), /COHORT_SOURCE_MISMATCH/);
});

test('duration/workflow strata include pending, failed, missing and sparse-tail cases with exact boundaries', t => {
  const f = fixture(t), plan = f.plan();
  f.receipt(f.run('short', START, 5 * MIN));
  f.receipt(f.run('medium', START, 15 * MIN), { history: [0.5, 1, 2] });
  f.receipt(f.run('long', START, 15 * MIN + 1, { task_class: 'research' }));
  f.receipt(f.run('failed', START, 5 * MIN, { status: 'failed', profile: 'failure' }));
  f.receipt(f.run('cancelled', START, 5 * MIN, { status: 'cancelled', profile: 'failure' }));
  f.run('no-receipt', START, 5 * MIN, { profile: 'missing' });
  f.run('pending', START, 0, { status: 'running', finished_at: null });
  f.run('paused', START, 0, { status: 'paused', finished_at: null });
  f.run('invalid', START, -1);
  const report = f.compare(plan);
  assert.equal(report.comparison.population.pendingRuns, 2);
  assert.equal(report.comparison.population.invalidRuns, 1);
  const short = report.strata.find(s => s.profile === 'synthetic' && s.durationBand === 'up_to_5m');
  const g = short.landmarks[0].groups[0];
  assert.equal(g.primary.meanAbsoluteErrorMinutes, 2);
  assert.equal(g.candidate.meanAbsoluteErrorMinutes, 0);
  assert.equal(g.medianBaseline.meanAbsoluteErrorMinutes, 1);
  assert.equal(g.candidateMinusPrimary.meanAbsoluteErrorDifferenceMinutes, -2);
  assert.equal(g.n, 1);
  const medium = report.strata.find(s => s.durationBand === '5_to_15m');
  assert.equal(medium.landmarks[0].candidateAvailability.reasons.insufficient_tail, 1);
  assert.equal(medium.landmarks[0].candidateAvailability.abstentionRate, 1);
  const long = report.strata.find(s => s.durationBand === 'over_15m');
  assert.equal(long.taskClass, 'research');
  const failed = report.strata.find(s => s.profile === 'failure');
  assert.equal(failed.landmarks[0].candidateAvailability.denominator, 2);
  assert.equal(failed.landmarks[0].pairedRuns, 0);
  assert.equal(failed.landmarks[0].accuracyExclusions.outcome_failed, 1);
  assert.equal(failed.landmarks[0].accuracyExclusions.outcome_cancelled, 1);
  assert.equal(report.strata.find(s => s.profile === 'missing').landmarks[0].candidateAvailability.missingRate, 1);
  const unknown = report.strata.find(s => s.durationBand === 'unknown');
  assert.equal(unknown.population.totalRuns, 3);
  assert.equal(report.promotionEligible, false);
});

test('a pending holdout stays in its cohort after finishing and is never dropped for finishing after the window', t => {
  const f = fixture(t), plan = f.plan();
  const r = f.run('new', END - MIN, 0, { status: 'running', finished_at: null });
  f.receipt(r);
  const before = f.compare(plan);
  assert.equal(before.comparison.population.pendingRuns, 1);
  f.tracker.db.prepare("UPDATE agentwhen_runs SET status='succeeded', active_ms=?, finished_at=? WHERE id='new'")
    .run(5 * MIN, END + 4 * MIN);
  const after = f.compare(plan);
  assert.deepEqual(after.membership, before.membership);
  assert.equal(after.comparison.landmarks[0].pairedRuns, 1);
});

test('plan tampering, unsupported fields, invalid selections and unreadable plans fail closed', t => {
  const f = fixture(t), plan = f.plan();
  for (const value of [null, [], {}, { ...plan, holdoutEnd: iso(END + 1) }, { ...plan, extra: true },
    { ...plan, knownRunIds: ['fake'] }, { ...plan, tuningReceiptIds: ['fake'] }]) {
    assert.throws(() => validateCohortPlan(value), /INVALID_COHORT_PLAN/);
  }
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  assert.deepEqual(f.compare(reordered).comparison, f.compare(plan).comparison);
  assert.throws(() => f.compare(plan, 'all'), /INVALID_COHORT/);
  assert.throws(() => readCohortPlan(join(f.dir, 'absent.json')), /COHORT_PLAN_READ_FAILED/);
  writeFileSync(join(f.dir, 'bad.json'), 'not json');
  assert.throws(() => readCohortPlan(join(f.dir, 'bad.json')), /COHORT_PLAN_READ_FAILED/);
});

test('comparison and declaration are read-only, deterministic and preserve original compare output', t => {
  const f = fixture(t);
  f.receipt(f.run('old'));
  const bytes = () => [f.filename, `${f.filename}-wal`].map(path => existsSync(path) ? readFileSync(path) : null);
  const before = bytes(), unplanned = compareDatabase(f.filename), plan = f.plan();
  assert.deepEqual(f.plan(), plan);
  assert.deepEqual(f.compare(plan), f.compare(plan));
  assert.deepEqual(compareDatabase(f.filename), unplanned);
  assert.deepEqual(bytes(), before);
  const absent = join(f.dir, 'absent.sqlite');
  assert.throws(() => createCohortPlan(absent, { holdoutStart: iso(START), holdoutEnd: iso(END) }, () => NOW), /DATABASE_NOT_FOUND/);
  assert.throws(() => compareCohortDatabase(absent, plan, 'holdout'), /DATABASE_NOT_FOUND/);
  assert.equal(existsSync(absent), false);
});

test('legacy tuning stays missing-journal after collection starts; orphan receipts remain visible in source counts', t => {
  const f = fixture(t);
  f.run('legacy');
  f.tracker.db.exec('DROP TABLE eta_forecasts');
  const plan = f.plan();
  assert.equal(plan.tuningJournal, false);
  const before = f.compare(plan, 'tuning').comparison;
  assert.equal(before.journal, 'missing_journal');
  const migration = new AgentETA({ filename: f.filename });
  migration.close();
  const id = f.receipt(f.run('new', START));
  f.tracker.db.prepare(`INSERT INTO eta_forecasts SELECT 'orphan', 'absent', estimated_at, active_ms,
    estimate_status, model_version, payload_json FROM eta_forecasts WHERE id=?`).run(id);
  const after = f.compare(plan, 'tuning');
  assert.deepEqual(after.comparison, before);
  assert.equal(after.source.orphanReceipts, 1);
  assert.equal(f.compare(plan).comparison.landmarks[0].pairedRuns, 1);
});

test('CLI plans/compares with real current clock, scopes options and supports the legacy alias', t => {
  const f = fixture(t), planPath = join(f.dir, 'plan.json');
  const invoke = (args, binary = cli) => spawnSync(process.execPath, ['--no-warnings', binary, ...args], { encoding: 'utf8' });
  const start = Date.now() + 24 * 60 * MIN;
  const result = invoke(['cohort-plan', '--db', f.filename, '--holdout-start', iso(start), '--holdout-end', iso(start + MIN)]);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(planPath, result.stdout);
  const plan = readCohortPlan(planPath);
  const args = ['compare', '--db', f.filename, '--plan', planPath, '--cohort', 'holdout'];
  const comparison = invoke(args);
  assert.equal(comparison.status, 0, comparison.stderr);
  assert.deepEqual(JSON.parse(comparison.stdout), f.compare(plan));
  const alias = fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url));
  assert.equal(invoke(args, alias).stdout, comparison.stdout);
  for (const args of [
    ['compare', '--plan', planPath], ['compare', '--cohort', 'holdout'],
    ['start', '--plan', planPath, '--cohort', 'holdout'], ['evaluate', '--holdout-start', iso(start)],
    ['cohort-plan'], ['compare', '--plan', planPath, '--cohort', 'all'],
    ['cohort-plan', '--holdout-start', iso(start), '--holdout-end', iso(start + MIN), '--db', join(f.dir, 'missing.sqlite')],
  ]) {
    const rejected = invoke(args);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.equal(rejected.stdout, '');
    assert.ok(JSON.parse(rejected.stderr).error);
  }
  assert.equal(existsSync(join(f.dir, 'missing.sqlite')), false);
});
