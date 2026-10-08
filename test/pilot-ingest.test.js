import { afterCleanup } from '../test-support/cleanup.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { importLiveScans } from '../src/adapters/importer.js';
import { createCodexShadowWatcher } from '../src/live/watcher.js';
import { scanCodexPilotSession } from '../src/pilot/codex-goal-scan.js';
import { taskWorksetIdForGoal } from '../src/pilot/ingest.js';
import { buildActiveLiveSelections, buildLatestLiveSnapshot } from '../src/server/main.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const THREAD = '01999999-1111-2222-3333-444444444444';
const SESSION = '01999999-aaaa-bbbb-cccc-dddddddddddd';
const TURN_A = 'private-turn-a';
const TURN_B = 'private-turn-b';
const CREATED_SECONDS = Date.parse('2026-08-30T00:00:00.000Z') / 1_000;

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function call(timestamp, name, callId, argumentsValue = {}) {
  return record(timestamp, 'response_item', {
    type: 'function_call',
    name,
    call_id: callId,
    arguments: JSON.stringify(argumentsValue),
  });
}

function output(timestamp, callId, value) {
  return record(timestamp, 'response_item', {
    type: 'function_call_output',
    call_id: callId,
    output: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

function goal(status, updatedSeconds) {
  return {
    goal: {
      threadId: THREAD,
      objective: 'private objective must never persist',
      status,
      createdAt: CREATED_SECONDS,
      updatedAt: CREATED_SECONDS + updatedSeconds,
    },
    remainingTokens: null,
    completionBudgetReport: null,
  };
}

function base({ includeConfirmation = true } = {}) {
  const records = [
    record('2026-08-30T00:00:00.000Z', 'session_meta', {
      id: THREAD,
      session_id: SESSION,
      timestamp: '2026-08-30T00:00:00.000Z',
    }),
    record('2026-08-30T00:00:01.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:01.000Z',
    }),
    call('2026-08-30T00:00:02.000Z', 'create_goal', 'goal-create', {
      objective: 'private objective must never persist',
    }),
    output('2026-08-30T00:00:02.100Z', 'goal-create', 'Goal created'),
  ];
  if (includeConfirmation) {
    records.push(
      call('2026-08-30T00:00:03.000Z', 'get_goal', 'goal-get-a'),
      output('2026-08-30T00:00:03.100Z', 'goal-get-a', goal('active', 2)),
    );
  }
  return records;
}

function blocked(records) {
  return [
    ...records,
    call('2026-08-30T00:00:04.000Z', 'update_goal', 'goal-block', { status: 'blocked' }),
    output('2026-08-30T00:00:04.100Z', 'goal-block', goal('blocked', 4)),
  ];
}

function resumed(records) {
  return [
    ...records,
    record('2026-08-30T00:00:05.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:05.000Z',
    }),
    record('2026-08-30T00:00:06.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
      started_at: '2026-08-30T00:00:06.000Z',
    }),
    call('2026-08-30T00:00:07.000Z', 'get_goal', 'goal-get-b'),
    output('2026-08-30T00:00:07.100Z', 'goal-get-b', goal('active', 7)),
  ];
}

function completed(records) {
  return [
    ...records,
    call('2026-08-30T00:00:08.000Z', 'update_goal', 'goal-complete', { status: 'complete' }),
    output('2026-08-30T00:00:08.100Z', 'goal-complete', goal('complete', 8)),
  ];
}

