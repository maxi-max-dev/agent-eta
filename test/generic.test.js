import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { AgentWhen } from '../src/generic/tracker.js';

function setup(t) {
  let now = 1_800_000_000_000;
  const tracker = new AgentWhen({ filename: ':memory:', clock: () => now });
  t.after(() => tracker.close());
  return { tracker, advance: ms => { now += ms; } };
}

test('cold start exposes no invented ETA; status is not a heartbeat', t => {
  const { tracker, advance } = setup(t);
  const first = tracker.start();
  assert.equal(first.estimateStatus, 'cold_start');
  assert.equal(first.remainingMinutes, null);
  advance(61_000);
  const later = tracker.status(first.runId);
  assert.equal(later.estimateStatus, 'stale');
  assert.equal(later.observedAt, first.observedAt);
  assert.notEqual(later.estimatedAt, first.estimatedAt);
  const ping = tracker.ping(first.runId);
  assert.equal(ping.estimateStatus, 'observation_gap');
  assert.equal(ping.historyEligible, false);
});

test('pause time is excluded; duplicate pause/resume does not double count; terminal cannot reopen', t => {
  const { tracker, advance } = setup(t);
  const { runId } = tracker.start();
  advance(30_000); tracker.pause(runId);
  advance(600_000); tracker.pause(runId);
  assert.equal(tracker.status(runId).activeMinutes, 0.5);
  tracker.resume(runId);
  advance(15_000); tracker.resume(runId);
  advance(15_000);
  const end = tracker.finish(runId);
  assert.equal(end.activeMinutes, 1);
  assert.equal(end.historyEligible, true);
  advance(60_000);
  const duplicate = tracker.finish(runId, 'failed');
  assert.equal(duplicate.status, 'succeeded');
  assert.equal(duplicate.finishedAt, end.finishedAt);
  assert.equal(tracker.resume(runId).status, 'succeeded');
  assert.equal(tracker.status(runId).activeMinutes, 1);
});

test('history requires successful, continuously observed, matching-profile/class runs', t => {
  const { tracker, advance } = setup(t);
  const finish = (options, duration, outcome = 'succeeded') => {
    const { runId } = tracker.start(options);
    advance(duration);
    tracker.finish(runId, outcome);
  };
  finish({}, 20_000, 'failed');
  finish({}, 20_000, 'cancelled');
  finish({}, 61_000);
  finish({ profile: 'different' }, 30_000);
  finish({ taskClass: 'coding' }, 30_000);
  for (const duration of [20_000, 30_000, 40_000]) finish({}, duration);
  const first = tracker.start();
  assert.equal(first.historyCount, 3);
  assert.equal(first.estimateStatus, 'experimental');
  const { p20, p50, p80 } = first.remainingMinutes;
  assert.ok(p20 <= p50 && p50 <= p80);
  advance(10_000);
  const refreshed = tracker.status(first.runId);
  assert.equal(refreshed.observedAt, first.observedAt);
  assert.ok(refreshed.remainingMinutes.p50 < first.remainingMinutes.p50);
  assert.equal(refreshed.calibrated, false);
  assert.equal(tracker.start({ profile: 'new-agent' }).historyCount, 0);
});

test('a wall-clock reversal cannot create negative active duration', t => {
  const { tracker, advance } = setup(t);
  const { runId } = tracker.start();
  advance(-10_000);
  assert.equal(tracker.ping(runId).activeMinutes, 0);
  assert.equal(tracker.finish(runId).activeMinutes, 0);
});

const cli = fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url));
function cliFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentwhen-test-'));
  const db = join(dir, 'runs.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', cli, ...args, '--db', db], { encoding: 'utf8', cwd: dir });
  return { dir, db, run };
}

test('independent CLI invocations share state and return parseable JSON', t => {
  const { run } = cliFixture(t);
  const start = run('start', '--profile', 'tool-agent', '--class', 'coding');
  assert.equal(start.status, 0, start.stderr);
  const { runId } = JSON.parse(start.stdout);
  assert.equal(JSON.parse(run('pause', runId).stdout).status, 'paused');
  assert.equal(JSON.parse(run('resume', runId).stdout).status, 'running');
  assert.equal(JSON.parse(run('finish', runId, '--outcome', 'failed').stdout).status, 'failed');
  assert.equal(JSON.parse(run('watch', runId).stdout).estimateStatus, 'terminal');
  assert.equal(JSON.parse(run('list').stdout).length, 1);
  assert.equal(run('status', 'invalid-id').status, 1);
  assert.equal(run('start', '--profile', '../bad').status, 1);
  assert.equal(run('start', '--class', 'invented').status, 1);
  assert.equal(run('finish', runId, '--outcome', 'invented').status, 1);
});

test('process wrapper preserves output and exit code, without storing command or output', t => {
  const { db, dir } = cliFixture(t);
  const marker = 'PRIVATE_PROMPT_MUST_NOT_PERSIST';
  const result = spawnSync(process.execPath, ['--no-warnings', cli, 'run', '--db', db, '--profile', 'test',
    '--', process.execPath, '-e', `process.stdout.write('${marker}');process.exit(7)`], { encoding: 'utf8', cwd: dir });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, marker);
  const states = result.stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(states.at(-1).status, 'failed');
  assert.equal(readFileSync(db).includes(Buffer.from(marker)), false);
});

test('process wrapper records launch errors and returns 127', t => {
  const { db } = cliFixture(t);
  const result = spawnSync(process.execPath, ['--no-warnings', cli, 'run', '--db', db, '--',
    'agentwhen-test-nonexistent-executable'], { encoding: 'utf8' });
  assert.equal(result.status, 127);
  assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).status, 'failed');
});

test('process wrapper emits live heartbeats and exits successfully', async t => {
  const { db } = cliFixture(t);
  const child = spawn(process.execPath, ['--no-warnings', cli, 'run', '--db', db, '--interval', '1',
    '--', process.execPath, '-e', 'setTimeout(() => {}, 1400)']);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  const rows = stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length >= 3);
  assert.ok(rows[1].observedAt > rows[0].observedAt);
  assert.equal(rows.at(-1).status, 'succeeded');
});

test('interrupting a wrapper records cancellation and propagates the signal', { skip: process.platform === 'win32' }, async t => {
  const { db } = cliFixture(t);
  const child = spawn(process.execPath, ['--no-warnings', cli, 'run', '--db', db,
    '--', process.execPath, '-e', 'setTimeout(() => {}, 10000)']);
  let stderr = '';
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise(resolve => child.stderr.once('data', chunk => { stderr += chunk; resolve(); }));
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Wait until the wrapper has installed its signal handler after spawning.
  await new Promise(resolve => setTimeout(resolve, 100));
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  const rows = stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.at(-1).status, 'cancelled');
});
