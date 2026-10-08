import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCodexShadowWatcher } from '../src/live/watcher.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function alias(prefix, value) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function startEvent() {
  const at = '2026-08-29T00:00:00.000Z';
  return {
    schema_version: 'agenteta.event/1',
    event_id: alias('codex-event', 'watch-start'),
    run_id: alias('codex-run', 'watch-run'),
    provider: 'codex',
    native_session_id: alias('codex-session', 'watch-session'),
    occurred_at: at,
    observed_at: at,
    kind: 'run_started',
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data: { task_class: 'other' },
  };
}

function manualTimers() {
  let callback = null;
  let cleared = null;
  return {
    setInterval(fn) {
      callback = fn;
      return 17;
    },
    clearInterval(handle) {
      cleared = handle;
    },
    fire() {
      return callback?.();
    },
    cleared() {
      return cleared;
    },
  };
}

test('watcher uses overlap discovery, scans only changed JSONL and relies on event-id idempotency', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-watcher-'));
  const database = new AgentEtaDatabase(join(directory, 'watch.sqlite'));
  const reports = [];
  const updates = [];
  const savedStates = [];
  const sinceValues = [];
  const privateFile = '/private/Max/project/secret-session.jsonl';
  let discoveryCall = 0;
  let scanCalls = 0;
  const clock = [100_000, 102_000, 104_000];
  try {
    const watcher = createCodexShadowWatcher({
      root: '/private/Max/.codex/sessions',
      database,
      now: () => clock.shift(),
      initialLookbackMs: 10_000,
      overlapMs: 5_000,
      onReport: (report) => reports.push(report),
      onUpdate: (report) => updates.push(report),
      saveState: (state) => savedStates.push(state),
      discover: async ({ since }) => {
        sinceValues.push(since);
        discoveryCall += 1;
        return [{
          file: privateFile,
          modifiedAt: discoveryCall < 3
            ? '1970-01-01T00:01:39.000Z'
            : '1970-01-01T00:01:43.000Z',
          sizeBytes: discoveryCall < 3 ? 100 : 120,
        }];
      },
      scan: async (file) => {
        assert.equal(file, privateFile);
        scanCalls += 1;
        return { events: [startEvent()] };
      },
    });

    const first = await watcher.scanOnce();
    const unchanged = await watcher.scanNow();
    const overlappedDuplicate = await watcher.scanOnce();
    assert.deepEqual(sinceValues, [90_000, 95_000, 97_000]);
    assert.equal(scanCalls, 2);
    assert.deepEqual(
      [first, unchanged, overlappedDuplicate].map((report) => ({
        ok: report.ok,
        scannedFiles: report.scannedFiles,
        insertedEvents: report.insertedEvents,
        savedForecasts: report.savedForecasts,
      })),
      [
        { ok: true, scannedFiles: 1, insertedEvents: 1, savedForecasts: 1 },
        { ok: true, scannedFiles: 0, insertedEvents: 0, savedForecasts: 0 },
        { ok: true, scannedFiles: 1, insertedEvents: 0, savedForecasts: 0 },
      ],
    );
    assert.equal(database.countEvents(alias('codex-run', 'watch-run')), 1);
    assert.equal(reports.length, 3);
    assert.equal(updates.length, 1, 'onUpdate fires only for a material insertion');
    assert.equal(savedStates.length, 3);
    assert.equal(Object.hasOwn(savedStates[0], 'file'), false);
    const publicJson = JSON.stringify({ reports, updates, status: watcher.getStatus(), savedStates });
    assert.equal(publicJson.includes('/private/'), false);
    assert.equal(publicJson.includes('secret-session'), false);
    assert.deepEqual(watcher.status().counters, {
      scans: 3,
      files: 2,
      insertedEvents: 1,
      savedForecasts: 1,
      failures: 0,
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stale restart watermark expands discovery without expanding realtime Goal provenance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-watcher-provenance-'));
  const database = new AgentEtaDatabase(join(directory, 'watch.sqlite'));
  const scanStarted = 1_000_000;
  const staleWatermark = 100_000;
  let discoverySince = null;
  let importOptions = null;
  try {
    const watcher = createCodexShadowWatcher({
      root: '/private/restart/catchup',
      database,
      now: () => scanStarted,
      initialLookbackMs: 10_000,
      overlapMs: 5_000,
      loadState: () => ({ watermarkMs: staleWatermark }),
      discover: async ({ since }) => {
        discoverySince = since;
        return [{
          file: '/private/restart/catchup/session.jsonl',
          modifiedAt: new Date(scanStarted - 1).toISOString(),
          sizeBytes: 10,
        }];
      },
      scan: async () => ({ events: [] }),
      importScans: (options) => {
        importOptions = options;
        return { insertedEvents: 0, savedForecasts: 0 };
      },
    });
    const report = await watcher.scanOnce();
    assert.equal(report.ok, true);
    assert.equal(discoverySince, staleWatermark - 5_000);
    assert.equal(importOptions.goalPilotMode, 'live');
    assert.equal(
      importOptions.goalPilotLiveSinceAt,
      new Date(scanStarted - 10_000).toISOString(),
    );
    assert.equal(importOptions.receivedAt, new Date(scanStarted).toISOString());
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('start/stop use injected timers and concurrent scans coalesce safely', async () => {
  const timers = manualTimers();
  let releaseDiscovery;
  const pendingDiscovery = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const watcher = createCodexShadowWatcher({
    root: '/private/root',
    database: {},
    timers,
    now: () => 200_000,
    discover: () => pendingDiscovery,
    scan: async () => ({ events: [] }),
    importScans: () => ({ insertedEvents: 0, savedForecasts: 0 }),
  });

  assert.equal(await watcher.start({ immediate: false }), null);
  assert.equal(watcher.status().running, true);
  const first = watcher.scanOnce();
  assert.equal(watcher.status().status, 'scanning');
  let becameIdle = false;
  const idle = watcher.whenIdle().then(() => { becameIdle = true; });
  await Promise.resolve();
  assert.equal(becameIdle, false);
  const concurrent = await watcher.scanNow();
  assert.equal(concurrent.errorCode, 'WATCH_ALREADY_SCANNING');
  releaseDiscovery([]);
  assert.equal((await first).ok, true);
  await idle;
  assert.equal(becameIdle, true);
  watcher.stop();
  assert.equal(timers.cleared(), 17);
  assert.equal(watcher.getStatus().status, 'stopped');
});

test('watcher exposes only enumerated errors and never exception messages or paths', async () => {
  const privateText = '/Users/example/secret prompt and transcript';
  const stages = [
    {
      code: 'WATCH_DISCOVERY_FAILED',
      discover: async () => { throw new Error(privateText); },
      scan: async () => ({ events: [] }),
      importScans: () => ({ insertedEvents: 0, savedForecasts: 0 }),
    },
    {
      code: 'WATCH_SCAN_FAILED',
      discover: async () => [{ file: privateText, modifiedAt: '2026-08-29T00:00:00Z', sizeBytes: 1 }],
      scan: async () => { throw new Error(privateText); },
      importScans: () => ({ insertedEvents: 0, savedForecasts: 0 }),
    },
    {
      code: 'WATCH_IMPORT_FAILED',
      discover: async () => [{ file: privateText, modifiedAt: '2026-08-29T00:00:00Z', sizeBytes: 1 }],
      scan: async () => ({ events: [] }),
      importScans: () => { throw new Error(privateText); },
    },
  ];

  for (const stage of stages) {
    const watcher = createCodexShadowWatcher({
      root: privateText,
      database: {},
      now: () => 300_000,
      onReport: () => { throw new Error(privateText); },
      ...stage,
    });
    const report = await watcher.scanOnce();
    assert.equal(report.errorCode, stage.code);
    assert.equal(watcher.status().lastNotificationErrorCode, 'WATCH_CALLBACK_FAILED');
    const publicJson = JSON.stringify({ report, status: watcher.status() });
    assert.equal(publicJson.includes('/Users/'), false);
    assert.equal(publicJson.includes('prompt'), false);
    assert.equal(publicJson.includes('transcript'), false);
  }
});

test('watcher restores only structural state and disabled mode performs no discovery', async () => {
  let discoveries = 0;
  const watcher = createCodexShadowWatcher({
    root: '/private/root',
    database: {},
    enabled: false,
    now: () => 400_000,
    loadState: () => ({
      watermarkMs: 350_000,
      lastSuccessAt: '1970-01-01T00:05:50.000Z',
      lastChangeAt: '1970-01-01T00:05:40.000Z',
      counters: { scans: 2, files: 1, insertedEvents: 3, savedForecasts: 3, failures: 0 },
      file: '/private/must-be-ignored.jsonl',
    }),
    discover: async () => {
      discoveries += 1;
      return [];
    },
  });
  const report = await watcher.start();
  assert.equal(report.errorCode, 'WATCH_DISABLED');
  assert.equal(discoveries, 0);
  assert.equal(watcher.getStatus().enabled, false);
  assert.equal(JSON.stringify(watcher.getStatus()).includes('/private/'), false);
});
