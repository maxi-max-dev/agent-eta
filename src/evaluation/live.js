import { calibrateForecastP80, estimateP80Calibration } from '../core/calibration.js';
import { forecastRun } from '../core/estimator.js';
import { createRunState, reduceEvent } from '../core/reducer.js';
import { withReadSnapshot } from './database.js';

const MINUTE_MS = 60_000;
const DEFAULT_BOOTSTRAP_SAMPLES = 2_000;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function median(values) {
  return quantile(values, 0.5);
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
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

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function eventPriority(kind) {
  return ({
    run_started: 0,
    plan_declared: 1,
    plan_revised: 2,
    step_started: 3,
    step_completed: 4,
    retry_started: 5,
    needs_input: 6,
    resumed: 7,
    run_succeeded: 9,
    run_failed: 9,
    run_cancelled: 9,
  })[kind] ?? 8;
}

function compareEvents(left, right) {
  return Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || eventPriority(left.kind) - eventPriority(right.kind)
    || left.event_id.localeCompare(right.event_id);
}

function selectedOutcomes(database) {
  return database.prepare(`
    SELECT
      runs.run_id, runs.provider, runs.model_family, runs.project_id,
      COALESCE(runs.task_class, (
        SELECT reporter.task_class
        FROM reporter_observations AS reporter
        WHERE reporter.run_id = runs.run_id
          AND julianday(reporter.reported_at) <= julianday(runs.started_at)
          AND julianday(reporter.received_at) <= julianday(runs.started_at)
        ORDER BY reporter.reported_at DESC, reporter.observation_id DESC
        LIMIT 1
      )) AS task_class,
      runs.user_id, runs.started_at, runs.finished_at, runs.outcome_minutes,
      runs.initial_forecast_minutes,
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
      runs.initial_steps, runs.final_steps, runs.state_json
    FROM runs
    WHERE runs.history_source = 'live_adapter'
      AND runs.provider = 'codex'
      AND runs.status = 'succeeded'
      AND runs.outcome_minutes > 0
      AND runs.started_at IS NOT NULL
      AND runs.finished_at IS NOT NULL
    ORDER BY runs.finished_at, runs.started_at, runs.run_id
  `).all().filter((row) =>
    Number.isFinite(Date.parse(row.started_at))
    && Number.isFinite(Date.parse(row.finished_at))
    && Date.parse(row.finished_at) > Date.parse(row.started_at)
    && finite(row.outcome_minutes) > 0);
}

function safeHistoryRow(row) {
  const savedState = parseJson(row.state_json, {});
  return {
    provider: row.provider,
    modelFamily: row.model_family,
    projectId: row.project_id,
    taskClass: row.task_class,
    userId: row.user_id,
    actualMinutes: Number(row.outcome_minutes),
    durationMinutes: Number(row.outcome_minutes),
    initialForecastMinutes: finite(row.initial_forecast_minutes),
    modelSelfEtaMinutes: finite(row.model_self_eta_minutes),
    initialStepCount: finite(row.initial_steps),
    finalStepCount: finite(row.final_steps),
    finishedAt: row.finished_at,
    historySource: 'live_adapter',
    steps: Array.isArray(savedState.steps) ? savedState.steps : [],
  };
}

function eventsFor(database, runId) {
  return database.prepare(`
    SELECT payload_json FROM events WHERE run_id = ?
  `).all(runId)
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean)
    .toSorted(compareEvents);
}

function stateAtStart(row, events) {
  const startIndex = events.findIndex((event) => event.kind === 'run_started');
  let state = createRunState(row.run_id);
  if (startIndex >= 0) {
    for (let index = 0; index <= startIndex; index += 1) {
      state = reduceEvent(state, events[index]);
    }
  } else {
    state = {
      ...state,
      provider: row.provider,
      modelFamily: row.model_family,
      projectId: row.project_id,
      taskClass: row.task_class,
      userId: row.user_id,
      modelSelfEtaMinutes: finite(row.model_self_eta_minutes),
      status: 'running',
      startedAt: new Date(row.started_at).toISOString(),
      activeSinceAt: new Date(row.started_at).toISOString(),
      lastOccurredAt: new Date(row.started_at).toISOString(),
    };
  }
  // These are immutable structural columns captured at run start. Filling a
  // missing adapter field from them does not expose terminal outcome data.
  state.provider ??= row.provider;
  state.modelFamily ??= row.model_family;
  state.projectId ??= row.project_id;
  state.taskClass ??= row.task_class;
  state.userId ??= row.user_id;
  state.modelSelfEtaMinutes ??= finite(row.model_self_eta_minutes);
  return { state, landmarkAt: state.startedAt ?? row.started_at };
}

