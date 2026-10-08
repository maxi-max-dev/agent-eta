import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importLiveScans } from '../src/adapters/importer.js';
import { applyReporterObservation } from '../src/reporter/ingest.js';
import {
  createWorksetState,
  forecastWorkset,
  reduceWorksetEvent,
} from '../src/scopes/index.js';
import {
  buildLatestLiveSnapshot,
  createApp,
} from '../src/server/main.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const BASE = '2026-08-29T10:00:00.000Z';
const MINUTE = 60_000;

function repeated(value) {
  return String(value).repeat(20);
}

function runId(value) {
  return `codex-run-${repeated(value)}`;
}

function codexEventId(value) {
  return `codex-event-${repeated(value)}`;
}

function sessionId(value) {
  return `codex-session-${repeated(value)}`;
}

function worksetId(type, value) {
  return `${type}-workset-${repeated(value)}`;
}

function worksetEventId(value) {
  return `workset-event-${repeated(value)}`;
}

function memberId(value) {
  return `workset-member-${repeated(value)}`;
}

function parallelGroup(value) {
  return `parallel-group-${repeated(value)}`;
}

function isoAfter(minutes) {
  return new Date(Date.parse(BASE) + minutes * MINUTE).toISOString();
}

function liveEvent({
  eventToken,
  runToken,
  occurredAt,
  observedAt = occurredAt,
  kind,
  data = {},
}) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: codexEventId(eventToken),
    run_id: runId(runToken),
    provider: 'codex',
    native_session_id: sessionId(runToken),
    occurred_at: occurredAt,
    observed_at: observedAt,
    kind,
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data,
  };
}

function saveLiveForecast(database, {
  runToken,
  eventToken,
  at,
  status = 'running',
  kind = 'run_started',
  startedAt = BASE,
  finishedAt = null,
  forecastStatus = 'forecast',
  lower = 3,
  p50 = 5,
  p80 = 9,
}) {
  const event = liveEvent({
    eventToken,
    runToken,
    occurredAt: at,
    kind,
    data: kind === 'run_started' ? { task_class: 'other' } : {},
  });
  database.insertEvent(event);
  database.saveRun({
    runId: runId(runToken),
    provider: 'codex',
    status,
    startedAt,
    finishedAt,
    activeElapsedMs: 0,
    planRevision: 0,
    steps: [],
  }, event);
  database.saveForecast({
    runId: runId(runToken),
    eventId: event.event_id,
    observedAt: at,
    forecast: {
      mode: 'run_fallback',
      status: forecastStatus,
      lowerMinutes: lower,
      p50Minutes: p50,
      p80Minutes: p80,
      raw: { historyCount: 4 },
    },
    display: { headline: 'stored', range: 'stored', reason: 'stored', tone: 'working' },
  });
  return event;
}

function persistBareRun(database, token) {
  database.saveRun({
    runId: runId(token),
    provider: 'codex',
    status: 'running',
    startedAt: BASE,
    finishedAt: null,
    activeElapsedMs: 0,
    planRevision: 0,
    steps: [],
  });
}

function worksetMember({ token, runToken, orderIndex, executionGroup = null }) {
  return {
    member_id: memberId(token),
    child_type: 'run',
    child_id: runId(runToken),
    order_index: orderIndex,
    execution_group: executionGroup,
    attached_at: BASE,
    detached_at: null,
  };
}

function taskWorksetEvent({
  worksetToken,
  eventToken,
  at = BASE,
  kind = 'workset_declared',
  data,
}) {
  return {
    schema_version: 'agenteta.workset-event/1',
    event_id: worksetEventId(eventToken),
    workset_id: worksetId('task', worksetToken),
    workset_type: 'task',
    occurred_at: at,
    kind,
    data,
  };
}

function replayWorkset(database, id) {
  let state = createWorksetState(id, 'task');
  for (const { event } of database.listWorksetEvents(id)) {
    state = reduceWorksetEvent(state, event);
  }
  return state;
}