function jsonl(records) {
  return `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-pilot-'));
  afterCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  return {
    file: join(directory, 'private-transcript.jsonl'),
    database: new AgentEtaDatabase(join(directory, 'pilot.sqlite')),
  };
}

test('bare create stays unbound while structured goal receipts drive one open task across turns', async (t) => {
  const first = fixture(t);
  afterCleanup(t, () => first.database.close());
  await writeFile(first.file, jsonl(base({ includeConfirmation: false })), 'utf8');
  const unsupported = await scanCodexPilotSession(first.file);
  importLiveScans({
    database: first.database,
    scans: [unsupported],
    receivedAt: '2026-08-30T00:10:00.000Z',
  });
  assert.equal(first.database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
  assert.equal(first.database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_receipts').get().count, 0);

  const activeRecords = base();
  await writeFile(first.file, jsonl(activeRecords), 'utf8');
  const activeScan = await scanCodexPilotSession(first.file);
  const activeImport = importLiveScans({
    database: first.database,
    scans: [activeScan],
    receivedAt: '2026-08-30T00:10:01.000Z',
  });
  const goalId = activeScan.goalPilot.projections[0].events[0].goalId;
  const taskId = taskWorksetIdForGoal(goalId);
  let task = first.database.loadWorkset(taskId);
  assert.equal(activeImport.goalPilot.insertedWorksetEvents, 1);
  assert.equal(task.worksetType, 'task');
  assert.equal(task.worksetClosed, false);
  assert.equal(task.status, 'running');
  assert.equal(task.members.length, 1);
  assert.equal(first.database.listWorksetForecasts(taskId).at(-1).forecast.status, 'unknown');
  assert.equal(first.database.loadWorksetSource(taskId).sourceStatus, 'verified_structural');
  assert.equal(first.database.db.prepare(`SELECT COUNT(*) AS count FROM worksets WHERE workset_type = 'project'`).get().count, 0);

  await writeFile(first.file, jsonl(blocked(activeRecords)), 'utf8');
  importLiveScans({
    database: first.database,
    scans: [await scanCodexPilotSession(first.file)],
    receivedAt: '2026-08-30T00:11:00.000Z',
  });
  task = first.database.loadWorkset(taskId);
  assert.equal(task.status, 'blocked');
  assert.equal(first.database.listWorksetForecasts(taskId).at(-1).forecast.p50Minutes, null);

  const resumedRecords = resumed(blocked(activeRecords));
  await writeFile(first.file, jsonl(resumedRecords), 'utf8');
  importLiveScans({
    database: first.database,
    scans: [await scanCodexPilotSession(first.file)],
    receivedAt: '2026-08-30T00:12:00.000Z',
  });
  task = first.database.loadWorkset(taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.revision, 2);
  assert.equal(task.members.length, 2);
  assert.equal(task.worksetClosed, false);

  await writeFile(first.file, jsonl(completed(resumedRecords)), 'utf8');
  importLiveScans({
    database: first.database,
    scans: [await scanCodexPilotSession(first.file)],
    receivedAt: '2026-08-30T00:13:00.000Z',
  });
  task = first.database.loadWorkset(taskId);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.ownerTerminal, true);
  assert.equal(task.outcomeMinutes, 5 / 60);
  assert.equal(first.database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_receipts').get().count, 4);
  assert.equal(first.database.db.prepare(`
    SELECT COUNT(*) AS count FROM codex_goal_receipts
    WHERE applied = 1 AND censored = 0 AND quarantined = 0
  `).get().count, 4);
  assert.deepEqual(first.database.db.prepare('PRAGMA foreign_key_check').all(), []);
  const publicScan = JSON.stringify(activeScan.goalPilot);
  for (const privateValue of [THREAD, SESSION, TURN_A, 'private objective', first.file]) {
    assert.equal(publicScan.includes(privateValue), false);
  }
});

test('historical Goal replay stays out of realtime selection until a distinct live receipt arrives', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-provenance-'));
  afterCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  const filename = join(directory, 'pilot.sqlite');
  let database = new AgentEtaDatabase(filename);
  afterCleanup(t, () => {
    try { database.close(); } catch {}
  });

  const initial = base();
  await writeFile(file, jsonl(initial), 'utf8');
  const firstScan = await scanCodexPilotSession(file);
  const first = importLiveScans({
    database,
    scans: [firstScan],
    receivedAt: '2026-08-30T00:10:00.000Z',
    goalPilotMode: 'backfill',
  });
  assert.equal(first.goalPilot.backfillGoalReceipts, 1);
  assert.equal(first.goalPilot.liveGoalReceipts, 0);
  assert.deepEqual(database.db.prepare(`
    SELECT first_ingest_mode FROM codex_goal_receipts
  `).all().map((row) => row.first_ingest_mode), ['backfill']);
  assert.equal(
    buildActiveLiveSelections(database, new Date('2026-08-30T00:10:01.000Z'))
      .selections.some((entry) => entry.meta.defaultScope === 'task'),
    false,
  );
  const goalId = firstScan.goalPilot.projections[0].events[0].goalId;
  const taskId = taskWorksetIdForGoal(goalId);
  const backfillSelection = `sel-${createHash('sha256')
    .update(`agent-eta-workset-selection\0${taskId}`)
    .digest('hex').slice(0, 20)}`;
  const historical = buildLatestLiveSnapshot(database, {
    selectionId: backfillSelection,
    scope: 'task',
  });
  assert.equal(historical.status, 'unknown');
  assert.equal(historical.forecast.status, 'historical_backfill');
  assert.equal(historical.forecast.p50Minutes, null);
  assert.equal(historical.display.headline, '历史结构观察');

  // Replaying the identical immutable receipt through a live watcher window
  // cannot upgrade its first-ingest provenance.
  importLiveScans({
    database,
    scans: [firstScan],
    receivedAt: '2026-08-30T00:11:00.000Z',
    goalPilotMode: 'live',
    goalPilotLiveSinceAt: '2026-08-30T00:00:00.000Z',
  });
  assert.equal(database.db.prepare(`
    SELECT first_ingest_mode FROM codex_goal_receipts
  `).get().first_ingest_mode, 'backfill');

  const later = resumed(initial);
  await writeFile(file, jsonl(later), 'utf8');
  const live = importLiveScans({
    database,
    scans: [await scanCodexPilotSession(file)],
    receivedAt: '2026-08-30T00:12:00.000Z',
    goalPilotMode: 'live',
    goalPilotLiveSinceAt: '2026-08-30T00:00:06.000Z',
  });
  assert.equal(live.goalPilot.liveGoalReceipts, 1);
  assert.equal(live.goalPilot.backfillGoalReceipts, 1);
  assert.deepEqual(database.db.prepare(`
    SELECT first_ingest_mode, COUNT(*) AS count
    FROM codex_goal_receipts
    GROUP BY first_ingest_mode
    ORDER BY first_ingest_mode
  `).all().map((row) => ({ ...row })), [
    { first_ingest_mode: 'backfill', count: 1 },
    { first_ingest_mode: 'live', count: 1 },
  ]);
  assert.equal(
    buildActiveLiveSelections(database, new Date('2026-08-30T00:12:01.000Z'))
      .selections.some((entry) => entry.meta.defaultScope === 'task'),
    true,
  );

  database.close();
  database = new AgentEtaDatabase(filename);
  assert.deepEqual(database.db.prepare(`
    SELECT first_ingest_mode, COUNT(*) AS count
    FROM codex_goal_receipts
    GROUP BY first_ingest_mode
    ORDER BY first_ingest_mode
  `).all().map((row) => ({ ...row })), [
    { first_ingest_mode: 'backfill', count: 1 },
    { first_ingest_mode: 'live', count: 1 },
  ]);
  assert.equal(
    buildActiveLiveSelections(database, new Date('2026-08-30T00:12:02.000Z'))
      .selections.some((entry) => entry.meta.defaultScope === 'task'),
    true,
  );
});

test('get_goal absence is coverage-only and cannot roll back canonical run import', async (t) => {
  const { file, database } = fixture(t);
  afterCleanup(t, () => database.close());
  const records = [
    ...base({ includeConfirmation: false }),
    call('2026-08-30T00:00:03.000Z', 'get_goal', 'goal-absent'),
    output('2026-08-30T00:00:03.100Z', 'goal-absent', {
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    }),
  ];
  await writeFile(file, jsonl(records), 'utf8');
  const imported = importLiveScans({
    database,
    scans: [await scanCodexPilotSession(file)],
    receivedAt: '2026-08-30T00:10:00.000Z',
  });
  assert.equal(imported.insertedRunEvents, 1);
  assert.equal(imported.goalPilot.absentGoalReceipts, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
});

test('an active goal pauses across a turn gap and resumes under the same task alias', async (t) => {
  const { file, database } = fixture(t);
  afterCleanup(t, () => database.close());
  const initialRecords = base();
  await writeFile(file, jsonl(initialRecords), 'utf8');
  const firstScan = await scanCodexPilotSession(file);
  importLiveScans({ database, scans: [firstScan], receivedAt: '2026-08-30T00:10:00.000Z' });
  const taskId = taskWorksetIdForGoal(firstScan.goalPilot.projections[0].events[0].goalId);

  const gapRecords = [
    ...initialRecords,
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:04.000Z',
    }),
  ];
  await writeFile(file, jsonl(gapRecords), 'utf8');
  const gapImport = importLiveScans({
    database,
    scans: [await scanCodexPilotSession(file)],
    receivedAt: '2026-08-30T00:11:00.000Z',
  });
  assert.equal(gapImport.goalPilot.pausedTurnGaps, 1);
  assert.equal(database.loadWorkset(taskId).status, 'paused');
  assert.equal(database.listWorksetForecasts(taskId).at(-1).forecast.p50Minutes, null);

  const nextTurn = [
    ...gapRecords,
    record('2026-08-30T00:00:05.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
      started_at: '2026-08-30T00:00:05.000Z',
    }),
    call('2026-08-30T00:00:06.000Z', 'get_goal', 'goal-next-turn'),
    output('2026-08-30T00:00:06.100Z', 'goal-next-turn', goal('active', 6)),
  ];
  await writeFile(file, jsonl(nextTurn), 'utf8');
  importLiveScans({
    database,
    scans: [await scanCodexPilotSession(file)],
    receivedAt: '2026-08-30T00:12:00.000Z',
  });
  const resumedTask = database.loadWorkset(taskId);
  assert.equal(resumedTask.status, 'running');
  assert.equal(resumedTask.revision, 2);
  assert.equal(resumedTask.members.length, 2);
});

test('active or blocked goal disappearance is persisted as censored and survives restart', async (t) => {
  for (const initialStatus of ['active', 'blocked']) {
    await t.test(initialStatus, async (subtest) => {
      const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-censored-'));
      afterCleanup(subtest, () => rmSync(directory, { recursive: true, force: true }));
      const file = join(directory, 'session.jsonl');
      const filename = join(directory, 'pilot.sqlite');
      let database = new AgentEtaDatabase(filename);
      afterCleanup(subtest, () => {
        try {
          database.close();
        } catch {
          // The restart path closes the first handle explicitly.
        }
      });
      const starting = initialStatus === 'blocked' ? blocked(base()) : base();
      await writeFile(file, jsonl(starting), 'utf8');
      const initial = await scanCodexPilotSession(file);
      importLiveScans({ database, scans: [initial], receivedAt: '2026-08-30T00:10:00.000Z' });
      const taskId = taskWorksetIdForGoal(initial.goalPilot.projections[0].events[0].goalId);

      const absentAt = initialStatus === 'blocked' ? '2026-08-30T00:00:05.000Z' : '2026-08-30T00:00:04.000Z';
      const absentOutputAt = initialStatus === 'blocked'
        ? '2026-08-30T00:00:05.100Z'
        : '2026-08-30T00:00:04.100Z';
      await writeFile(file, jsonl([
        ...starting,
        call(absentAt, 'get_goal', `goal-absent-${initialStatus}`),
        output(absentOutputAt, `goal-absent-${initialStatus}`, {
          goal: null,
          remainingTokens: null,
          completionBudgetReport: null,
        }),
      ]), 'utf8');
      const result = importLiveScans({
        database,
        scans: [await scanCodexPilotSession(file)],
        receivedAt: '2026-08-30T00:11:00.000Z',
      });
      assert.equal(result.goalPilot.censoredGoals, 1);
      assert.equal(database.loadWorkset(taskId).status, 'paused');
      assert.equal(database.loadWorkset(taskId).ownerTerminal, false);
      assert.equal(database.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_goal_receipts
        WHERE kind = 'goal_absent' AND censored = 1 AND applied = 0
      `).get().count, 1);

      database.close();
      database = new AgentEtaDatabase(filename);
      assert.equal(database.loadWorkset(taskId).status, 'paused');
      assert.equal(database.db.prepare(`
        SELECT COUNT(*) AS count FROM codex_goal_receipts
        WHERE censored = 1 AND quarantined = 0
      `).get().count, 1);
    });
  }
});

