import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  ingestWorksetCascade,
  ingestWorksetEvent,
} from '../src/scopes/ingest.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const AT = '2026-08-29T10:00:00.000Z';

function hex(value) {
  return Number(value).toString(16).padStart(20, '0');
}

function runId(value) {
  return `codex-run-${hex(value)}`;
}

function worksetId(type, value) {
  return `${type}-workset-${hex(value)}`;
}

function member(value, childType, childId, orderIndex = 0) {
  return {
    member_id: `workset-member-${hex(value)}`,
    child_type: childType,
    child_id: childId,
    order_index: orderIndex,
    execution_group: null,
    attached_at: AT,
    detached_at: null,
  };
}

function event({
  value,
  id,
  type = 'task',
  kind = 'workset_declared',
  at = AT,
  data = { revision: 1, workset_closed: true, members: [] },
}) {
  return {
    schema_version: 'agenteta.workset-event/1',
    event_id: `workset-event-${hex(value)}`,
    workset_id: id,
    workset_type: type,
    occurred_at: at,
    kind,
    data,
  };
}

function saveRunForecast(database, value, {
  status = 'running',
  lower = 2,
  p50 = 5,
  p80 = 8,
  at = AT,
} = {}) {
  const id = runId(value);
  database.saveRun({
    runId: id,
    provider: 'codex',
    status,
    startedAt: AT,
    finishedAt: status === 'succeeded' ? at : null,
    activeElapsedMs: 0,
    steps: [],
    planRevision: 0,
  }, { provider: 'codex', observed_at: at, data: {} });
  database.saveForecast({
    runId: id,
    observedAt: at,
    forecast: {
      mode: 'run_fallback',
      status: status === 'succeeded' ? 'terminal' : status,
      lowerMinutes: lower,
      p50Minutes: p50,
      p80Minutes: p80,
      raw: {},
    },
    display: { headline: '', range: '', reason: '' },
  });
  return id;
}

function temporaryDatabase(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    filename: join(directory, 'agent-eta.sqlite'),
  };
}

