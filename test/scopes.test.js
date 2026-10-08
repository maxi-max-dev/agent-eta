import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  WORKSET_EVENT_SCHEMA_VERSION,
  createWorksetState,
  forecastWorkset,
  reduceWorksetEvent,
  validateWorksetEvent,
} from '../src/scopes/index.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const AT = '2026-08-29T10:00:00.000Z';

function hex(number) {
  return number.toString(16).padStart(20, '0');
}

function worksetId(type, number) {
  return `${type}-workset-${hex(number)}`;
}

function runId(number) {
  return `codex-run-${hex(number)}`;
}

function member(number, childType, childId, orderIndex, executionGroup = null) {
  return {
    member_id: `workset-member-${hex(number)}`,
    child_type: childType,
    child_id: childId,
    order_index: orderIndex,
    execution_group: executionGroup,
    attached_at: AT,
    detached_at: null,
  };
}

function event({
  number,
  id,
  type = 'task',
  kind = 'workset_declared',
  at = AT,
  data = { revision: 1, workset_closed: true, members: [] },
}) {
  return {
    schema_version: WORKSET_EVENT_SCHEMA_VERSION,
    event_id: `workset-event-${hex(number)}`,
    workset_id: id,
    workset_type: type,
    occurred_at: at,
    kind,
    data,
  };
}

function replay(id, type, events) {
  let state = createWorksetState(id, type);
  for (const input of events) state = reduceWorksetEvent(state, input);
  return state;
}

function child(memberId, status, lower, p50, p80) {
  return {
    memberId,
    status,
    lowerMinutes: lower,
    p50Minutes: p50,
    p80Minutes: p80,
  };
}

function persistRun(database, id) {
  database.saveRun({
    runId: id,
    provider: 'codex',
    status: 'running',
    startedAt: AT,
    finishedAt: null,
    activeElapsedMs: 0,
    steps: [],
    planRevision: 0,
  });
}

test('workset contract is exact, hashed, structural, and rejects text or accessors', () => {
  const id = worksetId('task', 1);
  const valid = event({ number: 1, id });
  assert.equal(validateWorksetEvent(valid).valid, true);
  assert.deepEqual(validateWorksetEvent({ ...valid, label: 'private task' }), {
    valid: false,
    code: 'WORKSET_UNKNOWN_FIELD',
    value: null,
  });
  assert.equal(validateWorksetEvent({ ...valid, workset_id: 'native-task-1' }).code, 'WORKSET_INVALID_ID');

  const accessor = { ...valid };
  Object.defineProperty(accessor, 'data', { enumerable: true, get() { throw new Error('must not run'); } });
  assert.equal(validateWorksetEvent(accessor).code, 'WORKSET_ACCESSOR_FIELD');

  const wrongChild = event({
    number: 2,
    id,
    data: {
      revision: 1,
      workset_closed: true,
      members: [member(1, 'workset', worksetId('task', 2), 0)],
    },
  });
  assert.equal(validateWorksetEvent(wrongChild).code, 'WORKSET_TASK_CHILD_MUST_BE_RUN');
  assert.throws(() => reduceWorksetEvent(
    createWorksetState(id, 'task'),
    event({ number: 3, id, kind: 'workset_succeeded', data: {} }),
  ), /WORKSET_NOT_DECLARED/);
});

test('open worksets are unknown without parent survival and use only explicit survival when supplied', () => {
  const id = worksetId('task', 10);
  const declared = event({
    number: 10,
    id,
    data: { revision: 1, workset_closed: false, members: [] },
  });
  const state = replay(id, 'task', [declared]);
  const unknown = forecastWorkset({ state });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reasonCode, 'open_workset_without_parent_survival');
  assert.equal(unknown.p50Minutes, null);

  const survival = forecastWorkset({
    state,
    parentSurvival: { lowerMinutes: 12, p50Minutes: 20, p80Minutes: 35 },
  });
  assert.equal(survival.mode, 'workset_parent_survival');
  assert.equal(survival.p50Minutes, 20);
  assert.equal(survival.p80Minutes, 35);
});

