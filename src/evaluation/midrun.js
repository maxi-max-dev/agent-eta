import { calibrateForecastP80, estimateP80Calibration } from '../core/calibration.js';
import { forecastRun } from '../core/estimator.js';
import { createRunState, reduceEvent } from '../core/reducer.js';
import { withReadSnapshot } from './database.js';

const MINUTE_MS = 60_000;
const LANDMARK_FRACTIONS = Object.freeze([0.25, 0.5, 0.75]);
const WAITING_STATUSES = new Set(['needs_input', 'waiting_provider', 'blocked', 'paused']);
const METHODS = Object.freeze([
  'global_median',
  'task_median',
  'fixed_clamp',
  'unclamped',
  'empirical_heavy_tail',
  'calibrated_fixed_clamp',
  'calibrated_unclamped',
  'calibrated_empirical_heavy_tail',
  'plan_conditioned',
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function median(values) {
  return quantile(values, 0.5);
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
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

function parseJson(value, fallback = null) {
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
    waiting_provider: 6,
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
      runs.run_id,
      runs.provider,
      runs.model_family,
      runs.project_id,
      runs.task_class,
      runs.user_id,
      runs.started_at,
      runs.finished_at,
      runs.outcome_minutes,
      runs.model_self_eta_minutes,
      runs.state_json,
      MIN(events.observed_at) AS terminal_observed_at
    FROM runs
    JOIN events
      ON events.run_id = runs.run_id
      AND events.kind = 'run_succeeded'
    WHERE runs.history_source = 'live_adapter'
      AND runs.provider = 'codex'
      AND runs.status = 'succeeded'
      AND runs.outcome_minutes > 0
      AND runs.started_at IS NOT NULL
      AND runs.finished_at IS NOT NULL
    GROUP BY runs.run_id
    ORDER BY runs.finished_at, runs.started_at, runs.run_id
  `).all().filter((row) =>
    Number.isFinite(Date.parse(row.started_at))
    && Number.isFinite(Date.parse(row.finished_at))
    && Number.isFinite(Date.parse(row.terminal_observed_at))
    && Date.parse(row.finished_at) > Date.parse(row.started_at));
}

function historyRow(row) {
  const state = parseJson(row.state_json, {});
  return {
    provider: row.provider,
    modelFamily: row.model_family,
    projectId: row.project_id,
    taskClass: row.task_class,
    userId: row.user_id,
    actualMinutes: Number(row.outcome_minutes),
    durationMinutes: Number(row.outcome_minutes),
    finishedAt: row.finished_at,
    historySource: 'live_adapter',
    steps: Array.isArray(state.steps) ? state.steps : [],
  };
}

function eventsFor(database, runId) {
  return database.prepare('SELECT payload_json FROM events WHERE run_id = ?').all(runId)
    .map((row) => parseJson(row.payload_json))
    .filter(Boolean)
    .toSorted(compareEvents);
}

function stateAt(row, events, landmarkAt) {
  let state = createRunState(row.run_id);
  const cutoff = Date.parse(landmarkAt);
  for (const event of events) {
    if (Date.parse(event.occurred_at) > cutoff) break;
    if (Date.parse(event.observed_at) > cutoff) continue;
    state = reduceEvent(state, event);
  }
  if (!state.startedAt) return null;
  state.provider ??= row.provider;
  state.modelFamily ??= row.model_family;
  state.projectId ??= row.project_id;
  state.taskClass ??= row.task_class;
  state.userId ??= row.user_id;
  return state;
}

function activeElapsedMinutes(state, landmarkAt) {
  let elapsed = Math.max(0, Number(state.activeElapsedMs ?? 0)) / MINUTE_MS;
  const paused = Boolean(state.needsInput) || WAITING_STATUSES.has(String(state.status ?? ''));
  if (!paused && state.activeSinceAt) {
    const start = Date.parse(state.activeSinceAt);
    const end = Date.parse(landmarkAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      elapsed += (end - start) / MINUTE_MS;
    }
  }
  return elapsed;
}

function historyBefore(outcomes, landmarkAt, taskClass = null) {
  const cutoff = Date.parse(landmarkAt);
  return outcomes.filter((candidate) =>
    Date.parse(candidate.finished_at) < cutoff
    && Date.parse(candidate.terminal_observed_at) < cutoff
    && (taskClass === null || (candidate.task_class ?? 'other') === taskClass));
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// Peter J. Acklam's rational approximation, sufficient for evaluation quantiles.
function inverseNormalCdf(probability) {
  const p = clamp(probability, Number.EPSILON, 1 - Number.EPSILON);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143,
    3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function fitLogNormal(durations, clampSigma) {
  if (!durations.length) return null;
  const logs = durations.filter((value) => value > 0).map(Math.log);
  if (!logs.length) return null;
  const mu = mean(logs);
  const variance = mean(logs.map((value) => (value - mu) ** 2)) ?? 0;
  const rawSigma = logs.length < 3 ? 0.65 : Math.sqrt(variance) + 0.12;
  return {
    mu,
    sigma: clampSigma ? clamp(rawSigma, 0.28, 0.9) : clamp(rawSigma, 0.12, 2.5),
    rawSigma,
  };
}

function conditionalLogNormalPrediction(durations, elapsed, clampSigma) {
  const fit = fitLogNormal(durations, clampSigma);
  if (!fit) return null;
  const lowerCdf = elapsed > 0
    ? normalCdf((Math.log(elapsed) - fit.mu) / fit.sigma)
    : 0;
  const remainingAt = (probability) => {
    const conditionalProbability = lowerCdf + probability * Math.max(Number.EPSILON, 1 - lowerCdf);
    const total = Math.exp(fit.mu + fit.sigma * inverseNormalCdf(conditionalProbability));
    return Math.max(0.05, total - elapsed);
  };
  return {
    lower: remainingAt(0.2),
    p50: remainingAt(0.5),
    p80: remainingAt(0.8),
    rawSigma: fit.rawSigma,
    appliedSigma: fit.sigma,
  };
}

function conditionalEmpiricalPrediction(durations, elapsed) {
  const survivors = durations.filter((duration) => duration > elapsed)
    .map((duration) => duration - elapsed);
  if (!survivors.length) return null;
  return {
    lower: quantile(survivors, 0.2),
    p50: median(survivors),
    p80: quantile(survivors, 0.8),
    survivorCount: survivors.length,
  };
}

function historicalMedianPrediction(durations, elapsed) {
  const positive = durations.filter((duration) => Number.isFinite(duration) && duration > 0);
  if (!positive.length) return null;
  const remainingAt = (probability) => Math.max(0.05, quantile(positive, probability) - elapsed);
  return {
    lower: remainingAt(0.2),
    p50: remainingAt(0.5),
    p80: remainingAt(0.8),
  };
}

function estimatorPrediction(forecast) {
  return Number.isFinite(forecast?.p50Minutes) ? {
    lower: finite(forecast.lowerMinutes),
    p50: finite(forecast.p50Minutes),
    p80: finite(forecast.p80Minutes),
  } : null;
}

function fallbackState(state) {
  return {
    ...structuredClone(state),
    steps: [],
    currentStep: null,
    planRevision: 0,
    initialStepCount: null,
  };
}

function rawRows(database, outcomes) {
  const rows = [];
  let excludedWaitingLandmarks = 0;
  let excludedUnobservedLandmarks = 0;
  for (const outcome of outcomes) {
    const started = Date.parse(outcome.started_at);
    const finished = Date.parse(outcome.finished_at);
    const events = eventsFor(database, outcome.run_id);
    for (const fraction of LANDMARK_FRACTIONS) {
      const landmarkMs = started + (finished - started) * fraction;
      const landmarkAt = new Date(landmarkMs).toISOString();
      const state = stateAt(outcome, events, landmarkAt);
      if (!state) {
        excludedUnobservedLandmarks += 1;
        continue;
      }
      if (Boolean(state.needsInput) || WAITING_STATUSES.has(String(state.status ?? ''))) {
        excludedWaitingLandmarks += 1;
        continue;
      }
      const allHistoryRows = historyBefore(outcomes, landmarkAt);
      const taskHistoryRows = historyBefore(outcomes, landmarkAt, outcome.task_class ?? 'other');
      const allDurations = allHistoryRows.map((row) => Number(row.outcome_minutes));
      const taskDurations = taskHistoryRows.map((row) => Number(row.outcome_minutes));
      const elapsed = activeElapsedMinutes(state, landmarkAt);
      const productionFallback = forecastRun({
        state: fallbackState(state),
        history: allHistoryRows.map(historyRow),
        now: new Date(landmarkAt),
        seed: `midrun:fixed:${outcome.run_id}:${fraction}`,
      });
      const plan = Array.isArray(state.steps) && state.steps.length
        ? forecastRun({
            state,
            history: allHistoryRows.map(historyRow),
            now: new Date(landmarkAt),
            seed: `midrun:plan:${outcome.run_id}:${fraction}`,
          })
        : null;
      rows.push({
        privateRunKey: outcome.run_id,
        fraction,
        landmarkAt,
        finishedAt: outcome.finished_at,
        terminalObservedAt: outcome.terminal_observed_at,
        actualRemainingMinutes: Math.max(0, (finished - landmarkMs) / MINUTE_MS),
        predictions: {
          global_median: historicalMedianPrediction(allDurations, elapsed),
          task_median: historicalMedianPrediction(taskDurations, elapsed),
          fixed_clamp: estimatorPrediction(productionFallback),
          unclamped: conditionalLogNormalPrediction(allDurations, elapsed, false),
          empirical_heavy_tail: conditionalEmpiricalPrediction(allDurations, elapsed),
          plan_conditioned: estimatorPrediction(plan),
        },
      });
    }
  }
  return { rows, excludedWaitingLandmarks, excludedUnobservedLandmarks };
}

function addTimeForwardCalibration(rows) {
  const variants = ['fixed_clamp', 'unclamped', 'empirical_heavy_tail'];
  for (const row of rows) {
    for (const method of variants) {
      const prior = rows.filter((candidate) =>
        candidate.fraction === row.fraction
        && Date.parse(candidate.finishedAt) < Date.parse(row.landmarkAt)
        && Date.parse(candidate.terminalObservedAt) < Date.parse(row.landmarkAt)
        && Number.isFinite(candidate.predictions[method]?.p80));
      const calibration = estimateP80Calibration(prior.map((candidate) => ({
        actualRemainingMinutes: candidate.actualRemainingMinutes,
        rawP80Minutes: candidate.predictions[method].p80,
      })));
      const calibrated = calibrateForecastP80({
        status: 'forecast',
        p50Minutes: row.predictions[method]?.p50,
        p80Minutes: row.predictions[method]?.p80,
        lowerMinutes: row.predictions[method]?.lower,
        raw: {},
      }, calibration);
      row.predictions[`calibrated_${method}`] = estimatorPrediction(calibrated);
      row.calibrations ??= {};
      row.calibrations[method] = calibration;
    }
  }
}

function methodMetrics(rows, method) {
  const eligible = rows.filter((row) => Number.isFinite(row.predictions[method]?.p50));
  const errors = eligible.map((row) =>
    Math.abs(row.predictions[method].p50 - row.actualRemainingMinutes));
  const p80Rows = eligible.filter((row) => Number.isFinite(row.predictions[method]?.p80));
  const p80Covered = p80Rows.filter((row) =>
    row.actualRemainingMinutes <= row.predictions[method].p80).length;
  return {
    status: eligible.length ? 'available' : 'unavailable',
    eligibleLandmarks: eligible.length,
    eligibleRuns: new Set(eligible.map((row) => row.privateRunKey)).size,
    missingLandmarks: rows.length - eligible.length,
    meanAbsoluteErrorMinutes: mean(errors),
    medianAbsoluteErrorMinutes: median(errors),
    severeUnderestimateRate: eligible.length
      ? eligible.filter((row) => row.predictions[method].p50 < row.actualRemainingMinutes * 0.5).length / eligible.length
      : null,
    p80Coverage: p80Rows.length ? p80Covered / p80Rows.length : null,
    p80CoverageWilson95: wilsonInterval(p80Covered, p80Rows.length),
    p80CoverageLandmarks: p80Rows.length,
    completionClockVolatilityMinutes: completionClockVolatility(eligible, method),
  };
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z ** 2) / total;
  const center = (proportion + (z ** 2) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + (z ** 2) / (4 * total)) / total,
  ) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function completionClockVolatility(rows, method) {
  const grouped = Map.groupBy(rows, (row) => row.privateRunKey);
  const drifts = [];
  for (const runRows of grouped.values()) {
    const clocks = runRows.toSorted((left, right) => left.fraction - right.fraction)
      .map((row) => Date.parse(row.landmarkAt) / MINUTE_MS + row.predictions[method].p50);
    for (let index = 1; index < clocks.length; index += 1) {
      drifts.push(Math.abs(clocks[index] - clocks[index - 1]));
    }
  }
  return median(drifts);
}

function pairedBootstrap(rows, baseline, candidate, samples, seed) {
  const paired = rows.filter((row) =>
    Number.isFinite(row.predictions[baseline]?.p50)
    && Number.isFinite(row.predictions[candidate]?.p50));
  const grouped = [...Map.groupBy(paired, (row) => row.privateRunKey).values()];
  if (!grouped.length || samples <= 0) {
    return { status: 'unavailable', pairedRuns: grouped.length, samples: 0 };
  }
  const random = mulberry32(seed);
  const gains = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const chosen = Array.from({ length: grouped.length }, () =>
      grouped[Math.floor(random() * grouped.length)]).flat();
    const baselineError = mean(chosen.map((row) =>
      Math.abs(row.predictions[baseline].p50 - row.actualRemainingMinutes)));
    const candidateError = mean(chosen.map((row) =>
      Math.abs(row.predictions[candidate].p50 - row.actualRemainingMinutes)));
    gains.push(baselineError - candidateError);
  }
  return {
    status: 'available',
    pairedRuns: grouped.length,
    samples,
    gainDefinition: `${baseline} MAE minus ${candidate} MAE`,
    medianMaeGainMinutes: median(gains),
    interval95: [quantile(gains, 0.025), quantile(gains, 0.975)],
    probabilityCandidateBeatsBaseline: gains.filter((gain) => gain > 0).length / gains.length,
  };
}

function provisionalWinner(metrics) {
  const candidates = [
    'calibrated_fixed_clamp',
    'calibrated_unclamped',
    'calibrated_empirical_heavy_tail',
  ].filter((method) => metrics[method].status === 'available');
  if (!candidates.length) return null;
  return candidates.toSorted((left, right) => {
    const a = metrics[left];
    const b = metrics[right];
    return Math.abs((a.p80Coverage ?? 0) - 0.8) - Math.abs((b.p80Coverage ?? 0) - 0.8)
      || (a.severeUnderestimateRate ?? 1) - (b.severeUnderestimateRate ?? 1)
      || (a.medianAbsoluteErrorMinutes ?? Infinity) - (b.medianAbsoluteErrorMinutes ?? Infinity)
      || (a.completionClockVolatilityMinutes ?? Infinity) - (b.completionClockVolatilityMinutes ?? Infinity)
      || candidates.indexOf(left) - candidates.indexOf(right);
  })[0];
}

function experimentVerdict(metrics, winner) {
  if (!winner) return { status: 'unavailable', gates: null };
  const candidate = metrics[winner];
  const baseline = metrics.global_median;
  const gates = {
    p80PointWithin075To085: Number.isFinite(candidate.p80Coverage)
      && candidate.p80Coverage >= 0.75
      && candidate.p80Coverage <= 0.85,
    severeUnderNoWorseThanGlobalMedian: Number.isFinite(candidate.severeUnderestimateRate)
      && Number.isFinite(baseline.severeUnderestimateRate)
      && candidate.severeUnderestimateRate <= baseline.severeUnderestimateRate,
    medianAbsoluteErrorAtLeast15PercentBetter: Number.isFinite(candidate.medianAbsoluteErrorMinutes)
      && Number.isFinite(baseline.medianAbsoluteErrorMinutes)
      && candidate.medianAbsoluteErrorMinutes <= baseline.medianAbsoluteErrorMinutes * 0.85,
  };
  return {
    status: Object.values(gates).every(Boolean)
      ? 'provisional_arm_passes_in_sample_gates'
      : 'no_arm_passes_all_in_sample_gates',
    gates,
  };
}

export function evaluateMidrunDatabase(filename, {
  bootstrapSamples = 2_000,
  generatedAt = new Date().toISOString(),
} = {}) {
  return withReadSnapshot(filename, (database) => {
    const outcomes = selectedOutcomes(database);
    const { rows, excludedWaitingLandmarks, excludedUnobservedLandmarks } = rawRows(database, outcomes);
    addTimeForwardCalibration(rows);
    const metrics = Object.fromEntries(METHODS.map((method) => [method, methodMetrics(rows, method)]));
    const byFraction = Object.fromEntries(LANDMARK_FRACTIONS.map((fraction, fractionIndex) => {
      const fractionRows = rows.filter((row) => row.fraction === fraction);
      const methods = Object.fromEntries(METHODS.map((method) => [
        method,
        methodMetrics(fractionRows, method),
      ]));
      return [String(fraction), {
        fraction,
        landmarks: fractionRows.length,
        methods,
        pairedFixedAgainstGlobalMedian: pairedBootstrap(
          fractionRows,
          'global_median',
          'calibrated_fixed_clamp',
          bootstrapSamples,
          0x7d1d0000 + fractionIndex * 101,
        ),
      }];
    }));
    const paired = Object.fromEntries([
      'calibrated_fixed_clamp',
      'calibrated_unclamped',
      'calibrated_empirical_heavy_tail',
    ].map((method, index) => [method, pairedBootstrap(
      rows,
      'global_median',
      method,
      bootstrapSamples,
      0x6d1d0000 + index * 101,
    )]));
    const winner = provisionalWinner(metrics);
    const verdict = experimentVerdict(metrics, winner);
    return {
      generatedAt,
      dataset: 'local privacy-minimized Codex turn/run proxy outcomes',
      simulated: false,
      targetRuns: outcomes.length,
      landmarkFractions: LANDMARK_FRACTIONS,
      eligibleLandmarks: rows.length,
      excludedWaitingLandmarks,
      excludedUnobservedLandmarks,
      temporalProtocol: {
        databaseReadSnapshot: 'single read transaction',
        historyRule: 'source finished_at and terminal observed_at must both be strictly earlier than target landmark_at',
        observationRule: 'target events and source terminal signals must also have observed_at strictly no later than the landmark',
        targetLandmarks: '25%, 50%, and 75% of final wall duration; final duration selects the audit landmark but is never an estimator input',
        waitingRule: 'open needs_input/provider/blocked/paused landmarks have no completion-clock forecast and are excluded',
        bootstrapUnit: 'run block; all landmarks from a sampled run move together',
        bootstrapSamples,
      },
      methods: metrics,
      methodDefinitions: {
        global_median: 'historical global total-duration quantiles minus active elapsed; no survival conditioning',
        task_median: 'same historical median baseline restricted to task_class; currently identical because every live class is other',
        fixed_clamp: 'production run-level conditional log-normal survival with sigma clamped to 0.28–0.90',
        unclamped: 'audit conditional log-normal survival with sigma allowed up to 2.50',
        empirical_heavy_tail: 'non-parametric conditional survivor residual quantiles',
        plan_conditioned: 'production plan-conditioned estimator when a plan is observable at the landmark',
      },
      landmarkBreakdown: byFraction,
      pairedAgainstGlobalMedian: paired,
      sigmaExperiment: {
        status: verdict.status,
        provisionalWinner: winner,
        inSampleGates: verdict.gates,
        priority: 'P80 distance to 0.8, then severe-underestimate, median AE, volatility, then simpler fixed model',
        productionEstimatorChanged: false,
        heldOutGate: '30 new comparable runs provisional; 50 runs and paired interval above zero before changing production',
      },
      limitations: [
        'All live task_class values are currently other, so task and global baselines are not independent evidence.',
        'Landmark fractions are selected retrospectively from final wall duration; predictions use only state and outcomes observable at the landmark.',
        'Successful Codex lifecycle records are turn/run proxies, not labelled human tasks or projects.',
        'This experiment does not predict open external or human waiting time.',
      ],
      privacy: {
        aggregateOnly: true,
        nativeIdentifiersEmitted: false,
        filesystemPathsEmitted: false,
        contentEmitted: false,
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

export function midrunEvaluationMarkdown(report) {
  const lines = [
    '# Agent ETA mid-run time-forward evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '> Real local privacy-minimized turn/run proxy outcomes. No prompt, code, command, native identifier, or filesystem path is emitted.',
    '',
    `Evaluated ${report.targetRuns} runs at 25% / 50% / 75% wall-duration audit landmarks (${report.eligibleLandmarks} eligible; ${report.excludedWaitingLandmarks} open-wait and ${report.excludedUnobservedLandmarks} not-yet-observable landmarks excluded).`,
    '',
    '| Method | Landmarks | Runs | MAE | Median AE | Severe under | P80 coverage | Clock volatility |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [name, metrics] of Object.entries(report.methods)) {
    lines.push(`| ${name} | ${metrics.eligibleLandmarks} | ${metrics.eligibleRuns} | ${minutes(metrics.meanAbsoluteErrorMinutes)} | ${minutes(metrics.medianAbsoluteErrorMinutes)} | ${percentage(metrics.severeUnderestimateRate)} | ${percentage(metrics.p80Coverage)} | ${minutes(metrics.completionClockVolatilityMinutes)} |`);
  }
  lines.push(
    '',
    '## Sigma experiment verdict',
    '',
    `Status: **${report.sigmaExperiment.status}**. Best in-sample arm: **${report.sigmaExperiment.provisionalWinner ?? 'unavailable'}**. Production estimator changed: **no**.`,
    '',
    'This report is an experiment, not permission to tune on the same cohort. The selected arm must still pass the stated held-out 30/50-run gate.',
    '',
    '## 50% elapsed landmark',
    '',
    `At the 50% landmark, calibrated fixed-clamp median AE is ${minutes(report.landmarkBreakdown['0.5'].methods.calibrated_fixed_clamp.medianAbsoluteErrorMinutes)} minutes versus ${minutes(report.landmarkBreakdown['0.5'].methods.global_median.medianAbsoluteErrorMinutes)} for global median. Its paired MAE-gain 95% interval is ${report.landmarkBreakdown['0.5'].pairedFixedAgainstGlobalMedian.interval95?.map(minutes).join(' to ') ?? 'unavailable'}.`,
    '',
    '## Limitations',
    '',
    ...report.limitations.map((item) => `- ${item}`),
    '',
  );
  return lines.join('\n');
}