test('a malformed durable line makes an already known goal source sticky quarantined', async (t) => {
  const { file, database } = fixture(t);
  afterCleanup(t, () => database.close());
  await writeFile(file, jsonl(base()), 'utf8');
  const initial = await scanCodexPilotSession(file);
  importLiveScans({ database, scans: [initial], receivedAt: '2026-08-30T00:10:00.000Z' });
  const taskId = taskWorksetIdForGoal(initial.goalPilot.projections[0].events[0].goalId);
  assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'verified_structural');

  const corrupted = `${jsonl(base())}{not-valid-json}\n${JSON.stringify(record(
    '2026-08-30T00:00:03.200Z',
    'event_msg',
    { type: 'agent_message', message: 'private tail' },
  ))}\n`;
  await writeFile(file, corrupted, 'utf8');
  const quarantined = await scanCodexPilotSession(file);
  assert.ok(quarantined.goalPilot.errorCodes.length > 0);
  assert.equal(quarantined.goalPilot.quarantinedGoalIds.length, 1);
  importLiveScans({
    database,
    scans: [quarantined],
    receivedAt: '2026-08-30T00:11:00.000Z',
  });
  assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'quarantined');

  await writeFile(file, jsonl(base()), 'utf8');
  importLiveScans({
    database,
    scans: [await scanCodexPilotSession(file)],
    receivedAt: '2026-08-30T00:12:00.000Z',
  });
  assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'quarantined');
});