test('closed sequential members sum explicitly but do not claim a joint P80', () => {
  const id = worksetId('task', 20);
  const first = member(20, 'run', runId(20), 0);
  const second = member(21, 'run', runId(21), 1);
  const state = replay(id, 'task', [event({
    number: 20,
    id,
    data: { revision: 1, workset_closed: true, members: [first, second] },
  })]);
  const forecast = forecastWorkset({
    state,
    childProjections: [
      child(first.member_id, 'running', 3, 5, 9),
      child(second.member_id, 'scheduled', 4, 7, 11),
    ],
  });
  assert.equal(forecast.status, 'forecast');
  assert.equal(forecast.reasonCode, 'closed_workset_sequential');
  assert.equal(forecast.lowerMinutes, 7);
  assert.equal(forecast.p50Minutes, 12);
  assert.equal(forecast.p80Minutes, null);
  assert.equal(forecast.upperMinutes, 20);
  assert.equal(forecast.jointP80Claimed, false);
});

test('only an explicit observed parallel group uses max and keeps a conservative upper range', () => {
  const id = worksetId('task', 30);
  const group = `parallel-group-${hex(30)}`;
  const first = member(30, 'run', runId(30), 0, group);
  const second = member(31, 'run', runId(31), 1, group);
  const third = member(32, 'run', runId(32), 2);
  const state = replay(id, 'task', [event({
    number: 30,
    id,
    data: { revision: 1, workset_closed: true, members: [first, second, third] },
  })]);
  const forecast = forecastWorkset({
    state,
    childProjections: [
      child(first.member_id, 'running', 2, 6, 10),
      child(second.member_id, 'running', 4, 8, 12),
      child(third.member_id, 'scheduled', 1, 3, 5),
    ],
  });
  assert.equal(forecast.reasonCode, 'closed_workset_explicit_parallel');
  assert.equal(forecast.lowerMinutes, 5);
  assert.equal(forecast.p50Minutes, 11);
  assert.equal(forecast.upperMinutes, 27);
  assert.equal(forecast.p80Minutes, null);
  assert.equal(forecast.raw.parallelGroupCount, 1);

  const notRunning = forecastWorkset({
    state,
    childProjections: [
      child(first.member_id, 'running', 2, 6, 10),
      child(second.member_id, 'scheduled', 4, 8, 12),
      child(third.member_id, 'scheduled', 1, 3, 5),
    ],
  });
  assert.equal(notRunning.status, 'unknown');
  assert.equal(notRunning.reasonCode, 'parallel_group_not_observed_running');
});

test('pending semantics and blocking states stop the parent completion clock', () => {
  const id = worksetId('task', 40);
  const item = member(40, 'run', runId(40), 0);
  const declared = event({
    number: 40,
    id,
    data: { revision: 1, workset_closed: true, members: [item] },
  });
  const running = replay(id, 'task', [declared]);
  const pending = forecastWorkset({
    state: running,
    childProjections: [child(item.member_id, 'pending', null, null, null)],
  });
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.reasonCode, 'child_pending_or_terminal_semantics_unknown');

  const waiting = reduceWorksetEvent(running, event({
    number: 41,
    id,
    kind: 'workset_status_changed',
    at: '2026-08-29T10:05:00.000Z',
    data: { status: 'needs_input' },
  }));
  const blocked = forecastWorkset({
    state: waiting,
    childProjections: [child(item.member_id, 'running', 4, 7, 12)],
  });
  assert.equal(blocked.status, 'needs_input');
  assert.equal(blocked.p50Minutes, null);
  assert.equal(blocked.resumeLowerMinutes, 4);
  assert.equal(blocked.resumeUpperMinutes, 12);
  assert.equal(waiting.activeElapsedMs, 5 * 60_000);
});