function firstPlanState(row, events) {
  const planIndex = events.findIndex((event) =>
    (event.kind === 'plan_declared' || event.kind === 'plan_revised')
    && Date.parse(event.occurred_at) < Date.parse(row.finished_at));
  if (planIndex < 0) return null;
  let state = createRunState(row.run_id);
  for (let index = 0; index <= planIndex; index += 1) {
    state = reduceEvent(state, events[index]);
  }
  if (!state.startedAt || !state.steps.length || state.status !== 'running') return null;
  return { state, landmarkAt: events[planIndex].occurred_at };
}

function historyBefore(outcomes, landmarkAt) {
  const cutoff = Date.parse(landmarkAt);
  return outcomes
    .filter((candidate) => Date.parse(candidate.finished_at) < cutoff)
    .map(safeHistoryRow);
}

function empiricalPrediction(history) {
  const durations = history.map((entry) => entry.actualMinutes).filter(Number.isFinite);
  if (!durations.length) return null;
  return {
    p50: median(durations),
    lower: quantile(durations, 0.2),
    p80: quantile(durations, 0.8),
  };
}

function estimatorPrediction(forecast) {
  if (!Number.isFinite(forecast?.p50Minutes)) return null;
  return {
    p50: forecast.p50Minutes,
    lower: finite(forecast.lowerMinutes),
    p80: finite(forecast.p80Minutes),
  };
}

function timeForwardCalibration(rows, method, landmarkAt) {
  const cutoff = Date.parse(landmarkAt);
  const priorRows = rows.filter((row) => Date.parse(row.finishedAt) < cutoff).slice(-500);
  return estimateP80Calibration(priorRows.flatMap((row) => {
    const prediction = row.predictions?.[method];
    return Number.isFinite(row.actualRemainingMinutes)
      && Number.isFinite(prediction?.p80)
      && prediction.p80 > 0
      ? [{
          actualRemainingMinutes: row.actualRemainingMinutes,
          rawP80Minutes: prediction.p80,
        }]
      : [];
  }));
}

function calibrationDiagnostics(rows) {
  const calibrations = rows.map((row) => row.calibration).filter(Boolean);
  const eligible = calibrations.filter((calibration) => calibration.eligible);
  return {
    targetCoverage: 0.8,
    samplingUnit: 'one first-landmark forecast per prior completed run',
    historyRule: 'source run finished_at must be strictly earlier than target landmark',
    minimumSamples: calibrations[0]?.minimumSamples ?? 20,
    maximumRecentRuns: 500,
    eligibleLandmarks: eligible.length,
    ineligibleLandmarks: calibrations.length - eligible.length,
    medianAppliedMultiplier: median(eligible.map((calibration) => calibration.multiplier)),
    p80AppliedMultiplier: quantile(eligible.map((calibration) => calibration.multiplier), 0.8),
    latestMultiplier: calibrations.at(-1)?.multiplier ?? null,
    conformalStyleWithEmpiricalBayesShrinkage: true,
    formalCoverageGuaranteeClaimed: false,
  };
}

