import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveLiveSelections,
  buildLatestLiveSnapshot,
  createApp,
} from '../src/server/main.js';
import {
  WORKSET_EVENT_SCHEMA_VERSION,
  createWorksetState,
  forecastWorkset,
  reduceWorksetEvent,
} from '../src/scopes/index.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const BASE = '2026-08-29T10:00:00.000Z';
const GOAL_SOURCE = Object.freeze({
  provider: 'codex',
  sourceKind: 'codex_goal_shadow',
  sourceStatus: 'verified_structural',
  taskClass: 'other',
  eligibleLargeTask: null,
});

function liveEvent({ runId, eventId, at = BASE, kind = 'run_started', secret = null }) {
  return {
    schema_version: 1,
    event_id: eventId,
    run_id: runId,
    occurred_at: at,
    observed_at: at,
    kind,
    provider: 'codex',
    source: { adapter: 'codex-jsonl', mode: 'local_read_only' },
    data: secret ? { private_text: secret } : {},
  };
}

function saveLive(database, {
  runId,
  eventId,
  at = BASE,
  status = 'running',
  forecastStatus = 'forecast',
  p50 = 10,
  p80 = 16,
  lower = 6,
  startedAt = BASE,
  finishedAt = null,
  kind = 'run_started',
  secret = null,
} = {}) {
  const event = liveEvent({ runId, eventId, at, kind, secret });
  database.insertEvent(event);
  database.saveRun({
    runId,
    provider: 'codex',
    status,
    startedAt,
    finishedAt,
    activeElapsedMs: 0,
    planRevision: 0,
    steps: [],
  }, event);
  database.saveForecast({
    runId,
    eventId,
    observedAt: at,
    forecast: {
      mode: 'run_fallback',
      status: forecastStatus,
      p50Minutes: p50,
      p80Minutes: p80,
      lowerMinutes: lower,
      raw: { historyCount: 4 },
    },
    display: { headline: secret ?? 'stored', range: secret ?? 'stored', reason: secret ?? 'stored', tone: 'working' },
  });
}

function saveLiveGoalReceipt(database, { taskId, runId, at = BASE }) {
  const suffix = taskId.slice(-20);
  database.db.prepare(`
    INSERT INTO codex_goal_receipts(
      receipt_id, goal_id, run_id, occurred_at, first_received_at,
      last_received_at, first_ingest_mode, kind, fingerprint, workset_id,
      applied, censored, quarantined
    ) VALUES (?, ?, ?, ?, ?, ?, 'live', 'goal_active', ?, ?, 1, 0, 0)
  `).run(
    `codex-goal-event-${suffix}`,
    `codex-goal-${suffix}`,
    runId,
    at,
    at,
    at,
    `digest-${suffix}`,
    taskId,
  );
}

test('active endpoint projection is opaque and fixed selection never falls back to a newer run', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    saveLive(database, {
      runId: 'codex-run-00000000000000000001',
      eventId: 'event-private-1',
      at: '2026-08-29T10:01:00.000Z',
      status: 'needs_input',
      forecastStatus: 'needs_input',
      secret: 'DO-NOT-LEAK /Users/example/private prompt',
    });
    saveLive(database, {
      runId: 'codex-run-00000000000000000002',
      eventId: 'event-private-2',
      at: '2026-08-29T10:02:00.000Z',
    });
    const active = buildActiveLiveSelections(database, new Date('2026-08-29T10:03:00.000Z'));
    assert.equal(active.selections.length, 2);
    const selected = active.selections.find((item) => item.status === 'needs_input').selectionId;
    assert.match(selected, /^sel-[a-f0-9]{20}$/);
    const serialized = JSON.stringify(active);
    assert.doesNotMatch(serialized, /codex-run|event-private|DO-NOT-LEAK|Users|max\/private|prompt/i);
    assert.doesNotMatch(serialized, /runId|session|native|path|private_text/i);

    const before = buildLatestLiveSnapshot(database, { selectionId: selected });
    assert.equal(before.status, 'needs_input');
    saveLive(database, {
      runId: 'codex-run-00000000000000000003',
      eventId: 'event-private-3',
      at: '2026-08-29T10:03:30.000Z',
      p50: 99,
    });
    const after = buildLatestLiveSnapshot(database, { selectionId: selected });
    assert.equal(after.selectionId, selected);
    assert.equal(after.status, 'needs_input');
    assert.equal(after.forecast.p50Minutes, 10);
  } finally {
    database.close();
  }
});

