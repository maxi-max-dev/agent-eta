import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server/main.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function writeSession(file) {
  const records = [
    {
      timestamp: '2026-08-29T04:00:00.000Z',
      type: 'session_meta',
      payload: {
        session_id: 'private-native-session',
        timestamp: '2026-08-29T04:00:00.000Z',
      },
    },
    {
      timestamp: '2026-08-29T04:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'private-turn',
        started_at: '2026-08-29T04:00:01.000Z',
      },
    },
    {
      timestamp: '2026-08-29T04:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'update_plan',
        call_id: 'private-call',
        arguments: JSON.stringify({ plan: [{ step: 'private label', status: 'in_progress' }] }),
      },
    },
    {
      timestamp: '2026-08-29T04:01:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'private-turn',
        completed_at: '2026-08-29T04:01:01.000Z',
      },
    },
  ];
  writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached');
}

test('one-command app watcher imports new events, exposes safe status, and restarts idempotently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-shadow-server-'));
  const databasePath = join(directory, 'shadow.sqlite');
  const sessionFile = join(directory, 'session.jsonl');
  writeSession(sessionFile);

  let app = createApp({
    databasePath,
    liveWatchEnabled: true,
    liveWatchRoot: directory,
    liveWatchIntervalMs: 60_000,
    wallClock: () => new Date('2026-08-29T04:02:00.000Z'),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const address = app.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const status = await waitFor(async () => {
      const response = await fetch(`${base}/api/live/status`);
      const value = await response.json();
      return value.lastSuccessAt ? value : null;
    });
    assert.equal(status.kind, 'live_watch_status');
    assert.equal(status.enabled, true);
    assert.equal(status.running, true);
    assert.equal(status.errorCode, null);

    const snapshot = await (await fetch(`${base}/api/live/latest`)).json();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.isRealtime, true);
    assert.equal(snapshot.display.headline, '已完成');
    const publicJson = JSON.stringify({ status, snapshot });
    assert.doesNotMatch(publicJson, /private|session\.jsonl|agent-eta-shadow-server/);
  } finally {
    await app.close();
  }

  let database = new AgentEtaDatabase(databasePath);
  assert.equal(database.countEventsByAdapter('codex-jsonl'), 4);
  assert.equal(database.loadLiveWatchState().running, false);
  database.close();

  app = createApp({
    databasePath,
    liveWatchEnabled: true,
    liveWatchRoot: directory,
    liveWatchIntervalMs: 60_000,
    wallClock: () => new Date('2026-08-29T04:02:00.000Z'),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await waitFor(() => app.getLiveWatchStatus().lastSuccessAt);
  await app.close();

  database = new AgentEtaDatabase(databasePath);
  assert.equal(database.countEventsByAdapter('codex-jsonl'), 4, 'restart scan is idempotent');
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test('missing watcher root is an explicit degraded state', async () => {
  const app = createApp({
    databasePath: ':memory:',
    liveWatchEnabled: true,
    liveWatchRoot: '/definitely/missing/agent-eta-root',
  });
  assert.deepEqual(app.getLiveWatchStatus(), {
    kind: 'live_watch_status',
    enabled: true,
    running: false,
    status: 'degraded',
    lastScanAt: null,
    lastSuccessAt: null,
    lastChangeAt: null,
    errorCode: 'WATCH_ROOT_UNAVAILABLE',
    pollIntervalMs: null,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  await app.close();
});

test('app close waits for an in-flight watcher before persisting stopped state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-shadow-close-'));
  const databasePath = join(directory, 'shadow.sqlite');
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  const app = createApp({
    databasePath,
    liveWatchEnabled: true,
    liveWatchRoot: directory,
    liveWatchIntervalMs: 60_000,
    liveWatchOperations: { discover: () => discovery },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = app.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  releaseDiscovery([]);
  await close;

  const database = new AgentEtaDatabase(databasePath);
  assert.equal(database.loadLiveWatchState().running, false);
  assert.equal(database.loadLiveWatchState().status, 'stopped');
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
