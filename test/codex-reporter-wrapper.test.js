import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  codexRunAlias,
  codexSessionAlias,
} from '../src/adapters/codex.js';
import { importLiveScans } from '../src/adapters/importer.js';
import {
  buildCodexReporterReport,
  reportCurrentCodexRun,
  resolveActiveCodexRun,
} from '../src/reporter/codex-wrapper.js';
import { applyReporterObservation } from '../src/reporter/ingest.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function transcript(threadId, turns, {
  sessionId = threadId,
  nestedSessionMeta = null,
} = {}) {
  const records = [{
    timestamp: '2026-08-29T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, session_id: sessionId, timestamp: '2026-08-29T00:00:00.000Z' },
  }];
  if (nestedSessionMeta) {
    records.push({
      timestamp: '2026-08-29T00:00:00.500Z',
      type: 'session_meta',
      payload: {
        id: nestedSessionMeta.id,
        session_id: nestedSessionMeta.sessionId,
        timestamp: '2026-08-29T00:00:00.500Z',
      },
    });
  }
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

async function sessionFile(root, name, body) {
  const directory = join(root, '2026', '08', '29');
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, body, 'utf8');
  return file;
}

function observation(overrides = {}) {
  return {
    reported_at: '2026-08-29T00:01:00.000Z',
    task_class: 'coding',
    eligible_large_task: true,
    model_self_eta_minutes: 12,
    plan_present: false,
    plan_step_count: 0,
    plan_adherence: 'not_applicable',
    ...overrides,
  };
}