function formatClock(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

test('workset persistence converges with chronological replay after same-revision events arrive out of order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-adversarial-order-'));
  const filename = join(directory, 'order.sqlite');
  let database = new AgentEtaDatabase(filename);
  const id = worksetId('task', '1');
  try {
    persistBareRun(database, '1');
    const declared = taskWorksetEvent({
      worksetToken: '1',
      eventToken: '1',
      data: {
        revision: 1,
        workset_closed: true,
        members: [worksetMember({ token: '1', runToken: '1', orderIndex: 0 })],
      },
    });
    const declarationState = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    database.saveWorksetProjection(declarationState, declared);

    const older = taskWorksetEvent({
      worksetToken: '1',
      eventToken: '2',
      at: isoAfter(1),
      kind: 'workset_status_changed',
      data: { status: 'running' },
    });
    const newer = taskWorksetEvent({
      worksetToken: '1',
      eventToken: '3',
      at: isoAfter(2),
      kind: 'workset_status_changed',
      data: { status: 'paused' },
    });
    database.saveWorksetProjection(reduceWorksetEvent(declarationState, newer), newer);

    // A valid implementation may reject the stale event or accept it and rebuild
    // from the persisted log. Either way, its materialized row must converge with
    // chronological replay and must not resurrect the older running state.
    try {
      database.saveWorksetProjection(reduceWorksetEvent(declarationState, older), older);
    } catch (error) {
      assert.match(String(error?.message), /STALE|OUT_OF_ORDER/);
    }
    database.close();

    database = new AgentEtaDatabase(filename);
    const replayed = replayWorkset(database, id);
    const stored = database.loadWorkset(id);
    assert.equal(replayed.status, 'paused');
    assert.equal(stored.status, replayed.status);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an empty membership revision cannot gain members through a heartbeat projection', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    persistBareRun(database, '4');
    const id = worksetId('task', '4');
    const declared = taskWorksetEvent({
      worksetToken: '4',
      eventToken: '4',
      data: { revision: 1, workset_closed: true, members: [] },
    });
    const declarationState = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    database.saveWorksetProjection(declarationState, declared);
    const heartbeat = taskWorksetEvent({
      worksetToken: '4',
      eventToken: '5',
      at: isoAfter(1),
      kind: 'workset_heartbeat',
      data: {},
    });
    const forged = reduceWorksetEvent(declarationState, heartbeat);
    forged.members.push({
      memberId: memberId('4'),
      childType: 'run',
      childId: runId('4'),
      orderIndex: 0,
      executionGroup: null,
      attachedAt: BASE,
      detachedAt: null,
    });
    assert.throws(
      () => database.saveWorksetProjection(forged, heartbeat),
      /WORKSET_REVISION_MEMBERS_CONFLICT/,
    );
    assert.equal(database.loadWorkset(id).members.length, 0);
  } finally {
    database.close();
  }
});

test('workset storage cannot persist a materialized membership that is not derivable from its event', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    persistBareRun(database, '5');
    persistBareRun(database, '6');
    const id = worksetId('task', '5');
    const declaredMember = worksetMember({ token: '5', runToken: '5', orderIndex: 0 });
    const declared = taskWorksetEvent({
      worksetToken: '5',
      eventToken: '5',
      data: { revision: 1, workset_closed: true, members: [declaredMember] },
    });
    const forged = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    forged.members = [{
      memberId: memberId('6'),
      childType: 'run',
      childId: runId('6'),
      orderIndex: 0,
      executionGroup: null,
      attachedAt: BASE,
      detachedAt: null,
    }];

    try {
      database.saveWorksetProjection(forged, declared);
    } catch (error) {
      assert.match(String(error?.message), /STATE_EVENT_MISMATCH|PROJECTION_MISMATCH|REVISION_MEMBERS_CONFLICT/);
    }
    const stored = database.loadWorkset(id);
    if (stored === null) {
      assert.equal(database.listWorksetEvents(id).length, 0);
    } else {
      assert.equal(stored.members.length, 1);
      assert.equal(stored.members[0].childId, declaredMember.child_id);
      assert.deepEqual(stored.members, replayWorkset(database, id).members);
    }
  } finally {
    database.close();
  }
});

