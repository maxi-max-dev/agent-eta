import { withReadSnapshot } from './database.js';

const MINUTE_MS = 60_000;
const DEFAULT_BOOTSTRAP_SAMPLES = 2_000;
const DEFAULT_SEED = 0x0e7a2026;
const P80_TARGET = 0.8;
const DEFAULT_MINIMUM_VOLATILITY_SCOPES = 30;
const EVIDENCE_STATUSES = new Set(['unavailable', 'contract_only', 'provider_shadow']);
const TARGET_PROVENANCE_STATUSES = new Set([
  'not_provided',
  'not_applicable',
  'live',
  'backfill_only',
  'no_causal_receipt',
  'unavailable_legacy_column',
]);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestamp(value, code) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(code);
  return milliseconds;
}

function normalizedTaskClass(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  return ['other', 'unknown'].includes(normalized.toLowerCase()) ? null : normalized;
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

function mean(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length
    ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
    : null;
}

function nonnegativeInteger(value, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(code);
  return number;
}

function nonnegativeValues(value, code) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(code);
  return value.map((entry) => {
    const number = finite(entry);
    if (number === null) throw new TypeError(code);
    return number;
  });
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

function wilson95(successes, trials) {
  if (!Number.isInteger(trials) || trials < 1) return null;
  const z = 1.959963984540054;
  const proportion = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (proportion + (z * z) / (2 * trials)) / denominator;
  const halfWidth = z * Math.sqrt(
    (proportion * (1 - proportion) + (z * z) / (4 * trials)) / trials,
  ) / denominator;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

function normalizePrediction(value, { allowMode = false } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PILOT_INVALID_PREDICTION');
  }
  const p50 = finite(value.p50);
  const p80 = finite(value.p80);
  if (p50 === null || (p80 !== null && p80 < p50)) {
    throw new TypeError('PILOT_INVALID_PREDICTION');
  }
  const mode = allowMode && typeof value.mode === 'string' ? value.mode : null;
  return { p50, p80, mode };
}

function normalizeRows(inputRows) {
  if (!Array.isArray(inputRows)) throw new TypeError('PILOT_ROWS_REQUIRED');
  const keys = new Set();
  return inputRows.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('PILOT_INVALID_ROW');
    }
    const scopeType = input.scopeType;
    if (scopeType !== 'task' && scopeType !== 'project') {
      throw new TypeError('PILOT_INVALID_SCOPE_TYPE');
    }
    const scopeKey = typeof input.scopeKey === 'string' && input.scopeKey
      ? input.scopeKey
      : `${scopeType}:${index}`;
    const uniqueKey = `${scopeType}:${scopeKey}`;
    if (keys.has(uniqueKey)) throw new TypeError('PILOT_DUPLICATE_SCOPE_SAMPLE');
    keys.add(uniqueKey);

    const startedAtMs = timestamp(input.startedAt, 'PILOT_INVALID_START_TIME');
    const finishedAtMs = timestamp(input.finishedAt, 'PILOT_INVALID_FINISH_TIME');
    const landmarkAtMs = input.landmarkAt === null || input.landmarkAt === undefined
      ? null
      : timestamp(input.landmarkAt, 'PILOT_INVALID_LANDMARK_TIME');
    const terminalReceivedAtMs = timestamp(
      input.terminalReceivedAt ?? input.finishedAt,
      'PILOT_INVALID_TERMINAL_RECEIPT_TIME',
    );
    if (finishedAtMs <= startedAtMs || (landmarkAtMs !== null
      && (landmarkAtMs < startedAtMs || finishedAtMs <= landmarkAtMs))) {
      throw new TypeError('PILOT_INVALID_TIME_ORDER');
    }
    if (terminalReceivedAtMs < finishedAtMs) {
      throw new TypeError('PILOT_TERMINAL_RECEIPT_PRECEDES_FINISH');
    }
    const derivedActual = landmarkAtMs === null
      ? null
      : (finishedAtMs - landmarkAtMs) / MINUTE_MS;
    const suppliedActual = finite(input.actualRemainingMinutes);
    if (suppliedActual !== null && (derivedActual === null
      || Math.abs(suppliedActual - derivedActual) > 1e-6)) {
      throw new TypeError('PILOT_ACTUAL_TIME_MISMATCH');
    }
    const taskClass = normalizedTaskClass(input.taskClass);
    const scopeForecast = normalizePrediction(input.scopeForecast, { allowMode: true });
    if (scopeForecast !== null && landmarkAtMs === null) {
      throw new TypeError('PILOT_FORECAST_REQUIRES_LANDMARK');
    }
    const waitContaminated = input.waitContaminated === true;
    const targetProvenanceStatus = input.targetProvenanceStatus ?? 'not_provided';
    if (!TARGET_PROVENANCE_STATUSES.has(targetProvenanceStatus)) {
      throw new TypeError('PILOT_INVALID_TARGET_PROVENANCE');
    }
    const completionClockShiftsMinutes = nonnegativeValues(
      input.completionClockShiftsMinutes,
      'PILOT_INVALID_COMPLETION_CLOCK_SHIFTS',
    );
    const minimumObservedSnapshots = scopeForecast === null
      ? completionClockShiftsMinutes.length + (completionClockShiftsMinutes.length ? 1 : 0)
      : Math.max(1, completionClockShiftsMinutes.length + 1);
    const completionClockSnapshotsObserved = input.completionClockSnapshotsObserved === undefined
      ? minimumObservedSnapshots
      : nonnegativeInteger(
          input.completionClockSnapshotsObserved,
          'PILOT_INVALID_COMPLETION_CLOCK_SNAPSHOT_COUNT',
        );
    if (completionClockSnapshotsObserved < minimumObservedSnapshots) {
      throw new TypeError('PILOT_INVALID_COMPLETION_CLOCK_SNAPSHOT_COUNT');
    }
    return {
      scopeKey,
      scopeType,
      startedAtMs,
      landmarkAtMs,
      finishedAtMs,
      terminalReceivedAtMs,
      actualRemainingMinutes: derivedActual,
      totalOutcomeMinutes: (finishedAtMs - startedAtMs) / MINUTE_MS,
      taskClass,
      scopeForecast,
      modelSelfEta: normalizePrediction(input.modelSelfEta),
      outcomeEligible: input.outcomeEligible !== false,
      targetSourceEligible: input.targetSourceEligible !== false,
      targetProvenanceStatus,
      waitContaminated,
      outcomeWaitContaminated: input.outcomeWaitContaminated === undefined
        ? waitContaminated
        : input.outcomeWaitContaminated === true,
      completionClockShiftsMinutes,
      completionClockSnapshotsObserved,
      completionClockStructuralTransitionsExcluded: nonnegativeInteger(
        input.completionClockStructuralTransitionsExcluded ?? 0,
        'PILOT_INVALID_COMPLETION_CLOCK_EXCLUSION_COUNT',
      ),
      completionClockWaitingTransitionsExcluded: nonnegativeInteger(
        input.completionClockWaitingTransitionsExcluded ?? 0,
        'PILOT_INVALID_COMPLETION_CLOCK_EXCLUSION_COUNT',
      ),
      historicalGlobalMedian: null,
      historicalTaskClassMedian: null,
      historicalReference: null,
    };
  });
}

function historicalPrediction(history, target) {
  const elapsed = (target.landmarkAtMs - target.startedAtMs) / MINUTE_MS;
  const remaining = history
    .map((candidate) => candidate.totalOutcomeMinutes)
    .filter((duration) => duration > elapsed)
    .map((duration) => duration - elapsed);
  if (!remaining.length) return null;
  return {
    p50: quantile(remaining, 0.5),
    p80: quantile(remaining, 0.8),
    mode: 'historical_conditional_survival',
  };
}

function attachTimeForwardBaselines(rows) {
  let overlappingPotentialHistoryExcluded = 0;
  let lateTerminalReceiptExcluded = 0;
  const outcomeLibrary = rows.filter((candidate) =>
    candidate.outcomeEligible && !candidate.outcomeWaitContaminated);
  const targets = rows.filter((target) =>
    target.landmarkAtMs !== null
    && target.scopeForecast !== null
    && target.targetSourceEligible);
  for (const target of targets) {
    const sameScope = outcomeLibrary.filter((candidate) =>
      candidate.scopeType === target.scopeType
      && candidate.scopeKey !== target.scopeKey);
    const potentialHistory = sameScope.filter((candidate) =>
      candidate.startedAtMs < target.landmarkAtMs);
    overlappingPotentialHistoryExcluded += potentialHistory.filter((candidate) =>
      candidate.finishedAtMs >= target.landmarkAtMs).length;
    lateTerminalReceiptExcluded += potentialHistory.filter((candidate) =>
      candidate.finishedAtMs < target.landmarkAtMs
      && candidate.terminalReceivedAtMs >= target.landmarkAtMs).length;
    const globalHistory = sameScope.filter((candidate) =>
      candidate.finishedAtMs < target.landmarkAtMs
      && candidate.terminalReceivedAtMs < target.landmarkAtMs);
    target.historicalGlobalMedian = historicalPrediction(globalHistory, target);
    const taskHistory = target.taskClass === null
      ? []
      : globalHistory.filter((candidate) => candidate.taskClass === target.taskClass);
    target.historicalTaskClassMedian = historicalPrediction(taskHistory, target);
    target.historicalReference = target.historicalTaskClassMedian ?? target.historicalGlobalMedian;
  }
  return { overlappingPotentialHistoryExcluded, lateTerminalReceiptExcluded };
}