test('a fresh explicit project remains discoverable when unrelated run snapshots fill the active limit', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    const runId = 'codex-run-00000000000000000004';
    saveLive(database, { runId, eventId: 'bound-run-event', at: BASE });
    const taskId = 'task-workset-00000000000000000004';
    const taskMemberId = 'workset-member-00000000000000000004';
    const taskDeclared = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000004',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: BASE,
      kind: 'workset_declared',
      data: {
        revision: 1,
        workset_closed: true,
        members: [{
          member_id: taskMemberId,
          child_type: 'run',
          child_id: runId,
          order_index: 0,
          execution_group: null,
          attached_at: BASE,
          detached_at: null,
        }],
      },
    };
    const taskState = reduceWorksetEvent(createWorksetState(taskId, 'task'), taskDeclared);
    database.saveWorksetProjection(taskState, taskDeclared, { receivedAt: '2026-08-29T10:20:00.000Z' });
    database.saveWorksetForecast({
      worksetId: taskId,
      eventId: taskDeclared.event_id,
      observedAt: '2026-08-29T10:20:00.000Z',
      forecast: forecastWorkset({
        state: taskState,
        childProjections: [{
          memberId: taskMemberId,
          status: 'running',
          lowerMinutes: 4,
          p50Minutes: 8,
          p80Minutes: 12,
        }],
      }),
    });

    const projectId = 'project-workset-00000000000000000004';
    const projectMemberId = 'workset-member-00000000000000000005';
    const projectDeclared = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000005',
      workset_id: projectId,
      workset_type: 'project',
      occurred_at: BASE,
      kind: 'workset_declared',
      data: {
        revision: 1,
        workset_closed: true,
        members: [{
          member_id: projectMemberId,
          child_type: 'workset',
          child_id: taskId,
          order_index: 0,
          execution_group: null,
          attached_at: BASE,
          detached_at: null,
        }],
      },
    };
    const projectState = reduceWorksetEvent(createWorksetState(projectId, 'project'), projectDeclared);
    database.saveWorksetProjection(projectState, projectDeclared, { receivedAt: '2026-08-29T10:20:00.000Z' });
    database.saveWorksetForecast({
      worksetId: projectId,
      eventId: projectDeclared.event_id,
      observedAt: '2026-08-29T10:20:00.000Z',
      forecast: forecastWorkset({
        state: projectState,
        childProjections: [{
          memberId: projectMemberId,
          status: 'running',
          lowerMinutes: 4,
          p50Minutes: 8,
          p80Minutes: 12,
        }],
      }),
    });

    for (let index = 1; index <= 8; index += 1) {
      saveLive(database, {
        runId: `codex-run-${String(index + 100).padStart(20, '0')}`,
        eventId: `unrelated-${index}`,
        at: `2026-08-29T10:${String(20 + index).padStart(2, '0')}:00.000Z`,
      });
    }

    const active = buildActiveLiveSelections(database, new Date('2026-08-29T10:29:00.000Z'));
    assert.equal(active.selections.length, 8);
    const bound = active.selections.find((item) => item.meta.scopeAvailability.project === 'available');
    assert.ok(bound, 'fresh explicit project must not be displaced by unrelated run snapshots');
    assert.equal(active.selections.indexOf(bound), 0);
    assert.equal(bound.observedAt, '2026-08-29T10:20:00.000Z');
    assert.doesNotMatch(JSON.stringify(active), /bound-run-event|unrelated-|codex-run|workset-/i);
  } finally {
    database.close();
  }
});

test('all explicit waits remove the absolute completion clock and expose only post-resume active time', () => {
  for (const [index, status] of ['needs_input', 'waiting_provider', 'blocked', 'paused'].entries()) {
    const database = new AgentEtaDatabase(':memory:');
    try {
      saveLive(database, {
        runId: `codex-run-${String(index + 10).padStart(20, '0')}`,
        eventId: `wait-event-${index}`,
        at: `2026-08-29T10:0${index}:00.000Z`,
        status,
        forecastStatus: status === 'needs_input' ? 'needs_input' : 'forecast',
      });
      const snapshot = buildLatestLiveSnapshot(database);
      assert.equal(snapshot.status, status);
      assert.doesNotMatch(snapshot.display.headline, /预计|\d{2}:\d{2}/);
      assert.doesNotMatch(snapshot.display.remaining, /\d{2}:\d{2}/);
      assert.match(snapshot.display.range, /(回复后|恢复后|解除后)约 \d+–\d+ 分钟/);
    } finally {
      database.close();
    }
  }
});

