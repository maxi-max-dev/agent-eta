import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRunState, reduceEvent } from '../src/core/reducer.js';
import {
  evaluateWeeklyDatabase,
  weeklyEvaluationMarkdown,
} from '../src/evaluation/weekly.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function event(runId, eventId, at, kind, data = {}) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: eventId,
    run_id: runId,
    provider: 'codex',
    native_session_id: 'private-native-session',
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
  eligibility,
  planned = false,
  selfEta = null,
  forecasts = [],
  terminalKind = 'run_succeeded',
}) {
  const startData = { task_class: 'other', model_self_eta_minutes: selfEta };
  if (typeof eligibility === 'boolean') startData.eligible_large_task = eligibility;
  const events = [event(runId, `${runId}-start-private`, startedAt, 'run_started', startData)];
  if (planned) {
    const planAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
    events.push(event(runId, `${runId}-plan-private`, planAt, 'plan_declared', {
      revision: 1,
      steps: [{
        id: `${runId}-step-private`,
        label: 'private step body',
        class: 'other',
        status: 'pending',
        prior_minutes: 5,
      }],
    }));
  }
  events.push(event(runId, `${runId}-finish-private`, finishedAt, terminalKind));
  let state = createRunState(runId);
  for (const current of events) {
    database.insertEvent(current);
    state = reduceEvent(state, current);
  }
  const learningEligible = terminalKind === 'run_succeeded';
  database.saveRun(state, events.at(-1), {
    isHistory: learningEligible,
    historySource: learningEligible ? 'live_adapter' : null,
  });
  for (const forecast of forecasts) {
    database.saveForecast({
      runId,
      eventId: null,
      observedAt: forecast.at,
      forecast: {
        mode: planned ? 'plan_conditioned' : 'run_fallback',
        status: 'forecast',
        p50Minutes: forecast.p50,
        p80Minutes: forecast.p80 ?? null,
        lowerMinutes: forecast.lower ?? null,
        reason: 'private internal reason',
      },
      display: { headline: 'private display', range: '', reason: '' },
    });
  }
}

function withDatabase(prefix, fn) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const filename = join(directory, 'private-weekly.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    fn(database, filename);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function weeklyRun(database, weekIndex, runIndex, options = {}) {
  const startMs = Date.parse('2026-08-03T00:00:00Z')
    + weekIndex * 7 * 24 * 60 * 60_000
    + (runIndex + 1) * 60 * 60_000;
  const startedAt = new Date(startMs).toISOString();
  const finishedAt = new Date(startMs + 10 * 60_000).toISOString();
  persistRun(database, {
    runId: `private-week-${weekIndex}-run-${runIndex}`,
    startedAt,
    finishedAt,
    eligibility: Object.hasOwn(options, 'eligibility') ? options.eligibility : true,
    planned: options.planned ?? runIndex === 0,
    selfEta: options.selfEta ?? null,
    forecasts: options.forecasts ?? [
      { at: startedAt, p50: 8, p80: 12, lower: 6 },
      { at: new Date(startMs + 5 * 60_000).toISOString(), p50: 6, p80: 9, lower: 4 },
    ],
  });
}

test('weekly report evaluates saved forecasts and fires four consecutive sub-30% gate', () => {
  withDatabase('agent-eta-weekly-gate-', (database, filename) => {
    for (let week = 0; week < 4; week += 1) {
      for (let run = 0; run < 4; run += 1) weeklyRun(database, week, run);
    }

    const report = evaluateWeeklyDatabase(filename, {
      generatedAt: '2026-08-31T00:00:00.000Z',
      completedWeeks: 4,
    });
    assert.equal(report.completedWeeks.length, 4);
    assert.deepEqual(report.completedWeeks.map((week) => week.outcomeRuns), [4, 4, 4, 4]);
    assert.deepEqual(report.completedWeeks.map((week) =>
      week.planCoverage.explicitEligibleLargeTaskCoverage.rate), [0.25, 0.25, 0.25, 0.25]);
    assert.equal(report.completedWeeks[0].savedForecastEvaluation.meanAbsoluteErrorMinutes, 2);
    assert.equal(report.completedWeeks[0].savedForecastEvaluation.p80Coverage, 1);
    assert.equal(
      report.completedWeeks[0].completionClockVolatility.medianRunMeanAbsoluteShiftMinutes,
      3,
    );
    assert.equal(report.fourWeekPlanCoverageGate.status, 'degrade');
    assert.equal(report.fourWeekPlanCoverageGate.decision, 'demote_plan_conditioned');
    assert.equal(report.completedWeeks[0].planCoverage.planAdherence.status, 'unavailable');
    assert.equal(report.completedWeeks[0].modelSelfEta.status, 'unavailable');

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /private-week|private-native|private display|private internal|\.sqlite/);
    const markdown = weeklyEvaluationMarkdown(report);
    assert.match(markdown, /Status: \*\*degrade\*\*/);
    assert.doesNotMatch(markdown, /private-week|private-native|\.sqlite/);
  });
});

