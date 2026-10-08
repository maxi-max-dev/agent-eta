import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  evaluatePilotCohort,
  evaluatePilotDatabase,
  pilotEvaluationMarkdown,
} from '../src/evaluation/pilot.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

function rows(count, {
  scopeType = 'task',
  startDay = 0,
  p80Miss = false,
  includeSelfEta = false,
  includeVolatility = false,
  taskClass = 'coding',
} = {}) {
  const epoch = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const actual = 10 + index;
    const started = epoch + (startDay + index) * DAY_MS;
    const landmark = started + 60_000;
    const finished = landmark + actual * 60_000;
    return {
      scopeKey: `${scopeType}-${startDay}-${index}`,
      scopeType,
      startedAt: new Date(started).toISOString(),
      landmarkAt: new Date(landmark).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      taskClass,
      scopeForecast: {
        p50: p80Miss ? Math.max(0, actual - 2) : actual,
        p80: p80Miss ? Math.max(0, actual - 1) : actual + 1,
        mode: 'workset_aggregate',
      },
      modelSelfEta: includeSelfEta ? { p50: actual + 3, p80: null } : null,
      completionClockShiftsMinutes: includeVolatility ? [1] : undefined,
      completionClockSnapshotsObserved: includeVolatility ? 2 : undefined,
    };
  });
}

const liveOptions = {
  evidenceStatus: 'provider_shadow',
  generatedAt: '2026-08-29T00:00:00.000Z',
  bootstrapSamples: 500,
  seed: 12345,
};

test('pilot stays contract-only and insufficient for the current n=1 shape', () => {
  const report = evaluatePilotCohort(rows(1), {
    ...liveOptions,
    evidenceStatus: 'contract_only',
  });
  assert.equal(report.status, 'contract_only');
  assert.equal(report.task.stage, 'insufficient');
  assert.equal(report.task.verdict, 'contract_only');
  assert.equal(report.task.numericAccuracyWinClaimed, false);
  assert.equal(report.task.methods.model_self_eta.status, 'unavailable');
  assert.equal(report.task.completionClockVolatility.status, 'unavailable');
  assert.equal(report.project.completedScopeSamples, 0);
  assert.equal(report.project.evidenceStatus, 'unavailable');
  assert.match(pilotEvaluationMarkdown(report), /contract evidence/);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /task-0-0|scopeKey|\.sqlite|\/Users\//);
});

test('time-forward baseline excludes a scope that had started but not finished', () => {
  const epoch = Date.parse('2026-02-01T00:00:00.000Z');
  const make = (scopeKey, landmarkDay, finishDay, actual) => ({
    scopeKey,
    scopeType: 'task',
    startedAt: new Date(epoch + landmarkDay * DAY_MS - 60_000).toISOString(),
    landmarkAt: new Date(epoch + landmarkDay * DAY_MS).toISOString(),
    finishedAt: new Date(epoch + finishDay * DAY_MS).toISOString(),
    taskClass: 'coding',
    scopeForecast: { p50: actual, p80: actual + 1, mode: 'workset_aggregate' },
  });
  const report = evaluatePilotCohort([
    make('overlap', 0, 10, 10 * 24 * 60),
    make('finished', 1, 2, 24 * 60),
    make('target', 3, 4, 24 * 60),
  ], liveOptions);
  assert.equal(report.task.methods.historical_task_class_median.eligibleScopes, 1);
  assert.equal(report.task.pairedAgainstHistoricalTaskClassMedian.pairedScopes, 1);
  assert.equal(report.temporalProtocol.temporalDiagnostics.overlappingPotentialHistoryExcluded, 2);
  assert.equal(report.temporalProtocol.snapshotsAndTurnsAreNeverIndependentSamples, true);
});