test('Codex wrapper resolves one active turn inside only the explicit thread and deduplicates branches', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eta-codex-wrapper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threadId = '01999999-aaaa-bbbb-cccc-0123456789ab';
  const sessionId = '01999999-dddd-eeee-ffff-0123456789ab';
  const turnId = 'native-turn-private-one';
  const body = transcript(
    threadId,
    [{ id: turnId, startedAt: '2026-08-29T00:00:01.000Z' }],
    {
      sessionId,
      nestedSessionMeta: {
        id: 'nested-private-thread',
        sessionId: 'nested-private-session',
      },
    },
  );
  await sessionFile(root, `rollout-primary-${threadId}.jsonl`, body);
  await sessionFile(root, `rollout-copy-${threadId}.jsonl`, body);
  await sessionFile(
    root,
    'rollout-other-01888888-aaaa-bbbb-cccc-0123456789ab.jsonl',
    transcript('01888888-aaaa-bbbb-cccc-0123456789ab', [
      { id: 'later-private-turn', startedAt: '2026-08-29T23:59:59.000Z' },
    ]),
  );

  const expected = codexRunAlias(codexSessionAlias(sessionId), turnId);
  const resolved = await resolveActiveCodexRun({ root, threadId });
  assert.deepEqual(resolved, { provider: 'codex', runId: expected });
  assert.doesNotMatch(
    JSON.stringify(resolved),
    new RegExp(`${threadId}|${sessionId}|${turnId}|${root}`),
  );

  let posted = null;
  const response = await reportCurrentCodexRun({
    root,
    threadId,
    observation: observation(),
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(init.body);
      return new Response(JSON.stringify({ accepted: true, inserted: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(response, { accepted: true, inserted: true });
  assert.deepEqual(posted, buildCodexReporterReport(expected, observation()));
  assert.doesNotMatch(
    JSON.stringify(posted),
    new RegExp(`${threadId}|${sessionId}|${turnId}|${root}`),
  );
});

test('Codex wrapper fails closed for zero or multiple active turns and never selects a global latest run', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-eta-codex-wrapper-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const closedThread = '01777777-aaaa-bbbb-cccc-0123456789ab';
  await sessionFile(root, `rollout-${closedThread}.jsonl`, transcript(closedThread, [{
    id: 'closed-private-turn',
    startedAt: '2026-08-29T00:00:01.000Z',
    finishedAt: '2026-08-29T00:01:01.000Z',
  }]));
  await assert.rejects(
    resolveActiveCodexRun({ root, threadId: closedThread }),
    (error) => error.message === 'CODEX_REPORTER_NO_ACTIVE_RUN',
  );

  const ambiguousThread = '01666666-aaaa-bbbb-cccc-0123456789ab';
  await sessionFile(root, `rollout-${ambiguousThread}.jsonl`, transcript(ambiguousThread, [
    { id: 'private-turn-a', startedAt: '2026-08-29T00:00:01.000Z' },
    { id: 'private-turn-b', startedAt: '2026-08-29T00:00:02.000Z' },
  ]));
  await assert.rejects(
    resolveActiveCodexRun({ root, threadId: ambiguousThread }),
    (error) => error.message === 'CODEX_REPORTER_MULTIPLE_ACTIVE_RUNS',
  );
  await assert.rejects(
    resolveActiveCodexRun({ root, threadId: '01555555-aaaa-bbbb-cccc-0123456789ab' }),
    (error) => error.message === 'CODEX_REPORTER_SESSION_NOT_FOUND',
  );

  const branchedThread = '01444444-aaaa-bbbb-cccc-0123456789ab';
  const branchedTurn = 'private-branched-turn';
  await sessionFile(root, `rollout-stale-${branchedThread}.jsonl`, transcript(branchedThread, [{
    id: branchedTurn,
    startedAt: '2026-08-29T00:00:01.000Z',
  }]));
  await sessionFile(root, `rollout-terminal-${branchedThread}.jsonl`, transcript(branchedThread, [{
    id: branchedTurn,
    startedAt: '2026-08-29T00:00:01.000Z',
    finishedAt: '2026-08-29T00:01:01.000Z',
  }]));
  await assert.rejects(
    resolveActiveCodexRun({ root, threadId: branchedThread }),
    (error) => error.message === 'CODEX_REPORTER_NO_ACTIVE_RUN',
  );

  const splitThread = '01333333-aaaa-bbbb-cccc-0123456789ab';
  await sessionFile(root, `rollout-primary-${splitThread}.jsonl`, transcript(
    splitThread,
    [{ id: 'private-split-turn-a', startedAt: '2026-08-29T00:00:01.000Z' }],
    { sessionId: '01333333-dddd-bbbb-cccc-0123456789ab' },
  ));
  await sessionFile(root, `rollout-branch-${splitThread}.jsonl`, transcript(
    splitThread,
    [{ id: 'private-split-turn-b', startedAt: '2026-08-29T00:00:02.000Z' }],
    { sessionId: '01333333-eeee-bbbb-cccc-0123456789ab' },
  ));
  await assert.rejects(
    resolveActiveCodexRun({ root, threadId: splitThread }),
    (error) => error.message === 'CODEX_REPORTER_MULTIPLE_SESSION_ALIASES',
  );

  const privatePath = '/Users/private/native-session\0scope';
  await assert.rejects(
    resolveActiveCodexRun({ root: privatePath, threadId: splitThread }),
    (error) => error.message === 'CODEX_REPORTER_SCOPE_READ_FAILED'
      && !error.message.includes(privatePath),
  );
});

test('Codex wrapper CLI reduces observation file read failures to a fixed path-free code', async () => {
  const privatePath = '/Users/private/native-reporter-observation.json';
  await assert.rejects(
    execFileAsync(process.execPath, [
      '--no-warnings',
      'scripts/report-codex.js',
      '--file',
      privatePath,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEX_THREAD_ID: '01222222-aaaa-bbbb-cccc-0123456789ab',
      },
    }),
    (error) => error.stderr.trim() === 'CODEX_REPORTER_SCOPE_READ_FAILED'
      && !error.stderr.includes(privatePath),
  );
});

function alias(prefix, value) {
  return `${prefix}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

function liveEvent({ eventId, runId, at, kind, data = {} }) {
  return {
    schema_version: 'agenteta.event/1',
    event_id: alias('codex-event', eventId),
    run_id: runId,
    provider: 'codex',
    native_session_id: alias('codex-session', 'reporter-ingest-session'),
    occurred_at: at,
    observed_at: at,
    kind,
    source: { adapter: 'codex-jsonl', mode: 'local_read_only', confidence: 1 },
    data,
  };
}

test('matched Reporter receipt saves one causal forecast and survives restart; unmatched stays observation-only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-reporter-ingest-'));
  const filename = join(directory, 'reporter.sqlite');
  const runId = alias('codex-run', 'causal-run');
  let database = new AgentEtaDatabase(filename);
  try {
    importLiveScans({
      database,
      scans: [{ events: [
        liveEvent({
          eventId: 'causal-start',
          runId,
          at: '2026-08-29T00:00:00.000Z',
          kind: 'run_started',
          data: { task_class: 'other' },
        }),
        liveEvent({
          eventId: 'future-terminal',
          runId,
          at: '2026-08-29T00:10:00.000Z',
          kind: 'run_succeeded',
        }),
      ] }],
    });
    assert.equal(database.listForecasts(runId).length, 2);
    const report = buildCodexReporterReport(runId, observation());
    const applied = applyReporterObservation(database, report, {
      receivedAt: '2026-08-29T00:02:00.000Z',
    });
    assert.deepEqual(
      { inserted: applied.inserted, matched: applied.matched, forecastSaved: applied.forecastSaved, landmark: applied.landmark },
      { inserted: true, matched: true, forecastSaved: true, landmark: 'receipt' },
    );
    const forecasts = database.listForecasts(runId);
    assert.equal(forecasts.length, 3);
    const receiptForecast = forecasts.at(-1);
    assert.equal(receiptForecast.observed_at, '2026-08-29T00:02:00.000Z');
    assert.equal(receiptForecast.forecast.status, 'forecast');
    assert.equal(receiptForecast.forecast.mode, 'run_fallback');
    assert.deepEqual(receiptForecast.forecast.raw.reporterReceiptLandmark, {
      schemaVersion: 'agenteta.reporter/1',
      reportedAt: '2026-08-29T00:01:00.000Z',
      receivedAt: '2026-08-29T00:02:00.000Z',
      taskClassApplied: 'coding',
      planDeclared: false,
      planStepCount: 0,
      planSynthesized: false,
    });

    const repeated = applyReporterObservation(database, report, {
      receivedAt: '2026-08-29T00:02:00.000Z',
    });
    assert.equal(repeated.inserted, false);
    assert.equal(repeated.forecastSaved, false);
    assert.equal(database.listForecasts(runId).length, 3);

    const unmatchedRun = alias('codex-run', 'unmatched-causal-run');
    const unmatched = applyReporterObservation(
      database,
      buildCodexReporterReport(unmatchedRun, observation({ reported_at: '2026-08-29T00:03:00.000Z' })),
      { receivedAt: '2026-08-29T00:03:01.000Z' },
    );
    assert.deepEqual(
      { matched: unmatched.matched, forecastSaved: unmatched.forecastSaved },
      { matched: false, forecastSaved: false },
    );
    assert.equal(database.listReporterObservations().length, 2);
  } finally {
    database.close();
  }

  database = new AgentEtaDatabase(filename);
  try {
    assert.equal(database.listReporterObservations().length, 2);
    assert.equal(database.listForecasts(runId).length, 3);
    assert.doesNotMatch(
      JSON.stringify(database.listReporterObservations()),
      /native-turn|CODEX_THREAD_ID|\/Users\//,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