test('stale paused Goal tasks cannot crowd out a fresh run and null resume evidence stays unavailable', () => {
  const database = new AgentEtaDatabase(':memory:');
  let pinnedPausedSelection = null;
  try {
    for (let index = 0; index < 8; index += 1) {
      const number = 200 + index;
      const runId = `codex-run-${String(number).padStart(20, '0')}`;
      const taskId = `task-workset-${String(number).padStart(20, '0')}`;
      const memberId = `workset-member-${String(number).padStart(20, '0')}`;
      const declaredAt = `2026-08-30T10:${String(index).padStart(2, '0')}:00.000Z`;
      const pausedAt = `2026-08-30T10:${String(index).padStart(2, '0')}:30.000Z`;
      saveLive(database, {
        runId,
        eventId: `old-paused-run-${index}`,
        at: declaredAt,
        p50: 5,
        p80: 8,
        lower: 3,
      });
      const declared = {
        schema_version: WORKSET_EVENT_SCHEMA_VERSION,
        event_id: `workset-event-${String(number).padStart(20, '0')}`,
        workset_id: taskId,
        workset_type: 'task',
        occurred_at: declaredAt,
        kind: 'workset_declared',
        data: {
          revision: 1,
          workset_closed: false,
          members: [{
            member_id: memberId,
            child_type: 'run',
            child_id: runId,
            order_index: 0,
            execution_group: null,
            attached_at: declaredAt,
            detached_at: null,
          }],
        },
      };
      let state = reduceWorksetEvent(createWorksetState(taskId, 'task'), declared);
      database.saveWorksetProjection(state, declared, {
        receivedAt: declaredAt,
        forecast: forecastWorkset({
          state,
          childProjections: [{
            memberId,
            status: 'running',
            lowerMinutes: 3,
            p50Minutes: 5,
            p80Minutes: 8,
          }],
        }),
        source: GOAL_SOURCE,
      });
      saveLiveGoalReceipt(database, { taskId, runId, at: declaredAt });
      const paused = {
        schema_version: WORKSET_EVENT_SCHEMA_VERSION,
        event_id: `workset-event-${String(number + 100).padStart(20, '0')}`,
        workset_id: taskId,
        workset_type: 'task',
        occurred_at: pausedAt,
        kind: 'workset_status_changed',
        data: { status: 'paused' },
      };
      state = reduceWorksetEvent(state, paused);
      database.saveWorksetProjection(state, paused, {
        receivedAt: pausedAt,
        forecast: forecastWorkset({
          state,
          childProjections: [{
            memberId,
            status: 'failed',
            lowerMinutes: null,
            p50Minutes: null,
            p80Minutes: null,
          }],
        }),
      });
      if (index === 0) {
        pinnedPausedSelection = buildActiveLiveSelections(
          database,
          new Date('2026-08-30T10:01:00.000Z'),
        ).defaultSelectionId;
      }
    }

    saveLive(database, {
      runId: 'codex-run-00000000000000000999',
      eventId: 'fresh-unbound-run',
      at: '2026-08-30T11:59:00.000Z',
      p50: 10,
      p80: 16,
      lower: 6,
    });
    const active = buildActiveLiveSelections(database, new Date('2026-08-30T12:00:00.000Z'));
    assert.equal(active.selections.length, 1);
    assert.equal(active.selections[0].meta.defaultScope, 'run');
    assert.equal(active.selections[0].status, 'working');

    const pinned = buildLatestLiveSnapshot(database, {
      selectionId: pinnedPausedSelection,
      scope: 'task',
    });
    assert.equal(pinned.status, 'paused');
    assert.equal(pinned.display.confidence, 'unavailable');
    assert.equal(pinned.forecast.confidence, 'unavailable');
    assert.equal(pinned.forecast.p50Minutes, null);
    assert.match(pinned.display.remaining, /active 时间暂不可用/);
    assert.doesNotMatch(
      `${pinned.display.headline} ${pinned.display.remaining} ${pinned.display.range}`,
      /\d{2}:\d{2}/,
    );
  } finally {
    database.close();
  }
});

