import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRunState, reduceEvent } from '../src/core/reducer.js';
import {
  evaluateMidrunDatabase,
  midrunEvaluationMarkdown,
} from '../src/evaluation/midrun.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function event(runId, id, at, kind, data = {}, observedAt = at) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: id,
    run_id: runId,
    provider: 'codex',
    native_session_id: 'private-session-value',
    occurred_at: at,
    observed_at: observedAt,
    kind,
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data,
  };
}

function persist(database, index, minutes, {
  wait = false,
  latePlan = false,
  terminalObservedAt = null,
} = {}) {
  const runId = `private-midrun-${String(index).padStart(3, '0')}`;
  const started = Date.parse('2026-08-01T00:00:00Z') + index * 60 * MINUTE;
  const finished = started + minutes * MINUTE;
  const events = [event(runId, `${runId}-start`, new Date(started).toISOString(), 'run_started', {
    task_class: 'other',
  })];
  if (wait) {
    events.push(event(runId, `${runId}-wait`, new Date(started + minutes * MINUTE * 0.45).toISOString(), 'needs_input'));
    events.push(event(runId, `${runId}-resume`, new Date(started + minutes * MINUTE * 0.65).toISOString(), 'resumed'));
  }
  if (latePlan) {
    events.push(event(
      runId,
      `${runId}-plan`,
      new Date(started + minutes * MINUTE * 0.1).toISOString(),
      'plan_declared',
      {
        revision: 1,
        steps: [{
          id: 'late',
          label: 'late plan',
          class: 'other',
          status: 'pending',
          prior_minutes: 4,
        }],
      },
      new Date(finished + MINUTE).toISOString(),
    ));
  }
  events.push(event(
    runId,
    `${runId}-finish`,
    new Date(finished).toISOString(),
    'run_succeeded',
    {},
    terminalObservedAt ?? new Date(finished).toISOString(),
  ));
  events.sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  let state = createRunState(runId);
  for (const current of events) {
    database.insertEvent(current);
    state = reduceEvent(state, current);
  }
  database.saveRun(state, events.at(-1), { isHistory: true, historySource: 'live_adapter' });
}

const MINUTE = 60_000;

test('mid-run evaluation uses strict prior outcomes, run-block bootstrap, and no identifiers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-midrun-'));
  const filename = join(directory, 'private.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    for (let index = 0; index < 24; index += 1) {
      persist(database, index, 4 + (index % 6) * 3);
    }
  } finally {
    database.close();
  }

  try {
    const report = evaluateMidrunDatabase(filename, {
      bootstrapSamples: 100,
      generatedAt: '2026-08-29T00:00:00.000Z',
    });
    assert.equal(report.targetRuns, 24);
    assert.deepEqual(report.landmarkFractions, [0.25, 0.5, 0.75]);
    assert.equal(report.eligibleLandmarks, 72);
    assert.equal(report.temporalProtocol.bootstrapUnit.startsWith('run block'), true);
    assert.equal(report.sigmaExperiment.productionEstimatorChanged, false);
    assert.equal(report.methods.fixed_clamp.eligibleRuns, 24);
    assert.ok(report.methods.global_median.missingLandmarks > 0);
    assert.equal(report.pairedAgainstGlobalMedian.calibrated_fixed_clamp.samples, 100);
    assert.equal(report.landmarkBreakdown['0.5'].fraction, 0.5);
    assert.equal(report.landmarkBreakdown['0.5'].pairedFixedAgainstGlobalMedian.samples, 100);
    assert.equal(report.methods.fixed_clamp.p80CoverageWilson95.length, 2);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /private-midrun|private-session|private\.sqlite/);
    const markdown = midrunEvaluationMarkdown(report);
    assert.match(markdown, /Production estimator changed: \*\*no\*\*/);
    assert.doesNotMatch(markdown, /private-midrun|private-session|private\.sqlite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('open waiting landmarks are excluded from completion-clock scoring', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-midrun-wait-'));
  const filename = join(directory, 'wait.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    persist(database, 0, 20, { wait: true });
  } finally {
    database.close();
  }
  try {
    const report = evaluateMidrunDatabase(filename, { bootstrapSamples: 0 });
    assert.equal(report.targetRuns, 1);
    assert.equal(report.excludedWaitingLandmarks, 1);
    assert.equal(report.eligibleLandmarks, 2);
    assert.match(report.temporalProtocol.waitingRule, /no completion-clock/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('events and completed histories observed after a landmark cannot leak backward', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-midrun-causal-'));
  const filename = join(directory, 'causal.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    persist(database, 0, 8, {
      terminalObservedAt: '2026-08-03T00:00:00.000Z',
    });
    persist(database, 1, 20, { latePlan: true });
  } finally {
    database.close();
  }
  try {
    const report = evaluateMidrunDatabase(filename, { bootstrapSamples: 0 });
    assert.equal(report.targetRuns, 2);
    assert.equal(report.methods.plan_conditioned.eligibleLandmarks, 0);
    assert.equal(report.methods.global_median.eligibleLandmarks, 0);
    assert.match(report.temporalProtocol.observationRule, /observed_at/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
