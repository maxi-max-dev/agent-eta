import { withReadSnapshot } from './database.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MINUTE_MS = 60_000;
const DEFAULT_COMPLETED_WEEKS = 4;
const PLAN_COVERAGE_THRESHOLD = 0.3;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mean(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

function iso(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be a valid ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function startOfUtcWeek(value) {
  const date = new Date(value);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - daysSinceMonday,
  ));
}

function completedWeekWindows(asOf, count) {
  const latestEnd = startOfUtcWeek(asOf).getTime();
  return Array.from({ length: count }, (_, index) => {
    const start = latestEnd - (count - index) * 7 * DAY_MS;
    return {
      kind: 'complete_utc_week',
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + 7 * DAY_MS).toISOString(),
    };
  });
}

function booleanField(value) {
  return typeof value === 'boolean' ? value : null;
}

function eventEligibility(event) {
  return booleanField(event?.data?.eligible_large_task)
    ?? booleanField(event?.data?.reporter?.eligible_large_task)
    ?? null;
}

function eventPlanPresent(event) {
  if (event?.kind === 'plan_declared' || event?.kind === 'plan_revised') return true;
  return booleanField(event?.data?.plan_present)
    ?? booleanField(event?.data?.reporter?.plan_present)
    ?? false;
}

function explicitEligibility(savedState, events) {
  const stateValue = booleanField(savedState?.eligibleLargeTask)
    ?? booleanField(savedState?.eligible_large_task);
  if (stateValue !== null) return stateValue;
  for (const event of events) {
    const value = eventEligibility(event);
    if (value !== null) return value;
  }
  return null;
}

function loadOutcomeRows(database) {
  const runs = database.prepare(`
    SELECT
      runs.run_id, runs.started_at, runs.finished_at, runs.outcome_minutes,
      COALESCE(runs.model_self_eta_minutes, (
        SELECT reporter.model_self_eta_minutes
        FROM reporter_observations AS reporter
        WHERE reporter.run_id = runs.run_id
          AND julianday(reporter.reported_at) <= julianday(runs.started_at)
          AND julianday(reporter.received_at) <= julianday(runs.started_at)
          AND reporter.model_self_eta_minutes IS NOT NULL
        ORDER BY reporter.reported_at DESC, reporter.observation_id DESC
        LIMIT 1
      )) AS model_self_eta_minutes,
      runs.state_json
    FROM runs
    WHERE runs.history_source = 'live_adapter'
      AND runs.provider = 'codex'
      AND runs.status = 'succeeded'
      AND runs.outcome_minutes > 0
      AND runs.started_at IS NOT NULL
      AND runs.finished_at IS NOT NULL
    ORDER BY runs.finished_at, runs.started_at, runs.run_id
  `).all();
  const eventStatement = database.prepare(`
    SELECT occurred_at, kind, payload_json
    FROM events
    WHERE run_id = ?
    ORDER BY occurred_at, event_id
  `);
  const forecastStatement = database.prepare(`
    SELECT snapshot_id, observed_at, p50_minutes, p80_minutes, lower_minutes
    FROM forecast_snapshots
    WHERE run_id = ?
    ORDER BY observed_at, snapshot_id
  `);

  return runs.flatMap((row) => {
    const started = Date.parse(row.started_at);
    const finished = Date.parse(row.finished_at);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) return [];

    const events = eventStatement.all(row.run_id)
      .filter((entry) => {
        const occurred = Date.parse(entry.occurred_at);
        return Number.isFinite(occurred) && occurred <= finished;
      })
      .map((entry) => parseJson(entry.payload_json, { kind: entry.kind }))
      .filter(Boolean);
    const savedState = parseJson(row.state_json, {});
    const forecasts = forecastStatement.all(row.run_id)
      .map((forecast) => ({
        observedAt: forecast.observed_at,
        observedMs: Date.parse(forecast.observed_at),
        p50: finite(forecast.p50_minutes),
        p80: finite(forecast.p80_minutes),
        lower: finite(forecast.lower_minutes),
      }))
      .filter((forecast) =>
        Number.isFinite(forecast.observedMs)
        && forecast.observedMs >= started
        && forecast.observedMs <= finished
        && forecast.p50 !== null)
      .toSorted((left, right) => left.observedMs - right.observedMs);

    return [{
      startedMs: started,
      finishedMs: finished,
      actualMinutes: (finished - started) / MINUTE_MS,
      selfEta: finite(row.model_self_eta_minutes),
      eligibility: explicitEligibility(savedState, events),
      planPresent: events.some(eventPlanPresent),
      forecasts,
    }];
  });
}