test('a first-seen conflicted goal remains tombstoned across restart and a later clean branch', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-tombstone-'));
  afterCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const poisonedFile = join(directory, 'poisoned.jsonl');
  const cleanFile = join(directory, 'clean-copy.jsonl');
  const filename = join(directory, 'pilot.sqlite');
  const poisonedRecords = [
    ...base(),
    call('2026-08-30T00:00:04.000Z', 'update_goal', 'goal-finish-poisoned', {
      status: 'complete',
    }),
    output('2026-08-30T00:00:04.100Z', 'goal-finish-poisoned', goal('complete', 4)),
    call('2026-08-30T00:00:05.000Z', 'get_goal', 'goal-reopen-poisoned'),
    output('2026-08-30T00:00:05.100Z', 'goal-reopen-poisoned', goal('active', 5)),
  ];
  await writeFile(poisonedFile, jsonl(poisonedRecords), 'utf8');
  await writeFile(cleanFile, jsonl(base()), 'utf8');

  let database = new AgentEtaDatabase(filename);
  afterCleanup(t, () => {
    try {
      database.close();
    } catch {
      // The restart path closes the first handle explicitly.
    }
  });
  const poisoned = await scanCodexPilotSession(poisonedFile);
  assert.equal(poisoned.goalPilot.projections.length, 0);
  assert.equal(poisoned.goalPilot.quarantinedGoalIds.length, 1);
  const first = importLiveScans({
    database,
    scans: [poisoned],
    receivedAt: '2026-08-30T00:10:00.000Z',
  });
  assert.equal(first.insertedRunEvents, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM workset_sources').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_receipts').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_quarantines').get().count, 1);

  database.close();
  database = new AgentEtaDatabase(filename);
  const clean = await scanCodexPilotSession(cleanFile);
  assert.equal(clean.goalPilot.projections.length, 1);
  const retried = importLiveScans({
    database,
    scans: [clean],
    receivedAt: '2026-08-30T00:11:00.000Z',
  });
  assert.equal(retried.goalPilot.insertedWorksetEvents, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM workset_sources').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_quarantines').get().count, 1);
});

