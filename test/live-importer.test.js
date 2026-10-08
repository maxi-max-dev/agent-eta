import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importLiveScans, sanitizeLiveEvent } from '../src/adapters/importer.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function alias(prefix, value) {
  return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

function runAlias(value) {
  return alias('codex-run', value);
}

function liveEvent({ eventId, runId, at, kind, data = {} }) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: alias('codex-event', eventId),
    run_id: runAlias(runId),
    provider: 'codex',
    native_session_id: alias('codex-session', 'sanitized'),
    occurred_at: at,
    observed_at: at,
    kind,
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data,
  };
}

function fixtureScan() {
  return {
    metadata: { deliberately: 'ignored by importer' },
    events: [
      liveEvent({ eventId: 'a-start', runId: 'a', at: '2026-08-01T00:00:00Z', kind: 'run_started', data: { task_class: 'other' } }),
      liveEvent({ eventId: 'a-done', runId: 'a', at: '2026-08-01T00:10:00Z', kind: 'run_succeeded' }),
      liveEvent({ eventId: 'b-start', runId: 'b', at: '2026-08-01T00:20:00Z', kind: 'run_started', data: { task_class: 'other' } }),
      liveEvent({
        eventId: 'b-plan',
        runId: 'b',
        at: '2026-08-01T00:21:00Z',
        kind: 'plan_declared',
        data: {
          revision: 1,
          steps: [{ id: `${runAlias('b')}-step-1`, label: '步骤 1', class: 'other', status: 'pending' }],
        },
      }),
      liveEvent({ eventId: 'b-step-start', runId: 'b', at: '2026-08-01T00:22:00Z', kind: 'step_started', data: { step_id: `${runAlias('b')}-step-1` } }),
      liveEvent({ eventId: 'b-step-done', runId: 'b', at: '2026-08-01T00:24:00Z', kind: 'step_completed', data: { step_id: `${runAlias('b')}-step-1` } }),
      liveEvent({ eventId: 'b-done', runId: 'b', at: '2026-08-01T00:27:00Z', kind: 'run_succeeded' }),
    ],
  };
}

test('live importer is idempotent and learns only from earlier successful live runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-import-'));
  const database = new AgentEtaDatabase(join(directory, 'live.sqlite'));
  try {
    const first = importLiveScans({ database, scans: [fixtureScan()] });
    assert.deepEqual(
      {
        insertedEvents: first.insertedEvents,
        duplicateEvents: first.duplicateEvents,
        touchedRuns: first.touchedRuns,
        savedForecasts: first.savedForecasts,
        terminalOutcomes: first.terminalOutcomes,
        learningOutcomes: first.learningOutcomes,
      },
      {
        insertedEvents: 7,
        duplicateEvents: 0,
        touchedRuns: 2,
        savedForecasts: 7,
        terminalOutcomes: 2,
        learningOutcomes: 2,
      },
    );
    assert.equal(database.loadHistory({ source: 'live_adapter' }).length, 2);
    assert.equal(database.listForecasts(runAlias('a')).length, 2);
    assert.equal(database.listForecasts(runAlias('b')).length, 5);
    const secondStart = database.listForecasts(runAlias('b'))[0];
    assert.equal(secondStart.forecast.raw.historyCount, 1);
    assert.equal(secondStart.forecast.raw.intervalCalibration.sampleCount, 1);
    assert.equal(secondStart.forecast.raw.intervalCalibration.applied, false);
    const intervalCalibration = database.listCalibration()
      .filter((row) => row.metric === 'p80_upper_multiplier');
    assert.equal(intervalCalibration.length, 2);
    assert.ok(intervalCalibration.every((row) => row.source === 'live_adapter'));

    const repeated = importLiveScans({ database, scans: [fixtureScan()] });
    assert.equal(repeated.insertedEvents, 0);
    assert.equal(repeated.duplicateEvents, 7);
    assert.equal(repeated.savedForecasts, 0);
    assert.equal(database.listForecasts(runAlias('b')).length, 5);

    database.resetReplayRun('unrelated-frozen-run');
    assert.equal(database.loadHistory({ source: 'live_adapter' }).length, 2);

    const cleared = database.clearLiveAdapterData();
    assert.deepEqual(cleared, { runs: 2, events: 7 });
    assert.equal(database.loadHistory({ source: 'live_adapter' }).length, 0);
    assert.equal(database.countEvents(runAlias('a')), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live persistence fails closed on content-bearing or path-like extras', () => {
  const base = liveEvent({
    eventId: 'unsafe',
    runId: 'unsafe',
    at: '2026-08-01T00:00:00Z',
    kind: 'run_started',
    data: { task_class: 'other' },
  });
  assert.doesNotThrow(() => sanitizeLiveEvent(base));
  assert.throws(
    () => sanitizeLiveEvent({ ...base, data: { ...base.data, prompt: 'private text' } }),
    /not allowed/,
  );
  assert.throws(
    () => sanitizeLiveEvent({ ...base, source: { ...base.source, path: '/private/source.jsonl' } }),
    /not allowed/,
  );
  assert.throws(
    () => sanitizeLiveEvent({ ...base, native_session_id: '/Users/private/session' }),
    /safe structural token/,
  );
  assert.throws(
    () => sanitizeLiveEvent({ ...base, native_session_id: 'codex-session-native-id' }),
    /safe structural token/,
  );
  assert.throws(
    () => sanitizeLiveEvent({
      ...base,
      source: { adapter: 'claude-code-jsonl', mode: 'local_readonly_metadata', confidence: 1 },
    }),
    /does not match/,
  );
});