test('four-week gate is unsupported without an explicit eligibility denominator', () => {
  withDatabase('agent-eta-weekly-unsupported-', (database, filename) => {
    for (let week = 0; week < 4; week += 1) {
      weeklyRun(database, week, 0, { eligibility: null });
    }
    const report = evaluateWeeklyDatabase(filename, {
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    assert.equal(report.fourWeekPlanCoverageGate.status, 'unsupported');
    assert.equal(report.fourWeekPlanCoverageGate.decision, 'unsupported_denominator');
    assert.equal(
      report.completedWeeks[0].planCoverage.observedPresenceAllLifecycleRuns.rate,
      1,
    );
    assert.equal(
      report.completedWeeks[0].planCoverage.observedPresenceAllLifecycleRuns.suitableForFourWeekGate,
      false,
    );
  });
});

test('four-week gate stays insufficient when a complete week has no outcomes', () => {
  withDatabase('agent-eta-weekly-missing-', (database, filename) => {
    weeklyRun(database, 0, 0);
    weeklyRun(database, 1, 0);
    weeklyRun(database, 3, 0);
    const report = evaluateWeeklyDatabase(filename, {
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    assert.deepEqual(report.completedWeeks.map((week) => week.outcomeRuns), [1, 1, 0, 1]);
    assert.equal(report.fourWeekPlanCoverageGate.status, 'insufficient');
    assert.equal(report.fourWeekPlanCoverageGate.decision, 'insufficient_evidence');
  });
});

test('forecast ordering is temporal and pre-start, post-finish and future outcomes do not leak', () => {
  withDatabase('agent-eta-weekly-temporal-', (database, filename) => {
    const startedAt = '2026-08-25T01:00:00.000Z';
    const finishedAt = '2026-08-25T01:10:00.000Z';
    persistRun(database, {
      runId: 'private-temporal-run',
      startedAt,
      finishedAt,
      eligibility: true,
      planned: true,
      forecasts: [
        { at: '2026-08-25T01:11:00.000Z', p50: 999, p80: 999 },
        { at: '2026-08-25T01:05:00.000Z', p50: 4, p80: 6 },
        { at: '2026-08-25T00:59:00.000Z', p50: 999, p80: 999 },
        { at: '2026-08-25T01:00:00.000Z', p50: 9, p80: 11 },
      ],
    });
    persistRun(database, {
      runId: 'private-failed-eligible-planless',
      startedAt: '2026-08-25T02:00:00.000Z',
      finishedAt: '2026-08-25T02:03:00.000Z',
      eligibility: true,
      planned: false,
      terminalKind: 'run_failed',
      forecasts: [{ at: '2026-08-25T02:00:00.000Z', p50: 999, p80: 999 }],
    });
    persistRun(database, {
      runId: 'private-after-as-of',
      startedAt: '2026-08-31T01:00:00.000Z',
      finishedAt: '2026-08-31T01:10:00.000Z',
      eligibility: true,
      planned: true,
      forecasts: [{ at: '2026-08-31T01:00:00.000Z', p50: 1, p80: 1 }],
    });

    const report = evaluateWeeklyDatabase(filename, {
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    const week = report.completedWeeks.at(-1);
    assert.equal(report.selection.outcomesBeforeGeneratedAt, 1);
    assert.equal(week.outcomeRuns, 1);
    assert.equal(week.lifecycleRuns, 2);
    assert.equal(week.evaluationCohort.runs, 1);
    assert.equal(week.coverageCohort.runs, 2);
    assert.equal(week.coverageCohort.includesFailedAndCancelledRuns, true);
    assert.equal(week.savedForecastEvaluation.evaluatedRuns, 1);
    assert.equal(week.savedForecastEvaluation.meanAbsoluteErrorMinutes, 1);
    assert.equal(week.savedForecastEvaluation.p80Coverage, 1);
    assert.equal(week.completionClockVolatility.forecastTransitions, 1);
    assert.equal(week.completionClockVolatility.medianRunMeanAbsoluteShiftMinutes, 0);
    assert.equal(week.planCoverage.explicitEligibleLargeTaskCoverage.eligibleLargeTaskRuns, 2);
    assert.equal(week.planCoverage.explicitEligibleLargeTaskCoverage.planPresentRuns, 1);
    assert.equal(week.planCoverage.explicitEligibleLargeTaskCoverage.rate, 0.5);
    assert.equal(report.temporalProtocol.postFinishForecastsExcluded, true);
    assert.equal(report.temporalProtocol.estimatorRerun, false);
  });
});

test('weekly coverage uses only Reporter observations attached to lifecycle runs', () => {
  withDatabase('agent-eta-weekly-reporter-', (database, filename) => {
    const plannedRun = 'codex-run-aaaaaaaaaaaaaaaaaaaa';
    const unplannedRun = 'codex-run-bbbbbbbbbbbbbbbbbbbb';
    persistRun(database, {
      runId: plannedRun,
      startedAt: '2026-08-25T01:00:00.000Z',
      finishedAt: '2026-08-25T01:10:00.000Z',
      planned: false,
      forecasts: [{ at: '2026-08-25T01:00:00.000Z', p50: 8, p80: 12 }],
    });
    persistRun(database, {
      runId: unplannedRun,
      startedAt: '2026-08-25T02:00:00.000Z',
      finishedAt: '2026-08-25T02:10:00.000Z',
      planned: false,
      forecasts: [{ at: '2026-08-25T02:00:00.000Z', p50: 8, p80: 12 }],
    });
    const report = (runId, overrides = {}) => ({
      schema_version: 'agenteta.reporter/1',
      provider: 'codex',
      run_id: runId,
      reported_at: '2026-08-25T03:00:00.000Z',
      task_class: 'coding',
      eligible_large_task: true,
      model_self_eta_minutes: null,
      plan_present: true,
      plan_step_count: 3,
      plan_adherence: 'following',
      ...overrides,
    });
    database.saveReporterObservation(report(plannedRun));
    database.saveReporterObservation(report(unplannedRun, {
      eligible_large_task: false,
      plan_present: false,
      plan_step_count: 0,
      plan_adherence: 'not_applicable',
    }));
    database.saveReporterObservation(report('codex-run-cccccccccccccccccccc'));

    const result = evaluateWeeklyDatabase(filename, {
      generatedAt: '2026-08-31T12:00:00.000Z',
      completedWeeks: 1,
    });
    const week = result.completedWeeks[0];
    assert.equal(week.lifecycleRuns, 2);
    assert.deepEqual(week.planCoverage.reporterSidecar, {
      attachedLifecycleRuns: 2,
      unattachedLifecycleRuns: 0,
    });
    assert.deepEqual(week.planCoverage.explicitEligibleLargeTaskCoverage, {
      status: 'available',
      eligibilitySource: 'explicit structural eligible_large_task boolean only',
      eligibilityInferredFromDurationOrContent: false,
      labeledRuns: 2,
      unlabeledRuns: 0,
      eligibleLargeTaskRuns: 1,
      planPresentRuns: 1,
      rate: 1,
      denominatorComplete: true,
    });
    assert.equal(week.planCoverage.planAdherence.status, 'available');
    assert.equal(week.planCoverage.planAdherence.observedRuns, 1);
    assert.deepEqual(week.planCoverage.planAdherence.distribution, {
      following: 1,
      replanned: 0,
      departed: 0,
    });
    assert.match(weeklyEvaluationMarkdown(result), /Reporter sidecar: 2 lifecycle runs attached/);
  });
});