test('time-forward baseline excludes a finished outcome until terminal receipt is observed', () => {
  const epoch = Date.parse('2026-02-15T00:00:00.000Z');
  const lateHistory = {
    scopeKey: 'late-terminal-history',
    scopeType: 'task',
    startedAt: new Date(epoch).toISOString(),
    landmarkAt: new Date(epoch + 60_000).toISOString(),
    finishedAt: new Date(epoch + DAY_MS).toISOString(),
    terminalReceivedAt: new Date(epoch + 4 * DAY_MS).toISOString(),
    taskClass: 'coding',
    scopeForecast: { p50: 1_439, p80: 1_500, mode: 'workset_aggregate' },
  };
  const target = {
    scopeKey: 'target-before-terminal-receipt',
    scopeType: 'task',
    startedAt: new Date(epoch + 2 * DAY_MS - 60_000).toISOString(),
    landmarkAt: new Date(epoch + 2 * DAY_MS).toISOString(),
    finishedAt: new Date(epoch + 3 * DAY_MS).toISOString(),
    taskClass: 'coding',
    scopeForecast: { p50: 1_440, p80: 1_500, mode: 'workset_aggregate' },
  };
  const report = evaluatePilotCohort([lateHistory, target], liveOptions);
  assert.equal(report.task.methods.historical_task_class_median.eligibleScopes, 0);
  assert.equal(report.temporalProtocol.temporalDiagnostics.lateTerminalReceiptExcluded, 1);
  assert.throws(
    () => evaluatePilotCohort([{
      ...target,
      terminalReceivedAt: new Date(epoch + DAY_MS).toISOString(),
    }], liveOptions),
    /PILOT_TERMINAL_RECEIPT_PRECEDES_FINISH/,
  );
});

test('trusted outcomes without a numeric forecast still enter future global and task-class history', () => {
  const history = {
    scopeKey: 'outcome-only-history',
    scopeType: 'task',
    startedAt: '2026-04-01T00:00:00.000Z',
    finishedAt: '2026-04-01T00:20:00.000Z',
    terminalReceivedAt: '2026-04-01T00:20:01.000Z',
    taskClass: 'coding',
    scopeForecast: null,
  };
  const target = {
    scopeKey: 'numeric-target',
    scopeType: 'task',
    startedAt: '2026-04-02T00:00:00.000Z',
    landmarkAt: '2026-04-02T00:01:00.000Z',
    finishedAt: '2026-04-02T00:11:00.000Z',
    taskClass: 'coding',
    scopeForecast: { p50: 10, p80: 12, mode: 'workset_aggregate' },
  };
  const report = evaluatePilotCohort([history, target], liveOptions);
  assert.equal(report.task.rawCompletedScopes, 2);
  assert.equal(report.task.completedOutcomeScopes, 2);
  assert.equal(report.task.causalNumericFirstForecasts, 1);
  assert.equal(report.task.completedScopeSamples, 1);
  assert.equal(report.task.methods.historical_global_median.eligibleScopes, 1);
  assert.equal(report.task.methods.historical_task_class_median.eligibleScopes, 1);
  assert.equal(report.task.pairedAgainstHistoricalReference.pairedScopes, 1);
});

test('blocking waits after a landmark are excluded before the 30-scope gate', () => {
  const cohort = rows(30);
  cohort[29] = { ...cohort[29], waitContaminated: true };
  const report = evaluatePilotCohort(cohort, liveOptions);
  assert.equal(report.task.causalNumericFirstForecasts, 30);
  assert.equal(report.task.waitContaminatedExcluded, 1);
  assert.equal(report.task.waitContaminatedOutcomesExcluded, 1);
  assert.equal(report.task.completedOutcomeScopes, 29);
  assert.equal(report.task.completedScopeSamples, 29);
  assert.equal(report.task.stage, 'insufficient');
  assert.equal(report.task.methods.scope_primary.eligibleScopes, 29);
  assert.equal(report.task.numericAccuracyWinClaimed, false);
});

test('30/50 gates stay status-only until the class, P80, and volatility evidence closes', () => {
  const insufficient = evaluatePilotCohort(rows(29), liveOptions);
  const provisional = evaluatePilotCohort(rows(30), liveOptions);
  const decision = evaluatePilotCohort([
    ...rows(50, { scopeType: 'task' }),
    ...rows(50, { scopeType: 'project', startDay: 100 }),
  ], liveOptions);
  const repeated = evaluatePilotCohort([
    ...rows(50, { scopeType: 'task' }),
    ...rows(50, { scopeType: 'project', startDay: 100 }),
  ], liveOptions);

  assert.equal(insufficient.task.stage, 'insufficient');
  assert.equal(insufficient.task.numericAccuracyWinClaimed, false);
  assert.equal(provisional.task.stage, 'provisional');
  assert.equal(provisional.task.verdict, 'provisional_no_accuracy_claim');
  assert.equal(decision.task.stage, 'decision');
  assert.equal(decision.project.stage, 'decision');
  assert.equal(decision.task.verdict, 'provisional_volatility_gate');
  assert.equal(decision.project.verdict, 'provisional_volatility_gate');
  assert.equal(decision.task.recommendation, 'status_only');
  assert.equal(decision.task.completionClockVolatility.status, 'unavailable');
  assert.equal(decision.task.gates.accuracyGatesPass, true);
  assert.equal(decision.task.gates.allDecisionGatesPass, false);
  assert.ok(decision.task.pairedAgainstHistoricalTaskClassMedian.interval95[0] > 0);
  assert.ok(decision.task.methods.scope_primary.p80CoverageInterval95[0] >= 0.8);
  assert.equal(decision.task.methods.scope_primary.resamplingUnit, 'task');
  assert.equal(decision.project.methods.scope_primary.resamplingUnit, 'project');
  assert.deepEqual(
    decision.task.pairedAgainstHistoricalTaskClassMedian,
    repeated.task.pairedAgainstHistoricalTaskClassMedian,
  );
});