function summarize(rows, method, bootstrapSamples, seed) {
  const comparable = rows.filter((row) => Number.isFinite(row.predictions[method]?.p50));
  const errors = comparable.map((row) =>
    Math.abs(row.predictions[method].p50 - row.actualRemainingMinutes));
  const severe = comparable.filter((row) =>
    row.predictions[method].p50 < row.actualRemainingMinutes * 0.5).length;
  const p80Rows = comparable.filter((row) => Number.isFinite(row.predictions[method].p80));
  const p80Covered = p80Rows.filter((row) =>
    row.actualRemainingMinutes <= row.predictions[method].p80).length;
  const rangeRows = p80Rows.filter((row) => Number.isFinite(row.predictions[method].lower));
  const rangeCovered = rangeRows.filter((row) => {
    const prediction = row.predictions[method];
    return row.actualRemainingMinutes >= prediction.lower
      && row.actualRemainingMinutes <= prediction.p80;
  }).length;
  const status = comparable.length ? 'available' : 'unavailable';

  return {
    status,
    eligibleRuns: comparable.length,
    missingPredictions: rows.length - comparable.length,
    meanAbsoluteErrorMinutes: mean(errors),
    medianAbsoluteErrorMinutes: median(errors),
    severeUnderestimateRate: comparable.length ? severe / comparable.length : null,
    p80Coverage: p80Rows.length ? p80Covered / p80Rows.length : null,
    p80CoverageRuns: p80Rows.length,
    displayedP20P80RangeCoverage: rangeRows.length ? rangeCovered / rangeRows.length : null,
    runLevelBootstrap95: bootstrapMethod(comparable, method, bootstrapSamples, seed),
  };
}

function bootstrapMethod(rows, method, samples, seed) {
  if (!rows.length || samples <= 0) return null;
  const random = mulberry32(seed);
  const mae = [];
  const medianAe = [];
  const severe = [];
  const p80Coverage = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const chosen = Array.from({ length: rows.length }, () =>
      rows[Math.floor(random() * rows.length)]);
    const errors = chosen.map((row) =>
      Math.abs(row.predictions[method].p50 - row.actualRemainingMinutes));
    mae.push(mean(errors));
    medianAe.push(median(errors));
    severe.push(chosen.filter((row) =>
      row.predictions[method].p50 < row.actualRemainingMinutes * 0.5).length / chosen.length);
    const withP80 = chosen.filter((row) => Number.isFinite(row.predictions[method].p80));
    if (withP80.length) {
      p80Coverage.push(withP80.filter((row) =>
        row.actualRemainingMinutes <= row.predictions[method].p80).length / withP80.length);
    }
  }
  const interval = (values) => [quantile(values, 0.025), quantile(values, 0.975)];
  return {
    samples,
    resamplingUnit: 'run',
    meanAbsoluteErrorMinutes: interval(mae),
    medianAbsoluteErrorMinutes: interval(medianAe),
    severeUnderestimateRate: interval(severe),
    p80Coverage: p80Coverage.length ? interval(p80Coverage) : null,
  };
}

function pairedPlanBootstrap(rows, samples) {
  const paired = rows.filter((row) =>
    Number.isFinite(row.predictions.plan_conditioned?.p50)
    && Number.isFinite(row.predictions.same_landmark_fallback?.p50));
  if (!paired.length || samples <= 0) {
    return { pairedRuns: paired.length, samples: 0, status: 'unavailable' };
  }
  const random = mulberry32(0x51a7c0de);
  const gains = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let fallbackError = 0;
    let planError = 0;
    for (let index = 0; index < paired.length; index += 1) {
      const row = paired[Math.floor(random() * paired.length)];
      fallbackError += Math.abs(
        row.predictions.same_landmark_fallback.p50 - row.actualRemainingMinutes,
      );
      planError += Math.abs(row.predictions.plan_conditioned.p50 - row.actualRemainingMinutes);
    }
    gains.push((fallbackError - planError) / paired.length);
  }
  return {
    pairedRuns: paired.length,
    samples,
    status: 'available',
    gainDefinition: 'same-landmark fallback MAE minus plan-conditioned MAE',
    medianMaeGainMinutes: median(gains),
    interval95: [quantile(gains, 0.025), quantile(gains, 0.975)],
    probabilityPlanBeatsFallback: gains.filter((gain) => gain > 0).length / gains.length,
  };
}

function counts(database, selectedCount) {
  const total = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM runs
    WHERE history_source = 'live_adapter' AND provider = 'codex'
  `).get().count);
  const successful = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM runs
    WHERE history_source = 'live_adapter' AND provider = 'codex' AND status = 'succeeded'
  `).get().count);
  return {
    liveAdapterRuns: total,
    successfulRuns: successful,
    selectedPositiveDurationRuns: selectedCount,
    excludedRuns: total - selectedCount,
  };
}

function distribution(values) {
  return {
    p20: quantile(values, 0.2),
    median: median(values),
    p80: quantile(values, 0.8),
    p95: quantile(values, 0.95),
  };
}