test('workset storage rejects a forged revised projection and rolls the event back', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    for (const token of ['7', '8', '9']) persistBareRun(database, token);
    const id = worksetId('task', '7');
    const declaredMember = worksetMember({ token: '7', runToken: '7', orderIndex: 0 });
    const declared = taskWorksetEvent({
      worksetToken: '7',
      eventToken: '7',
      data: { revision: 1, workset_closed: false, members: [declaredMember] },
    });
    const revisionOne = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    database.saveWorksetProjection(revisionOne, declared);

    const revisedMember = worksetMember({ token: '8', runToken: '8', orderIndex: 0 });
    const revised = taskWorksetEvent({
      worksetToken: '7',
      eventToken: '8',
      at: isoAfter(1),
      kind: 'workset_revised',
      data: { revision: 2, workset_closed: true, members: [revisedMember] },
    });
    const forgedRevision = reduceWorksetEvent(revisionOne, revised);
    forgedRevision.members = [{
      memberId: memberId('9'),
      childType: 'run',
      childId: runId('9'),
      orderIndex: 0,
      executionGroup: null,
      attachedAt: BASE,
      detachedAt: null,
    }];

    assert.throws(
      () => database.saveWorksetProjection(forgedRevision, revised),
      /WORKSET_STATE_EVENT_MISMATCH|WORKSET_REVISION_MEMBERS_CONFLICT/,
    );
    const stored = database.loadWorkset(id);
    assert.equal(stored.revision, 1);
    assert.equal(stored.members[0].childId, declaredMember.child_id);
    assert.equal(database.listWorksetEvents(id).length, 1);
  } finally {
    database.close();
  }
});

test('multi-member workset UI preserves the conservative upper bound instead of substituting P50', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    saveLiveForecast(database, { runToken: '6', eventToken: '6', at: BASE });
    saveLiveForecast(database, { runToken: '7', eventToken: '7', at: BASE });
    const id = worksetId('task', '6');
    const first = worksetMember({ token: '6', runToken: '6', orderIndex: 0 });
    const second = worksetMember({ token: '7', runToken: '7', orderIndex: 1 });
    const declared = taskWorksetEvent({
      worksetToken: '6',
      eventToken: '6',
      data: { revision: 1, workset_closed: true, members: [first, second] },
    });
    const state = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    database.saveWorksetProjection(state, declared);
    const forecast = forecastWorkset({
      state,
      childProjections: [
        { memberId: first.member_id, status: 'running', lowerMinutes: 3, p50Minutes: 5, p80Minutes: 9 },
        { memberId: second.member_id, status: 'scheduled', lowerMinutes: 4, p50Minutes: 7, p80Minutes: 11 },
      ],
    });
    assert.equal(forecast.p80Minutes, null);
    assert.equal(forecast.upperMinutes, 20);
    database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: BASE,
      forecast,
    });

    const selected = buildLatestLiveSnapshot(database).selectionId;
    const snapshot = buildLatestLiveSnapshot(database, { selectionId: selected, scope: 'task' });
    const expectedUpperClock = formatClock(new Date(Date.parse(BASE) + 20 * MINUTE));
    assert.equal(snapshot.forecast.upperMinutes, 20);
    assert.match(snapshot.display.range, new RegExp(expectedUpperClock.replace(':', '\\:')));
  } finally {
    database.close();
  }
});

test('quantile-only parallel aggregation never claims it performed sample-wise max', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    saveLiveForecast(database, { runToken: '8', eventToken: '8', at: BASE });
    saveLiveForecast(database, { runToken: '9', eventToken: '9', at: BASE });
    const id = worksetId('task', '8');
    const group = parallelGroup('8');
    const first = worksetMember({ token: '8', runToken: '8', orderIndex: 0, executionGroup: group });
    const second = worksetMember({ token: '9', runToken: '9', orderIndex: 1, executionGroup: group });
    const declared = taskWorksetEvent({
      worksetToken: '8',
      eventToken: '8',
      data: { revision: 1, workset_closed: true, members: [first, second] },
    });
    const state = reduceWorksetEvent(createWorksetState(id, 'task'), declared);
    database.saveWorksetProjection(state, declared);
    const forecast = forecastWorkset({
      state,
      childProjections: [
        { memberId: first.member_id, status: 'running', lowerMinutes: 2, p50Minutes: 6, p80Minutes: 10 },
        { memberId: second.member_id, status: 'running', lowerMinutes: 4, p50Minutes: 8, p80Minutes: 12 },
      ],
    });
    database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: BASE,
      forecast,
    });

    const selected = buildLatestLiveSnapshot(database).selectionId;
    const snapshot = buildLatestLiveSnapshot(database, { selectionId: selected, scope: 'task' });
    assert.doesNotMatch(snapshot.display.reason, /sample-wise max/i);
  } finally {
    database.close();
  }
});