function loadCoverageRows(database, asOfMs) {
  const runs = database.prepare(`
    SELECT run_id, started_at, updated_at, state_json
    FROM runs
    WHERE provider = 'codex'
      AND EXISTS (
        SELECT 1 FROM events
        WHERE events.run_id = runs.run_id
          AND json_extract(events.source_json, '$.adapter') = 'codex-jsonl'
      )
    ORDER BY COALESCE(started_at, updated_at), run_id
  `).all();
  const eventStatement = database.prepare(`
    SELECT occurred_at, kind, payload_json
    FROM events
    WHERE run_id = ?
      AND json_extract(source_json, '$.adapter') = 'codex-jsonl'
    ORDER BY occurred_at, event_id
  `);
  const reporterStatement = database.prepare(`
    SELECT
      eligible_large_task, plan_present, plan_adherence, reported_at
    FROM reporter_observations
    WHERE run_id = ? AND reported_at < ?
    ORDER BY reported_at DESC, observation_id DESC
    LIMIT 1
  `);
  const asOf = new Date(asOfMs).toISOString();

  return runs.flatMap((row) => {
    const events = eventStatement.all(row.run_id)
      .filter((entry) => {
        const occurred = Date.parse(entry.occurred_at);
        return Number.isFinite(occurred) && occurred < asOfMs;
      })
      .map((entry) => parseJson(entry.payload_json, { kind: entry.kind }))
      .filter(Boolean);
    if (!events.length) return [];
    const runStarted = events.find((event) => event.kind === 'run_started');
    const cohortAt = Date.parse(row.started_at ?? runStarted?.occurred_at ?? row.updated_at);
    if (!Number.isFinite(cohortAt) || cohortAt >= asOfMs) return [];
    const reporter = reporterStatement.get(row.run_id, asOf) ?? null;
    return [{
      cohortAt,
      eligibility: reporter
        ? Boolean(reporter.eligible_large_task)
        : explicitEligibility(parseJson(row.state_json, {}), events),
      planPresent: Boolean(reporter?.plan_present) || events.some(eventPlanPresent),
      planAdherence: reporter?.plan_adherence ?? null,
      reporterAttached: reporter !== null,
    }];
  });
}

function summarizeForecasts(rows) {
  const evaluated = rows.flatMap((row) => {
    const first = row.forecasts[0];
    if (!first) return [];
    const actualRemaining = Math.max(0, (row.finishedMs - first.observedMs) / MINUTE_MS);
    return [{
      error: Math.abs(first.p50 - actualRemaining),
      p80Covered: first.p80 === null ? null : actualRemaining <= first.p80,
      rangeCovered: first.p80 === null || first.lower === null
        ? null
        : actualRemaining >= first.lower && actualRemaining <= first.p80,
    }];
  });
  const p80 = evaluated.filter((row) => row.p80Covered !== null);
  const ranges = evaluated.filter((row) => row.rangeCovered !== null);
  return {
    status: evaluated.length ? 'available' : 'unavailable',
    landmark: 'first persisted forecast at or after run start and no later than finish',
    evaluatedRuns: evaluated.length,
    missingForecastRuns: rows.length - evaluated.length,
    meanAbsoluteErrorMinutes: mean(evaluated.map((row) => row.error)),
    medianAbsoluteErrorMinutes: median(evaluated.map((row) => row.error)),
    p80Coverage: p80.length
      ? p80.filter((row) => row.p80Covered).length / p80.length
      : null,
    p80CoverageRuns: p80.length,
    displayedP20P80RangeCoverage: ranges.length
      ? ranges.filter((row) => row.rangeCovered).length / ranges.length
      : null,
    displayedRangeCoverageRuns: ranges.length,
  };
}