function predictionFor(row, method) {
  if (method === 'historical_global_median') return row.historicalGlobalMedian;
  if (method === 'historical_task_class_median') return row.historicalTaskClassMedian;
  if (method === 'historical_reference') return row.historicalReference;
  if (method === 'model_self_eta') return row.modelSelfEta;
  if (method === 'scope_primary') return row.scopeForecast;
  if (method === 'scope_fallback') {
    return row.scopeForecast?.mode === 'workset_parent_survival' ? row.scopeForecast : null;
  }
  if (method === 'scope_aggregation') {
    return row.scopeForecast?.mode === 'workset_aggregate' ? row.scopeForecast : null;
  }
  throw new TypeError('PILOT_UNKNOWN_METHOD');
}

function methodSummary(rows, method, scopeType) {
  const comparable = rows.flatMap((row) => {
    const prediction = predictionFor(row, method);
    return prediction === null ? [] : [{ row, prediction }];
  });
  const absoluteErrors = comparable.map(({ row, prediction }) =>
    Math.abs(prediction.p50 - row.actualRemainingMinutes));
  const p80Rows = comparable.filter(({ prediction }) => prediction.p80 !== null);
  const covered = p80Rows.filter(({ row, prediction }) =>
    row.actualRemainingMinutes <= prediction.p80).length;
  const interval95 = wilson95(covered, p80Rows.length);
  const severeUnderestimates = comparable.filter(({ row, prediction }) =>
    prediction.p50 < row.actualRemainingMinutes * 0.5).length;
  return {
    status: comparable.length ? 'available' : 'unavailable',
    eligibleScopes: comparable.length,
    missingPredictions: rows.length - comparable.length,
    meanAbsoluteErrorMinutes: mean(absoluteErrors),
    medianAbsoluteErrorMinutes: quantile(absoluteErrors, 0.5),
    severeUnderestimateRate: comparable.length
      ? severeUnderestimates / comparable.length
      : null,
    severeUnderestimatedScopes: severeUnderestimates,
    severeUnderestimateInterval95: wilson95(severeUnderestimates, comparable.length),
    severeUnderestimateDefinition: 'saved P50 is less than 50% of actual remaining minutes',
    p80Coverage: p80Rows.length ? covered / p80Rows.length : null,
    p80CoveredScopes: p80Rows.length ? covered : 0,
    p80EvaluatedScopes: p80Rows.length,
    p80CoverageInterval95: interval95,
    p80IntervalMethod: 'wilson_score_scope_level',
    resamplingUnit: scopeType,
  };
}

function completionClockVolatility(rows, options) {
  const eligibleRows = rows.filter((row) => row.completionClockShiftsMinutes.length > 0);
  const shifts = eligibleRows.flatMap((row) => row.completionClockShiftsMinutes);
  const perScopeMedianShifts = eligibleRows.map((row) =>
    quantile(row.completionClockShiftsMinutes, 0.5));
  const thresholdDeclared = options.volatilityThresholdMinutes !== null;
  const enoughScopes = eligibleRows.length >= options.minimumVolatilityScopes;
  const medianShift = quantile(perScopeMedianShifts, 0.5);
  const thresholdMet = thresholdDeclared
    && medianShift !== null
    && medianShift <= options.volatilityThresholdMinutes;
  return {
    status: shifts.length ? 'available' : 'unavailable',
    definition: 'median absolute completion-clock shift is computed within each scope, then scope medians are summarized across independent scopes',
    resamplingUnit: rows[0]?.scopeType ?? null,
    scopeSummarization: 'per_scope_median_then_across_scope',
    scopeTargets: rows.length,
    scopesWithTransitions: eligibleRows.length,
    scopesWithOnlyFirstForecast: rows.filter((row) =>
      row.completionClockSnapshotsObserved === 1
      && row.completionClockShiftsMinutes.length === 0).length,
    numericSnapshotsObserved: rows.reduce(
      (sum, row) => sum + row.completionClockSnapshotsObserved,
      0,
    ),
    eligibleTransitions: shifts.length,
    transitionCountDiagnosticOnly: true,
    structuralTransitionsExcluded: rows.reduce(
      (sum, row) => sum + row.completionClockStructuralTransitionsExcluded,
      0,
    ),
    waitingTransitionsExcluded: rows.reduce(
      (sum, row) => sum + row.completionClockWaitingTransitionsExcluded,
      0,
    ),
    medianAbsoluteShiftMinutes: medianShift,
    p80AbsoluteShiftMinutes: quantile(perScopeMedianShifts, 0.8),
    unclassifiedStructuralChangeLimitation: 'only observable workset revisions and waiting transitions can be excluded',
    gate: {
      p1RequiredForNumericEtaDecision: true,
      metric: 'median_of_scope_median_absolute_completion_clock_shift_minutes',
      minimumScopes: options.minimumVolatilityScopes,
      enoughScopes,
      maximumMinutes: options.volatilityThresholdMinutes,
      thresholdDeclared,
      thresholdMet,
      readyForDecision: enoughScopes && thresholdDeclared,
      pass: enoughScopes && thresholdMet,
    },
  };
}

function pairedGain(rows, baselineMethod, scopeType, bootstrapSamples, seed) {
  const paired = rows.flatMap((row) => {
    const candidate = predictionFor(row, 'scope_primary');
    const baseline = predictionFor(row, baselineMethod);
    if (candidate === null || baseline === null) return [];
    const candidateError = Math.abs(candidate.p50 - row.actualRemainingMinutes);
    const baselineError = Math.abs(baseline.p50 - row.actualRemainingMinutes);
    return [{ gain: baselineError - candidateError }];
  });
  const point = mean(paired.map((row) => row.gain));
  if (!paired.length || bootstrapSamples === 0) {
    return {
      pairedScopes: paired.length,
      meanAbsoluteErrorGainMinutes: point,
      interval95: null,
      bootstrapSamples,
      resamplingUnit: scopeType,
      intervalEntirelyAboveZero: false,
    };
  }
  const random = mulberry32(seed);
  const gains = [];
  for (let sample = 0; sample < bootstrapSamples; sample += 1) {
    const selected = Array.from({ length: paired.length }, () =>
      paired[Math.floor(random() * paired.length)]);
    gains.push(mean(selected.map((row) => row.gain)));
  }
  const interval95 = [quantile(gains, 0.025), quantile(gains, 0.975)];
  return {
    pairedScopes: paired.length,
    meanAbsoluteErrorGainMinutes: point,
    interval95,
    bootstrapSamples,
    resamplingUnit: scopeType,
    intervalEntirelyAboveZero: interval95[0] > 0,
  };
}

function stageFor(size) {
  if (size < 30) return 'insufficient';
  if (size < 50) return 'provisional';
  return 'decision';
}

