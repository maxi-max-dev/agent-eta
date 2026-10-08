import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRunState, reduceEvent } from '../src/core/reducer.js';
import { evaluateLiveDatabase, liveEvaluationMarkdown } from '../src/evaluation/live.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function event(runId, eventId, at, kind, data = {}) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: eventId,
    run_id: runId,
    provider: 'codex',
    native_session_id: 'private-session-alias',
    occurred_at: at,
    observed_at: at,
    kind,
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data,
  };
}

function persistRun(database, {
  runId,
  startedAt,
  finishedAt,
  selfEta = null,
  planAt = null,
}) {
  const events = [event(runId, `${runId}-start-private`, startedAt, 'run_started', {
    task_class: 'other',
    model_self_eta_minutes: selfEta,
  })];
  if (planAt) {
    events.push(event(runId, `${runId}-plan-private`, planAt, 'plan_declared', {
      revision: 1,
      steps: [{
        id: `${runId}-step-private`,
        label: '步骤 1',
        class: 'other',
        status: 'pending',
        prior_minutes: 8,
      }],
    }));
  }
  events.push(event(runId, `${runId}-finish-private`, finishedAt, 'run_succeeded'));
  let state = createRunState(runId);
  for (const current of events) {
    database.insertEvent(current);
    state = reduceEvent(state, current);
  }
  database.saveRun(state, events.at(-1), { isHistory: true, historySource: 'live_adapter' });
  database.setInitialForecast(runId, 12);
}

test('live evaluation is time-forward and does not leak overlapping outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-eval-'));
  const filename = join(directory, 'private-fixture.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    // A finishes first, but it is still unfinished when B starts. A must not be
    // available to B's start-landmark predictor.
    persistRun(database, {
      runId: 'private-run-a',
      startedAt: '2026-08-01T00:00:00Z',
      finishedAt: '2026-08-01T00:10:00Z',
      selfEta: 9,
    });
    persistRun(database, {
      runId: 'private-run-b',
      startedAt: '2026-08-01T00:05:00Z',
      finishedAt: '2026-08-01T00:20:00Z',
    });
    persistRun(database, {
      runId: 'private-run-c',
      startedAt: '2026-08-01T00:25:00Z',
      planAt: '2026-08-01T00:30:00Z',
      finishedAt: '2026-08-01T00:45:00Z',
      selfEta: 18,
    });
  } finally {
    database.close();
  }

  try {
    const report = evaluateLiveDatabase(filename, {
      bootstrapSamples: 100,
      generatedAt: '2026-08-29T00:00:00.000Z',
    });
    assert.equal(report.selection.selectedPositiveDurationRuns, 3);
    assert.equal(report.startLandmark.historyAvailability.noPriorFinishedOutcomeRuns, 2);
    assert.equal(report.startLandmark.methods.global_median.eligibleRuns, 1);
    assert.equal(report.startLandmark.methods.global_median.missingPredictions, 2);
    assert.equal(report.startLandmark.methods.global_median.meanAbsoluteErrorMinutes, 7.5);
    assert.equal(report.startLandmark.methods.model_self_eta.eligibleRuns, 2);
    assert.equal(report.startLandmark.methods.model_self_eta.missingPredictions, 1);
    assert.equal(report.startLandmark.methods.calibrated_run_level_fallback.eligibleRuns, 3);
    assert.equal(report.startLandmark.intervalCalibration.eligibleLandmarks, 0);
    assert.equal(report.startLandmark.intervalCalibration.ineligibleLandmarks, 3);
    assert.equal(report.planLandmark.targetRuns, 1);
    assert.equal(report.planLandmark.historyAvailability.medianPriorFinishedOutcomes, 2);
    assert.equal(report.planLandmark.methods.plan_conditioned.eligibleRuns, 1);
    assert.equal(report.planLandmark.methods.calibrated_plan_conditioned.eligibleRuns, 1);
    assert.equal(report.planLandmark.methods.same_landmark_fallback.eligibleRuns, 1);
    assert.equal(report.planLandmark.pairedRunLevelBootstrap.pairedRuns, 1);
    assert.equal(report.temporalProtocol.overlappingRunsExcludedFromHistoryUntilFinished, true);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /private-run|private-session|private-fixture|\.sqlite/);
    const markdown = liveEvaluationMarkdown(report);
    assert.match(markdown, /Model self-ETA is available/);
    assert.doesNotMatch(markdown, /private-run|private-session|\.sqlite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('model self-ETA remains explicitly unavailable when the field is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-eval-missing-'));
  const filename = join(directory, 'missing.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    persistRun(database, {
      runId: 'no-self-eta-private',
      startedAt: '2026-08-01T00:00:00Z',
      finishedAt: '2026-08-01T00:04:00Z',
    });
  } finally {
    database.close();
  }
  try {
    const report = evaluateLiveDatabase(filename, { bootstrapSamples: 0 });
    assert.deepEqual(
      {
        status: report.startLandmark.methods.model_self_eta.status,
        eligibleRuns: report.startLandmark.methods.model_self_eta.eligibleRuns,
        missingPredictions: report.startLandmark.methods.model_self_eta.missingPredictions,
        mae: report.startLandmark.methods.model_self_eta.meanAbsoluteErrorMinutes,
      },
      { status: 'unavailable', eligibleRuns: 0, missingPredictions: 1, mae: null },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Reporter self-ETA excludes observations declared early but received after run start', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-eval-reporter-'));
  const filename = join(directory, 'reporter.sqlite');
  const database = new AgentEtaDatabase(filename);
  const earlyRun = 'codex-run-aaaaaaaaaaaaaaaaaaaa';
  const lateRun = 'codex-run-bbbbbbbbbbbbbbbbbbbb';
  const reporter = (runId, reportedAt) => ({
    schema_version: 'agenteta.reporter/1',
    provider: 'codex',
    run_id: runId,
    reported_at: reportedAt,
    task_class: 'coding',
    eligible_large_task: true,
    model_self_eta_minutes: 5,
    plan_present: false,
    plan_step_count: 0,
    plan_adherence: 'not_applicable',
  });
  try {
    persistRun(database, {
      runId: earlyRun,
      startedAt: '2026-08-01T00:00:00Z',
      finishedAt: '2026-08-01T00:04:00Z',
    });
    persistRun(database, {
      runId: lateRun,
      startedAt: '2026-08-01T00:10:00Z',
      finishedAt: '2026-08-01T00:14:00Z',
    });
    database.saveReporterObservation(reporter(earlyRun, '2026-08-01T00:00:00Z'), {
      receivedAt: '2026-08-01T00:00:00Z',
    });
    database.saveReporterObservation(reporter(lateRun, '2026-08-01T00:09:00Z'), {
      receivedAt: '2026-08-01T00:11:00Z',
    });
  } finally {
    database.close();
  }
  try {
    const report = evaluateLiveDatabase(filename, { bootstrapSamples: 0 });
    assert.equal(report.startLandmark.methods.model_self_eta.eligibleRuns, 1);
    assert.equal(report.startLandmark.methods.model_self_eta.missingPredictions, 1);
    assert.equal(report.startLandmark.methods.model_self_eta.meanAbsoluteErrorMinutes, 1);
    assert.equal(report.observedData.modelSelfEtaPresentRuns, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