test('lifecycle, state, and causality conflicts downgrade only their previously verified task', async (t) => {
  const cases = [
    {
      name: 'lifecycle',
      append: [record('2026-08-30T00:00:04.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: TURN_A,
        started_at: '2026-08-30T00:00:04.000Z',
      })],
    },
    {
      name: 'state',
      append: [
        call('2026-08-30T00:00:04.000Z', 'update_goal', 'goal-finish-conflict', {
          status: 'complete',
        }),
        output('2026-08-30T00:00:04.100Z', 'goal-finish-conflict', goal('complete', 4)),
        call('2026-08-30T00:00:05.000Z', 'get_goal', 'goal-reopen-conflict'),
        output('2026-08-30T00:00:05.100Z', 'goal-reopen-conflict', goal('active', 5)),
      ],
    },
    {
      name: 'causality',
      append: [
        call('2026-08-30T00:00:04.000Z', 'get_goal', 'goal-time-conflict'),
        output('2026-08-30T00:00:03.500Z', 'goal-time-conflict', goal('active', 3)),
      ],
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const { file, database } = fixture(subtest);
      afterCleanup(subtest, () => database.close());
      await writeFile(file, jsonl(base()), 'utf8');
      const initial = await scanCodexPilotSession(file);
      importLiveScans({ database, scans: [initial], receivedAt: '2026-08-30T00:10:00.000Z' });
      const taskId = taskWorksetIdForGoal(initial.goalPilot.projections[0].events[0].goalId);

      await writeFile(file, jsonl([...base(), ...entry.append]), 'utf8');
      const conflicted = await scanCodexPilotSession(file);
      assert.ok(conflicted.goalPilot.errorCodes.length > 0);
      assert.equal(conflicted.goalPilot.quarantinedGoalIds.length, 1);
      importLiveScans({
        database,
        scans: [conflicted],
        receivedAt: '2026-08-30T00:11:00.000Z',
      });
      assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'quarantined');
    });
  }
});

