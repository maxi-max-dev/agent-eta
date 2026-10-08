import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calibrateForecastP80,
  estimateP80Calibration,
} from '../src/core/calibration.js';

test('P80 calibration waits for enough independent run observations', () => {
  const calibration = estimateP80Calibration(Array.from({ length: 19 }, () => ({
    actualRemainingMinutes: 20,
    rawP80Minutes: 10,
  })));

  assert.equal(calibration.sampleCount, 19);
  assert.equal(calibration.eligible, false);
  assert.equal(calibration.multiplier, 1);
});

test('P80 calibration widens an undercovered upper bound without moving the median', () => {
  const observations = [
    ...Array.from({ length: 80 }, () => ({ actualRemainingMinutes: 10, rawP80Minutes: 10 })),
    ...Array.from({ length: 20 }, () => ({ actualRemainingMinutes: 20, rawP80Minutes: 10 })),
  ];
  const calibration = estimateP80Calibration(observations);
  const forecast = calibrateForecastP80({
    mode: 'run_fallback',
    status: 'forecast',
    p50Minutes: 8,
    p80Minutes: 10,
    lowerMinutes: 5,
    raw: { source: 'test' },
  }, calibration);

  assert.equal(calibration.eligible, true);
  assert.ok(calibration.multiplier > 1);
  assert.equal(calibration.observedRawCoverage, 0.8);
  assert.equal(forecast.p50Minutes, 8);
  assert.equal(forecast.lowerMinutes, 5);
  assert.ok(forecast.p80Minutes > 10);
  assert.equal(forecast.raw.intervalCalibration.preCalibrationP80Minutes, 10);
  assert.equal(forecast.raw.intervalCalibration.applied, true);
});

test('terminal and needs-input forecasts are calibration-exempt', () => {
  const calibration = {
    eligible: true,
    multiplier: 2,
    sampleCount: 100,
    targetCoverage: 0.8,
    source: 'test',
  };
  for (const status of ['terminal', 'needs_input']) {
    const forecast = calibrateForecastP80({
      mode: 'run_fallback',
      status,
      p50Minutes: 5,
      p80Minutes: 10,
      lowerMinutes: 3,
      raw: {},
    }, calibration);
    assert.equal(forecast.p80Minutes, 10);
    assert.equal(forecast.raw.intervalCalibration.applied, false);
    assert.equal(forecast.raw.intervalCalibration.exemptReason, status);
  }
});