test('all children complete still awaits explicit owner terminal and terminal truth is immutable', () => {
  const id = worksetId('task', 50);
  const item = member(50, 'run', runId(50), 0);
  const declared = event({
    number: 50,
    id,
    data: { revision: 1, workset_closed: true, members: [item] },
  });
  const running = replay(id, 'task', [declared]);
  const waitingForOwner = forecastWorkset({
    state: running,
    childProjections: [child(item.member_id, 'succeeded', null, null, null)],
  });
  assert.equal(waitingForOwner.status, 'unknown');
  assert.equal(waitingForOwner.reasonCode, 'awaiting_owner_terminal');

  const terminalEvent = event({
    number: 51,
    id,
    kind: 'workset_succeeded',
    at: '2026-08-29T10:30:00.000Z',
    data: {},
  });
  const terminal = reduceWorksetEvent(running, terminalEvent);
  assert.equal(terminal.ownerTerminal, true);
  assert.equal(terminal.status, 'succeeded');
  assert.equal(forecastWorkset({ state: terminal }).p50Minutes, 0);

  const late = reduceWorksetEvent(terminal, event({
    number: 52,
    id,
    kind: 'workset_status_changed',
    at: '2026-08-29T10:31:00.000Z',
    data: { status: 'running' },
  }));
  assert.equal(late.status, 'succeeded');
  assert.equal(late.finishedAt, terminal.finishedAt);
});

test('revision must increment and explicit new work extends the aggregate', () => {
  const id = worksetId('task', 60);
  const first = member(60, 'run', runId(60), 0);
  const declared = event({
    number: 60,
    id,
    data: { revision: 1, workset_closed: true, members: [first] },
  });
  const revisionOne = replay(id, 'task', [declared]);
  const before = forecastWorkset({
    state: revisionOne,
    childProjections: [child(first.member_id, 'running', 2, 5, 8)],
  });
  const second = member(61, 'run', runId(61), 1);
  const revisedEvent = event({
    number: 61,
    id,
    kind: 'workset_revised',
    at: '2026-08-29T10:02:00.000Z',
    data: { revision: 2, workset_closed: true, members: [first, second] },
  });
  const revisionTwo = reduceWorksetEvent(revisionOne, revisedEvent);
  const after = forecastWorkset({
    state: revisionTwo,
    childProjections: [
      child(first.member_id, 'running', 2, 5, 8),
      child(second.member_id, 'scheduled', 3, 6, 10),
    ],
  });
  assert.equal(revisionTwo.revision, 2);
  assert.ok(after.p50Minutes > before.p50Minutes);
  assert.throws(() => reduceWorksetEvent(revisionTwo, {
    ...revisedEvent,
    event_id: `workset-event-${hex(62)}`,
    data: { ...revisedEvent.data, revision: 4 },
  }), /WORKSET_REVISION_MUST_INCREMENT/);
});