test('a target thread that starts late in a mixed file still sticky-quarantines its prior task', async (t) => {
  const { file, database } = fixture(t);
  afterCleanup(t, () => database.close());
  const childThread = '01888888-1111-2222-3333-444444444444';
  const prefix = [record('2026-08-29T23:59:00.000Z', 'session_meta', {
    id: childThread,
    session_id: SESSION,
    timestamp: '2026-08-29T23:59:00.000Z',
  })];
  for (let index = 0; index < 30; index += 1) {
    prefix.push(record(`2026-08-29T23:59:${String(index + 1).padStart(2, '0')}.000Z`, 'event_msg', {
      type: 'agent_message',
      message: `private child ${index}`,
    }));
  }
  const valid = [...prefix, ...base()];
  await writeFile(file, jsonl(valid), 'utf8');
  const initial = await scanCodexPilotSession(file);
  importLiveScans({ database, scans: [initial], receivedAt: '2026-08-30T00:10:00.000Z' });
  const taskId = taskWorksetIdForGoal(initial.goalPilot.projections[0].events[0].goalId);

  await writeFile(file, jsonl([
    ...valid,
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:04.000Z',
    }),
  ]), 'utf8');
  const conflicted = await scanCodexPilotSession(file);
  assert.equal(conflicted.goalPilot.quarantinedGoalIds.length, 1);
  importLiveScans({ database, scans: [conflicted], receivedAt: '2026-08-30T00:11:00.000Z' });
  assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'quarantined');
});

test('a local receipt cannot precede active or complete Goal output time', async (t) => {
  await t.test('active output', async (subtest) => {
    const { file, database } = fixture(subtest);
    afterCleanup(subtest, () => database.close());
    await writeFile(file, jsonl(base()), 'utf8');
    const result = importLiveScans({
      database,
      scans: [await scanCodexPilotSession(file)],
      receivedAt: '2026-08-30T00:00:03.050Z',
    });
    assert.equal(result.insertedRunEvents, 1, 'canonical run import remains independent');
    assert.equal(result.goalPilot.rejectedReceipts, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 1);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_quarantines').get().count, 1);
  });

  await t.test('complete output', async (subtest) => {
    const { file, database } = fixture(subtest);
    afterCleanup(subtest, () => database.close());
    const activeRecords = base();
    await writeFile(file, jsonl(activeRecords), 'utf8');
    const active = await scanCodexPilotSession(file);
    importLiveScans({
      database,
      scans: [active],
      receivedAt: '2026-08-30T00:00:07.000Z',
    });
    const taskId = taskWorksetIdForGoal(active.goalPilot.projections[0].events[0].goalId);

    await writeFile(file, jsonl(completed(activeRecords)), 'utf8');
    const result = importLiveScans({
      database,
      scans: [await scanCodexPilotSession(file)],
      receivedAt: '2026-08-30T00:00:08.050Z',
    });
    assert.equal(result.goalPilot.rejectedReceipts, 1);
    assert.equal(database.loadWorkset(taskId).ownerTerminal, false);
    assert.equal(database.loadWorksetSource(taskId).sourceStatus, 'quarantined');
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_quarantines').get().count, 1);
  });
});

test('run events, goal receipt, task state, source and forecast roll back together on failure', async (t) => {
  const { file, database } = fixture(t);
  afterCleanup(t, () => database.close());
  await writeFile(file, jsonl(base()), 'utf8');
  const scan = await scanCodexPilotSession(file);
  const original = database.saveWorksetForecast.bind(database);
  let failed = false;
  database.saveWorksetForecast = (...args) => {
    if (!failed) {
      failed = true;
      throw new Error('injected-private-storage-failure');
    }
    return original(...args);
  };
  assert.throws(
    () => importLiveScans({
      database,
      scans: [scan],
      receivedAt: '2026-08-30T00:10:00.000Z',
    }),
    /WORKSET_INGEST_FAILED/,
  );
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM worksets').get().count, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM codex_goal_receipts').get().count, 0);

  database.saveWorksetForecast = original;
  const retry = importLiveScans({
    database,
    scans: [scan],
    receivedAt: '2026-08-30T00:10:01.000Z',
  });
  assert.equal(retry.insertedRunEvents, 1);
  assert.equal(retry.goalPilot.insertedWorksetEvents, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM forecast_snapshots').get().count, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM workset_events').get().count, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM workset_forecast_snapshots').get().count, 1);
});