function evaluateScope(rows, scopeType, options) {
  const scoped = rows.filter((row) => row.scopeType === scopeType);
  const outcomeLibrary = scoped.filter((row) => row.outcomeEligible && !row.outcomeWaitContaminated);
  const outcomeWaitContaminated = scoped.filter((row) =>
    row.outcomeEligible && row.outcomeWaitContaminated);
  const causalTargets = scoped.filter((row) =>
    row.landmarkAtMs !== null
    && row.scopeForecast !== null
    && row.targetSourceEligible);
  const waitContaminated = causalTargets.filter((row) => row.waitContaminated);
  const targets = causalTargets.filter((row) => !row.waitContaminated);
  const numericForecastRows = scoped.filter((row) =>
    row.landmarkAtMs !== null && row.scopeForecast !== null);
  const backfillNumericTargetsExcluded = numericForecastRows.filter((row) =>
    row.targetProvenanceStatus === 'backfill_only').length;
  const legacyProvenanceNumericTargetsExcluded = numericForecastRows.filter((row) =>
    row.targetProvenanceStatus === 'unavailable_legacy_column').length;
  const noCausalReceiptNumericTargetsExcluded = numericForecastRows.filter((row) =>
    row.targetProvenanceStatus === 'no_causal_receipt').length;
  const methods = Object.fromEntries([
    'historical_global_median',
    'historical_task_class_median',
    'historical_reference',
    'model_self_eta',
    'scope_fallback',
    'scope_aggregation',
    'scope_primary',
  ].map((method) => [method, methodSummary(targets, method, scopeType)]));
  const pairedReference = pairedGain(
    targets,
    'historical_reference',
    scopeType,
    options.bootstrapSamples,
    options.seed + (scopeType === 'task' ? 0x1451 : 0x2903),
  );
  const pairedTaskClass = pairedGain(
    targets,
    'historical_task_class_median',
    scopeType,
    options.bootstrapSamples,
    options.seed + (scopeType === 'task' ? 0x3451 : 0x4903),
  );
  const pairedGlobal = pairedGain(
    targets,
    'historical_global_median',
    scopeType,
    options.bootstrapSamples,
    options.seed + (scopeType === 'task' ? 0x5451 : 0x6903),
  );
  const stage = stageFor(targets.length);
  const primary = methods.scope_primary;
  const volatility = completionClockVolatility(targets, options);
  const p80IntervalSupportsTarget = primary.p80CoverageInterval95?.[0] >= P80_TARGET;
  const p80HasEnoughScopes = primary.p80EvaluatedScopes >= 30;
  const classComparisonHasEnoughPairs = pairedTaskClass.pairedScopes >= 30;
  const classAccuracySupportsCandidate = pairedTaskClass.intervalEntirelyAboveZero;
  const accuracyEvidenceReady = classComparisonHasEnoughPairs && p80HasEnoughScopes;
  const accuracyGatesPass = accuracyEvidenceReady
    && classAccuracySupportsCandidate
    && p80IntervalSupportsTarget;
  const evidenceStatus = options.evidenceByScope[scopeType];
  const evidenceIsLive = evidenceStatus === 'provider_shadow';
  const decisionPass = stage === 'decision'
    && evidenceIsLive
    && accuracyGatesPass
    && volatility.gate.pass;

  let verdict;
  let recommendation;
  if (evidenceStatus === 'unavailable') {
    verdict = 'unavailable';
    recommendation = 'status_only';
  } else if (!evidenceIsLive) {
    verdict = 'contract_only';
    recommendation = stage === 'decision' ? 'status_only' : 'continue_contract_validation';
  } else if (stage === 'insufficient') {
    verdict = 'insufficient';
    recommendation = 'continue_shadow_collection';
  } else if (stage === 'provisional') {
    verdict = 'provisional_no_accuracy_claim';
    recommendation = 'continue_shadow_collection';
  } else if (decisionPass) {
    verdict = 'numeric_eta_supported';
    recommendation = 'continue_numeric_eta';
  } else if (!accuracyEvidenceReady) {
    verdict = 'provisional_accuracy_evidence';
    recommendation = 'status_only';
  } else if (!accuracyGatesPass) {
    verdict = 'numeric_eta_falsified';
    recommendation = 'status_only';
  } else if (!volatility.gate.readyForDecision) {
    verdict = 'provisional_volatility_gate';
    recommendation = 'status_only';
  } else {
    verdict = 'numeric_eta_falsified';
    recommendation = 'status_only';
  }

  return {
    scope: scopeType,
    rawCompletedScopes: scoped.length,
    completedOutcomeScopes: outcomeLibrary.length,
    waitContaminatedOutcomesExcluded: outcomeWaitContaminated.length,
    completedScopeSamples: targets.length,
    causalNumericFirstForecasts: causalTargets.length,
    backfillNumericTargetsExcluded,
    legacyProvenanceNumericTargetsExcluded,
    noCausalReceiptNumericTargetsExcluded,
    waitContaminatedExcluded: waitContaminated.length,
    stage,
    evidenceStatus,
    verdict,
    recommendation,
    numericAccuracyWinClaimed: decisionPass,
    knownTaskClassScopes: targets.filter((row) => row.taskClass !== null).length,
    methods,
    pairedAgainstHistoricalReference: pairedReference,
    pairedAgainstHistoricalTaskClassMedian: pairedTaskClass,
    pairedAgainstHistoricalGlobalMedian: pairedGlobal,
    completionClockVolatility: volatility,
    gates: {
      minimumProvisionalSamples: 30,
      minimumDecisionSamples: 50,
      minimumClassSpecificPairedComparisons: 30,
      classSpecificPairedComparisonHasEnoughScopes: classComparisonHasEnoughPairs,
      classSpecificPairedAbsoluteErrorGainIntervalEntirelyAboveZero: classAccuracySupportsCandidate,
      pairedAbsoluteErrorGainIntervalEntirelyAboveZero: classAccuracySupportsCandidate,
      p80Target: P80_TARGET,
      minimumP80EvaluatedScopes: 30,
      p80HasEnoughScopes,
      p80CoverageIntervalLowerBoundMeetsTarget: p80IntervalSupportsTarget,
      accuracyEvidenceReady,
      accuracyGatesPass,
      completionClockVolatilityP1Required: true,
      completionClockVolatilityReady: volatility.gate.readyForDecision,
      completionClockVolatilityPass: volatility.gate.pass,
      providerOwnedShadowEvidenceRequired: true,
      providerOwnedShadowEvidencePresent: evidenceIsLive,
      allDecisionGatesPass: decisionPass,
    },
  };
}

function validateOptions({
  generatedAt = new Date().toISOString(),
  bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed = DEFAULT_SEED,
  evidenceStatus = 'contract_only',
  evidenceByScope = null,
  volatilityThresholdMinutes = null,
  minimumVolatilityScopes = DEFAULT_MINIMUM_VOLATILITY_SCOPES,
  simulated = false,
} = {}) {
  timestamp(generatedAt, 'PILOT_INVALID_GENERATED_TIME');
  if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 0) {
    throw new TypeError('PILOT_INVALID_BOOTSTRAP_SAMPLES');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new TypeError('PILOT_INVALID_SEED');
  }
  if (!EVIDENCE_STATUSES.has(evidenceStatus)) {
    throw new TypeError('PILOT_INVALID_EVIDENCE_STATUS');
  }
  if (evidenceByScope !== null
      && (typeof evidenceByScope !== 'object' || Array.isArray(evidenceByScope))) {
    throw new TypeError('PILOT_INVALID_SCOPE_EVIDENCE');
  }
  const explicitEvidence = evidenceByScope === null ? null : Object.fromEntries(
    ['task', 'project'].map((scopeType) => {
      const value = evidenceByScope[scopeType] ?? 'unavailable';
      if (!EVIDENCE_STATUSES.has(value)) throw new TypeError('PILOT_INVALID_SCOPE_EVIDENCE');
      return [scopeType, value];
    }),
  );
  const normalizedVolatilityThreshold = volatilityThresholdMinutes === null
    || volatilityThresholdMinutes === undefined
    ? null
    : finite(volatilityThresholdMinutes);
  if (volatilityThresholdMinutes !== null
      && volatilityThresholdMinutes !== undefined
      && normalizedVolatilityThreshold === null) {
    throw new TypeError('PILOT_INVALID_VOLATILITY_THRESHOLD');
  }
  const normalizedMinimumVolatilityScopes = nonnegativeInteger(
    minimumVolatilityScopes,
    'PILOT_INVALID_VOLATILITY_SCOPE_MINIMUM',
  );
  if (normalizedMinimumVolatilityScopes < 1) {
    throw new TypeError('PILOT_INVALID_VOLATILITY_SCOPE_MINIMUM');
  }
  return {
    generatedAt,
    bootstrapSamples,
    seed,
    evidenceStatus,
    evidenceByScope: explicitEvidence,
    volatilityThresholdMinutes: normalizedVolatilityThreshold,
    minimumVolatilityScopes: normalizedMinimumVolatilityScopes,
    simulated: Boolean(simulated),
  };
}

/**
 * Evaluate one terminal outcome per explicit scope. A row may omit its
 * landmark/forecast and still enter later history; only causal numeric rows
 * enter target scoring. `scopeKey` is used solely for deduplication and is
 * never returned in the report.
 */
export function evaluatePilotCohort(inputRows, inputOptions = {}) {
  const rows = normalizeRows(inputRows);
  const options = validateOptions(inputOptions);
  options.evidenceByScope ??= Object.fromEntries(['task', 'project'].map((scopeType) => [
    scopeType,
    rows.some((row) => row.scopeType === scopeType) ? options.evidenceStatus : 'unavailable',
  ]));
  const temporalDiagnostics = attachTimeForwardBaselines(rows);
  const task = evaluateScope(rows, 'task', options);
  const project = evaluateScope(rows, 'project', options);
  const evidenceValues = [task.evidenceStatus, project.evidenceStatus];
  const evidenceStatus = evidenceValues.every((value) => value === evidenceValues[0])
    ? evidenceValues[0]
    : 'mixed';
  const providerDecisionAvailable = [task, project].some((scope) =>
    scope.evidenceStatus === 'provider_shadow' && scope.stage === 'decision');
  return {
    generatedAt: new Date(options.generatedAt).toISOString(),
    status: evidenceValues.includes('provider_shadow')
      ? providerDecisionAvailable
        ? 'decision_available'
        : 'shadow_collecting'
      : evidenceValues.includes('contract_only')
      ? 'contract_only'
      : 'unavailable',
    simulated: options.simulated,
    evidenceStatus,
    evidenceByScope: { task: task.evidenceStatus, project: project.evidenceStatus },
    task,
    project,
    temporalProtocol: {
      landmark: 'first positive saved forecast after scope start and before owner terminal',
      outcomeLibrary: 'every trusted successful scope with a causally observed terminal, whether or not it had a numeric forecast',
      targetForecastCohort: 'trusted scopes with a causal numeric first forecast and no blocking wait between landmark and terminal',
      historyRule: 'same-scope-type and same-task-class outcome finished_at must be strictly earlier than target landmark_at',
      terminalReceiptRule: 'terminal received_at must also be strictly earlier than target landmark_at',
      overlappingScopesExcludedUntilFinished: true,
      oneSamplePerScope: true,
      snapshotsAndTurnsAreNeverIndependentSamples: true,
      resamplingUnits: { task: 'task', project: 'project' },
      bootstrapSamples: options.bootstrapSamples,
      fixedSeed: options.seed,
      p80CoverageDefinition: 'actual remaining minutes <= saved scope P80',
      p80Interval: '95% Wilson score interval over independent scopes',
      severeUnderestimateDefinition: 'saved P50 is less than 50% of actual remaining minutes',
      completionClockVolatilityDefinition: 'absolute change in predicted completion timestamp between consecutive causal numeric forecasts within one scope; structural revisions and waiting transitions are excluded when observable',
      completionClockVolatilityLimit: 'the gate first summarizes transitions within each scope so prolific scopes cannot dominate; hidden structural work may remain unclassified',
      waits: 'needs_input, waiting_provider, blocked, or paused after the landmark excludes the completion-clock target before scoring',
      temporalDiagnostics,
    },
    policy: {
      insufficient: 'fewer than 30 completed comparable scopes; collect only and make no accuracy claim',
      provisional: '30 to 49 completed scopes; report shadow metrics but make no accuracy claim',
      decision: '50 or more completed scopes; numeric ETA requires 30+ class-specific paired MAE comparisons with bootstrap CI entirely above zero, P80 Wilson lower bound at least 0.8, and the predeclared completion-clock-volatility P1 gate',
      failureAction: 'recommend status_only and retain state, waiting reason, and completion notification',
    },
    privacy: {
      aggregateOnly: true,
      identifiersEmitted: false,
      contentEmitted: false,
      filesystemPathsEmitted: false,
      nativeIdentifiersEmitted: false,
    },
  };
}