for (const [index, status] of ['failed', 'cancelled'].entries()) {
  test(`${status} terminal retains actual duration and initial-vs-actual comparison`, () => {
    const database = new AgentEtaDatabase(':memory:');
    const runToken = status === 'failed' ? 'a' : 'b';
    const startToken = status === 'failed' ? 'a' : 'c';
    const finishToken = status === 'failed' ? 'b' : 'd';
    try {
      saveLiveForecast(database, {
        runToken,
        eventToken: startToken,
        at: BASE,
        lower: 5,
        p50: 10,
        p80: 15,
      });
      saveLiveForecast(database, {
        runToken,
        eventToken: finishToken,
        at: isoAfter(12 + index),
        status,
        kind: status === 'failed' ? 'run_failed' : 'run_cancelled',
        startedAt: BASE,
        finishedAt: isoAfter(12 + index),
        forecastStatus: 'terminal',
        lower: 0,
        p50: 0,
        p80: 0,
      });
      const snapshot = buildLatestLiveSnapshot(database);
      assert.equal(snapshot.status, status);
      assert.match(snapshot.display.remaining, /实际用时/);
      assert.match(snapshot.display.range, /初次预计.+实际/);
      assert.equal(snapshot.display.comparison.actualAt, isoAfter(12 + index));
    } finally {
      database.close();
    }
  });
}

test('live importer history requires terminal receipt observation before the target landmark', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    const sourceStart = liveEvent({
      eventToken: '1',
      runToken: '1',
      occurredAt: '2026-08-29T09:50:00.000Z',
      kind: 'run_started',
      data: { task_class: 'other' },
    });
    const sourceTerminal = liveEvent({
      eventToken: '2',
      runToken: '1',
      occurredAt: '2026-08-29T10:00:00.000Z',
      observedAt: '2026-08-29T12:00:00.000Z',
      kind: 'run_succeeded',
    });
    const targetStart = liveEvent({
      eventToken: '3',
      runToken: '2',
      occurredAt: '2026-08-29T11:00:00.000Z',
      kind: 'run_started',
      data: { task_class: 'other' },
    });
    // Persist the late-observed terminal first, then backfill the earlier target
    // landmark. Sorting a single scan by observed_at would accidentally hide the
    // database-history leak this test is meant to falsify.
    importLiveScans({ database, scans: [{ events: [sourceStart, sourceTerminal] }] });
    importLiveScans({ database, scans: [{ events: [targetStart] }] });

    const targetForecast = database.listForecasts(runId('2'))[0];
    assert.equal(targetForecast.observed_at, targetStart.observed_at);
    assert.equal(targetForecast.forecast.raw.historyCount, 0);
  } finally {
    database.close();
  }
});