test('a task workset remains selectable and stops its clock across a stale run gap', () => {
  const database = new AgentEtaDatabase(':memory:');
  const runId = 'codex-run-00000000000000000018';
  const taskId = 'task-workset-00000000000000000018';
  const memberId = 'workset-member-00000000000000000018';
  const secret = 'DO-NOT-LEAK /Users/example/private objective';
  try {
    saveLive(database, {
      runId,
      eventId: 'stale-run-event',
      at: BASE,
      secret,
      p50: 5,
      p80: 8,
      lower: 3,
    });
    const priorRunSelection = buildLatestLiveSnapshot(database).selectionId;
    const declared = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000018',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: BASE,
      kind: 'workset_declared',
      data: {
        revision: 1,
        workset_closed: false,
        members: [{
          member_id: memberId,
          child_type: 'run',
          child_id: runId,
          order_index: 0,
          execution_group: null,
          attached_at: BASE,
          detached_at: null,
        }],
      },
    };
    let state = reduceWorksetEvent(createWorksetState(taskId, 'task'), declared);
    database.saveWorksetProjection(state, declared, { receivedAt: BASE, source: GOAL_SOURCE });
    saveLiveGoalReceipt(database, { taskId, runId, at: BASE });
    database.saveWorksetForecast({
      worksetId: taskId,
      eventId: declared.event_id,
      observedAt: BASE,
      forecast: forecastWorkset({
        state,
        childProjections: [{
          memberId,
          status: 'running',
          lowerMinutes: 3,
          p50Minutes: 5,
          p80Minutes: 8,
        }],
      }),
    });

    const blockedAt = '2026-08-30T10:00:00.000Z';
    const blocked = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000019',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: blockedAt,
      kind: 'workset_status_changed',
      data: { status: 'blocked' },
    };
    state = reduceWorksetEvent(state, blocked);
    database.saveWorksetProjection(state, blocked, { receivedAt: blockedAt });
    database.saveWorksetForecast({
      worksetId: taskId,
      eventId: blocked.event_id,
      observedAt: blockedAt,
      forecast: forecastWorkset({
        state,
        childProjections: [{
          memberId,
          status: 'running',
          lowerMinutes: 3,
          p50Minutes: 5,
          p80Minutes: 8,
        }],
      }),
    });
    saveLive(database, {
      runId,
      eventId: 'stale-run-terminal-event',
      at: '2026-08-30T10:01:00.000Z',
      status: 'succeeded',
      forecastStatus: 'terminal',
      p50: 0,
      p80: 0,
      lower: 0,
      finishedAt: '2026-08-30T10:01:00.000Z',
      kind: 'run_succeeded',
    });

    const active = buildActiveLiveSelections(database, new Date('2026-08-30T12:00:00.000Z'));
    assert.equal(active.selections.length, 1);
    assert.equal(active.selections[0].status, 'blocked');
    assert.equal(active.selections[0].meta.defaultScope, 'task');
    assert.equal(active.selections[0].meta.replacesSelectionId, priorRunSelection);
    assert.deepEqual(active.selections[0].meta.scopeAvailability, {
      run: 'available', task: 'available', project: 'unknown',
    });

    const task = buildLatestLiveSnapshot(database, {
      selectionId: active.defaultSelectionId,
      scope: 'task',
    });
    assert.equal(task.status, 'blocked');
    assert.equal(task.display.headline, '暂时阻塞');
    assert.equal(task.display.remaining, '解除后 active 时间暂不可用');
    assert.equal(task.display.range, '不预测等待何时结束');
    assert.equal(task.display.confidence, 'unavailable');
    assert.doesNotMatch(`${task.display.headline} ${task.display.remaining} ${task.display.range}`, /\d{2}:\d{2}/);
    assert.equal(task.forecast.p50Minutes, null);
    assert.equal(task.scope, 'task');

    const serialized = JSON.stringify({ active, task });
    assert.doesNotMatch(serialized, /codex-run|workset-|stale-run|DO-NOT-LEAK|Users|max\/private|objective/i);
    assert.equal(buildLatestLiveSnapshot(database, {
      selectionId: active.defaultSelectionId,
      scope: 'project',
    }).available, false, 'a task selection must not invent a project');

    for (const [offset, status] of ['needs_input', 'waiting_provider', 'paused'].entries()) {
      const occurredAt = `2026-08-30T10:${String((offset + 1) * 10).padStart(2, '0')}:00.000Z`;
      const waiting = {
        schema_version: WORKSET_EVENT_SCHEMA_VERSION,
        event_id: `workset-event-${String(21 + offset).padStart(20, '0')}`,
        workset_id: taskId,
        workset_type: 'task',
        occurred_at: occurredAt,
        kind: 'workset_status_changed',
        data: { status },
      };
      state = reduceWorksetEvent(state, waiting);
      database.saveWorksetProjection(state, waiting, { receivedAt: occurredAt });
      database.saveWorksetForecast({
        worksetId: taskId,
        eventId: waiting.event_id,
        observedAt: occurredAt,
        forecast: forecastWorkset({
          state,
          childProjections: [{
            memberId,
            status: 'running',
            lowerMinutes: 3,
            p50Minutes: 5,
            p80Minutes: 8,
          }],
        }),
      });
      const waitingActive = buildActiveLiveSelections(database, new Date('2026-08-30T13:00:00.000Z'));
      if (status === 'paused') {
        assert.equal(waitingActive.selections.length, 0, 'stale paused tasks leave the active picker');
      } else {
        assert.equal(waitingActive.selections[0].status, status);
      }
      const waitingSnapshot = buildLatestLiveSnapshot(database, {
        selectionId: status === 'paused' ? active.defaultSelectionId : waitingActive.defaultSelectionId,
        scope: 'task',
      });
      assert.equal(waitingSnapshot.status, status);
      assert.equal(waitingSnapshot.forecast.p50Minutes, null);
      assert.doesNotMatch(
        `${waitingSnapshot.display.headline} ${waitingSnapshot.display.remaining} ${waitingSnapshot.display.range}`,
        /\d{2}:\d{2}/,
      );
    }

    const completedAt = '2026-08-30T12:05:00.000Z';
    const completed = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000020',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: completedAt,
      kind: 'workset_succeeded',
      data: {},
    };
    state = reduceWorksetEvent(state, completed);
    database.saveWorksetProjection(state, completed, { receivedAt: completedAt });
    database.saveWorksetForecast({
      worksetId: taskId,
      eventId: completed.event_id,
      observedAt: completedAt,
      forecast: forecastWorkset({ state }),
    });
    const terminalActive = buildActiveLiveSelections(database, new Date('2026-08-30T12:10:00.000Z'));
    assert.equal(terminalActive.selections[0].status, 'succeeded');
    const terminal = buildLatestLiveSnapshot(database, {
      selectionId: terminalActive.defaultSelectionId,
      scope: 'task',
    });
    assert.equal(terminal.display.headline, '任务已完成');
    assert.doesNotMatch(terminal.display.headline, /预计|\d{2}:\d{2}/);
    assert.equal(
      buildActiveLiveSelections(database, new Date('2026-08-30T12:21:00.000Z')).selections.length,
      0,
      'terminal task is retained only for the terminal grace window',
    );
  } finally {
    database.close();
  }
});