function latestRunFeatures(database, runId, landmarkAt) {
  const landmark = new Date(landmarkAt).toISOString();
  const terminal = database.prepare(`
    SELECT 1 FROM events
    WHERE run_id = ?
      AND kind = 'run_succeeded'
      AND julianday(occurred_at) <= julianday(?)
      AND julianday(observed_at) <= julianday(?)
    LIMIT 1
  `).get(runId, landmark, landmark);
  if (terminal) return { taskClass: null, selfEta: 0, complete: true };

  const reporter = database.prepare(`
    SELECT task_class, model_self_eta_minutes, reported_at, received_at
    FROM reporter_observations
    WHERE run_id = ?
      AND julianday(reported_at) <= julianday(?)
      AND julianday(received_at) <= julianday(?)
    ORDER BY julianday(received_at) DESC, observation_id DESC
    LIMIT 1
  `).get(runId, landmark, landmark);
  const start = database.prepare(`
    SELECT
      json_extract(payload_json, '$.data.task_class') AS task_class,
      json_extract(payload_json, '$.data.model_self_eta_minutes') AS model_self_eta_minutes,
      occurred_at AS reported_at,
      observed_at AS received_at
    FROM events
    WHERE run_id = ?
      AND kind = 'run_started'
      AND julianday(occurred_at) <= julianday(?)
      AND julianday(observed_at) <= julianday(?)
    ORDER BY julianday(observed_at) DESC, event_id DESC
    LIMIT 1
  `).get(runId, landmark, landmark);
  const candidates = [reporter, start].filter(Boolean).toSorted((left, right) =>
    Date.parse(right.received_at) - Date.parse(left.received_at));
  const taskClass = candidates.find((candidate) =>
    typeof candidate.task_class === 'string' && candidate.task_class)?.task_class ?? null;
  const selfSource = candidates.find((candidate) => finite(candidate.model_self_eta_minutes) !== null);
  const rawSelfEta = finite(selfSource?.model_self_eta_minutes);
  const ageMinutes = rawSelfEta === null
    ? 0
    : Math.max(0, (Date.parse(landmark) - Date.parse(selfSource.reported_at)) / MINUTE_MS);
  return {
    taskClass,
    selfEta: rawSelfEta === null ? null : Math.max(0, rawSelfEta - ageMinutes),
    complete: false,
  };
}

function revisionAt(database, worksetId, landmarkAt) {
  return database.prepare(`
    SELECT revision, kind
    FROM workset_events
    WHERE workset_id = ?
      AND julianday(occurred_at) <= julianday(?)
      AND julianday(received_at) <= julianday(?)
    ORDER BY julianday(occurred_at) DESC,
      CASE kind
        WHEN 'workset_succeeded' THEN 9
        WHEN 'workset_failed' THEN 9
        WHEN 'workset_cancelled' THEN 9
        WHEN 'workset_heartbeat' THEN 3
        WHEN 'workset_status_changed' THEN 2
        WHEN 'workset_revised' THEN 1
        ELSE 0
      END DESC,
      event_id DESC
    LIMIT 1
  `).get(worksetId, landmarkAt, landmarkAt) ?? null;
}

function aggregateValues(members, values) {
  if (!members.length || values.some((value) => value === null)) return null;
  const units = [];
  const grouped = new Map();
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.execution_group === null) {
      units.push({ order: Number(member.order_index), values: [values[index]] });
    } else {
      const group = grouped.get(member.execution_group) ?? [];
      group.push({ order: Number(member.order_index), value: values[index] });
      grouped.set(member.execution_group, group);
    }
  }
  for (const group of grouped.values()) {
    const orders = group.map((entry) => entry.order).toSorted((left, right) => left - right);
    if (group.length < 2 || orders.at(-1) - orders[0] + 1 !== group.length) return null;
    units.push({ order: orders[0], values: group.map((entry) => entry.value) });
  }
  return units.toSorted((left, right) => left.order - right.order)
    .reduce((sum, unit) => sum + Math.max(...unit.values), 0);
}

function worksetFeaturesAt(database, worksetId, revision, landmarkAt, visited = new Set()) {
  if (visited.has(worksetId)) return { taskClass: null, selfEta: null };
  const nextVisited = new Set(visited).add(worksetId);
  const current = revisionAt(database, worksetId, landmarkAt);
  if (!current) return { taskClass: null, selfEta: null };
  if (['workset_succeeded', 'workset_failed', 'workset_cancelled'].includes(current.kind)) {
    return { taskClass: null, selfEta: 0 };
  }
  const selectedRevision = revision ?? Number(current.revision);
  const members = database.prepare(`
    SELECT child_type, child_run_id, child_workset_id, order_index, execution_group
    FROM workset_members
    WHERE parent_workset_id = ? AND revision = ?
      AND julianday(attached_at) <= julianday(?)
      AND (detached_at IS NULL OR julianday(detached_at) > julianday(?))
    ORDER BY order_index, member_id
  `).all(worksetId, selectedRevision, landmarkAt, landmarkAt);
  const features = members.map((member) => member.child_type === 'run'
    ? latestRunFeatures(database, member.child_run_id, landmarkAt)
    : worksetFeaturesAt(
        database,
        member.child_workset_id,
        null,
        landmarkAt,
        nextVisited,
      ));
  const taskClasses = features.map((feature) => feature.taskClass);
  const knownClasses = new Set(taskClasses.filter(Boolean));
  const taskClass = features.length && taskClasses.every(Boolean) && knownClasses.size === 1
    ? [...knownClasses][0]
    : null;
  return {
    taskClass,
    selfEta: aggregateValues(members, features.map((feature) => feature.selfEta)),
  };
}