test('overall decision status cannot combine a contract scope stage with another provider scope', () => {
  const report = evaluatePilotCohort([
    ...rows(50, { scopeType: 'task' }),
    ...rows(1, { scopeType: 'project', startDay: 100 }),
  ], {
    ...liveOptions,
    evidenceByScope: {
      task: 'contract_only',
      project: 'provider_shadow',
    },
  });
  assert.equal(report.evidenceStatus, 'mixed');
  assert.equal(report.task.stage, 'decision');
  assert.equal(report.task.evidenceStatus, 'contract_only');
  assert.equal(report.project.stage, 'insufficient');
  assert.equal(report.project.evidenceStatus, 'provider_shadow');
  assert.equal(report.status, 'shadow_collecting');
});

test('a 50-scope decision can pass only with predeclared scope-level volatility evidence', () => {
  const report = evaluatePilotCohort(rows(50, { includeVolatility: true }), {
    ...liveOptions,
    volatilityThresholdMinutes: 2,
    minimumVolatilityScopes: 30,
  });
  assert.equal(report.task.verdict, 'numeric_eta_supported');
  assert.equal(report.task.recommendation, 'continue_numeric_eta');
  assert.equal(report.task.completionClockVolatility.scopesWithTransitions, 50);
  assert.equal(report.task.completionClockVolatility.medianAbsoluteShiftMinutes, 1);
  assert.equal(report.task.gates.completionClockVolatilityPass, true);
  assert.equal(report.task.gates.allDecisionGatesPass, true);
});

test('volatility gate summarizes within scope before aggregation', () => {
  const cohort = rows(30, { includeVolatility: true });
  cohort[0] = {
    ...cohort[0],
    completionClockShiftsMinutes: Array.from({ length: 100 }, () => 0.1),
    completionClockSnapshotsObserved: 101,
  };
  for (let index = 1; index < cohort.length; index += 1) {
    cohort[index] = {
      ...cohort[index],
      completionClockShiftsMinutes: [10],
      completionClockSnapshotsObserved: 2,
    };
  }
  const report = evaluatePilotCohort(cohort, {
    ...liveOptions,
    volatilityThresholdMinutes: 2,
    minimumVolatilityScopes: 30,
  });
  assert.equal(report.task.completionClockVolatility.eligibleTransitions, 129);
  assert.equal(report.task.completionClockVolatility.scopesWithTransitions, 30);
  assert.equal(report.task.completionClockVolatility.medianAbsoluteShiftMinutes, 10);
  assert.equal(report.task.completionClockVolatility.transitionCountDiagnosticOnly, true);
  assert.equal(report.task.gates.completionClockVolatilityPass, false);
});

test('other and unknown are not class evidence and severe underestimation is explicit', () => {
  const unclassified = rows(50, {
    includeVolatility: true,
    taskClass: 'other',
  }).map((row) => ({
    ...row,
    scopeForecast: {
      ...row.scopeForecast,
      p50: row.scopeForecast.p50 * 0.4,
    },
  }));
  const report = evaluatePilotCohort(unclassified, {
    ...liveOptions,
    volatilityThresholdMinutes: 2,
  });
  assert.equal(report.task.knownTaskClassScopes, 0);
  assert.equal(report.task.methods.historical_task_class_median.status, 'unavailable');
  assert.ok(report.task.pairedAgainstHistoricalGlobalMedian.pairedScopes >= 30);
  assert.equal(report.task.gates.classSpecificPairedComparisonHasEnoughScopes, false);
  assert.equal(report.task.verdict, 'provisional_accuracy_evidence');
  assert.equal(report.task.recommendation, 'status_only');
  assert.equal(report.task.methods.scope_primary.severeUnderestimateRate, 1);
  assert.match(pilotEvaluationMarkdown(report), /P50 < 50%/);
});

