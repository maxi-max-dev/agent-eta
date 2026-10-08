import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLatestLiveSnapshot,
  createApp,
  isLiveSnapshotFresh,
} from '../src/server/main.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function collectKeys(value, keys = []) {
  if (!value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

test('live UI snapshot has an honest empty state', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    const snapshot = buildLatestLiveSnapshot(database);
    assert.equal(snapshot.kind, 'live_snapshot');
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.isRealtime, false);
    assert.equal(snapshot.display.headline, '暂无实机快照');
    assert.match(snapshot.display.reason, /不会假装实时监听/);
  } finally {
    database.close();
  }
});

test('live UI snapshot exposes only a saved forecast projection, never IDs or stored text', () => {
  const database = new AgentEtaDatabase(':memory:');
  const secret = 'DO-NOT-LEAK prompt /Users/example/private command';
  const event = {
    schema_version: 1,
    event_id: 'private-event-id',
    run_id: 'private-run-id',
    occurred_at: '2026-08-29T03:14:30.000Z',
    observed_at: '2026-08-29T03:14:30.168Z',
    kind: 'plan_revised',
    provider: 'codex',
    source: { adapter: 'codex-jsonl', mode: 'local_read_only' },
    data: { prompt: secret },
  };
  const state = {
    runId: event.run_id,
    provider: 'codex',
    status: 'running',
    startedAt: '2026-08-29T03:10:00.000Z',
    activeElapsedMs: 270_000,
    planRevision: 1,
    steps: [{ id: 'private-step-id', label: secret, class: 'other', status: 'active' }],
  };

  try {
    database.insertEvent(event);
    database.saveRun(state, event);
    database.savePlanSteps(state);
    database.saveForecast({
      runId: state.runId,
      eventId: event.event_id,
      observedAt: event.observed_at,
      forecast: {
        mode: 'plan_conditioned',
        status: 'forecast',
        p50Minutes: 2,
        p80Minutes: 4,
        lowerMinutes: 1,
      },
      display: { headline: secret, range: secret, currentStep: secret, reason: secret, tone: 'working' },
    });
    database.insertEvent({
      ...event,
      event_id: 'zz-unassociated-event',
      kind: 'retry_started',
    });

    const snapshot = buildLatestLiveSnapshot(database);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.isRealtime, false);
    assert.equal(snapshot.provider, 'Codex');
    assert.equal(snapshot.forecast.mode, 'plan_conditioned');
    assert.match(snapshot.display.headline, /^预计 \d{2}:\d{2} 完成$/);
    assert.match(snapshot.display.range, /^大致 \d{2}:\d{2}–\d{2}:\d{2}$/);
    assert.equal(snapshot.display.currentStep, '正在执行任务');
    assert.match(snapshot.display.reason, /计划发生变化/);

    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /private|DO-NOT-LEAK|\/Users\/|command|prompt/i);
    const keys = collectKeys(snapshot);
    assert.ok(!keys.some((key) => /(^|_)(run|session|event|step)_?id$/i.test(key)), keys.join(', '));
  } finally {
    database.close();
  }
});

test('live snapshot endpoint is GET-only, no-store, and empty without imported live rows', async (t) => {
  const app = createApp({ databasePath: ':memory:' });
  await new Promise((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => app.close());
  const address = app.server.address();
  const url = `http://127.0.0.1:${address.port}/api/live/latest`;

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).available, false);

  const mutation = await fetch(url, { method: 'POST' });
  assert.equal(mutation.status, 404);
});

test('live freshness expires completed and overdue work but preserves explicit input waits', () => {
  const base = {
    available: true,
    capturedAt: '2026-08-29T04:00:00.000Z',
    display: { tone: 'done' },
    forecast: { p80Minutes: 0 },
  };
  assert.equal(isLiveSnapshotFresh(base, new Date('2026-08-29T04:14:59.000Z')), true);
  assert.equal(isLiveSnapshotFresh(base, new Date('2026-08-29T04:16:00.000Z')), false);
  assert.equal(isLiveSnapshotFresh({
    ...base,
    display: { tone: 'working' },
    forecast: { p80Minutes: 30 },
  }, new Date('2026-08-29T04:44:00.000Z')), true);
  assert.equal(isLiveSnapshotFresh({
    ...base,
    display: { tone: 'working' },
    forecast: { p80Minutes: 30 },
  }, new Date('2026-08-29T04:46:00.000Z')), false);
  assert.equal(isLiveSnapshotFresh({
    ...base,
    display: { tone: 'waiting' },
  }, new Date('2026-08-30T04:00:00.000Z')), true);
});