function summarizeVolatility(rows) {
  const perRun = rows.flatMap((row) => {
    if (row.forecasts.length < 2) return [];
    const predictedFinish = row.forecasts.map((forecast) =>
      forecast.observedMs + forecast.p50 * MINUTE_MS);
    const shifts = predictedFinish.slice(1).map((value, index) =>
      Math.abs(value - predictedFinish[index]) / MINUTE_MS);
    return [{ meanShift: mean(shifts), maxShift: Math.max(...shifts), transitions: shifts.length }];
  });
  return {
    status: perRun.length ? 'available' : 'unavailable',
    definition: 'absolute change in predicted completion clock between consecutive saved forecasts',
    unitOfAggregation: 'run',
    eligibleRuns: perRun.length,
    missingOrSingleForecastRuns: rows.length - perRun.length,
    forecastTransitions: perRun.reduce((sum, row) => sum + row.transitions, 0),
    medianRunMeanAbsoluteShiftMinutes: median(perRun.map((row) => row.meanShift)),
    p80RunMeanAbsoluteShiftMinutes: quantile(perRun.map((row) => row.meanShift), 0.8),
    medianRunMaximumShiftMinutes: median(perRun.map((row) => row.maxShift)),
  };
}

function summarizeSelfEta(rows) {
  const evaluated = rows.filter((row) => row.selfEta !== null);
  const errors = evaluated.map((row) => Math.abs(row.selfEta - row.actualMinutes));
  return {
    status: evaluated.length ? 'available' : 'unavailable',
    presentRuns: evaluated.length,
    missingRuns: rows.length - evaluated.length,
    meanAbsoluteErrorMinutes: mean(errors),
    medianAbsoluteErrorMinutes: median(errors),
    synthesizedWhenMissing: false,
  };
}

function summarizePlanCoverage(rows) {
  const labeled = rows.filter((row) => row.eligibility !== null);
  const eligible = labeled.filter((row) => row.eligibility === true);
  const eligibleWithPlan = eligible.filter((row) => row.planPresent);
  const allWithPlan = rows.filter((row) => row.planPresent);
  const reporterAttached = rows.filter((row) => row.reporterAttached);
  const adherence = rows.filter((row) =>
    ['following', 'replanned', 'departed'].includes(row.planAdherence));
  const adherenceDistribution = Object.fromEntries(
    ['following', 'replanned', 'departed'].map((value) => [
      value,
      adherence.filter((row) => row.planAdherence === value).length,
    ]),
  );
  return {
    observedPresenceAllLifecycleRuns: {
      status: rows.length ? 'available' : 'unavailable',
      denominatorDefinition: 'all-status Codex live-adapter lifecycle runs assigned by run start time',
      denominatorRuns: rows.length,
      planPresentRuns: allWithPlan.length,
      rate: rows.length ? allWithPlan.length / rows.length : null,
      suitableForFourWeekGate: false,
    },
    explicitEligibleLargeTaskCoverage: {
      status: eligible.length ? 'available' : 'unavailable',
      eligibilitySource: 'explicit structural eligible_large_task boolean only',
      eligibilityInferredFromDurationOrContent: false,
      labeledRuns: labeled.length,
      unlabeledRuns: rows.length - labeled.length,
      eligibleLargeTaskRuns: eligible.length,
      planPresentRuns: eligibleWithPlan.length,
      rate: eligible.length ? eligibleWithPlan.length / eligible.length : null,
      denominatorComplete: rows.length > 0 && labeled.length === rows.length,
    },
    planAdherence: {
      status: adherence.length ? 'available' : 'unavailable',
      source: 'explicit Reporter sidecar observation only',
      observedRuns: adherence.length,
      missingRuns: rows.length - adherence.length,
      distribution: adherenceDistribution,
      stepCompletionTreatedAsAdherence: false,
      reason: adherence.length
        ? null
        : 'No explicit Reporter adherence observation is attached; step completion is not treated as adherence.',
    },
    reporterSidecar: {
      attachedLifecycleRuns: reporterAttached.length,
      unattachedLifecycleRuns: rows.length - reporterAttached.length,
    },
  };
}