test('a failed 50-scope P80 gate recommends status_only and cannot claim a win', () => {
  const report = evaluatePilotCohort(rows(50, { p80Miss: true }), liveOptions);
  assert.equal(report.task.stage, 'decision');
  assert.equal(report.task.gates.pairedAbsoluteErrorGainIntervalEntirelyAboveZero, true);
  assert.equal(report.task.gates.p80CoverageIntervalLowerBoundMeetsTarget, false);
  assert.equal(report.task.verdict, 'numeric_eta_falsified');
  assert.equal(report.task.recommendation, 'status_only');
  assert.equal(report.task.numericAccuracyWinClaimed, false);
  assert.match(pilotEvaluationMarkdown(report), /recommendation: \*\*status_only\*\*/i);
});

test('P80 coverage cannot rescue a non-positive paired accuracy gain', () => {
  const overpredicted = rows(50).map((row, index) => ({
    ...row,
    scopeForecast: {
      p50: 110 + index,
      p80: 111 + index,
      mode: 'workset_aggregate',
    },
  }));
  const report = evaluatePilotCohort(overpredicted, liveOptions);
  assert.equal(report.task.gates.p80CoverageIntervalLowerBoundMeetsTarget, true);
  assert.equal(report.task.gates.pairedAbsoluteErrorGainIntervalEntirelyAboveZero, false);
  assert.equal(report.task.verdict, 'numeric_eta_falsified');
  assert.equal(report.task.recommendation, 'status_only');
  assert.equal(report.task.numericAccuracyWinClaimed, false);
});

test('one scope cannot be counted twice as independent snapshots', () => {
  const duplicated = rows(1)[0];
  assert.throws(
    () => evaluatePilotCohort([duplicated, structuredClone(duplicated)], liveOptions),
    /PILOT_DUPLICATE_SCOPE_SAMPLE/,
  );
});