test('verified open goal task is status-only, then sticky quarantine suppresses ETA and terminal truth', () => {
  const database = new AgentEtaDatabase(':memory:');
  const runId = 'codex-run-00000000000000000070';
  const taskId = 'task-workset-00000000000000000070';
  const memberId = 'workset-member-00000000000000000070';
  try {
    saveLive(database, {
      runId,
      eventId: 'verified-goal-run-event',
      at: BASE,
      p50: 60,
      p80: 120,
      lower: 30,
    });
    const runSelection = buildLatestLiveSnapshot(database).selectionId;
    const declared = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000070',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: BASE,
      kind: 'workset_declared',
      data: {
        revision: 1,
        workset_closed: false,
        members: [{
          member_id: memberId,
          child_type: 'run',
          child_id: runId,
          order_index: 0,
          execution_group: null,
          attached_at: BASE,
          detached_at: null,
        }],
      },
    };
    let state = reduceWorksetEvent(createWorksetState(taskId, 'task'), declared);
    const unknown = forecastWorkset({
      state,
      childProjections: [{
        memberId,
        status: 'running',
        lowerMinutes: 30,
        p50Minutes: 60,
        p80Minutes: 120,
      }],
    });
    assert.equal(unknown.status, 'unknown');
    database.saveWorksetProjection(state, declared, {
      receivedAt: BASE,
      forecast: unknown,
      source: GOAL_SOURCE,
    });
    saveLiveGoalReceipt(database, { taskId, runId, at: BASE });

    const active = buildActiveLiveSelections(database, new Date('2026-08-29T10:30:00.000Z'));
    assert.equal(active.selections.length, 1);
    assert.equal(active.selections[0].status, 'working');
    assert.equal(active.selections[0].meta.defaultScope, 'task');
    assert.equal(active.selections[0].meta.replacesSelectionId, runSelection);
    const taskSelection = active.defaultSelectionId;
    const statusOnly = buildLatestLiveSnapshot(database, { selectionId: taskSelection, scope: 'task' });
    assert.equal(statusOnly.available, true);
    assert.equal(statusOnly.status, 'working');
    assert.equal(statusOnly.display.headline, '任务进行中');
    assert.equal(statusOnly.display.remaining, 'ETA 证据不足');
    assert.equal(statusOnly.forecast.p50Minutes, null);
    assert.doesNotMatch(
      `${statusOnly.display.headline} ${statusOnly.display.remaining} ${statusOnly.display.range}`,
      /\d{2}:\d{2}/,
    );

    const numericAt = '2026-08-29T10:30:30.000Z';
    const numericHeartbeat = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000072',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: numericAt,
      kind: 'workset_heartbeat',
      data: {},
    };
    state = reduceWorksetEvent(state, numericHeartbeat);
    database.saveWorksetProjection(state, numericHeartbeat, {
      receivedAt: numericAt,
      forecast: {
        mode: 'workset_parent_survival',
        status: 'forecast',
        evidence: 'history_backed',
        lowerMinutes: 30,
        p50Minutes: 60,
        p80Minutes: 120,
        upperMinutes: 120,
        resumeLowerMinutes: null,
        resumeUpperMinutes: null,
        reasonCode: 'open_workset_parent_survival',
        worksetRevision: 1,
        jointP80Claimed: true,
        raw: { aggregationUsed: false },
      },
    });
    const numericStillMasked = buildLatestLiveSnapshot(database, {
      selectionId: taskSelection,
      scope: 'task',
    });
    assert.equal(numericStillMasked.display.headline, '任务进行中');
    assert.equal(numericStillMasked.forecast.mode, 'unavailable');
    assert.equal(numericStillMasked.forecast.status, 'status_only');
    assert.equal(numericStillMasked.forecast.lowerMinutes, null);
    assert.equal(numericStillMasked.forecast.p50Minutes, null);
    assert.equal(numericStillMasked.forecast.p80Minutes, null);
    assert.equal(numericStillMasked.forecast.upperMinutes, null);
    assert.doesNotMatch(JSON.stringify(numericStillMasked), /10:31|11:30|12:30/);

    const blockedShadowAt = '2026-08-29T10:30:45.000Z';
    const blockedShadow = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000073',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: blockedShadowAt,
      kind: 'workset_status_changed',
      data: { status: 'blocked' },
    };
    state = reduceWorksetEvent(state, blockedShadow);
    database.saveWorksetProjection(state, blockedShadow, {
      receivedAt: blockedShadowAt,
      forecast: {
        mode: 'workset_parent_survival',
        status: 'blocked',
        evidence: 'history_backed',
        lowerMinutes: null,
        p50Minutes: null,
        p80Minutes: null,
        upperMinutes: null,
        resumeLowerMinutes: 30,
        resumeUpperMinutes: 120,
        reasonCode: 'workset_blocked',
        worksetRevision: 1,
        jointP80Claimed: false,
        raw: { aggregationUsed: false },
      },
    });
    const waitingStillMasked = buildLatestLiveSnapshot(database, {
      selectionId: taskSelection,
      scope: 'task',
    });
    assert.equal(waitingStillMasked.status, 'blocked');
    assert.equal(waitingStillMasked.display.remaining, '解除后 active 时间暂不可用');
    assert.equal(waitingStillMasked.display.range, '不预测等待何时结束');
    assert.equal(waitingStillMasked.forecast.status, 'status_only');
    assert.equal(waitingStillMasked.forecast.lowerMinutes, null);
    assert.equal(waitingStillMasked.forecast.p50Minutes, null);
    assert.equal(waitingStillMasked.forecast.p80Minutes, null);
    assert.equal(waitingStillMasked.forecast.upperMinutes, null);
    assert.doesNotMatch(JSON.stringify(waitingStillMasked), /30–120|11:00|12:30/);

    const completedAt = '2026-08-29T10:31:00.000Z';
    const completed = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000071',
      workset_id: taskId,
      workset_type: 'task',
      occurred_at: completedAt,
      kind: 'workset_succeeded',
      data: {},
    };
    state = reduceWorksetEvent(state, completed);
    database.saveWorksetProjection(state, completed, {
      receivedAt: completedAt,
      forecast: forecastWorkset({ state }),
      source: GOAL_SOURCE,
    });
    const terminalShadow = buildLatestLiveSnapshot(database, {
      selectionId: taskSelection,
      scope: 'task',
    });
    assert.equal(terminalShadow.status, 'succeeded');
    assert.equal(terminalShadow.display.comparison, null);
    assert.equal(terminalShadow.forecast.mode, 'unavailable');
    assert.equal(terminalShadow.forecast.status, 'status_only');
    assert.equal(terminalShadow.forecast.p50Minutes, null);
    assert.doesNotMatch(JSON.stringify(terminalShadow), /初次预计/);

    const quarantinedAt = '2026-08-29T10:32:00.000Z';
    database.saveWorksetSource(taskId, {
      ...GOAL_SOURCE,
      sourceStatus: 'quarantined',
    }, { receivedAt: quarantinedAt });
    const after = buildActiveLiveSelections(database, new Date('2026-08-29T10:33:00.000Z'));
    assert.equal(after.defaultSelectionId, runSelection);
    assert.equal(after.selections.length, 1);
    assert.deepEqual(after.selections[0].meta.scopeAvailability, {
      run: 'available', task: 'unknown', project: 'unknown',
    });
    assert.equal('replacesSelectionId' in after.selections[0].meta, false);

    const conflict = buildLatestLiveSnapshot(database, { selectionId: taskSelection, scope: 'task' });
    assert.equal(conflict.available, false);
    assert.equal(conflict.status, 'unknown');
    assert.equal(conflict.display.headline, '结构证据冲突，ETA 不可用');
    assert.equal(conflict.display.comparison, null);
    assert.equal(conflict.forecast.mode, 'unavailable');
    assert.equal(conflict.forecast.status, 'quarantined');
    assert.equal(conflict.forecast.p50Minutes, null);
    assert.equal(conflict.forecast.p80Minutes, null);
    assert.equal(conflict.forecast.lowerMinutes, null);
    assert.equal(conflict.capturedAt, quarantinedAt);
    assert.doesNotMatch(
      `${conflict.display.headline} ${conflict.display.remaining} ${conflict.display.range}`,
      /已完成|实际用时|预计|\d{2}:\d{2}/,
    );
    const throughRun = buildLatestLiveSnapshot(database, { selectionId: runSelection, scope: 'task' });
    assert.equal(throughRun.display.headline, '结构证据冲突，ETA 不可用');
    const project = buildLatestLiveSnapshot(database, { selectionId: taskSelection, scope: 'project' });
    assert.equal(project.display.headline, '结构证据冲突，ETA 不可用');
    assert.doesNotMatch(
      JSON.stringify({ active, statusOnly, after, conflict, throughRun, project }),
      /codex-run|workset-|verified-goal-run-event|source_kind|source_status|run_id/i,
    );
  } finally {
    database.close();
  }
});