function summarizeWindow(outcomeRows, coverageRows, window) {
  const start = Date.parse(window.startAt);
  const end = Date.parse(window.endAt);
  const outcomes = outcomeRows.filter((row) => row.finishedMs >= start && row.finishedMs < end);
  const lifecycle = coverageRows.filter((row) => row.cohortAt >= start && row.cohortAt < end);
  return {
    ...window,
    outcomeRuns: outcomes.length,
    lifecycleRuns: lifecycle.length,
    evaluationCohort: {
      assignment: 'successful positive-duration outcome finish time',
      runs: outcomes.length,
    },
    coverageCohort: {
      assignment: 'all Codex live-adapter lifecycle run start time',
      runs: lifecycle.length,
      includesFailedAndCancelledRuns: true,
    },
    savedForecastEvaluation: summarizeForecasts(outcomes),
    completionClockVolatility: summarizeVolatility(outcomes),
    modelSelfEta: summarizeSelfEta(outcomes),
    planCoverage: summarizePlanCoverage(lifecycle),
  };
}

function fourWeekGate(weeks, threshold) {
  const selected = weeks.slice(-4);
  const policy = 'Demote plan-conditioned ETA to an opportunistic feature after four consecutive complete weeks below the coverage threshold.';
  if (selected.length < 4) {
    return {
      status: 'insufficient',
      decision: 'insufficient_evidence',
      threshold,
      policy,
      reason: 'Fewer than four complete UTC weeks were requested.',
      evaluatedWeeks: selected.length,
      weeklyCoverage: [],
    };
  }
  if (selected.every((week) =>
    week.planCoverage.explicitEligibleLargeTaskCoverage.labeledRuns === 0)) {
    return {
      status: 'unsupported',
      decision: 'unsupported_denominator',
      threshold,
      policy,
      reason: 'No explicit eligible_large_task labels are available; lifecycle plan presence is not a safe denominator.',
      evaluatedWeeks: 4,
      weeklyCoverage: [],
    };
  }
  const emptyWeek = selected.find((week) => week.lifecycleRuns === 0);
  if (emptyWeek) {
    return {
      status: 'insufficient',
      decision: 'insufficient_evidence',
      threshold,
      policy,
      reason: 'At least one complete week has no lifecycle coverage cohort.',
      evaluatedWeeks: 4,
      weeklyCoverage: [],
    };
  }
  const incomplete = selected.find((week) =>
    !week.planCoverage.explicitEligibleLargeTaskCoverage.denominatorComplete);
  if (incomplete) {
    return {
      status: 'unsupported',
      decision: 'unsupported_denominator',
      threshold,
      policy,
      reason: 'At least one complete week has unlabeled runs, so eligible-large-task coverage cannot be safely constructed.',
      evaluatedWeeks: 4,
      weeklyCoverage: [],
    };
  }
  const noEligible = selected.find((week) =>
    week.planCoverage.explicitEligibleLargeTaskCoverage.eligibleLargeTaskRuns === 0);
  if (noEligible) {
    return {
      status: 'insufficient',
      decision: 'insufficient_evidence',
      threshold,
      policy,
      reason: 'At least one complete week has no explicitly eligible large task.',
      evaluatedWeeks: 4,
      weeklyCoverage: [],
    };
  }
  const weeklyCoverage = selected.map((week) => ({
    startAt: week.startAt,
    endAt: week.endAt,
    eligibleLargeTaskRuns: week.planCoverage.explicitEligibleLargeTaskCoverage.eligibleLargeTaskRuns,
    planPresentRuns: week.planCoverage.explicitEligibleLargeTaskCoverage.planPresentRuns,
    rate: week.planCoverage.explicitEligibleLargeTaskCoverage.rate,
  }));
  const belowThreshold = weeklyCoverage.every((week) => week.rate < threshold);
  return {
    status: belowThreshold ? 'degrade' : 'retain',
    decision: belowThreshold ? 'demote_plan_conditioned' : 'do_not_demote',
    threshold,
    policy,
    reason: belowThreshold
      ? 'All four complete weeks are below the explicit eligible-large-task coverage threshold.'
      : 'The four-week consecutive-below-threshold condition is not met.',
    evaluatedWeeks: 4,
    weeklyCoverage,
  };
}

/**
 * Summarize saved live forecasts in UTC weekly windows without rerunning the
 * estimator. Native identifiers are used only as private in-memory join keys.
 */
