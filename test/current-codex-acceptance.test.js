import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scanCodexSession } from '../src/adapters/codex.js';
import { importLiveScans } from '../src/adapters/importer.js';
import { acceptCurrentCodexProject } from '../src/scopes/codex-acceptance.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

function transcript(threadId, turns, sessionId = threadId) {
  const records = [{
    timestamp: '2026-08-29T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, session_id: sessionId, timestamp: '2026-08-29T00:00:00.000Z' },
  }];
  for (const turn of turns) {
    records.push({
      timestamp: turn.startedAt,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turn.id, started_at: turn.startedAt },
    });
    if (turn.finishedAt) {
      records.push({
        timestamp: turn.finishedAt,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: turn.id, completed_at: turn.finishedAt },
      });
    }
  }
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function sessionFile(root, threadId, body) {
  const directory = join(root, '2026', '08', '29');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-${threadId}.jsonl`);
  await writeFile(file, body, 'utf8');
  return file;
}

test('provider-owned binder declares and drives current task/project without exposing identities', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-current-project-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionRoot = join(directory, 'sessions');
  const database = new AgentEtaDatabase(join(directory, 'agent-eta.sqlite'));
  t.after(() => database.close());

  const threadId = '01999999-aaaa-bbbb-cccc-0123456789ab';
  const sessionId = '01999999-dddd-eeee-ffff-0123456789ab';
  const turnId = 'native-private-active-turn';
  const file = await sessionFile(sessionRoot, threadId, transcript(threadId, [{
    id: turnId,
    startedAt: '2026-08-29T00:00:01.000Z',
  }], sessionId));
  importLiveScans({ database, scans: [await scanCodexSession(file)] });

  const declared = await acceptCurrentCodexProject({
    database,
    root: sessionRoot,
    threadId,
    action: 'declare',
    receivedAt: '2026-08-29T00:01:00.000Z',
  });
  assert.deepEqual(Object.keys(declared), ['accepted', 'action', 'task', 'project']);
  assert.deepEqual(Object.keys(declared.task), ['accepted', 'inserted', 'forecastStatus']);
  assert.equal(declared.accepted, true);
  assert.equal(declared.task.forecastStatus, 'forecast');
  assert.equal(declared.project.forecastStatus, 'forecast');
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 2);
  assert.doesNotMatch(
    JSON.stringify(declared),
    new RegExp(`${threadId}|${sessionId}|${turnId}|${directory}|codex-run|workset-`),
  );

  const repeated = await acceptCurrentCodexProject({
    database,
    root: sessionRoot,
    threadId,
    action: 'declare',
    receivedAt: '2026-08-29T00:01:01.000Z',
  });
  assert.equal(repeated.task.inserted, false);
  assert.equal(repeated.project.inserted, false);

  const heartbeat = await acceptCurrentCodexProject({
    database,
    root: sessionRoot,
    threadId,
    action: 'heartbeat',
    occurredAt: '2026-08-29T00:02:00.000Z',
    receivedAt: '2026-08-29T00:02:01.000Z',
  });
  assert.equal(heartbeat.task.forecastStatus, 'forecast');
  assert.equal(heartbeat.project.forecastStatus, 'forecast');

  const waiting = await acceptCurrentCodexProject({
    database,
    root: sessionRoot,
    threadId,
    action: 'status',
    status: 'needs_input',
    occurredAt: '2026-08-29T00:03:00.000Z',
    receivedAt: '2026-08-29T00:03:01.000Z',
  });
  assert.equal(waiting.task.forecastStatus, 'needs_input');
  assert.equal(waiting.project.forecastStatus, 'needs_input');

  const terminal = await acceptCurrentCodexProject({
    database,
    root: sessionRoot,
    threadId,
    action: 'succeeded',
    occurredAt: '2026-08-29T00:04:00.000Z',
    receivedAt: '2026-08-29T00:04:01.000Z',
  });
  assert.equal(terminal.task.forecastStatus, 'terminal');
  assert.equal(terminal.project.forecastStatus, 'terminal');
  assert.equal(database.db.prepare(`
    SELECT COUNT(*) AS count FROM worksets WHERE owner_terminal = 1
  `).get().count, 2);
  assert.deepEqual(database.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('provider-owned binder fails closed for zero and multiple exact-thread active runs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-current-project-fail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionRoot = join(directory, 'sessions');
  const database = new AgentEtaDatabase(join(directory, 'agent-eta.sqlite'));
  t.after(() => database.close());

  const closedThread = '01888888-aaaa-bbbb-cccc-0123456789ab';
  await sessionFile(sessionRoot, closedThread, transcript(closedThread, [{
    id: 'closed-private-turn',
    startedAt: '2026-08-29T00:00:01.000Z',
    finishedAt: '2026-08-29T00:01:01.000Z',
  }]));
  await assert.rejects(
    acceptCurrentCodexProject({ database, root: sessionRoot, threadId: closedThread }),
    (error) => error.message === 'CODEX_REPORTER_NO_ACTIVE_RUN',
  );

  const ambiguousThread = '01777777-aaaa-bbbb-cccc-0123456789ab';
  await sessionFile(sessionRoot, ambiguousThread, transcript(ambiguousThread, [
    { id: 'private-turn-a', startedAt: '2026-08-29T00:00:01.000Z' },
    { id: 'private-turn-b', startedAt: '2026-08-29T00:00:02.000Z' },
  ]));
  await assert.rejects(
    acceptCurrentCodexProject({ database, root: sessionRoot, threadId: ambiguousThread }),
    (error) => error.message === 'CODEX_REPORTER_MULTIPLE_ACTIVE_RUNS',
  );
});