test('two task parents for one run fail closed and never replace its selector', () => {
  const database = new AgentEtaDatabase(':memory:');
  const runId = 'codex-run-00000000000000000060';
  try {
    saveLive(database, {
      runId,
      eventId: 'ambiguous-parent-run-event',
      at: '2026-08-29T10:00:00.000Z',
      p50: 8,
      p80: 12,
      lower: 4,
    });
    const runSelection = buildLatestLiveSnapshot(database).selectionId;
    for (const [offset, number] of [60, 61].entries()) {
      const taskId = `task-workset-${String(number).padStart(20, '0')}`;
      const memberId = `workset-member-${String(number).padStart(20, '0')}`;
      const occurredAt = `2026-08-29T10:0${offset + 1}:00.000Z`;
      const declared = {
        schema_version: WORKSET_EVENT_SCHEMA_VERSION,
        event_id: `workset-event-${String(number).padStart(20, '0')}`,
        workset_id: taskId,
        workset_type: 'task',
        occurred_at: occurredAt,
        kind: 'workset_declared',
        data: {
          revision: 1,
          workset_closed: true,
          members: [{
            member_id: memberId,
            child_type: 'run',
            child_id: runId,
            order_index: 0,
            execution_group: null,
            attached_at: occurredAt,
            detached_at: null,
          }],
        },
      };
      const state = reduceWorksetEvent(createWorksetState(taskId, 'task'), declared);
      database.saveWorksetProjection(state, declared, { receivedAt: occurredAt });
      database.saveWorksetForecast({
        worksetId: taskId,
        eventId: declared.event_id,
        observedAt: occurredAt,
        forecast: forecastWorkset({
          state,
          childProjections: [{
            memberId,
            status: 'running',
            lowerMinutes: 4,
            p50Minutes: 8,
            p80Minutes: 12,
          }],
        }),
      });
    }

    const active = buildActiveLiveSelections(database, new Date('2026-08-29T10:03:00.000Z'));
    assert.equal(active.selections.length, 1);
    assert.equal(active.defaultSelectionId, runSelection);
    assert.deepEqual(active.selections[0].meta.scopeAvailability, {
      run: 'available', task: 'unknown', project: 'unknown',
    });
    assert.equal('replacesSelectionId' in active.selections[0].meta, false);
    const task = buildLatestLiveSnapshot(database, { selectionId: runSelection, scope: 'task' });
    assert.equal(task.available, false);
    assert.match(task.display.reason, /多个显式 task workset/);
    assert.doesNotMatch(
      JSON.stringify({ active, task }),
      /codex-run|workset-|ambiguous-parent-run-event|run_id|workset_id/i,
    );
  } finally {
    database.close();
  }
});