export function evaluateWeeklyDatabase(filename, {
  generatedAt = new Date().toISOString(),
  completedWeeks = DEFAULT_COMPLETED_WEEKS,
  planCoverageThreshold = PLAN_COVERAGE_THRESHOLD,
} = {}) {
  const asOf = iso(generatedAt, 'generatedAt');
  if (!Number.isInteger(completedWeeks) || completedWeeks < 1) {
    throw new TypeError('completedWeeks must be a positive integer');
  }
  if (!Number.isFinite(planCoverageThreshold)
      || planCoverageThreshold < 0
      || planCoverageThreshold > 1) {
    throw new TypeError('planCoverageThreshold must be between 0 and 1');
  }

  return withReadSnapshot(filename, (database) => {
    const asOfMs = Date.parse(asOf);
    const outcomeRows = loadOutcomeRows(database).filter((row) => row.finishedMs < asOfMs);
    const coverageRows = loadCoverageRows(database, asOfMs);
    const completeWindows = completedWeekWindows(asOf, completedWeeks);
    const rollingWindow = {
      kind: 'rolling_7_days',
      startAt: new Date(Date.parse(asOf) - 7 * DAY_MS).toISOString(),
      endAt: asOf,
    };
    const complete = completeWindows.map((window) =>
      summarizeWindow(outcomeRows, coverageRows, window));
    return {
      generatedAt: asOf,
      dataset: 'local privacy-minimized persisted live forecasts and outcomes',
      simulated: false,
      databasePathPersisted: false,
      reportingTimezone: 'UTC',
      selection: {
        historySource: 'live_adapter',
        provider: 'codex',
        status: 'succeeded',
        positiveDurationOnly: true,
        evaluationCohort: {
          assignment: 'finished_at',
          historySource: 'live_adapter',
          status: 'succeeded',
          positiveDurationOnly: true,
          runsBeforeGeneratedAt: outcomeRows.length,
        },
        coverageCohort: {
          assignment: 'started_at (first live-adapter event only when started_at is missing)',
          adapter: 'codex-jsonl',
          statuses: 'all',
          positiveDurationRequired: false,
          runsBeforeGeneratedAt: coverageRows.length,
        },
        outcomesBeforeGeneratedAt: outcomeRows.length,
      },
      temporalProtocol: {
        outcomeAssignment: 'finished_at in [week_start, week_end)',
        databaseReadSnapshot: 'single read transaction for the entire report',
        coverageAssignment: 'all Codex live-adapter lifecycle runs by started_at in [week_start, week_end)',
        coverageStatuses: 'all, including failed and cancelled',
        targetOrder: 'finished_at ascending; private keys only break ties',
        forecastRule: 'persisted observed_at must be between run start and finish',
        postFinishForecastsExcluded: true,
        estimatorRerun: false,
        futureOutcomesUsedToReconstructForecasts: false,
        reporterRule: 'latest explicit observation before generatedAt, joined only by canonical run alias',
        reporterSelfEtaRule: 'self-ETA is evaluated only when both its declared time and local receipt time are no later than run start',
        unitOfAggregation: 'run',
        p80CoverageDefinition: 'actual remaining minutes at saved landmark <= saved forecast P80',
      },
      rollingSevenDays: summarizeWindow(outcomeRows, coverageRows, rollingWindow),
      completedWeeks: complete,
      fourWeekPlanCoverageGate: fourWeekGate(complete, planCoverageThreshold),
      unavailableMeasurements: {
        planAdherence: 'unavailable unless an explicit adherence outcome is persisted',
        modelSelfEta: complete.some((week) => week.modelSelfEta.presentRuns > 0)
          ? 'partially_available'
          : 'unavailable',
        eligibleLargeTaskCoverage: complete.some((week) =>
          week.planCoverage.explicitEligibleLargeTaskCoverage.labeledRuns > 0)
          ? 'partially_available'
          : 'unavailable',
      },
      limitations: [
        'Lifecycle runs are Agent turn/run proxies, not independently labelled human tasks.',
        'The four-week gate never substitutes all-run plan presence for explicit eligible-large-task coverage.',
        'Saved forecast quality is observational; this report does not prove that the online predictor itself avoided all upstream data leakage.',
        'Plan adherence is measured only when an explicit Reporter sidecar observation is attached; step completion is never substituted.',
        'Model self-ETA is unavailable when absent and is never synthesized.',
      ],
      privacy: {
        aggregateOnly: true,
        nativeContentRead: false,
        nativeIdentifiersEmitted: false,
        filesystemPathsEmitted: false,
      },
    };
  });
}