test('the default one-command watcher automatically materializes Goal task state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-watcher-'));
  afterCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  const database = new AgentEtaDatabase(join(directory, 'watcher.sqlite'));
  afterCleanup(t, () => database.close());
  await writeFile(file, jsonl(base()), 'utf8');
  const watcher = createCodexShadowWatcher({
    root: directory,
    database,
    now: () => Date.parse('2026-08-30T00:10:00.000Z'),
    initialLookbackMs: 24 * 60 * 60_000,
  });
  afterCleanup(t, () => watcher.stop());

  const report = await watcher.scanOnce();
  assert.equal(report.ok, true);
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.insertedEvents, 2);
  assert.equal(report.savedForecasts, 2);
  assert.equal(report.goalPilot.scannedGoalReceipts, 1);
  assert.equal(report.goalPilot.liveGoalReceipts, 1);
  assert.equal(report.goalPilot.backfillGoalReceipts, 0);
  assert.equal(report.goalPilot.insertedWorksetEvents, 1);
  assert.equal(watcher.getStatus().goalPilot.quarantinedTasks, 0);
  assert.equal(database.db.prepare(`
    SELECT COUNT(*) AS count FROM workset_sources
    WHERE source_kind = 'codex_goal_shadow' AND source_status = 'verified_structural'
  `).get().count, 1);
  assert.equal(database.db.prepare(`
    SELECT first_ingest_mode FROM codex_goal_receipts
  `).get().first_ingest_mode, 'live');
  const publicState = JSON.stringify({ report, status: watcher.getStatus() });
  for (const privateValue of [directory, file, THREAD, SESSION, TURN_A, 'private objective']) {
    assert.equal(publicState.includes(privateValue), false);
  }
});

test('watcher restart catch-up keeps old Goal receipts backfill while admitting a current receipt', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-goal-restart-provenance-'));
  afterCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  const database = new AgentEtaDatabase(join(directory, 'watcher.sqlite'));
  afterCleanup(t, () => database.close());
  const records = [
    ...base(),
    record('2026-08-30T00:00:05.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:05.000Z',
    }),
    record('2026-08-30T00:09:20.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
      started_at: '2026-08-30T00:09:20.000Z',
    }),
    call('2026-08-30T00:09:30.000Z', 'get_goal', 'goal-get-current'),
    output('2026-08-30T00:09:30.100Z', 'goal-get-current', goal('active', 570)),
  ];
  await writeFile(file, jsonl(records), 'utf8');
  const scanStarted = Date.parse('2026-08-30T00:10:00.000Z');
  const watcher = createCodexShadowWatcher({
    root: directory,
    database,
    now: () => scanStarted,
    initialLookbackMs: 60_000,
    overlapMs: 5_000,
    loadState: () => ({ watermarkMs: Date.parse('2026-08-30T00:00:10.000Z') }),
    discover: async ({ since }) => {
      assert.equal(since, Date.parse('2026-08-30T00:00:05.000Z'));
      return [{
        file,
        modifiedAt: '2026-08-30T00:09:59.000Z',
        sizeBytes: 100,
      }];
    },
  });
  afterCleanup(t, () => watcher.stop());

  const report = await watcher.scanOnce();
  assert.equal(report.ok, true);
  assert.equal(report.goalPilot.liveGoalReceipts, 1);
  assert.equal(report.goalPilot.backfillGoalReceipts, 1);
  assert.deepEqual(database.db.prepare(`
    SELECT first_ingest_mode, COUNT(*) AS count
    FROM codex_goal_receipts
    GROUP BY first_ingest_mode
    ORDER BY first_ingest_mode
  `).all().map((row) => ({ ...row })), [
    { first_ingest_mode: 'backfill', count: 1 },
    { first_ingest_mode: 'live', count: 1 },
  ]);
  assert.equal(
    buildActiveLiveSelections(database, new Date(scanStarted + 1_000))
      .selections.some((entry) => entry.meta.defaultScope === 'task'),
    true,
  );
});