test('schema v7 enforces FK/orphan constraints and persists events, members, forecasts and outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-scopes-'));
  const filename = join(directory, 'scopes.sqlite');
  const database = new AgentEtaDatabase(filename);
  try {
    assert.equal(database.db.prepare(`
      SELECT value FROM schema_meta WHERE key = 'schema_version'
    `).get().value, '7');
    for (const table of [
      'worksets',
      'workset_sources',
      'codex_goal_receipts',
      'codex_goal_quarantines',
      'workset_events',
      'workset_members',
      'workset_forecast_snapshots',
    ]) {
      assert.ok(database.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table));
    }
    const receiptMode = database.db.prepare(`
      SELECT dflt_value
      FROM pragma_table_info('codex_goal_receipts')
      WHERE name = 'first_ingest_mode'
    `).get();
    assert.ok(receiptMode, 'schema v7 persists immutable Goal receipt provenance');

    const orphanId = worksetId('task', 70);
    const orphanMember = member(70, 'run', runId(999), 0);
    const orphanEvent = event({
      number: 70,
      id: orphanId,
      data: { revision: 1, workset_closed: true, members: [orphanMember] },
    });
    const orphanState = replay(orphanId, 'task', [orphanEvent]);
    assert.throws(
      () => database.saveWorksetProjection(orphanState, orphanEvent),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(database.loadWorkset(orphanId), null, 'failed scope insert must roll back');

    const childRun = runId(70);
    persistRun(database, childRun);
    const id = worksetId('task', 71);
    const item = member(71, 'run', childRun, 0);
    const declared = event({
      number: 71,
      id,
      data: { revision: 1, workset_closed: true, members: [item] },
    });
    const state = replay(id, 'task', [declared]);
    const source = {
      provider: 'codex',
      sourceKind: 'codex_goal_shadow',
      sourceStatus: 'verified_structural',
      taskClass: 'other',
      eligibleLargeTask: null,
    };
    const saved = database.saveWorksetProjection(state, declared, {
      receivedAt: AT,
      source,
    });
    assert.equal(saved.inserted, true);
    assert.equal(database.saveWorksetProjection(state, declared, {
      receivedAt: AT,
      source,
    }).inserted, false);
    assert.equal(database.loadWorkset(id).members.length, 1);
    assert.deepEqual(database.loadWorksetSource(id), {
      ...source,
      firstReceivedAt: AT,
      lastReceivedAt: AT,
    });
    assert.throws(() => database.saveWorksetSource(id, {
      ...source,
      taskClass: 'private title',
    }, { receivedAt: AT }), /WORKSET_INVALID_SOURCE_TASK_CLASS/);
    assert.throws(() => database.saveWorksetSource(id, {
      ...source,
      sourceKind: 'explicit_project_shadow',
    }, { receivedAt: AT }), /WORKSET_PROJECT_SOURCE_REQUIRES_PROJECT/);
    database.saveWorksetSource(id, {
      ...source,
      sourceStatus: 'quarantined',
    }, { receivedAt: '2026-08-29T10:00:01.000Z' });
    assert.equal(database.loadWorksetSource(id).sourceStatus, 'quarantined');
    assert.throws(() => database.saveWorksetSource(id, source, {
      receivedAt: '2026-08-29T10:00:02.000Z',
    }), /WORKSET_SOURCE_STATUS_CONFLICT/);
    const conflictingEvent = {
      ...declared,
      data: { ...declared.data, workset_closed: false },
    };
    assert.throws(
      () => database.saveWorksetProjection(
        replay(id, 'task', [conflictingEvent]),
        conflictingEvent,
      ),
      /WORKSET_EVENT_CONFLICT/,
    );

    const statusEvent = event({
      number: 73,
      id,
      kind: 'workset_status_changed',
      at: '2026-08-29T10:01:00.000Z',
      data: { status: 'paused' },
    });
    const forgedSameRevision = reduceWorksetEvent(state, statusEvent);
    forgedSameRevision.members.push({
      memberId: `workset-member-${hex(73)}`,
      childType: 'run',
      childId: runId(73),
      orderIndex: 1,
      executionGroup: null,
      attachedAt: AT,
      detachedAt: null,
    });
    assert.throws(
      () => database.saveWorksetProjection(forgedSameRevision, statusEvent),
      /WORKSET_REVISION_MEMBERS_CONFLICT/,
    );
    assert.equal(database.loadWorkset(id).status, 'running', 'conflicting revision rolls back');

    const forecast = forecastWorkset({
      state,
      childProjections: [child(item.member_id, 'running', 2, 5, 8)],
    });
    assert.equal(database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: AT,
      forecast,
    }).inserted, true);
    assert.equal(database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: AT,
      forecast,
    }).inserted, false);
    assert.equal(database.listWorksetForecasts(id).length, 1);
    assert.throws(() => database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: AT,
      forecast: { ...forecast, prompt: 'private text' },
    }), /WORKSET_INVALID_FORECAST_FIELDS/);
    assert.throws(() => database.saveWorksetForecast({
      worksetId: id,
      eventId: declared.event_id,
      observedAt: AT,
      forecast: { ...forecast, p50Minutes: 6 },
    }), /WORKSET_FORECAST_CONFLICT/);

    const terminalEvent = event({
      number: 72,
      id,
      kind: 'workset_succeeded',
      at: '2026-08-29T10:20:00.000Z',
      data: {},
    });
    const terminal = reduceWorksetEvent(state, terminalEvent);
    database.saveWorksetProjection(terminal, terminalEvent, {
      receivedAt: '2026-08-29T10:20:01.000Z',
    });
    const stored = database.loadWorkset(id);
    assert.equal(stored.ownerTerminal, true);
    assert.equal(stored.outcomeMinutes, 20);
    assert.deepEqual(database.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v7 migration conservatively marks pre-provenance Goal receipts as backfill', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-scope-migration-'));
  const filename = join(directory, 'legacy-v6.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE codex_goal_receipts (
      receipt_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      first_received_at TEXT NOT NULL,
      last_received_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      workset_id TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      censored INTEGER NOT NULL DEFAULT 0,
      quarantined INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO codex_goal_receipts(
      receipt_id, goal_id, run_id, occurred_at, first_received_at,
      last_received_at, kind, fingerprint
    ) VALUES (
      'legacy-receipt', 'codex-goal-00000000000000000001',
      'codex-run-00000000000000000001', '2026-08-29T10:00:00.000Z',
      '2026-08-29T10:10:00.000Z', '2026-08-29T10:10:00.000Z',
      'goal_active', 'legacy-digest'
    );
  `);
  legacy.close();
  const database = new AgentEtaDatabase(filename);
  try {
    assert.equal(database.db.prepare(`
      SELECT value FROM schema_meta WHERE key = 'schema_version'
    `).get().value, '7');
    assert.equal(database.db.prepare(`
      SELECT first_ingest_mode FROM codex_goal_receipts WHERE receipt_id = 'legacy-receipt'
    `).get().first_ingest_mode, 'backfill');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project membership accepts only persisted task worksets and restart replay restores projection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-project-scope-'));
  const filename = join(directory, 'scopes.sqlite');
  let database = new AgentEtaDatabase(filename);
  try {
    const childRun = runId(80);
    persistRun(database, childRun);
    const taskId = worksetId('task', 80);
    const taskMember = member(80, 'run', childRun, 0);
    const taskEvent = event({
      number: 80,
      id: taskId,
      data: { revision: 1, workset_closed: true, members: [taskMember] },
    });
    database.saveWorksetProjection(replay(taskId, 'task', [taskEvent]), taskEvent);

    const projectId = worksetId('project', 81);
    const projectMember = member(81, 'workset', taskId, 0);
    const projectDeclared = event({
      number: 81,
      id: projectId,
      type: 'project',
      data: { revision: 1, workset_closed: true, members: [projectMember] },
    });
    let projectState = replay(projectId, 'project', [projectDeclared]);
    database.saveWorksetProjection(projectState, projectDeclared);
    const pausedEvent = event({
      number: 82,
      id: projectId,
      type: 'project',
      kind: 'workset_status_changed',
      at: '2026-08-29T10:10:00.000Z',
      data: { status: 'paused' },
    });
    projectState = reduceWorksetEvent(projectState, pausedEvent);
    database.saveWorksetProjection(projectState, pausedEvent);
    database.close();

    database = new AgentEtaDatabase(filename);
    const persisted = database.listWorksetEvents(projectId);
    const restored = replay(projectId, 'project', persisted.map((row) => row.event));
    assert.equal(restored.status, 'paused');
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.members, projectState.members);
    assert.equal(database.loadWorkset(projectId).status, 'paused');
    assert.deepEqual(database.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
