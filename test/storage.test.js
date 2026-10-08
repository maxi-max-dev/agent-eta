import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentEtaDatabase } from '../src/storage/database.js';

function event(overrides = {}) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: 'evt-storage-1',
    run_id: 'run-storage',
    provider: 'generic',
    native_session_id: 'native-storage',
    occurred_at: '2026-08-29T00:00:00.000Z',
    observed_at: '2026-08-29T00:00:00.000Z',
    kind: 'run_started',
    source: { adapter: 'test', mode: 'simulated_contract', confidence: 1 },
    data: {},
    ...overrides,
  };
}

test('SQLite persists raw events, state, forecasts, calibration, and replay cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-storage-'));
  const filename = join(directory, 'demo.sqlite');
  let database = new AgentEtaDatabase(filename);
  const input = event();
  const state = {
    runId: input.run_id,
    provider: input.provider,
    status: 'active_working',
    startedAt: input.occurred_at,
    finishedAt: null,
    activeElapsedMs: 0,
    planRevision: 1,
    initialStepCount: 1,
    steps: [{ id: 'inspect', label: '检查现场', class: 'inspect', status: 'active' }],
  };

  assert.equal(database.insertEvent(input), true);
  assert.equal(database.insertEvent(input), false, 'event_id is idempotent');
  database.saveRun(state, input);
  database.savePlanSteps(state);
  database.saveForecast({
    runId: state.runId,
    eventId: input.event_id,
    observedAt: input.observed_at,
    forecast: {
      mode: 'plan_conditioned',
      status: 'forecast',
      p50Minutes: 6,
      p80Minutes: 9,
      lowerMinutes: 4,
      raw: { samples: 800 },
    },
    display: {
      headline: '预计 10:06 完成',
      range: '大致 10:04–10:09',
      currentStep: '正在检查现场',
      reason: '根据第一轮先验',
      tone: 'working',
    },
  });
  database.saveCalibration('local/generic', 'personal_residual', 24, 0.8, { eligible: true });
  database.saveReplayState('fixture-storage', 2, state.runId);
  database.saveLiveWatchState({
    provider: 'codex',
    enabled: true,
    running: true,
    status: 'watching',
    errorCode: null,
    lastScanAt: '2026-08-29T00:01:00.000Z',
    lastSuccessAt: '2026-08-29T00:01:00.000Z',
    lastChangeAt: '2026-08-29T00:01:00.000Z',
    cursorAt: '2026-08-28T23:59:00.000Z',
    pollIntervalMs: 3000,
    scanCount: 2,
    importedEvents: 3,
    savedForecasts: 3,
  });
  database.close();

  database = new AgentEtaDatabase(filename);
  assert.equal(database.countEvents(state.runId), 1);
  assert.equal(database.loadRun(state.runId).state.steps[0].label, '检查现场');
  assert.equal(database.listForecasts(state.runId)[0].forecast.p80Minutes, 9);
  assert.equal(database.listCalibration()[0].sample_count, 24);
  assert.deepEqual(database.loadReplayState(), {
    fixtureId: 'fixture-storage',
    cursor: 2,
    runId: state.runId,
    updatedAt: database.loadReplayState().updatedAt,
  });
  assert.deepEqual(database.loadLiveWatchState(), {
    provider: 'codex',
    enabled: true,
    running: true,
    status: 'watching',
    errorCode: null,
    lastScanAt: '2026-08-29T00:01:00.000Z',
    lastSuccessAt: '2026-08-29T00:01:00.000Z',
    lastChangeAt: '2026-08-29T00:01:00.000Z',
    cursorAt: '2026-08-28T23:59:00.000Z',
    pollIntervalMs: 3000,
    scanCount: 2,
    importedEvents: 3,
    savedForecasts: 3,
    updatedAt: database.loadLiveWatchState().updatedAt,
  });
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('P80 calibration observations use one first forecast per completed run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-calibration-storage-'));
  const database = new AgentEtaDatabase(join(directory, 'calibration.sqlite'));
  try {
    const start = event({
      event_id: 'evt-calibration-start',
      run_id: 'run-calibration',
      occurred_at: '2026-08-29T01:00:00.000Z',
      observed_at: '2026-08-29T01:00:00.000Z',
    });
    const finish = event({
      event_id: 'evt-calibration-finish',
      run_id: start.run_id,
      kind: 'run_succeeded',
      occurred_at: '2026-08-29T01:20:00.000Z',
      observed_at: '2026-08-29T01:20:00.000Z',
    });
    database.insertEvent(start);
    database.insertEvent(finish);
    database.saveRun({
      runId: start.run_id,
      provider: 'codex',
      status: 'succeeded',
      startedAt: start.occurred_at,
      finishedAt: finish.occurred_at,
      activeElapsedMs: 20 * 60_000,
      steps: [],
    }, finish, { isHistory: true, historySource: 'live_adapter' });
    database.saveForecast({
      runId: start.run_id,
      eventId: start.event_id,
      observedAt: start.observed_at,
      forecast: {
        mode: 'run_fallback',
        status: 'forecast',
        p50Minutes: 8,
        p80Minutes: 18,
        lowerMinutes: 4,
        raw: { intervalCalibration: { preCalibrationP80Minutes: 10 } },
      },
      display: { headline: '', range: '', reason: '' },
    });
    database.saveForecast({
      runId: start.run_id,
      eventId: 'evt-calibration-later',
      observedAt: '2026-08-29T01:05:00.000Z',
      forecast: {
        mode: 'run_fallback',
        status: 'forecast',
        p50Minutes: 6,
        p80Minutes: 30,
        lowerMinutes: 3,
      },
      display: { headline: '', range: '', reason: '' },
    });

    assert.deepEqual(database.listP80CalibrationObservations({
      before: '2026-08-29T02:00:00.000Z',
      mode: 'run_fallback',
    }), [{
      actualRemainingMinutes: 20,
      rawP80Minutes: 10,
    }]);
    assert.deepEqual(database.listP80CalibrationObservations({
      before: '2026-08-29T01:20:00.000Z',
      mode: 'run_fallback',
    }), []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
