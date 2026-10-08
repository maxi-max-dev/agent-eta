const DEFAULT_TARGET_COVERAGE = 0.8;
const DEFAULT_MINIMUM_SAMPLES = 20;
const DEFAULT_PRIOR_STRENGTH = 20;
const MAX_MULTIPLIER = 3;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Estimate a conservative upper-bound multiplier from one observation per run.
 * The empirical quantile uses the finite-sample conformal rank, then shrinks in
 * log space toward 1 while the cohort is small. This is conformal-style
 * calibration, not a distribution-free guarantee after shrinkage.
 */
export function estimateP80Calibration(observations, {
  targetCoverage = DEFAULT_TARGET_COVERAGE,
  minimumSamples = DEFAULT_MINIMUM_SAMPLES,
  priorStrength = DEFAULT_PRIOR_STRENGTH,
} = {}) {
  if (!Array.isArray(observations)) {
    throw new TypeError('observations must be an array');
  }
  if (!(targetCoverage > 0 && targetCoverage < 1)) {
    throw new TypeError('targetCoverage must be between 0 and 1');
  }
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) {
    throw new TypeError('minimumSamples must be a positive integer');
  }
  if (!Number.isFinite(priorStrength) || priorStrength < 0) {
    throw new TypeError('priorStrength must be non-negative');
  }

  const ratios = observations.flatMap((observation) => {
    const actual = finitePositive(
      observation?.actualRemainingMinutes ?? observation?.actual_remaining_minutes,
    );
    const predicted = finitePositive(
      observation?.rawP80Minutes
        ?? observation?.raw_p80_minutes
        ?? observation?.p80Minutes
        ?? observation?.p80_minutes,
    );
    return actual !== null && predicted !== null ? [actual / predicted] : [];
  }).toSorted((left, right) => left - right);

  const sampleCount = ratios.length;
  const eligible = sampleCount >= minimumSamples;
  const rank = sampleCount
    ? Math.min(sampleCount, Math.ceil((sampleCount + 1) * targetCoverage))
    : 0;
  const rawQuantileMultiplier = rank ? ratios[rank - 1] : 1;
  const shrinkage = eligible ? sampleCount / (sampleCount + priorStrength) : 0;
  const shrunk = Math.exp(Math.log(Math.max(Number.EPSILON, rawQuantileMultiplier)) * shrinkage);
  // ETA upper bounds may widen after evidence of undercoverage, but this first
  // calibrator never narrows them. Avoiding false confidence is the objective.
  const multiplier = eligible ? Math.min(MAX_MULTIPLIER, Math.max(1, shrunk)) : 1;
  const coverage = (threshold) => sampleCount
    ? ratios.filter((ratio) => ratio <= threshold).length / sampleCount
    : null;

  return {
    targetCoverage,
    sampleCount,
    minimumSamples,
    eligible,
    multiplier: round(multiplier),
    rawQuantileMultiplier: round(rawQuantileMultiplier),
    shrinkage: round(shrinkage),
    conformalRank: rank,
    observedRawCoverage: coverage(1),
    observedCalibratedCoverage: coverage(multiplier),
    source: 'prior_run_first_forecast_ratio',
  };
}

export function calibrateForecastP80(forecast, calibration) {
  if (!forecast || typeof forecast !== 'object') return forecast;
  const rawP80 = finitePositive(forecast.p80Minutes);
  const multiplier = finitePositive(calibration?.multiplier) ?? 1;
  const exempt = forecast.status === 'terminal'
    || forecast.status === 'needs_input'
    || rawP80 === null;
  const applied = !exempt && calibration?.eligible === true && multiplier > 1;
  const calibratedP80 = applied
    ? Math.max(Number(forecast.p50Minutes ?? 0), Math.round(rawP80 * multiplier * 10) / 10)
    : forecast.p80Minutes;

  return {
    ...forecast,
    p80Minutes: calibratedP80,
    raw: {
      ...(forecast.raw ?? {}),
      intervalCalibration: {
        targetCoverage: calibration?.targetCoverage ?? DEFAULT_TARGET_COVERAGE,
        sampleCount: Number(calibration?.sampleCount ?? 0),
        minimumSamples: Number(calibration?.minimumSamples ?? DEFAULT_MINIMUM_SAMPLES),
        eligible: calibration?.eligible === true,
        multiplier: round(multiplier),
        preCalibrationP80Minutes: rawP80,
        applied,
        exemptReason: exempt
          ? (forecast.status === 'terminal' || forecast.status === 'needs_input'
            ? forecast.status
            : 'missing_positive_p80')
          : null,
        source: calibration?.source ?? 'unavailable',
      },
    },
  };
}