test('task-parent uniqueness does not change when one parent becomes stale', () => {
  for (const order of [['stale', 'fresh'], ['fresh', 'stale']]) {
    const database = new AgentEtaDatabase(':memory:');
    const runId = 'codex-run-00000000000000000080';
    try {
      saveLive(database, {
        runId,
        eventId: `freshness-run-${order.join('-')}`,
        at: '2026-08-29T10:00:00.000Z',
        p50: 60,
        p80: 120,
        lower: 30,
      });
      const runSelection = buildLatestLiveSnapshot(database).selectionId;
      for (const label of order) {
        const number = label === 'fresh' ? 80 : 81;
        const taskId = `task-workset-${String(number).padStart(20, '0')}`;
        const memberId = `workset-member-${String(number).padStart(20, '0')}`;
        const occurredAt = label === 'fresh'
          ? '2026-08-29T10:29:00.000Z'
          : '2026-08-29T10:01:00.000Z';
        const declared = {
          schema_version: WORKSET_EVENT_SCHEMA_VERSION,
          event_id: `workset-event-${String(number).padStart(20, '0')}`,
          workset_id: taskId,
          workset_type: 'task',
          occurred_at: occurredAt,
          kind: 'workset_declared',
          data: {
            revision: 1,
            workset_closed: true,
            members: [{
              member_id: memberId,
              child_type: 'run',
              child_id: runId,
              order_index: 0,
              execution_group: null,
              attached_at: occurredAt,
              detached_at: null,
            }],
          },
        };
        const state = reduceWorksetEvent(createWorksetState(taskId, 'task'), declared);
        const range = label === 'fresh'
          ? { lowerMinutes: 5, p50Minutes: 10, p80Minutes: 20 }
          : { lowerMinutes: 0.2, p50Minutes: 0.5, p80Minutes: 1 };
        database.saveWorksetProjection(state, declared, {
          receivedAt: occurredAt,
          forecast: forecastWorkset({
            state,
            childProjections: [{ memberId, status: 'running', ...range }],
          }),
        });
      }

      const active = buildActiveLiveSelections(database, new Date('2026-08-29T10:30:00.000Z'));
      assert.equal(active.selections.length, 1, `order ${order.join('→')}`);
      assert.equal(active.defaultSelectionId, runSelection, `order ${order.join('→')}`);
      assert.equal(active.selections[0].meta.scopeAvailability.task, 'unknown');
      assert.equal('replacesSelectionId' in active.selections[0].meta, false);
      assert.equal(
        buildLatestLiveSnapshot(database, { selectionId: runSelection, scope: 'task' }).available,
        false,
      );
    } finally {
      database.close();
    }
  }
});