test('live importer quarantines isolated unsafe, unsupported, and conflicting events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-quarantine-'));
  const filename = join(directory, 'quarantine.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    const start = liveEvent({
      eventId: 'quarantine-start',
      runId: 'quarantine',
      at: '2026-08-01T00:00:00Z',
      kind: 'run_started',
      data: { task_class: 'other' },
    });
    const unsafe = {
      ...liveEvent({
        eventId: 'quarantine-unsafe',
        runId: 'quarantine',
        at: '2026-08-01T00:00:01Z',
        kind: 'run_started',
        data: { task_class: 'other' },
      }),
      data: { task_class: 'other', prompt: 'private content must not persist' },
    };
    const unsupported = liveEvent({
      eventId: 'quarantine-unsupported',
      runId: 'quarantine',
      at: '2026-08-01T00:00:02Z',
      kind: 'scope_expanded',
      data: {},
    });
    const sourceConflict = {
      ...start,
      kind: 'run_succeeded',
      data: {},
    };

    const first = importLiveScans({
      database,
      scans: [{ events: [start, unsafe, unsupported, sourceConflict] }],
    });
    assert.deepEqual(
      {
        scannedEvents: first.scannedEvents,
        acceptedEvents: first.acceptedEvents,
        insertedEvents: first.insertedEvents,
        savedForecasts: first.savedForecasts,
        quarantinedEvents: first.quarantinedEvents,
        quarantine: first.quarantine,
      },
      {
        scannedEvents: 4,
        acceptedEvents: 1,
        insertedEvents: 1,
        savedForecasts: 1,
        quarantinedEvents: 3,
        quarantine: {
          invalidOrUnsupported: 2,
          conflictingSourceEvent: 1,
          conflictingStoredEvent: 0,
        },
      },
    );
    assert.equal(database.countEvents(runAlias('quarantine')), 1);
    assert.doesNotMatch(JSON.stringify(database.listEvents(runAlias('quarantine'))), /private content/);

    const storedConflict = importLiveScans({
      database,
      scans: [{ events: [sourceConflict] }],
    });
    assert.deepEqual(storedConflict.quarantine, {
      invalidOrUnsupported: 0,
      conflictingSourceEvent: 0,
      conflictingStoredEvent: 1,
    });
    assert.equal(storedConflict.insertedEvents, 0);
    assert.equal(storedConflict.savedForecasts, 0);
    assert.equal(storedConflict.quarantinedEvents, 1);
    assert.equal(database.countEvents(runAlias('quarantine')), 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('same-timestamp lifecycle events use semantic order and never invent training duration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-tie-'));
  const database = new AgentEtaDatabase(join(directory, 'tie.sqlite'));
  try {
    const at = '2026-08-01T00:00:00Z';
    const scan = {
      events: [
        liveEvent({ eventId: 'a-terminal', runId: 'tie', at, kind: 'run_succeeded' }),
        liveEvent({ eventId: 'z-start', runId: 'tie', at, kind: 'run_started', data: { task_class: 'other' } }),
      ],
    };
    const result = importLiveScans({ database, scans: [scan] });
    const row = database.loadRun(runAlias('tie'));
    assert.equal(row.state.status, 'succeeded');
    assert.equal(row.state.startedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(row.state.finishedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(row.outcome_minutes, 0);
    assert.equal(result.learningOutcomes, 0);
    assert.equal(database.countHistory('live_adapter'), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed import rolls back raw events so retry can still create every forecast', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-live-atomic-'));
  const database = new AgentEtaDatabase(join(directory, 'atomic.sqlite'));
  const originalSaveForecast = database.saveForecast.bind(database);
  let failOnce = true;
  database.saveForecast = (input) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash after event insert');
    }
    return originalSaveForecast(input);
  };
  try {
    assert.throws(
      () => importLiveScans({ database, scans: [fixtureScan()] }),
      /simulated crash/,
    );
    assert.equal(database.countEventsByAdapter('codex-jsonl'), 0);
    assert.equal(database.countHistory('live_adapter'), 0);

    const retry = importLiveScans({ database, scans: [fixtureScan()] });
    assert.equal(retry.insertedEvents, 7);
    assert.equal(retry.savedForecasts, 7);
    assert.equal(database.countEventsByAdapter('codex-jsonl'), 7);
    assert.equal(database.listForecasts(runAlias('a')).length, 2);
    assert.equal(database.listForecasts(runAlias('b')).length, 5);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
