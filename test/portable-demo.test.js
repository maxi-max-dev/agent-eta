import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { evaluateDatabase } from '../src/generic/evaluate.js';
import { compareDatabase } from '../src/generic/compare.js';
import { verifyJournalExport } from '../src/generic/verify-journal.js';
import { afterCleanup } from '../test-support/cleanup.js';

const script = fileURLToPath(new URL('../examples/portable-demo.mjs', import.meta.url));

test('portable demo isolates scripted data, explains states and leaves reproducible saved evidence', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'eta-demo-caller-'));
  afterCleanup(t, () => rmSync(cwd, { recursive: true, force: true }));
  const protectedPaths = [join(cwd, 'private.sqlite')];
  for (const name of ['.agent-eta', '.agentwhen']) {
    mkdirSync(join(cwd, name)); protectedPaths.push(join(cwd, name, 'runs.sqlite'));
  }
  const sentinel = 'PRIVATE_DATABASE_MUST_NOT_BE_READ_OR_MODIFIED';
  for (const path of protectedPaths) writeFileSync(path, sentinel);
  const before = readdirSync(cwd, { recursive: true }).sort();
  const result = spawnSync(process.execPath, ['--no-warnings', script], { cwd, encoding: 'utf8',
    env: { ...process.env, AGENT_ETA_TRACKER_DB: protectedPaths[0], AGENTWHEN_DB: protectedPaths[0] } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SYNTHETIC WALKTHROUGH/);
  assert.match(result.stdout, /not real accuracy evidence/);
  assert.equal(result.stdout.includes(sentinel), false);
  const locator = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(basename(locator.directory).startsWith('agent-eta-synthetic-demo-'));
  afterCleanup(t, () => rmSync(locator.directory, { recursive: true, force: true }));
  const demo = JSON.parse(readFileSync(locator.summary, 'utf8'));
  assert.equal(demo.evidence, 'synthetic_scripted_clock_not_real_prediction_evidence');
  assert.ok(demo.steps.every(step => step.evidence === demo.evidence));
  assert.deepEqual(demo.steps.map(step => step.status.estimateStatus),
    ['cold_start', 'experimental', 'paused', 'experimental', 'experimental', 'terminal', 'stale', 'observation_gap']);
  assert.deepEqual(demo.steps.slice(1, 6).map(step => step.status.activeMinutes), [1, 1, 5, 10, 12]);
  for (const step of demo.steps.filter(step => step.status.estimateStatus !== 'experimental')) {
    assert.equal(step.status.remainingMinutes, null);
  }
  assert.equal(demo.steps[6].status.observedAt < demo.steps[6].status.estimatedAt, true);
  assert.equal(demo.steps.at(-1).status.historyEligible, false);

  const sourceBytes = readFileSync(demo.paths.runs), journalBytes = readFileSync(demo.paths.journal);
  const savedEvaluation = JSON.parse(readFileSync(demo.paths.evaluation, 'utf8'));
  const savedComparison = JSON.parse(readFileSync(demo.paths.comparison, 'utf8'));
  assert.equal(savedEvaluation.evidence, demo.evidence);
  assert.equal(savedComparison.evidence, demo.evidence);
  assert.deepEqual(evaluateDatabase(demo.paths.runs), savedEvaluation.report);
  assert.deepEqual(compareDatabase(demo.paths.runs), savedComparison.report);
  assert.deepEqual(await verifyJournalExport(demo.paths.journal), demo.verification);
  assert.equal(savedEvaluation.report.population.totalRuns, 6);
  assert.equal(savedEvaluation.report.population.pendingRuns, 0);
  assert.ok(savedEvaluation.report.landmarks.every(point => point.groups
    .flatMap(group => group.pairs).some(pair => pair.runId === demo.scenario.targetRunId)));
  assert.equal(savedComparison.report.promotionEligible, false);
  assert.equal(savedComparison.report.landmarks[2].selections
    .find(row => row.runId === demo.scenario.targetRunId).candidateReason, 'insufficient_tail');
  const db = new DatabaseSync(demo.paths.runs, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM agentwhen_runs').all();
    assert.ok(rows.every(row => row.profile === 'synthetic-demo-only'));
    const target = rows.find(row => row.id === demo.scenario.targetRunId);
    assert.equal(target.active_ms, 12 * 60_000);
    assert.equal(target.finished_at - target.started_at, 22 * 60_000);
  } finally { db.close(); }
  for (const command of Object.values(demo.commands)) {
    const rerun = spawnSync(command[0], ['--no-warnings', ...command.slice(1)], { cwd, encoding: 'utf8' });
    assert.equal(rerun.status, 0, rerun.stderr);
    const expected = command.includes('verify-export') ? demo.verification
      : command.includes('compare') ? savedComparison.report : savedEvaluation.report;
    assert.deepEqual(JSON.parse(rerun.stdout), expected);
  }
  assert.deepEqual(readFileSync(demo.paths.runs), sourceBytes);
  assert.deepEqual(readFileSync(demo.paths.journal), journalBytes);
  assert.deepEqual(readdirSync(cwd, { recursive: true }).sort(), before);
  for (const path of protectedPaths) assert.equal(readFileSync(path, 'utf8'), sentinel);
});

test('portable demo refuses an existing-database argument before running the scenario', t => {
  const result = spawnSync(process.execPath, ['--no-warnings', script, '--db', 'must-not-open.sqlite'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /accepts no options or existing database path/);
});