test('terminal arrival window compares the initial saved forecast with actual completion', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    const runId = 'codex-run-00000000000000000020';
    saveLive(database, {
      runId,
      eventId: 'terminal-start',
      at: BASE,
      p50: 10,
      p80: 15,
      lower: 5,
    });
    saveLive(database, {
      runId,
      eventId: 'terminal-finish',
      at: '2026-08-29T10:12:00.000Z',
      status: 'succeeded',
      forecastStatus: 'terminal',
      p50: 0,
      p80: 0,
      lower: 0,
      finishedAt: '2026-08-29T10:12:00.000Z',
      kind: 'run_succeeded',
    });
    const snapshot = buildLatestLiveSnapshot(database);
    assert.equal(snapshot.status, 'succeeded');
    assert.equal(snapshot.display.headline, '已完成');
    assert.match(snapshot.display.range, /初次预计 \d{2}:\d{2}–\d{2}:\d{2} · 实际 \d{2}:\d{2}/);
    assert.equal(snapshot.display.comparison.actualAt, '2026-08-29T10:12:00.000Z');
    assert.equal(snapshot.display.comparison.deltaMinutes, 2);
  } finally {
    database.close();
  }
});

test('task and project scopes return contract unknown until an explicit unique workset exists', () => {
  const database = new AgentEtaDatabase(':memory:');
  try {
    const runId = 'codex-run-00000000000000000030';
    saveLive(database, { runId, eventId: 'scope-run', at: BASE });
    const run = buildLatestLiveSnapshot(database);
    const missing = buildLatestLiveSnapshot(database, { selectionId: run.selectionId, scope: 'task' });
    assert.equal(missing.available, false);
    assert.equal(missing.status, 'unknown');
    assert.match(missing.display.headline, /任务 ETA 暂不可用/);
    assert.equal(missing.forecast.p50Minutes, null);

    const worksetId = 'task-workset-00000000000000000030';
    const memberId = 'workset-member-00000000000000000030';
    const declared = {
      schema_version: WORKSET_EVENT_SCHEMA_VERSION,
      event_id: 'workset-event-00000000000000000030',
      workset_id: worksetId,
      workset_type: 'task',
      occurred_at: BASE,
      kind: 'workset_declared',
      data: {
        revision: 1,
        workset_closed: true,
        members: [{
          member_id: memberId,
          child_type: 'run',
          child_id: runId,
          order_index: 0,
          execution_group: null,
          attached_at: BASE,
          detached_at: null,
        }],
      },
    };
    const state = reduceWorksetEvent(createWorksetState(worksetId, 'task'), declared);
    database.saveWorksetProjection(state, declared, { receivedAt: BASE });
    const forecast = forecastWorkset({
      state,
      childProjections: [{ memberId, status: 'running', lowerMinutes: 4, p50Minutes: 8, p80Minutes: 12 }],
    });
    database.saveWorksetForecast({ worksetId, eventId: declared.event_id, observedAt: BASE, forecast });

    const task = buildLatestLiveSnapshot(database, { selectionId: run.selectionId, scope: 'task' });
    assert.equal(task.available, true);
    assert.equal(task.scope, 'task');
    assert.match(task.display.headline, /^预计 \d{2}:\d{2} 完成$/);
    assert.equal(task.display.remaining, '还剩约 8 分钟');
    const project = buildLatestLiveSnapshot(database, { selectionId: run.selectionId, scope: 'project' });
    assert.equal(project.available, false);
    assert.equal(project.status, 'unknown');
  } finally {
    database.close();
  }
});

test('live APIs expose safe selectors and honor an explicit selection query', async (t) => {
  const app = createApp({
    databasePath: ':memory:',
    wallClock: () => new Date('2026-08-29T10:05:00.000Z'),
  });
  saveLive(app.database, {
    runId: 'codex-run-00000000000000000040',
    eventId: 'api-event-private',
    at: '2026-08-29T10:04:00.000Z',
    secret: 'API MUST NOT LEAK THIS PATH /Users/example/private',
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const activeResponse = await fetch(`${base}/api/live/active`);
  assert.equal(activeResponse.headers.get('cache-control'), 'no-store');
  const active = await activeResponse.json();
  const selected = active.defaultSelectionId;
  const serialized = JSON.stringify(active);
  assert.doesNotMatch(serialized, /runId|run_id|codex-run|session|native|path|Users|max\/private/i);
  const latest = await (await fetch(`${base}/api/live/latest?selection=${selected}&scope=run`)).json();
  assert.equal(latest.selectionId, selected);
  assert.equal(latest.scope, 'run');
  const missing = await (await fetch(`${base}/api/live/latest?selection=sel-aaaaaaaaaaaaaaaaaaaa&scope=run`)).json();
  assert.equal(missing.available, false);
  assert.match(missing.display.reason, /不会改用另一个任务/);
});