test('database cohort fails closed and requires independent verified source rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-pilot-source-'));
  const filename = join(directory, 'pilot.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    database.db.exec(`
      CREATE TABLE IF NOT EXISTS workset_sources (
        workset_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        task_class TEXT,
        eligible_large_task INTEGER,
        source_status TEXT NOT NULL,
        first_received_at TEXT NOT NULL,
        last_received_at TEXT NOT NULL,
        FOREIGN KEY(workset_id) REFERENCES worksets(workset_id) ON DELETE CASCADE
      );
    `);
    const insertWorkset = database.db.prepare(`
      INSERT INTO worksets(
        workset_id, workset_type, status, revision, workset_closed,
        owner_terminal, started_at, finished_at, active_elapsed_ms,
        outcome_minutes, updated_at
      ) VALUES (?, ?, 'succeeded', 1, 1, 1, ?, ?, 600000, 10, ?)
    `);
    const insertEvent = database.db.prepare(`
      INSERT INTO workset_events(
        event_id, workset_id, revision, occurred_at, received_at, kind, payload_json
      ) VALUES (?, ?, 1, ?, ?, 'workset_declared', '{}')
    `);
    const insertTerminal = database.db.prepare(`
      INSERT INTO workset_events(
        event_id, workset_id, revision, occurred_at, received_at, kind, payload_json
      ) VALUES (?, ?, 1, ?, ?, 'workset_succeeded', '{}')
    `);
    const insertWait = database.db.prepare(`
      INSERT INTO workset_events(
        event_id, workset_id, revision, occurred_at, received_at, kind, payload_json
      ) VALUES (?, ?, 1, ?, ?, 'workset_status_changed',
        '{"data":{"status":"blocked"}}')
    `);
    const insertForecast = database.db.prepare(`
      INSERT INTO workset_forecast_snapshots(
        workset_id, event_id, revision, observed_at, mode, forecast_status,
        evidence, lower_minutes, p50_minutes, p80_minutes, upper_minutes,
        reason_code, forecast_json
      ) VALUES (?, ?, 1, ?, 'workset_aggregate', 'forecast',
        'explicit_workset', 5, 10, 12, 12, 'closed_workset_sequential', '{}')
    `);
    const insertUnknownForecast = database.db.prepare(`
      INSERT INTO workset_forecast_snapshots(
        workset_id, event_id, revision, observed_at, mode, forecast_status,
        evidence, lower_minutes, p50_minutes, p80_minutes, upper_minutes,
        reason_code, forecast_json
      ) VALUES (?, ?, 1, ?, 'workset_unknown', 'unknown',
        'unavailable', NULL, NULL, NULL, NULL, 'awaiting_forecast', '{}')
    `);
    const insertSource = database.db.prepare(`
      INSERT INTO workset_sources(
        workset_id, provider, source_kind, task_class, eligible_large_task, source_status,
        first_received_at, last_received_at
      ) VALUES (?, 'codex', ?, 'coding', NULL, ?, ?, ?)
    `);
    const add = (id, type, sourceKind, sourceStatus, {
      numeric = true,
      blockedAfterForecast = false,
      started = '2026-03-01T00:00:00.000Z',
      observed = '2026-03-01T00:01:00.000Z',
      finished = '2026-03-01T00:11:00.000Z',
    } = {}) => {
      const eventId = `${id}-event`;
      insertWorkset.run(id, type, started, finished, finished);
      insertEvent.run(eventId, id, started, observed);
      if (numeric) insertForecast.run(id, eventId, observed);
      else insertUnknownForecast.run(id, eventId, observed);
      if (blockedAfterForecast) {
        insertWait.run(
          `${id}-wait`,
          id,
          '2026-03-01T00:05:00.000Z',
          '2026-03-01T00:05:01.000Z',
        );
      }
      insertTerminal.run(`${id}-terminal`, id, finished, finished);
      insertSource.run(id, sourceKind, sourceStatus, observed, observed);
    };
    add('task-workset-provider-shadow', 'task', 'codex_goal_shadow', 'verified_structural');
    add('task-workset-provider-outcome-only', 'task', 'codex_goal_shadow', 'verified_structural', {
      numeric: false,
    });
    add('task-workset-provider-wait', 'task', 'codex_goal_shadow', 'verified_structural', {
      blockedAfterForecast: true,
    });
    add('task-workset-backfill-history', 'task', 'codex_goal_shadow', 'verified_structural', {
      started: '2026-02-01T00:00:00.000Z',
      observed: '2026-02-01T00:01:00.000Z',
      finished: '2026-02-01T00:11:00.000Z',
    });
    add('task-workset-source-only', 'task', 'codex_goal_shadow', 'verified_structural', {
      started: '2026-01-01T00:00:00.000Z',
      observed: '2026-01-01T00:01:00.000Z',
      finished: '2026-01-01T00:11:00.000Z',
    });
    add('task-workset-source-quarantined', 'task', 'codex_goal_shadow', 'quarantined');
    add('project-controlled', 'project', 'controlled_wrapper', 'contract_only');
    add('project-unknown', 'project', 'codex_goal_shadow', 'verified_structural');
    database.db.prepare(`
      INSERT INTO codex_goal_receipts(
        receipt_id, goal_id, run_id, occurred_at, first_received_at,
        last_received_at, first_ingest_mode, kind, fingerprint, workset_id,
        applied, censored, quarantined
      ) VALUES ('receipt-safe', 'goal-safe', 'run-safe',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z',
        '2026-03-01T00:00:01.000Z', 'backfill', 'goal_active', 'digest',
        'task-workset-provider-outcome-only', 1, 0, 0),
      ('receipt-conflict', 'goal-source-quarantined', 'run-conflict',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z',
        '2026-03-01T00:00:02.000Z', 'backfill', 'goal_active', 'digest-conflict',
        'task-workset-source-quarantined', 0, 0, 1),
      ('receipt-live-shadow', 'goal-live-shadow', 'run-live-shadow',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:30.000Z',
        '2026-03-01T00:00:30.000Z', 'live', 'goal_active', 'digest-live-shadow',
        'task-workset-provider-shadow', 1, 0, 0),
      ('receipt-live-wait', 'goal-live-wait', 'run-live-wait',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:30.000Z',
        '2026-03-01T00:00:30.000Z', 'live', 'goal_active', 'digest-live-wait',
        'task-workset-provider-wait', 1, 0, 0),
      ('receipt-backfill-history', 'goal-backfill-history', 'run-backfill-history',
        '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:30.000Z',
        '2026-02-01T00:00:30.000Z', 'backfill', 'goal_active',
        'digest-backfill-history', 'task-workset-backfill-history', 1, 0, 0)
    `).run();
    database.db.prepare(`
      INSERT INTO codex_goal_quarantines(
        goal_id, reason_code, first_received_at, last_received_at
      ) VALUES
        ('goal-safe', 'goal_structure_conflict',
          '2026-03-01T00:00:03.000Z', '2026-03-01T00:00:03.000Z'),
        ('goal-source-quarantined', 'goal_structure_conflict',
          '2026-03-01T00:00:03.000Z', '2026-03-01T00:00:03.000Z')
    `).run();
    database.close();

    const report = evaluatePilotDatabase(filename, {
      generatedAt: '2026-08-29T00:00:00.000Z',
      bootstrapSamples: 10,
      seed: 7,
    });
    assert.equal(report.evidenceStatus, 'mixed');
    assert.equal(report.task.evidenceStatus, 'provider_shadow');
    assert.equal(report.project.evidenceStatus, 'contract_only');
    assert.equal(report.task.completedOutcomeScopes, 2);
    assert.equal(report.task.completedScopeSamples, 1);
    assert.equal(report.task.backfillNumericTargetsExcluded, 1);
    assert.equal(report.funnel.task.backfillNumericTargetsExcluded, 1);
    assert.equal(report.task.waitContaminatedExcluded, 1);
    assert.equal(report.task.stage, 'insufficient');
    assert.equal(report.project.completedScopeSamples, 1);
    assert.equal(report.project.verdict, 'contract_only');
    assert.equal(report.sourceProtocol.goalNeverCreatesOrLabelsProject, true);
    assert.equal(report.sourceProtocol.excludedUnknownSourceRows, 1);
    assert.equal(report.sourceProtocol.excludedNoReceiptSourceRows, 1);
    assert.equal(
      report.funnel.sourceExclusions.verifiedGoalTaskWithoutCleanAppliedReceipt,
      1,
    );
    assert.equal(report.sourceProtocol.excludedTombstonedSourceRows, 2);
    assert.equal(report.funnel.receipts.confirmedStructuralGoals, 3);
    assert.equal(report.funnel.receipts.confirmedStructuralReceipts, 3);
    assert.equal(report.funnel.receipts.applied, 3);
    assert.equal(report.funnel.receiptProvenance.status, 'available');
    assert.deepEqual(report.funnel.receiptProvenance.live, {
      observedReceipts: 2,
      confirmedStructuralReceipts: 2,
      appliedReceipts: 2,
    });
    assert.deepEqual(report.funnel.receiptProvenance.backfill, {
      observedReceipts: 3,
      confirmedStructuralReceipts: 1,
      appliedReceipts: 1,
    });
    assert.equal(report.funnel.durableGoalQuarantineTombstones, 2);
    assert.equal(report.funnel.quarantineDisposition.quarantinedReceiptRows, 1);
    assert.equal(report.funnel.quarantineDisposition.sourceQuarantinedScopes, 1);
    assert.equal(report.funnel.quarantineDisposition.uniqueQuarantinedSubjects, 2);
    assert.equal(report.funnel.quarantineDisposition.categoryCountsAreNonAdditive, true);
    assert.equal(report.funnel.task.materialized, 4);
    assert.equal(report.funnel.task.sourceQuarantined, 1);
    assert.equal(report.funnel.task.completedOutcomeLibrary, 2);
    assert.equal(report.funnel.task.causalNumericFirstForecasts, 2);
    assert.equal(report.funnel.task.waitContaminatedExcluded, 1);
    assert.equal(report.task.methods.historical_task_class_median.eligibleScopes, 1);
    assert.match(pilotEvaluationMarkdown(report), /never enter the denominator/);
    assert.match(pilotEvaluationMarkdown(report), /first_ingest_mode=live/);
    assert.doesNotMatch(JSON.stringify(report), /task-workset-provider-shadow|task-workset-source-only|project-controlled|pilot\.sqlite/);

    const legacyDatabase = new DatabaseSync(filename);
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS codex_goal_receipts_ingest_mode;
      ALTER TABLE codex_goal_receipts DROP COLUMN first_ingest_mode;
    `);
    legacyDatabase.close();
    const legacyReport = evaluatePilotDatabase(filename, {
      generatedAt: '2026-08-29T00:00:00.000Z',
      bootstrapSamples: 10,
      seed: 7,
    });
    assert.equal(legacyReport.funnel.receiptProvenance.status, 'unavailable_legacy_column');
    assert.equal(legacyReport.task.completedOutcomeScopes, 2);
    assert.equal(legacyReport.task.completedScopeSamples, 0);
    assert.equal(legacyReport.task.legacyProvenanceNumericTargetsExcluded, 3);
    assert.equal(legacyReport.task.numericAccuracyWinClaimed, false);
    assert.match(pilotEvaluationMarkdown(legacyReport), /fails closed/);
  } finally {
    try {
      database.close();
    } catch {
      // It is already closed on the success path.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
