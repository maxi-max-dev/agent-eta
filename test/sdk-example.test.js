import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runWithTracking } from '../examples/sdk.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-sdk-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  const states = [], warnings = [];
  return { dir, filename, states, warnings, options: { filename, intervalMs: 10,
    onStatus: state => states.push(state), onTrackingError: stage => warnings.push(stage) } };
}
function storedRun(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare('SELECT * FROM agentwhen_runs').get(); }
  finally { db.close(); }
}
function blockUpdates(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`CREATE TRIGGER synthetic_write_failure BEFORE UPDATE ON agentwhen_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
  } finally { db.close(); }
}

test('SDK example returns the operation value, reports actual success and stops its heartbeat', async t => {
  const f = fixture(t);
  const result = { operation: 'synthetic wiring result' };
  let heartbeatSeen;
  const ping = new Promise(resolve => { heartbeatSeen = resolve; });
  const returned = await runWithTracking(async () => { await ping; return result; }, {
    ...f.options, onStatus: state => { f.states.push(state); if (f.states.length > 1) heartbeatSeen(); },
  });
  assert.equal(returned, result);
  assert.equal(f.states.at(-1).status, 'succeeded');
  assert.equal(storedRun(f.filename).status, 'succeeded');
  assert.deepEqual(f.warnings, []);
  const count = f.states.length;
  await delay(30);
  assert.equal(f.states.length, count);
});

test('SDK heartbeat and terminal write failure do not abort the operation or claim a saved completion', async t => {
  const f = fixture(t);
  let heartbeatFailed;
  const failure = new Promise(resolve => { heartbeatFailed = resolve; });
  const result = await runWithTracking(async () => {
    blockUpdates(f.filename);
    await failure;
    await delay(30); // The failing timer must stop, not keep spamming/retrying.
    return 'work completed';
  }, { ...f.options, onTrackingError: stage => { f.warnings.push(stage); if (stage === 'heartbeat') heartbeatFailed(); } });
  assert.equal(result, 'work completed');
  assert.deepEqual(f.warnings, ['heartbeat', 'final status']);
  assert.ok(f.states.every(state => state.status === 'running'));
  assert.equal(storedRun(f.filename).status, 'running');
  const count = f.warnings.length;
  await delay(30);
  assert.equal(f.warnings.length, count);
});

test('SDK example preserves the exact operation error when failure reporting also fails', async t => {
  const f = fixture(t);
  const original = new Error('operation failed');
  await assert.rejects(runWithTracking(async () => {
    blockUpdates(f.filename);
    throw original;
  }, { ...f.options, onTrackingError: () => { throw new Error('reporter failed'); } }), error => error === original);
  assert.equal(storedRun(f.filename).status, 'running');
});

test('SDK example keeps work running after tracking cannot start and contains rejected output callbacks', async t => {
  const f = fixture(t);
  let called = 0;
  const result = await runWithTracking(() => { called++; return 42; }, { ...f.options, filename: f.dir });
  assert.equal(called, 1);
  assert.equal(result, 42);
  assert.deepEqual(f.warnings, ['start']);
  assert.deepEqual(f.states, []);
  const original = { operationFailure: true };
  await assert.rejects(runWithTracking(() => { throw original; }, { ...f.options,
    onStatus: async () => { throw new Error('output rejected'); },
    onTrackingError: async () => { throw new Error('warning rejected'); },
  }), error => error === original);
  await delay(0); // Allow rejected callback promises to settle without escaping.
  assert.equal(storedRun(f.filename).status, 'failed');
});