test('ingest atomically materializes a real child-run forecast and is idempotent', () => {
  const temporary = temporaryDatabase('agent-eta-workset-ingest-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const child = saveRunForecast(database, 1, { lower: 3, p50: 7, p80: 11 });
    const task = worksetId('task', 1);
    const declared = event({
      value: 1,
      id: task,
      data: {
        revision: 1,
        workset_closed: true,
        members: [member(1, 'run', child)],
      },
    });
    const first = ingestWorksetEvent(database, declared, { receivedAt: AT });
    assert.equal(first.inserted, true);
    assert.equal(first.status, 'forecast');
    assert.equal(first.p50Minutes, 7);
    assert.equal(first.upperMinutes, 11);
    assert.equal(first.reasonCode, 'closed_workset_sequential');

    const saved = database.listWorksetForecasts(task);
    assert.equal(saved.length, 1);
    assert.notEqual(saved[0].forecast.reasonCode, 'awaiting_forecast');
    assert.equal(database.db.prepare(`
      SELECT COUNT(*) AS count
      FROM workset_events event
      LEFT JOIN workset_forecast_snapshots forecast
        ON forecast.workset_id = event.workset_id AND forecast.event_id = event.event_id
      WHERE forecast.snapshot_id IS NULL
        OR json_extract(forecast.forecast_json, '$.reasonCode') = 'awaiting_forecast'
    `).get().count, 0);

    const repeated = ingestWorksetEvent(database, declared, { receivedAt: AT });
    assert.equal(repeated.inserted, false);
    assert.equal(repeated.p50Minutes, 7);
    assert.equal(database.listWorksetEvents(task).length, 1);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('an invalid or missing child rolls back event, materialized state, and forecast', () => {
  const temporary = temporaryDatabase('agent-eta-workset-rollback-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const task = worksetId('task', 2);
    const declared = event({
      value: 2,
      id: task,
      data: {
        revision: 1,
        workset_closed: true,
        members: [member(2, 'run', runId(999))],
      },
    });
    assert.throws(() => ingestWorksetEvent(database, declared), {
      code: 'WORKSET_INGEST_FAILED',
    });
    assert.equal(database.loadWorkset(task), null);
    assert.equal(database.listWorksetEvents(task).length, 0);
    assert.equal(database.listWorksetForecasts(task).length, 0);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('a workset receipt cannot precede its structural event', () => {
  const temporary = temporaryDatabase('agent-eta-workset-causality-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const task = worksetId('task', 20);
    const declared = event({ value: 20, id: task });
    assert.throws(
      () => ingestWorksetEvent(database, declared, {
        receivedAt: '2026-08-29T09:59:59.999Z',
      }),
      { code: 'WORKSET_RECEIPT_PRECEDES_EVENT' },
    );
    assert.equal(database.loadWorkset(task), null);
    assert.equal(database.listWorksetEvents(task).length, 0);
    assert.equal(database.listWorksetForecasts(task).length, 0);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('explicit task then project heartbeat cascade deterministically refreshes both levels', () => {
  const temporary = temporaryDatabase('agent-eta-workset-cascade-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const child = saveRunForecast(database, 3, { lower: 2, p50: 5, p80: 9 });
    const task = worksetId('task', 3);
    ingestWorksetEvent(database, event({
      value: 3,
      id: task,
      data: {
        revision: 1,
        workset_closed: true,
        members: [member(3, 'run', child)],
      },
    }), { receivedAt: AT });

    const taskHeartbeat = event({
      value: 4,
      id: task,
      kind: 'workset_heartbeat',
      at: '2026-08-29T10:02:00.000Z',
      data: {},
    });
    const project = worksetId('project', 4);
    const projectHeartbeat = event({
      value: 5,
      id: project,
      type: 'project',
      kind: 'workset_heartbeat',
      at: '2026-08-29T10:02:00.000Z',
      data: {},
    });

    assert.throws(
      () => ingestWorksetCascade(database, [taskHeartbeat, projectHeartbeat], {
        receivedAt: '2026-08-29T10:02:01.000Z',
      }),
      { code: 'WORKSET_NOT_DECLARED' },
    );
    assert.equal(database.listWorksetEvents(task).length, 2, 'first cascade event remains retryable');

    ingestWorksetEvent(database, event({
      value: 6,
      id: project,
      type: 'project',
      at: '2026-08-29T10:01:00.000Z',
      data: {
        revision: 1,
        workset_closed: true,
        members: [member(4, 'workset', task)],
      },
    }), { receivedAt: '2026-08-29T10:01:00.000Z' });

    saveRunForecast(database, 3, {
      lower: 7,
      p50: 13,
      p80: 21,
      at: '2026-08-29T10:01:30.000Z',
    });
    const retried = ingestWorksetCascade(database, [taskHeartbeat, projectHeartbeat], {
      receivedAt: '2026-08-29T10:02:01.000Z',
    });
    assert.equal(retried.results[0].inserted, false);
    assert.equal(retried.results[1].inserted, true);

    // The first heartbeat was accepted before the newer child forecast. Submit
    // a new explicit cascade; no implicit latest/global inference is involved.
    const refreshed = ingestWorksetCascade(database, [
      event({
        value: 7,
        id: task,
        kind: 'workset_heartbeat',
        at: '2026-08-29T10:03:00.000Z',
        data: {},
      }),
      event({
        value: 8,
        id: project,
        type: 'project',
        kind: 'workset_heartbeat',
        at: '2026-08-29T10:03:00.000Z',
        data: {},
      }),
    ], { receivedAt: '2026-08-29T10:03:01.000Z' });
    const expected = 13 - (91 / 60);
    assert.ok(Math.abs(refreshed.results[0].p50Minutes - expected) < 1e-9);
    assert.ok(Math.abs(refreshed.results[1].p50Minutes - expected) < 1e-9);
    assert.ok(Math.abs(database.listWorksetForecasts(task).at(-1).forecast.p50Minutes - expected) < 1e-9);
    assert.ok(Math.abs(database.listWorksetForecasts(project).at(-1).forecast.p50Minutes - expected) < 1e-9);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('heartbeat ages active remaining time once so its completion clock does not drift', () => {
  const temporary = temporaryDatabase('agent-eta-workset-aging-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const child = saveRunForecast(database, 30, { lower: 4, p50: 10, p80: 16 });
    const task = worksetId('task', 30);
    const project = worksetId('project', 30);
    ingestWorksetEvent(database, event({
      value: 30,
      id: task,
      data: { revision: 1, workset_closed: true, members: [member(30, 'run', child)] },
    }), { receivedAt: AT });
    ingestWorksetEvent(database, event({
      value: 31,
      id: project,
      type: 'project',
      data: { revision: 1, workset_closed: true, members: [member(31, 'workset', task)] },
    }), { receivedAt: AT });

    const heartbeatAt = '2026-08-29T10:03:00.000Z';
    const refreshed = ingestWorksetCascade(database, [
      event({ value: 32, id: task, kind: 'workset_heartbeat', at: heartbeatAt, data: {} }),
      event({ value: 33, id: project, type: 'project', kind: 'workset_heartbeat', at: heartbeatAt, data: {} }),
    ], { receivedAt: heartbeatAt });

    assert.equal(refreshed.results[0].p50Minutes, 7);
    assert.equal(refreshed.results[1].p50Minutes, 7, 'project must not age the task twice');
    const initialArrival = Date.parse(AT) + 10 * 60_000;
    const refreshedArrival = Date.parse(heartbeatAt) + refreshed.results[1].p50Minutes * 60_000;
    assert.equal(refreshedArrival, initialArrival);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('heartbeat does not consume a blocked child post-resume range', () => {
  const temporary = temporaryDatabase('agent-eta-workset-wait-aging-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const child = saveRunForecast(database, 40, {
      status: 'waiting_provider',
      lower: 4,
      p50: 10,
      p80: 16,
    });
    const task = worksetId('task', 40);
    ingestWorksetEvent(database, event({
      value: 40,
      id: task,
      data: { revision: 1, workset_closed: true, members: [member(40, 'run', child)] },
    }), { receivedAt: AT });
    const heartbeatAt = '2026-08-29T10:03:00.000Z';
    const refreshed = ingestWorksetEvent(database, event({
      value: 41,
      id: task,
      kind: 'workset_heartbeat',
      at: heartbeatAt,
      data: {},
    }), { receivedAt: heartbeatAt });

    assert.equal(refreshed.status, 'waiting_provider');
    assert.equal(refreshed.p50Minutes, null);
    assert.equal(refreshed.resumeLowerMinutes, 4);
    assert.equal(refreshed.resumeUpperMinutes, 16);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('status, revision, and owner terminal remain explicit structural events', () => {
  const temporary = temporaryDatabase('agent-eta-workset-lifecycle-');
  const database = new AgentEtaDatabase(temporary.filename);
  try {
    const firstRun = saveRunForecast(database, 10, { lower: 2, p50: 5, p80: 8 });
    const secondRun = saveRunForecast(database, 11, { lower: 3, p50: 7, p80: 12 });
    const task = worksetId('task', 10);
    const first = member(10, 'run', firstRun, 0);
    ingestWorksetEvent(database, event({
      value: 10,
      id: task,
      data: { revision: 1, workset_closed: true, members: [first] },
    }), { receivedAt: AT });

    const revised = ingestWorksetEvent(database, event({
      value: 11,
      id: task,
      kind: 'workset_revised',
      at: '2026-08-29T10:01:00.000Z',
      data: {
        revision: 2,
        workset_closed: true,
        members: [first, member(11, 'run', secondRun, 1)],
      },
    }), { receivedAt: '2026-08-29T10:01:00.000Z' });
    assert.equal(revised.revision, 2);
    assert.equal(revised.p50Minutes, 10);
    assert.equal(revised.upperMinutes, 18);

    const waiting = ingestWorksetEvent(database, event({
      value: 12,
      id: task,
      kind: 'workset_status_changed',
      at: '2026-08-29T10:02:00.000Z',
      data: { status: 'needs_input' },
    }), { receivedAt: '2026-08-29T10:02:00.000Z' });
    assert.equal(waiting.status, 'needs_input');
    assert.equal(waiting.p50Minutes, null);
    assert.equal(waiting.resumeLowerMinutes, 1);
    assert.equal(waiting.resumeUpperMinutes, 16);

    const terminal = ingestWorksetEvent(database, event({
      value: 13,
      id: task,
      kind: 'workset_succeeded',
      at: '2026-08-29T10:03:00.000Z',
      data: {},
    }));
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.p50Minutes, 0);
    assert.equal(database.loadWorkset(task).ownerTerminal, true);
  } finally {
    database.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});

test('CLI rejects text/path/native identities with a fixed code and no echo', () => {
  const temporary = temporaryDatabase('agent-eta-workset-cli-');
  try {
    const invalid = {
      ...event({ value: 20, id: worksetId('task', 20) }),
      prompt: '/Users/example/private prompt',
    };
    const result = spawnSync(process.execPath, [
      '--no-warnings',
      resolve('scripts/workset.js'),
      '--stdin',
      '--db',
      temporary.filename,
    ], {
      cwd: resolve('.'),
      input: JSON.stringify(invalid),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'WORKSET_UNKNOWN_FIELD');
    assert.doesNotMatch(result.stderr, /Users|max|private|prompt/i);

    const native = event({ value: 21, id: 'native-project-name' });
    const nativeResult = spawnSync(process.execPath, [
      '--no-warnings',
      resolve('scripts/workset.js'),
      '--stdin',
      '--db',
      temporary.filename,
    ], {
      cwd: resolve('.'),
      input: JSON.stringify(native),
      encoding: 'utf8',
    });
    assert.equal(nativeResult.status, 1);
    assert.equal(nativeResult.stderr.trim(), 'WORKSET_INVALID_ID');
  } finally {
    rmSync(temporary.directory, { recursive: true, force: true });
  }
});