function waitObservedBetween(database, worksetId, afterAt, finishedAt, terminalReceivedAt) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM workset_events AS event
    WHERE event.workset_id = ?
      AND event.kind = 'workset_status_changed'
      AND json_extract(event.payload_json, '$.data.status') IN (
        'needs_input', 'waiting_provider', 'blocked', 'paused'
      )
      AND julianday(event.occurred_at) >= julianday(?)
      AND julianday(event.occurred_at) <= julianday(?)
      AND julianday(event.received_at) <= julianday(?)
    UNION ALL
    SELECT 1
    FROM workset_forecast_snapshots AS forecast
    WHERE forecast.workset_id = ?
      AND forecast.forecast_status IN (
        'needs_input', 'waiting_provider', 'blocked', 'paused'
      )
      AND julianday(forecast.observed_at) >= julianday(?)
      AND julianday(forecast.observed_at) <= julianday(?)
    UNION ALL
    SELECT 1
    FROM workset_members AS member
    JOIN events AS run_event ON run_event.run_id = member.child_run_id
    WHERE member.parent_workset_id = ?
      AND member.child_type = 'run'
      AND run_event.kind IN ('needs_input', 'waiting_provider')
      AND julianday(run_event.occurred_at) >= julianday(?)
      AND julianday(run_event.occurred_at) <= julianday(?)
      AND julianday(run_event.observed_at) <= julianday(?)
    UNION ALL
    SELECT 1
    FROM workset_members AS member
    JOIN workset_events AS child_event
      ON child_event.workset_id = member.child_workset_id
    WHERE member.parent_workset_id = ?
      AND member.child_type = 'workset'
      AND child_event.kind = 'workset_status_changed'
      AND json_extract(child_event.payload_json, '$.data.status') IN (
        'needs_input', 'waiting_provider', 'blocked', 'paused'
      )
      AND julianday(child_event.occurred_at) >= julianday(?)
      AND julianday(child_event.occurred_at) <= julianday(?)
      AND julianday(child_event.received_at) <= julianday(?)
    UNION ALL
    SELECT 1
    FROM workset_members AS parent_member
    JOIN workset_members AS child_member
      ON child_member.parent_workset_id = parent_member.child_workset_id
    JOIN events AS run_event ON run_event.run_id = child_member.child_run_id
    WHERE parent_member.parent_workset_id = ?
      AND parent_member.child_type = 'workset'
      AND child_member.child_type = 'run'
      AND run_event.kind IN ('needs_input', 'waiting_provider')
      AND julianday(run_event.occurred_at) >= julianday(?)
      AND julianday(run_event.occurred_at) <= julianday(?)
      AND julianday(run_event.observed_at) <= julianday(?)
    LIMIT 1
  `).get(
    worksetId,
    afterAt,
    finishedAt,
    terminalReceivedAt,
    worksetId,
    afterAt,
    terminalReceivedAt,
    worksetId,
    afterAt,
    finishedAt,
    terminalReceivedAt,
    worksetId,
    afterAt,
    finishedAt,
    terminalReceivedAt,
    worksetId,
    afterAt,
    finishedAt,
    terminalReceivedAt,
  ));
}

function databaseCompletionClockEvidence(
  database,
  worksetId,
  landmarkAt,
  finishedAt,
  terminalReceivedAt,
  sourceAvailableAtMs,
) {
  if (landmarkAt === null) {
    return {
      completionClockShiftsMinutes: [],
      completionClockSnapshotsObserved: 0,
      completionClockStructuralTransitionsExcluded: 0,
      completionClockWaitingTransitionsExcluded: 0,
    };
  }
  const snapshots = database.prepare(`
    SELECT
      forecast.observed_at,
      forecast.p50_minutes,
      forecast.reason_code,
      event.kind AS event_kind
    FROM workset_forecast_snapshots AS forecast
    LEFT JOIN workset_events AS event ON event.event_id = forecast.event_id
    WHERE forecast.workset_id = ?
      AND forecast.forecast_status = 'forecast'
      AND forecast.p50_minutes IS NOT NULL
      AND forecast.p50_minutes >= 0
      AND julianday(forecast.observed_at) >= julianday(?)
      AND julianday(forecast.observed_at) < julianday(?)
      AND julianday(forecast.observed_at) <= julianday(?)
    ORDER BY julianday(forecast.observed_at), forecast.snapshot_id
  `).all(worksetId, landmarkAt, finishedAt, terminalReceivedAt).filter((snapshot) =>
    sourceAvailableAtMs === null || Date.parse(snapshot.observed_at) >= sourceAvailableAtMs);
  const completionClockShiftsMinutes = [];
  let completionClockStructuralTransitionsExcluded = 0;
  let completionClockWaitingTransitionsExcluded = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const structural = current.event_kind === 'workset_revised'
      || /(?:replan|revis|new_work)/i.test(String(current.reason_code ?? ''));
    if (structural) {
      completionClockStructuralTransitionsExcluded += 1;
      continue;
    }
    if (waitObservedBetween(
      database,
      worksetId,
      previous.observed_at,
      current.observed_at,
      terminalReceivedAt,
    )) {
      completionClockWaitingTransitionsExcluded += 1;
      continue;
    }
    const previousClock = Date.parse(previous.observed_at)
      + Number(previous.p50_minutes) * MINUTE_MS;
    const currentClock = Date.parse(current.observed_at)
      + Number(current.p50_minutes) * MINUTE_MS;
    completionClockShiftsMinutes.push(Math.abs(currentClock - previousClock) / MINUTE_MS);
  }
  return {
    completionClockShiftsMinutes,
    completionClockSnapshotsObserved: snapshots.length,
    completionClockStructuralTransitionsExcluded,
    completionClockWaitingTransitionsExcluded,
  };
}

function databaseRows(database, sourceRows = []) {
  const sources = new Map(sourceRows.map((row) => [row.workset_id, row]));
  const receiptTableAvailable = tableExists(database, 'codex_goal_receipts');
  const receiptModeAvailable = receiptTableAvailable
    && columnExists(database, 'codex_goal_receipts', 'first_ingest_mode');
  const receiptQuarantineGate = tableExists(database, 'codex_goal_quarantines')
    ? `AND NOT EXISTS (
        SELECT 1 FROM codex_goal_quarantines AS quarantine
        WHERE quarantine.goal_id = receipt.goal_id
      )`
    : '';
  const causalReceiptAt = receiptModeAvailable ? database.prepare(`
    SELECT 1
    FROM codex_goal_receipts AS receipt
    WHERE receipt.workset_id = ?
      AND receipt.applied = 1
      AND receipt.censored = 0
      AND receipt.quarantined = 0
      AND receipt.first_ingest_mode = ?
      AND julianday(receipt.occurred_at) <= julianday(?)
      AND julianday(receipt.first_received_at) <= julianday(?)
      ${receiptQuarantineGate}
    LIMIT 1
  `) : null;
  const cleanOutcomeReceiptAt = receiptTableAvailable ? database.prepare(`
    SELECT 1
    FROM codex_goal_receipts AS receipt
    WHERE receipt.workset_id = ?
      AND receipt.applied = 1
      AND receipt.censored = 0
      AND receipt.quarantined = 0
      AND julianday(receipt.occurred_at) <= julianday(?)
      AND julianday(receipt.first_received_at) <= julianday(?)
      ${receiptQuarantineGate}
    LIMIT 1
  `) : null;
  const rows = database.prepare(`
    SELECT
      workset.workset_id,
      workset.workset_type,
      workset.started_at,
      workset.finished_at,
      (
        SELECT terminal.received_at
        FROM workset_events AS terminal
        WHERE terminal.workset_id = workset.workset_id
          AND terminal.kind IN ('workset_succeeded', 'workset_failed', 'workset_cancelled')
        ORDER BY julianday(terminal.occurred_at) DESC, terminal.event_id DESC
        LIMIT 1
      ) AS terminal_received_at,
      forecast.observed_at,
      forecast.revision,
      forecast.mode,
      forecast.p50_minutes,
      forecast.p80_minutes
    FROM worksets AS workset
    LEFT JOIN workset_forecast_snapshots AS forecast ON forecast.snapshot_id = (
      SELECT candidate.snapshot_id
      FROM workset_forecast_snapshots AS candidate
      WHERE candidate.workset_id = workset.workset_id
        AND candidate.p50_minutes > 0
        AND julianday(candidate.observed_at) >= julianday(workset.started_at)
        AND julianday(candidate.observed_at) < julianday(workset.finished_at)
      ORDER BY julianday(candidate.observed_at), candidate.snapshot_id
      LIMIT 1
    )
    WHERE workset.owner_terminal = 1
      AND workset.status = 'succeeded'
      AND julianday(workset.finished_at) > julianday(workset.started_at)
      AND EXISTS (
        SELECT 1 FROM workset_events AS terminal
        WHERE terminal.workset_id = workset.workset_id
          AND terminal.kind = 'workset_succeeded'
      )
    ORDER BY julianday(forecast.observed_at), workset.workset_type, workset.workset_id
  `).all();
  return rows.map((row) => {
    const source = sources.get(row.workset_id) ?? null;
    const landmarkAt = row.observed_at ?? null;
    const features = landmarkAt === null
      ? { taskClass: null, selfEta: null }
      : worksetFeaturesAt(database, row.workset_id, Number(row.revision), landmarkAt);
    const waitContaminated = landmarkAt === null
      ? false
      : waitObservedBetween(
          database,
          row.workset_id,
          landmarkAt,
          row.finished_at,
          row.terminal_received_at,
        );
    const sourceAvailableAtMs = Number.isFinite(Date.parse(source?.first_received_at))
      ? Date.parse(source.first_received_at)
      : null;
    const completionClockEvidence = databaseCompletionClockEvidence(
      database,
      row.workset_id,
      landmarkAt,
      row.finished_at,
      row.terminal_received_at,
      sourceAvailableAtMs,
    );
    const hasCausalReceipt = (mode) => landmarkAt !== null
      && causalReceiptAt !== null
      && Boolean(causalReceiptAt.get(row.workset_id, mode, landmarkAt, landmarkAt));
    const hasCausalLiveGoalReceipt = hasCausalReceipt('live');
    const hasCausalBackfillGoalReceipt = hasCausalReceipt('backfill');
    const hasCleanAppliedGoalOutcomeReceipt = cleanOutcomeReceiptAt !== null
      && Boolean(cleanOutcomeReceiptAt.get(
        row.workset_id,
        row.finished_at,
        row.terminal_received_at,
      ));
    const goalReceiptProvenanceApplies = row.workset_type === 'task'
      && source?.source_kind === 'codex_goal_shadow';
    const targetProvenanceStatus = !goalReceiptProvenanceApplies
      ? 'not_applicable'
      : !receiptModeAvailable
        ? 'unavailable_legacy_column'
        : hasCausalLiveGoalReceipt
          ? 'live'
          : hasCausalBackfillGoalReceipt
            ? 'backfill_only'
            : 'no_causal_receipt';
    return {
      scopeKey: row.workset_id,
      scopeType: row.workset_type,
      startedAt: row.started_at,
      landmarkAt,
      finishedAt: row.finished_at,
      terminalReceivedAt: row.terminal_received_at,
      taskClass: typeof source?.task_class === 'string' && source.task_class
        ? source.task_class
        : features.taskClass,
      scopeForecast: row.p50_minutes === null ? null : {
          p50: Number(row.p50_minutes),
          p80: finite(row.p80_minutes),
          mode: row.mode,
        },
      modelSelfEta: features.selfEta === null ? null : { p50: features.selfEta, p80: null },
      waitContaminated,
      outcomeWaitContaminated: waitObservedBetween(
        database,
        row.workset_id,
        row.started_at,
        row.finished_at,
        row.terminal_received_at,
      ),
      ...completionClockEvidence,
      sourceKind: source?.source_kind ?? null,
      sourceStatus: source?.source_status ?? null,
      sourceProvider: source?.provider ?? null,
      sourceAvailableAtMs,
      receiptModeAvailable,
      hasCausalLiveGoalReceipt,
      hasCleanAppliedGoalOutcomeReceipt,
      targetProvenanceStatus,
    };
  });
}

function tableExists(database, table) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function columnExists(database, table, column) {
  return Boolean(database.prepare(`
    SELECT 1 FROM pragma_table_info(?) WHERE name = ?
  `).get(table, column));
}

function databaseCohort(database) {
  if (!tableExists(database, 'workset_sources')) {
    const rows = databaseRows(database).map((row) => ({
      ...row,
      outcomeEligible: true,
      targetSourceEligible: true,
    }));
    return {
      rows,
      evidenceByScope: Object.fromEntries(['task', 'project'].map((scopeType) => [
        scopeType,
        rows.some((row) => row.scopeType === scopeType) ? 'contract_only' : 'unavailable',
      ])),
      sourceTableStatus: 'missing_contract_only',
      excludedUnknownSourceRows: 0,
      excludedNoReceiptSourceRows: 0,
      excludedSourceQuarantinedRows: 0,
      excludedTombstonedSourceRows: 0,
    };
  }
  const sourceRows = database.prepare(`
    SELECT workset_id, provider, source_kind, source_status, task_class, first_received_at
    FROM workset_sources
  `).all();
  const rows = databaseRows(database, sourceRows);
  const tombstonedWorksets = tableExists(database, 'codex_goal_quarantines')
      && tableExists(database, 'codex_goal_receipts')
    ? new Set(database.prepare(`
        SELECT DISTINCT receipt.workset_id
        FROM codex_goal_receipts AS receipt
        JOIN codex_goal_quarantines AS quarantine
          ON quarantine.goal_id = receipt.goal_id
        WHERE receipt.workset_id IS NOT NULL
      `).all().map((row) => row.workset_id))
    : new Set();
  const tombstonedCohortRows = rows.filter((row) => tombstonedWorksets.has(row.scopeKey));
  const cohortRows = rows.filter((row) => !tombstonedWorksets.has(row.scopeKey));
  const providerRows = cohortRows.filter((row) =>
    row.sourceProvider === 'codex'
    && row.sourceAvailableAtMs !== null
    && row.sourceAvailableAtMs <= Date.parse(row.terminalReceivedAt)
    && ((row.scopeType === 'task'
        && row.sourceKind === 'codex_goal_shadow'
        && row.sourceStatus === 'verified_structural'
        && row.hasCleanAppliedGoalOutcomeReceipt)
      || (row.scopeType === 'project'
        && row.sourceKind === 'explicit_project_shadow'
        && row.sourceStatus === 'verified_structural'))).map((row) => ({
          ...row,
          outcomeEligible: true,
          targetSourceEligible: row.landmarkAt !== null
            && row.sourceAvailableAtMs <= Date.parse(row.landmarkAt)
            && (row.scopeType !== 'task' || row.hasCausalLiveGoalReceipt),
        }));
  const controlledRows = cohortRows.filter((row) =>
    row.sourceProvider === 'codex'
    && row.sourceKind === 'controlled_wrapper'
    && row.sourceStatus === 'contract_only'
    && row.sourceAvailableAtMs !== null
    && row.sourceAvailableAtMs <= Date.parse(row.terminalReceivedAt)).map((row) => ({
      ...row,
      outcomeEligible: true,
      targetSourceEligible: row.landmarkAt !== null
        && row.sourceAvailableAtMs <= Date.parse(row.landmarkAt),
    }));
  const recognized = new Set([...providerRows, ...controlledRows].map((row) => row.scopeKey));
  const sourceQuarantinedRows = cohortRows.filter((row) => row.sourceStatus === 'quarantined');
  const noReceiptSourceRows = cohortRows.filter((row) =>
    row.scopeType === 'task'
    && row.sourceProvider === 'codex'
    && row.sourceKind === 'codex_goal_shadow'
    && row.sourceStatus === 'verified_structural'
    && !row.hasCleanAppliedGoalOutcomeReceipt);
  const selectedRows = [];
  const evidenceByScope = {};
  for (const scopeType of ['task', 'project']) {
    const providerScopeRows = providerRows.filter((row) => row.scopeType === scopeType);
    const controlledScopeRows = controlledRows.filter((row) => row.scopeType === scopeType);
    if (providerScopeRows.length) {
      selectedRows.push(...providerScopeRows);
      evidenceByScope[scopeType] = 'provider_shadow';
    } else if (controlledScopeRows.length) {
      selectedRows.push(...controlledScopeRows);
      evidenceByScope[scopeType] = 'contract_only';
    } else {
      evidenceByScope[scopeType] = 'unavailable';
    }
  }
  return {
    rows: selectedRows,
    evidenceByScope,
    sourceTableStatus: providerRows.length
      ? controlledRows.length
        ? 'independent_mixed_cohorts'
        : 'verified_structural_cohort'
      : controlledRows.length
        ? 'no_verified_structural_cohort'
        : 'no_recognized_cohort',
    excludedUnknownSourceRows: cohortRows.filter((row) =>
      row.sourceStatus !== 'quarantined'
      && !noReceiptSourceRows.includes(row)
      && !recognized.has(row.scopeKey)).length,
    excludedNoReceiptSourceRows: noReceiptSourceRows.length,
    excludedSourceQuarantinedRows: sourceQuarantinedRows.length,
    excludedTombstonedSourceRows: tombstonedCohortRows.length,
  };
}

function count(database, sql, ...parameters) {
  return Number(database.prepare(sql).get(...parameters)?.count ?? 0);
}

function materializedScopeFunnel(database, sourceKind, worksetType) {
  if (!tableExists(database, 'workset_sources')) {
    return {
      materialized: 0,
      active: 0,
      blocked: 0,
      quarantined: 0,
      sourceQuarantined: 0,
      completedStructural: 0,
    };
  }
  const tombstoneFilter = tableExists(database, 'codex_goal_quarantines')
      && tableExists(database, 'codex_goal_receipts')
    ? `AND NOT EXISTS (
        SELECT 1
        FROM codex_goal_receipts AS receipt
        JOIN codex_goal_quarantines AS quarantine
          ON quarantine.goal_id = receipt.goal_id
        WHERE receipt.workset_id = source.workset_id
      )`
    : '';
  const base = `
    FROM workset_sources AS source
    JOIN worksets AS workset ON workset.workset_id = source.workset_id
    WHERE source.source_kind = ?
      AND workset.workset_type = ?
      AND source.source_status <> 'quarantined'
      ${tombstoneFilter}
  `;
  const sourceQuarantined = count(database, `
    SELECT COUNT(*) AS count
    FROM workset_sources AS source
    JOIN worksets AS workset ON workset.workset_id = source.workset_id
    WHERE source.source_kind = ?
      AND workset.workset_type = ?
      AND source.source_status = 'quarantined'
  `, sourceKind, worksetType);
  return {
    materialized: count(database, `SELECT COUNT(*) AS count ${base}`, sourceKind, worksetType),
    active: count(database, `
      SELECT COUNT(*) AS count ${base}
        AND workset.owner_terminal = 0
        AND workset.status IN ('pending', 'running')
    `, sourceKind, worksetType),
    blocked: count(database, `
      SELECT COUNT(*) AS count ${base}
        AND workset.owner_terminal = 0
        AND workset.status IN ('needs_input', 'waiting_provider', 'blocked', 'paused')
    `, sourceKind, worksetType),
    quarantined: sourceQuarantined,
    sourceQuarantined,
    completedStructural: count(database, `
      SELECT COUNT(*) AS count ${base}
        AND source.source_status = 'verified_structural'
        AND workset.owner_terminal = 1
        AND workset.status = 'succeeded'
    `, sourceKind, worksetType),
  };
}

function databaseFunnel(database, report, cohort) {
  const receiptTablePresent = tableExists(database, 'codex_goal_receipts');
  const receiptModeAvailable = receiptTablePresent
    && columnExists(database, 'codex_goal_receipts', 'first_ingest_mode');
  const quarantineTablePresent = tableExists(database, 'codex_goal_quarantines');
  const sourceTablePresent = tableExists(database, 'workset_sources');
  const notTombstonedReceipt = quarantineTablePresent
    ? `AND NOT EXISTS (
        SELECT 1 FROM codex_goal_quarantines AS quarantine
        WHERE quarantine.goal_id = receipt.goal_id
      )`
    : '';
  const quarantinedReceiptRows = receiptTablePresent
    ? count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts
        WHERE quarantined = 1
      `)
    : 0;
  const receiptProvenance = receiptModeAvailable ? {
    status: 'available',
    live: {
      observedReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'live'
      `),
      confirmedStructuralReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'live'
          AND receipt.quarantined = 0 ${notTombstonedReceipt}
      `),
      appliedReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'live'
          AND receipt.applied = 1
          AND receipt.censored = 0
          AND receipt.quarantined = 0 ${notTombstonedReceipt}
      `),
    },
    backfill: {
      observedReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'backfill'
      `),
      confirmedStructuralReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'backfill'
          AND receipt.quarantined = 0 ${notTombstonedReceipt}
      `),
      appliedReceipts: count(database, `
        SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
        WHERE receipt.first_ingest_mode = 'backfill'
          AND receipt.applied = 1
          AND receipt.censored = 0
          AND receipt.quarantined = 0 ${notTombstonedReceipt}
      `),
    },
    numericPromotionRule: 'task target requires a clean applied live receipt causally received by its forecast landmark',
    backfillOutcomeRule: 'clean successful backfill scopes may enter outcome history but never establish realtime numeric target eligibility',
  } : {
    status: 'unavailable_legacy_column',
    live: null,
    backfill: null,
    numericPromotionRule: 'fail_closed_no_task_provider_numeric_targets',
    backfillOutcomeRule: 'outcome provenance unavailable; no realtime promotion inference',
  };
  const receipts = receiptTablePresent ? {
    observed: count(database, 'SELECT COUNT(*) AS count FROM codex_goal_receipts'),
    confirmedStructuralGoals: count(database, `
      SELECT COUNT(DISTINCT receipt.goal_id) AS count
      FROM codex_goal_receipts AS receipt
      WHERE receipt.quarantined = 0 ${notTombstonedReceipt}
    `),
    confirmedStructuralReceipts: count(database, `
      SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
      WHERE receipt.quarantined = 0 ${notTombstonedReceipt}
    `),
    applied: count(database, `
      SELECT COUNT(*) AS count FROM codex_goal_receipts AS receipt
      WHERE receipt.applied = 1
        AND receipt.censored = 0
        AND receipt.quarantined = 0
        ${notTombstonedReceipt}
    `),
    censored: count(database, `
      SELECT COUNT(*) AS count FROM codex_goal_receipts WHERE censored = 1
    `),
    backfillTerminalWithoutStart: count(database, `
      SELECT COUNT(*) AS count FROM codex_goal_receipts
      WHERE kind = 'goal_completed' AND censored = 1
    `),
    quarantined: quarantinedReceiptRows,
    quarantinedReceiptRows,
    receiptCollisionEvidenceStatus: 'not_separately_encoded_from_structural_apply_conflicts',
  } : {
    observed: 0,
    confirmedStructuralGoals: 0,
    confirmedStructuralReceipts: 0,
    applied: 0,
    censored: 0,
    backfillTerminalWithoutStart: 0,
    quarantined: 0,
    quarantinedReceiptRows: 0,
    receiptCollisionEvidenceStatus: 'unavailable_legacy_schema',
  };
  const taskMaterialization = materializedScopeFunnel(database, 'codex_goal_shadow', 'task');
  const projectMaterialization = materializedScopeFunnel(
    database,
    'explicit_project_shadow',
    'project',
  );
  const scope = (metrics, materialization) => ({
    ...materialization,
    completedOutcomeLibrary: metrics.completedOutcomeScopes,
    waitContaminatedOutcomesExcluded: metrics.waitContaminatedOutcomesExcluded,
    causalNumericFirstForecasts: metrics.causalNumericFirstForecasts,
    backfillNumericTargetsExcluded: metrics.backfillNumericTargetsExcluded,
    legacyProvenanceNumericTargetsExcluded: metrics.legacyProvenanceNumericTargetsExcluded,
    noCausalReceiptNumericTargetsExcluded: metrics.noCausalReceiptNumericTargetsExcluded,
    waitContaminatedExcluded: metrics.waitContaminatedExcluded,
    scoreableTargets: metrics.completedScopeSamples,
    pairedComparisons: metrics.pairedAgainstHistoricalTaskClassMedian.pairedScopes,
    globalPairedComparisons: metrics.pairedAgainstHistoricalGlobalMedian.pairedScopes,
  });
  const durableGoalQuarantineTombstones = quarantineTablePresent
    ? count(database, 'SELECT COUNT(*) AS count FROM codex_goal_quarantines')
    : 0;
  const sourceQuarantinedScopes = sourceTablePresent
    ? count(database, `
        SELECT COUNT(*) AS count FROM workset_sources
        WHERE source_status = 'quarantined'
      `)
    : 0;
  const subjectSelects = [];
  if (quarantineTablePresent) {
    subjectSelects.push(`SELECT 'goal:' || goal_id AS subject FROM codex_goal_quarantines`);
  }
  if (receiptTablePresent) {
    subjectSelects.push(`
      SELECT 'goal:' || goal_id AS subject
      FROM codex_goal_receipts WHERE quarantined = 1
    `);
  }
  if (sourceTablePresent && receiptTablePresent) {
    subjectSelects.push(`
      SELECT COALESCE(
        (
          SELECT 'goal:' || receipt.goal_id
          FROM codex_goal_receipts AS receipt
          WHERE receipt.workset_id = source.workset_id
          ORDER BY receipt.first_received_at, receipt.receipt_id
          LIMIT 1
        ),
        'workset:' || source.workset_id
      ) AS subject
      FROM workset_sources AS source
      WHERE source.source_status = 'quarantined'
    `);
  } else if (sourceTablePresent) {
    subjectSelects.push(`
      SELECT 'workset:' || workset_id AS subject
      FROM workset_sources WHERE source_status = 'quarantined'
    `);
  }
  const uniqueQuarantinedSubjects = subjectSelects.length
    ? count(database, `
        SELECT COUNT(*) AS count FROM (
          ${subjectSelects.join(' UNION ')}
        )
      `)
    : 0;
  return {
    receiptTableStatus: receiptTablePresent ? 'available' : 'missing_legacy_schema',
    quarantineTableStatus: quarantineTablePresent ? 'available' : 'missing_legacy_schema',
    durableGoalQuarantineTombstones,
    receiptProvenance,
    sourceExclusions: {
      verifiedGoalTaskWithoutCleanAppliedReceipt: cohort.excludedNoReceiptSourceRows,
      rule: 'source-only task rows are materialization diagnostics, never denominator, outcome-history, or target evidence',
    },
    receipts,
    task: scope(report.task, taskMaterialization),
    project: scope(report.project, projectMaterialization),
    quarantineDisposition: {
      durableGoalQuarantineTombstones,
      quarantinedReceiptRows,
      sourceQuarantinedScopes,
      uniqueQuarantinedSubjects,
      categoryCountsAreNonAdditive: true,
      receiptCollisionEvidenceStatus: receipts.receiptCollisionEvidenceStatus,
    },
    selectionRule: 'tombstones and quarantined sources are excluded; clean backfill outcomes may enter history, while task targets require causal live receipt provenance',
  };
}

/**
 * Existing v5 workset rows do not carry a provider-owned scope source label,
 * so database reports deliberately remain contract-only until that contract is
 * added. The evaluator never infers a live label from IDs or surrounding text.
 */
export function evaluatePilotDatabase(filename, inputOptions = {}) {
  return withReadSnapshot(filename, (database) => {
    const cohort = databaseCohort(database);
    const report = evaluatePilotCohort(cohort.rows, {
      ...inputOptions,
      evidenceByScope: cohort.evidenceByScope,
      simulated: false,
    });
    return {
      ...report,
      funnel: databaseFunnel(database, report, cohort),
      sourceProtocol: {
        tableStatus: cohort.sourceTableStatus,
        taskProviderShadow: "source_kind='codex_goal_shadow' and source_status='verified_structural' on the task itself",
        projectProviderShadow: "source_kind='explicit_project_shadow' and source_status='verified_structural' on the project itself",
        controlledContract: "source_kind='controlled_wrapper' and source_status='contract_only'",
        goalNeverCreatesOrLabelsProject: true,
        unknownEnumsFailClosed: true,
        taskNumericPromotionRequiresCausalLiveReceipt: true,
        legacyMissingReceiptModeFailsClosed: true,
        excludedUnknownSourceRows: cohort.excludedUnknownSourceRows,
        excludedNoReceiptSourceRows: cohort.excludedNoReceiptSourceRows,
        excludedSourceQuarantinedRows: cohort.excludedSourceQuarantinedRows,
        excludedTombstonedSourceRows: cohort.excludedTombstonedSourceRows,
      },
    };
  });
}

function metric(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : 'unavailable';
}

function percentage(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'unavailable';
}

function scopeMarkdown(scope) {
  const primary = scope.methods.scope_primary;
  const paired = scope.pairedAgainstHistoricalTaskClassMedian;
  const volatility = scope.completionClockVolatility;
  return [
    `## ${scope.scope}`,
    '',
    `Evidence: **${scope.evidenceStatus}**. Verdict: **${scope.verdict}**. Stage: **${scope.stage}**. Recommendation: **${scope.recommendation}**.`,
    '',
    `Outcome library: ${scope.completedOutcomeScopes} (${scope.waitContaminatedOutcomesExcluded} wait-contaminated outcomes excluded). Causal numeric first forecasts: ${scope.causalNumericFirstForecasts}. Wait-contaminated targets excluded: ${scope.waitContaminatedExcluded}. Scoreable independent ${scope.scope} targets: ${scope.completedScopeSamples}. Accuracy win claimed: **${scope.numericAccuracyWinClaimed}**.`,
    '',
    `Numeric provenance exclusions: ${scope.backfillNumericTargetsExcluded} backfill-only, ${scope.legacyProvenanceNumericTargetsExcluded} legacy-mode unavailable, and ${scope.noCausalReceiptNumericTargetsExcluded} without a causal clean receipt. These exclusions do not remove an otherwise trusted completion from the outcome history.`,
    '',
    '| Method | Status | Scopes | Missing | MAE (min) | Median AE (min) | Severe under | P80 coverage | P80 95% interval |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...Object.entries(scope.methods).map(([name, method]) =>
      `| ${name} | ${method.status} | ${method.eligibleScopes} | ${method.missingPredictions} | ${metric(method.meanAbsoluteErrorMinutes)} | ${metric(method.medianAbsoluteErrorMinutes)} | ${percentage(method.severeUnderestimateRate)} | ${percentage(method.p80Coverage)} | ${method.p80CoverageInterval95 ? method.p80CoverageInterval95.map(percentage).join(' to ') : 'unavailable'} |`),
    '',
    `Paired scope-vs-class-history absolute-error gain: ${metric(paired.meanAbsoluteErrorGainMinutes)} minutes on ${paired.pairedScopes} explicitly classified ${scope.scope}s; cluster bootstrap 95% interval ${paired.interval95 ? paired.interval95.map(metric).join(' to ') : 'unavailable'}. Positive favors scope ETA; at least 30 pairs are required and the interval must be entirely above zero.`,
    '',
    `P80 target: 80%. Observed ${percentage(primary.p80Coverage)} with 95% interval ${primary.p80CoverageInterval95 ? primary.p80CoverageInterval95.map(percentage).join(' to ') : 'unavailable'}; the lower bound must reach the target.`,
    '',
    `Severe underestimation means saved P50 < 50% of actual remaining time. Scope ETA observed ${percentage(primary.severeUnderestimateRate)} (${primary.severeUnderestimatedScopes}/${primary.eligibleScopes}).`,
    '',
    `Completion-clock volatility: **${volatility.status}**; ${volatility.eligibleTransitions} diagnostic transitions across ${volatility.scopesWithTransitions} independent scopes. Each scope is summarized first; the cross-scope median is ${metric(volatility.medianAbsoluteShiftMinutes)} minutes and P80 is ${metric(volatility.p80AbsoluteShiftMinutes)} minutes. ${volatility.structuralTransitionsExcluded} structural and ${volatility.waitingTransitionsExcluded} waiting transitions were excluded. Its P1 decision gate requires ${volatility.gate.minimumScopes} scopes and a predeclared maximum (current: ${metric(volatility.gate.maximumMinutes)} minutes).`,
    '',
  ];
}