/**
 * Evaluate privacy-minimized live outcomes with a strict time-forward protocol.
 * Native run IDs are used only as in-memory join keys and never enter the report.
 */
export function evaluateLiveDatabase(filename, {
  bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES,
  generatedAt = new Date().toISOString(),
} = {}) {
  return withReadSnapshot(filename, (database) => {
    const outcomes = selectedOutcomes(database);
    const startRows = [];
    const planRows = [];
    const startHistoryCounts = [];
    const planHistoryCounts = [];

    for (const row of outcomes) {
      const events = eventsFor(database, row.run_id);
      const start = stateAtStart(row, events);
      const startHistory = historyBefore(outcomes, start.landmarkAt);
      const matchingHistory = startHistory.filter((entry) =>
        (entry.taskClass ?? 'other') === (row.task_class ?? 'other'));
      const startForecast = forecastRun({
        state: start.state,
        history: startHistory,
        now: new Date(start.landmarkAt),
        seed: `live-evaluation:start:${row.run_id}`,
      });
      const startCalibration = timeForwardCalibration(
        startRows,
        'run_level_fallback',
        start.landmarkAt,
      );
      const calibratedStartForecast = calibrateForecastP80(startForecast, startCalibration);
      const selfEta = finite(row.model_self_eta_minutes);
      startRows.push({
        actualRemainingMinutes: Number(row.outcome_minutes),
        finishedAt: row.finished_at,
        calibration: startCalibration,
        predictions: {
          global_median: empiricalPrediction(startHistory),
          task_median: empiricalPrediction(matchingHistory),
          model_self_eta: selfEta === null ? null : { p50: selfEta, lower: null, p80: null },
          run_level_fallback: estimatorPrediction(startForecast),
          calibrated_run_level_fallback: estimatorPrediction(calibratedStartForecast),
        },
      });
      startHistoryCounts.push(startHistory.length);

      const plan = firstPlanState(row, events);
      if (!plan) continue;
      const planHistory = historyBefore(outcomes, plan.landmarkAt);
      const planForecast = forecastRun({
        state: plan.state,
        history: planHistory,
        now: new Date(plan.landmarkAt),
        seed: `live-evaluation:plan:${row.run_id}`,
      });
      const planCalibration = timeForwardCalibration(
        planRows,
        'plan_conditioned',
        plan.landmarkAt,
      );
      const calibratedPlanForecast = calibrateForecastP80(planForecast, planCalibration);
      const fallbackState = {
        ...structuredClone(plan.state),
        steps: [],
        currentStep: null,
        planRevision: 0,
        initialStepCount: null,
      };
      const counterfactual = forecastRun({
        state: fallbackState,
        history: planHistory,
        now: new Date(plan.landmarkAt),
        seed: `live-evaluation:plan-fallback:${row.run_id}`,
      });
      planRows.push({
        actualRemainingMinutes: Math.max(
          0,
          (Date.parse(row.finished_at) - Date.parse(plan.landmarkAt)) / MINUTE_MS,
        ),
        finishedAt: row.finished_at,
        calibration: planCalibration,
        predictions: {
          plan_conditioned: estimatorPrediction(planForecast),
          calibrated_plan_conditioned: estimatorPrediction(calibratedPlanForecast),
          same_landmark_fallback: estimatorPrediction(counterfactual),
        },
      });
      planHistoryCounts.push(planHistory.length);
    }

    const methodsAtStart = [
      'global_median',
      'task_median',
      'model_self_eta',
      'run_level_fallback',
      'calibrated_run_level_fallback',
    ];
    const methodsAtPlan = [
      'plan_conditioned',
      'calibrated_plan_conditioned',
      'same_landmark_fallback',
    ];
    const startMethods = Object.fromEntries(methodsAtStart.map((method, index) => [
      method,
      summarize(startRows, method, bootstrapSamples, 0x10face + index * 97),
    ]));
    const planMethods = Object.fromEntries(methodsAtPlan.map((method, index) => [
      method,
      summarize(planRows, method, bootstrapSamples, 0x20face + index * 97),
    ]));
    const durations = outcomes.map((row) => Number(row.outcome_minutes));
    const taskCounts = Object.fromEntries(Object.entries(outcomes.reduce((accumulator, row) => {
      const taskClass = row.task_class ?? 'other';
      accumulator[taskClass] = (accumulator[taskClass] ?? 0) + 1;
      return accumulator;
    }, {})).toSorted(([left], [right]) => left.localeCompare(right)));
    const providerCounts = Object.fromEntries(Object.entries(outcomes.reduce((accumulator, row) => {
      const provider = row.provider ?? 'unknown';
      accumulator[provider] = (accumulator[provider] ?? 0) + 1;
      return accumulator;
    }, {})).toSorted(([left], [right]) => left.localeCompare(right)));

    return {
      generatedAt,
      dataset: 'local privacy-minimized live adapter outcomes',
      simulated: false,
      databasePathPersisted: false,
      selection: {
        historySource: 'live_adapter',
        status: 'succeeded',
        positiveDurationOnly: true,
        ...counts(database, outcomes.length),
        firstFinishedAt: outcomes[0]?.finished_at ?? null,
        lastFinishedAt: outcomes.at(-1)?.finished_at ?? null,
      },
      temporalProtocol: {
        targetOrder: 'finished_at ascending; started_at and private run key only break ties',
        databaseReadSnapshot: 'single read transaction for the entire report',
        historyRule: 'finished_at must be strictly earlier than landmark timestamp',
        overlappingRunsExcludedFromHistoryUntilFinished: true,
        unitOfResampling: 'run',
        bootstrapSamples,
        p80CoverageDefinition: 'actual remaining minutes <= forecast P80',
        displayedRangeDefinition: 'forecast P20 <= actual remaining minutes <= forecast P80',
        intervalCalibration: 'up to 500 prior-run empirical P80 ratios with finite-sample rank and log-space shrinkage toward no adjustment',
        reporterSelfEtaRule: 'explicit sidecar self-ETA is eligible only when both reported_at and local received_at are <= run started_at',
      },
      startLandmark: {
        targetRuns: startRows.length,
        methods: startMethods,
        historyAvailability: {
          noPriorFinishedOutcomeRuns: startHistoryCounts.filter((count) => count === 0).length,
          medianPriorFinishedOutcomes: median(startHistoryCounts),
        },
        intervalCalibration: calibrationDiagnostics(startRows),
      },
      planLandmark: {
        targetRuns: planRows.length,
        missingPlanRuns: startRows.length - planRows.length,
        definition: 'state immediately after the first declared/revised plan event',
        methods: planMethods,
        pairedRunLevelBootstrap: pairedPlanBootstrap(planRows, bootstrapSamples),
        historyAvailability: {
          noPriorFinishedOutcomeRuns: planHistoryCounts.filter((count) => count === 0).length,
          medianPriorFinishedOutcomes: median(planHistoryCounts),
        },
        intervalCalibration: calibrationDiagnostics(planRows),
      },
      observedData: {
        providers: providerCounts,
        taskClasses: taskCounts,
        durationMinutes: distribution(durations),
        modelSelfEtaPresentRuns: outcomes.filter((row) => finite(row.model_self_eta_minutes) !== null).length,
        planRuns: planRows.length,
        planRunRate: outcomes.length ? planRows.length / outcomes.length : null,
      },
      dataBiases: [
        'Lifecycle runs are Agent turn/run proxies, not independently labelled human tasks.',
        'Only successful positive-duration Codex outcomes are learning-eligible; failures, cancellations and zero-duration records are excluded.',
        'Task class and model family are often unavailable in the privacy-minimized adapter, limiting stratified baselines.',
        'Plan comparisons use a self-selected low-coverage subset and do not identify a causal plan benefit.',
        'The local observation window and one user environment do not establish population calibration.',
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

function methodRow(name, metrics) {
  return `| ${name} | ${metrics.status} | ${metrics.eligibleRuns} | ${metrics.missingPredictions} | ${minutes(metrics.meanAbsoluteErrorMinutes)} | ${minutes(metrics.medianAbsoluteErrorMinutes)} | ${percentage(metrics.severeUnderestimateRate)} | ${percentage(metrics.p80Coverage)} |`;
}

export function liveEvaluationMarkdown(report) {
  const lines = [
    '# Agent ETA live time-forward evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '> This is a real local, privacy-minimized outcome evaluation. It is not a simulated replay and it does not read or emit prompts, code, commands, native IDs, or filesystem paths.',
    '',
    '## Verdict',
    '',
    `The evaluation contains ${report.selection.selectedPositiveDurationRuns} successful positive-duration live outcomes. ${report.planLandmark.targetRuns} have an observable plan landmark (${percentage(report.observedData.planRunRate)}). Model self-ETA is ${report.startLandmark.methods.model_self_eta.status} (${report.observedData.modelSelfEtaPresentRuns} values present); missing values were not imputed.`,
    '',
    'Predictions are reconstructed in finish-time order. At every landmark, the history query requires `finished_at < landmark_at`, so an overlapping run cannot leak its later outcome into an earlier prediction.',
    '',
    '## Start landmark',
    '',
    '| Method | Status | Evaluated | Missing | MAE (min) | Median AE (min) | Severe underestimate | P80 coverage |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [name, metrics] of Object.entries(report.startLandmark.methods)) {
    lines.push(methodRow(name, metrics));
  }
  lines.push(
    '',
    `No prior finished outcome was available for ${report.startLandmark.historyAvailability.noPriorFinishedOutcomeRuns} start landmarks. Baselines stay unavailable there; only the run-level estimator may use its public prior.`,
    '',
    `The calibrated fallback had enough prior independent runs at ${report.startLandmark.intervalCalibration.eligibleLandmarks} landmarks. Its median upper-bound multiplier was ${minutes(report.startLandmark.intervalCalibration.medianAppliedMultiplier)}; calibration changes P80 only, not P50.`,
    '',
    '## First-plan landmark',
    '',
    '| Method | Status | Evaluated | Missing | MAE (min) | Median AE (min) | Severe underestimate | P80 coverage |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const [name, metrics] of Object.entries(report.planLandmark.methods)) {
    lines.push(methodRow(name, metrics));
  }
  const paired = report.planLandmark.pairedRunLevelBootstrap;
  const intervalCrossesZero = paired.interval95?.[0] <= 0 && paired.interval95?.[1] >= 0;
  const planMedianAe = report.planLandmark.methods.plan_conditioned.medianAbsoluteErrorMinutes;
  const fallbackMedianAe = report.planLandmark.methods.same_landmark_fallback.medianAbsoluteErrorMinutes;
  const pairedVerdict = intervalCrossesZero
    ? 'The interval crosses zero, so this does not establish an accuracy improvement.'
    : 'The interval excludes zero; this local cohort supports the reported direction but does not establish population performance.';
  lines.push(
    '',
    `The same-landmark paired run bootstrap uses ${paired.pairedRuns} runs. Median plan MAE gain is ${minutes(paired.medianMaeGainMinutes)} minutes; 95% interval ${paired.interval95 ? paired.interval95.map(minutes).join(' to ') : 'unavailable'}; probability plan-conditioned beats fallback is ${percentage(paired.probabilityPlanBeatsFallback)}. Positive gain favors plan-conditioned. ${pairedVerdict}`,
    '',
    `Median absolute error points the other way (${minutes(planMedianAe)} minutes plan-conditioned versus ${minutes(fallbackMedianAe)} fallback), so the apparent mean-MAE gain is tail-sensitive and must not be presented as a general win.`,
    '',
    '## Calibration protocol',
    '',
    '- P80 coverage means `actual remaining <= predicted P80`.',
    '- Severe underestimate means `predicted P50 < 50% of actual remaining`.',
    `- Every confidence interval uses ${report.temporalProtocol.bootstrapSamples} run-level bootstrap samples.`,
    '- Global/task medians use only outcomes finished before the landmark; no cold-start constant is substituted.',
    '- Interval calibration uses one first-landmark ratio from each of up to 500 recent prior completed runs, with a 20-run gate and log-space shrinkage toward no adjustment.',
    '- The calibrated method never narrows P80 and makes no formal conformal coverage guarantee after shrinkage.',
    '- Model self-ETA is unavailable when absent; it is never synthesized.',
    '',
    '## Data limitations',
    '',
    ...report.dataBiases.map((bias) => `- ${bias}`),
    '',
  );
  return lines.join('\n');
}