test('an unmatched Reporter receipt is reconciled exactly once after lifecycle import and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-adversarial-reporter-'));
  const filename = join(directory, 'reporter.sqlite');
  const receipt = '2026-08-29T10:01:01.000Z';
  const report = {
    schema_version: 'agenteta.reporter/1',
    provider: 'codex',
    run_id: runId('3'),
    reported_at: '2026-08-29T10:01:00.000Z',
    task_class: 'coding',
    eligible_large_task: true,
    model_self_eta_minutes: 10,
    plan_present: false,
    plan_step_count: 0,
    plan_adherence: 'not_applicable',
  };
  let database = new AgentEtaDatabase(filename);
  try {
    const unmatched = applyReporterObservation(database, report, { receivedAt: receipt });
    assert.equal(unmatched.matched, false);
    database.close();

    database = new AgentEtaDatabase(filename);
    const start = liveEvent({
      eventToken: '4',
      runToken: '3',
      occurredAt: BASE,
      kind: 'run_started',
      data: { task_class: 'other' },
    });
    importLiveScans({ database, scans: [{ events: [start] }] });
    applyReporterObservation(database, report, { receivedAt: receipt });

    const receiptForecasts = database.listForecasts(runId('3'))
      .filter((forecast) => forecast.observed_at === receipt);
    assert.equal(receiptForecasts.length, 1);
    assert.equal(receiptForecasts[0].forecast.raw.reporterReceiptLandmark.receivedAt, receipt);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema-v7 restart recovery never leaves a durable workset event without its forecast', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-adversarial-workset-gap-'));
  const filename = join(directory, 'gap.sqlite');
  let database = new AgentEtaDatabase(filename);
  try {
    saveLiveForecast(database, { runToken: 'e', eventToken: 'e', at: BASE });
    const id = worksetId('task', 'e');
    const declared = taskWorksetEvent({
      worksetToken: 'e',
      eventToken: 'e',
      data: {
        revision: 1,
        workset_closed: true,
        members: [worksetMember({ token: 'e', runToken: 'e', orderIndex: 0 })],
      },
    });
    const state = reduceWorksetEvent(createWorksetState(id, 'task'), declared);

    // This is the crash boundary exposed by the current two-call API: the event
    // transaction commits, then the process exits before saveWorksetForecast.
    database.saveWorksetProjection(state, declared);
    database.close();

    database = new AgentEtaDatabase(filename);
    const gaps = database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM workset_events AS event
      LEFT JOIN workset_forecast_snapshots AS forecast
        ON forecast.workset_id = event.workset_id
        AND forecast.event_id = event.event_id
      WHERE forecast.snapshot_id IS NULL
    `).get();
    assert.equal(Number(gaps.count), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('frozen replay fail-once leaves no partial state and restart retry commits exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-adversarial-replay-'));
  const filename = join(directory, 'replay.sqlite');
  let app = createApp({ databasePath: filename });
  try {
    const beforeProjection = structuredClone(app.getProjection());
    const run = beforeProjection.state.runId;
    const nextEvent = app.fixtures.get(beforeProjection.fixtureId).events[beforeProjection.cursor];
    const before = {
      events: app.database.countEvents(run),
      forecasts: app.database.listForecasts(run).length,
      run: app.database.loadRun(run),
      replay: app.database.loadReplayState(),
    };
    const saveRun = app.database.saveRun.bind(app.database);
    let failOnce = true;
    app.database.saveRun = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('INJECTED_REPLAY_SAVE_FAILURE');
      }
      return saveRun(...args);
    };

    assert.throws(() => app.next(), /INJECTED_REPLAY_SAVE_FAILURE/);
    assert.equal(app.database.loadEvent(nextEvent.event_id), null);
    assert.equal(app.database.countEvents(run), before.events);
    assert.equal(app.database.listForecasts(run).length, before.forecasts);
    assert.deepEqual(app.database.loadRun(run), before.run);
    assert.deepEqual(app.database.loadReplayState(), before.replay);
    assert.deepEqual(app.getProjection(), beforeProjection);

    app.database.saveRun = saveRun;
    await app.close();
    app = createApp({ databasePath: filename });
    assert.equal(app.getProjection().cursor, beforeProjection.cursor);

    const retried = app.next();
    assert.equal(retried.cursor, beforeProjection.cursor + 1);
    assert.equal(app.database.countEvents(run), before.events + 1);
    assert.equal(app.database.listForecasts(run).length, before.forecasts + 1);
    assert.equal(app.database.loadRun(run).state.seenEventIds.length, before.events + 1);
    assert.equal(app.database.loadReplayState().cursor, beforeProjection.cursor + 1);
    assert.equal(app.database.db.prepare(`
      SELECT COUNT(*) AS count FROM forecast_snapshots WHERE event_id = ?
    `).get(nextEvent.event_id).count, 1);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