export function pilotEvaluationMarkdown(report) {
  const receiptProvenance = report.funnel?.receiptProvenance ?? null;
  const receiptProvenanceLine = receiptProvenance?.status === 'available'
    ? `Receipt provenance: first_ingest_mode=live has ${receiptProvenance.live.observedReceipts} observed / ${receiptProvenance.live.confirmedStructuralReceipts} confirmed / ${receiptProvenance.live.appliedReceipts} applied receipts; first_ingest_mode=backfill has ${receiptProvenance.backfill.observedReceipts} observed / ${receiptProvenance.backfill.confirmedStructuralReceipts} confirmed / ${receiptProvenance.backfill.appliedReceipts} applied receipts.`
    : 'Receipt provenance: unavailable because the legacy receipt schema lacks first_ingest_mode; realtime task numeric promotion fails closed.';
  const lines = [
    '# Agent ETA automatic shadow pilot gate',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Overall evidence: **${report.evidenceStatus}**. Current report status: **${report.status}**.`,
    '',
    '> Task and project evidence are independent. Unlabelled or controlled worksets are contract evidence, not provider-owned labels, and one scope can never supply evidence for the other.',
    '',
    ...scopeMarkdown(report.task),
    ...scopeMarkdown(report.project),
  ];
  if (report.funnel) {
    lines.push(
      '## Database funnel',
      '',
      `Goal receipts: ${report.funnel.receipts.confirmedStructuralGoals} confirmed goals / ${report.funnel.receipts.confirmedStructuralReceipts} confirmed receipts; ${report.funnel.receipts.censored} censored and ${report.funnel.receipts.backfillTerminalWithoutStart} terminal backfills without a start. Confirmed counts exclude every goal with a durable tombstone.`,
      '',
      receiptProvenanceLine,
      '',
      `Source-only exclusions: ${report.funnel.sourceExclusions.verifiedGoalTaskWithoutCleanAppliedReceipt} verified-labelled Goal task rows lacked a clean applied receipt and were excluded from denominators, outcomes, history, and targets.`,
      '',
      `Quarantine evidence: ${report.funnel.durableGoalQuarantineTombstones} durable goal tombstones, ${report.funnel.quarantineDisposition.quarantinedReceiptRows} quarantined receipt rows, ${report.funnel.quarantineDisposition.sourceQuarantinedScopes} quarantined source scopes, and ${report.funnel.quarantineDisposition.uniqueQuarantinedSubjects} unique subjects across those overlapping storage layers. Receipt-key collisions are not separately encoded from structural apply conflicts, so quarantined receipt rows are not labelled collision counts.`,
      '',
      '| Scope | Materialized source rows | Active | Blocked | Source quarantined | Completed outcome library | Numeric first forecast | Wait excluded | Scoreable | Paired |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
      `| task | ${report.funnel.task.materialized} | ${report.funnel.task.active} | ${report.funnel.task.blocked} | ${report.funnel.task.quarantined} | ${report.funnel.task.completedOutcomeLibrary} | ${report.funnel.task.causalNumericFirstForecasts} | ${report.funnel.task.waitContaminatedExcluded} | ${report.funnel.task.scoreableTargets} | ${report.funnel.task.pairedComparisons} |`,
      `| project | ${report.funnel.project.materialized} | ${report.funnel.project.active} | ${report.funnel.project.blocked} | ${report.funnel.project.quarantined} | ${report.funnel.project.completedOutcomeLibrary} | ${report.funnel.project.causalNumericFirstForecasts} | ${report.funnel.project.waitContaminatedExcluded} | ${report.funnel.project.scoreableTargets} | ${report.funnel.project.pairedComparisons} |`,
      '',
    );
  }
  lines.push(
    '## Protocol',
    '',
    '- Trusted completed outcomes enter the history library even when they had no numeric forecast.',
    '- Durable goal tombstones are rejection evidence: they are reported independently and never enter the denominator, outcome library, historical baseline, or scoreable target cohort.',
    '- Receipt quarantine and source quarantine are overlapping storage layers; the unique-subject count deduplicates them, and the report never relabels the shared receipt quarantine bit as a collision count.',
    '- Clean backfill completions may enter the outcome history after their terminal receipt, but a task numeric target requires a clean applied `first_ingest_mode=live` receipt received by the forecast landmark.',
    '- A `verified_structural` Goal task source is not outcome truth by itself: outcome/history eligibility also requires a clean applied receipt whose event occurred by finish and whose first receipt arrived by the terminal receipt.',
    '- Legacy receipt schemas without `first_ingest_mode` report provenance unavailable and cannot qualify provider task targets for numeric promotion.',
    '- One first positive forecast per scoreable scope; snapshots and turns are not independent samples.',
    '- `other` and `unknown` are unclassified, so they cannot populate task-class history or the 30-pair class-specific decision gate.',
    '- Historical global/task-class medians use only outcomes whose finish and terminal receipt are both strictly before the target landmark.',
    '- Blocking waits after a landmark are excluded before scoring and are never counted as ETA error.',
    '- Task bootstrap samples tasks; project bootstrap samples projects.',
    '- Severe underestimation is P50 below half of actual remaining time and is reported separately from MAE and P80 coverage.',
    '- Completion-clock volatility first takes a median within each scope, then aggregates across scopes; transition counts are diagnostic only, so a scope with many snapshots cannot dominate the gate.',
    '- Observable structural revisions and waits are excluded from volatility; hidden new work may remain unclassified and is reported as a limitation.',
    '- Fewer than 30 samples is insufficient; 30–49 is provisional; 50+ reaches a decision.',
    '- At 50+, numeric ETA requires 30+ explicitly classified paired scopes with positive MAE-gain CI, P80 Wilson lower bound >=80%, and a predeclared P1 volatility threshold with enough scopes.',
    '- Missing class-specific, P80, or volatility evidence remains provisional with `status_only`; a failed measured gate is falsified and also recommends `status_only`.',
    '- Missing model self-ETA remains unavailable and is never imputed.',
    '',
  );
  return lines.join('\n');
}