function percentage(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unavailable';
}

function minutes(value) {
  return Number.isFinite(value) ? value.toFixed(2) : 'unavailable';
}

function weekRow(week) {
  const forecasts = week.savedForecastEvaluation;
  const volatility = week.completionClockVolatility;
  const presence = week.planCoverage.observedPresenceAllLifecycleRuns;
  const eligible = week.planCoverage.explicitEligibleLargeTaskCoverage;
  return `| ${week.startAt.slice(0, 10)} | ${week.outcomeRuns} | ${week.lifecycleRuns} | ${forecasts.evaluatedRuns} | ${minutes(forecasts.meanAbsoluteErrorMinutes)} | ${percentage(forecasts.p80Coverage)} | ${minutes(volatility.medianRunMeanAbsoluteShiftMinutes)} | ${percentage(presence.rate)} | ${eligible.status === 'available' && eligible.denominatorComplete ? percentage(eligible.rate) : 'unavailable'} |`;
}

export function weeklyEvaluationMarkdown(report) {
  const rolling = report.rollingSevenDays;
  const gate = report.fourWeekPlanCoverageGate;
  const adherence = rolling.planCoverage.planAdherence;
  const adherenceLabel = adherence.status === 'available'
    ? `available (${adherence.observedRuns} explicit: ${adherence.distribution.following} following, ${adherence.distribution.replanned} replanned, ${adherence.distribution.departed} departed)`
    : 'unavailable';
  const lines = [
    '# Agent ETA weekly shadow evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '> Aggregate-only evaluation of persisted local forecasts. It emits no prompts, code, commands, native IDs, or filesystem paths.',
    '',
    '## Four-week falsification gate',
    '',
    `Status: **${gate.status}** — ${gate.reason}`,
    '',
    `Policy threshold: ${percentage(gate.threshold)} explicit plan coverage among explicitly eligible large tasks. All-run plan presence is diagnostic only.`,
    '',
    '## Complete UTC weeks',
    '',
    '| Week starting | Success outcomes | All lifecycle runs | Saved forecasts | First-forecast MAE (min) | P80 coverage | Median completion-clock shift (min) | All-run plan presence | Eligible-task plan coverage |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.completedWeeks.map(weekRow),
    '',
    '## Rolling seven days',
    '',
    `There are ${rolling.outcomeRuns} successful positive-duration outcomes for error evaluation, ${rolling.lifecycleRuns} all-status lifecycle runs for coverage, and ${rolling.savedForecastEvaluation.evaluatedRuns} runs with a saved forecast. First-snapshot MAE is ${minutes(rolling.savedForecastEvaluation.meanAbsoluteErrorMinutes)} minutes; P80 coverage is ${percentage(rolling.savedForecastEvaluation.p80Coverage)}.`,
    '',
    `Plan adherence: ${adherenceLabel}. Reporter sidecar: ${rolling.planCoverage.reporterSidecar.attachedLifecycleRuns} lifecycle runs attached. Model self-ETA: ${rolling.modelSelfEta.status} (${rolling.modelSelfEta.presentRuns} present, ${rolling.modelSelfEta.missingRuns} missing).`,
    '',
    '## Protocol and limitations',
    '',
    '- Successful outcome evaluation runs are assigned by finish time to half-open UTC week windows.',
    '- Plan coverage uses a separate all-status live-adapter lifecycle cohort assigned by run start time; failed and cancelled runs are not dropped.',
    '- Only snapshots saved between run start and finish are evaluated; the estimator is not rerun.',
    '- Volatility is the change in predicted completion clock, aggregated at run level.',
    '- Missing self-ETA and explicit eligibility labels stay unavailable; neither is inferred.',
    ...report.limitations.map((limitation) => `- ${limitation}`),
  ];
  return lines.join('\n');
}
