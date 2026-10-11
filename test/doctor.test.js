import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { AgentETA } from '../src/generic/tracker.js';
import { diagnose } from '../src/generic/doctor.js';
import { afterCleanup } from '../test-support/cleanup.js';

const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
const NOW = 1_800_000_000_000;
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eta-doctor-')));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'local data', 'runs.sqlite');
  const env = { ...process.env, AGENT_ETA_TRACKER_DB: '', AGENTWHEN_DB: '' };
  const invoke = (args, options = {}) => spawnSync(process.execPath, ['--no-warnings', cli, ...args],
    { cwd: dir, env, encoding: 'utf8', ...options });
  const tracker = () => {
    const value = new AgentETA({ filename, clock: () => NOW });
    afterCleanup(t, () => value.close());
    return value;
  };
  return { dir, filename, env, invoke, tracker };
}

test('fresh diagnosis creates nothing and returned argument arrays work across directories with spaces', t => {
  const f = fixture(t), other = join(f.dir, 'other directory');
  mkdirSync(other);
  const result = diagnose({ filename: f.filename, profile: 'tool-agent', taskClass: 'coding' });
  assert.equal(result.status, 'not_initialized');
  assert.equal(result.history.state, 'cold_start');
  assert.equal(result.history.additionalRunsNeeded, 3);
  assert.equal(result.dashboard.status, 'not_checked');
  assert.equal(existsSync(join(f.dir, 'local data')), false);
  const [executable, ...args] = result.commands.start;
  const started = spawnSync(executable, args, { cwd: other, env: f.env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const run = JSON.parse(started.stdout);
  assert.equal(run.estimateStatus, 'cold_start');
  assert.equal(run.remainingMinutes, null);
  const list = spawnSync(result.commands.list[0], result.commands.list.slice(1), { cwd: other, env: f.env, encoding: 'utf8' });
  assert.equal(JSON.parse(list.stdout)[0].runId, run.runId);
  assert.equal(existsSync(join(other, '.agent-eta')), false);
  assert.equal(JSON.parse(f.invoke(['pause', run.runId, '--db', f.filename]).stdout).status, 'paused');
  assert.equal(JSON.parse(f.invoke(['resume', run.runId, '--db', f.filename]).stdout).status, 'running');
  assert.equal(JSON.parse(f.invoke(['finish', run.runId, '--db', f.filename, '--outcome', 'cancelled']).stdout).status, 'cancelled');
});

test('diagnosis uses exactly the predictor history filter and 200-run cap without forecasting', t => {
  const f = fixture(t), tracker = f.tracker();
  const insert = tracker.db.prepare(`INSERT INTO agentwhen_runs
    (id, profile, task_class, status, started_at, finished_at, active_ms, last_seen, history_eligible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const row = (id, { profile = 'scope', taskClass = 'coding', status = 'succeeded', eligible = 1, duration = 1000, end = NOW - 1000 } = {}) =>
    insert.run(id, profile, taskClass, status, end - duration, end, duration, end, eligible);
  row('failed', { status: 'failed' }); row('cancelled', { status: 'cancelled' });
  row('gap', { eligible: 0 }); row('zero', { duration: 0 }); row('future', { end: NOW + 1000 });
  row('profile', { profile: 'another' }); row('class', { taskClass: 'writing' });
  const options = { filename: f.filename, profile: 'scope', taskClass: 'coding' };
  assert.equal(diagnose(options, () => NOW).history.eligibleRuns, 0);
  for (let i = 0; i < 3; i++) row(`valid-${i}`);
  const initial = diagnose(options, () => NOW);
  assert.equal(initial.history.eligibleRuns, 3);
  assert.equal(initial.history.state, 'experimental');
  assert.equal(initial.history.calibrated, false);
  const run = tracker.start({ profile: 'scope', taskClass: 'coding' });
  assert.equal(initial.history.eligibleRuns, run.historyCount);
  for (let i = 3; i < 205; i++) row(`valid-${i}`);
  assert.equal(diagnose(options, () => NOW).history.eligibleRuns, 200);
  assert.equal(tracker.status(run.runId).historyCount, 200);
});

test('diagnosis of an open WAL database leaves rows, forecasts, database and WAL unchanged', t => {
  const f = fixture(t), tracker = f.tracker();
  tracker.start();
  const bytes = () => [f.filename, `${f.filename}-wal`].map(path => readFileSync(path));
  const before = bytes();
  const counts = () => tracker.db.prepare('SELECT (SELECT count(*) FROM agentwhen_runs) AS runs, (SELECT count(*) FROM eta_forecasts) AS forecasts').get();
  const previous = counts();
  const first = diagnose({ filename: f.filename }, () => NOW);
  assert.deepEqual(diagnose({ filename: f.filename }, () => NOW), first);
  assert.deepEqual(bytes(), before);
  assert.deepEqual(counts(), previous);
});

test('CLI exposes path precedence, relative environment paths and legacy fallback without creating a store', t => {
  const f = fixture(t);
  const report = (args = [], env = f.env, cwd = f.dir) => {
    const r = f.invoke(['doctor', ...args], { env, cwd });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  let r = report();
  assert.equal(r.database.path, join(f.dir, '.agent-eta', 'runs.sqlite'));
  assert.equal(r.database.source, 'working_directory');
  assert.equal(r.database.dependsOnWorkingDirectory, true);
  const env = { ...f.env, AGENT_ETA_TRACKER_DB: 'primary.sqlite', AGENTWHEN_DB: 'legacy.sqlite' };
  r = report([], env);
  assert.equal(r.database.source, 'AGENT_ETA_TRACKER_DB');
  assert.equal(r.database.path, join(f.dir, 'primary.sqlite'));
  assert.equal(r.database.dependsOnWorkingDirectory, true);
  r = report(['--db', f.filename], env);
  assert.equal(r.database.source, 'argument');
  assert.equal(r.database.path, f.filename);
  assert.equal(r.database.dependsOnWorkingDirectory, false);
  r = report([], { ...env, AGENT_ETA_TRACKER_DB: '' });
  assert.equal(r.database.source, 'AGENTWHEN_DB');
  assert.deepEqual(readdirSync(f.dir), []);
  const legacy = join(f.dir, '.agentwhen', 'runs.sqlite');
  new AgentETA({ filename: legacy }).close();
  r = report();
  assert.equal(r.database.source, 'legacy_directory');
  assert.equal(r.database.path, legacy);
  assert.equal(r.status, 'ready');
  const other = join(f.dir, 'another'); mkdirSync(other);
  assert.notEqual(report([], f.env, other).database.path, r.database.path);
  assert.equal(existsSync(join(other, '.agent-eta')), false);
});

test('foreign, corrupt, directory and incomplete schemas are blocked without overwriting anything', t => {
  const f = fixture(t);
  for (const mode of ['foreign', 'corrupt', 'incomplete', 'journal']) {
    const filename = join(f.dir, `${mode}.sqlite`);
    if (mode === 'corrupt') writeFileSync(filename, 'not a database');
    else {
      const db = mode === 'journal' ? new AgentETA({ filename }).db : new DatabaseSync(filename);
      if (mode === 'foreign') db.exec('CREATE TABLE unrelated (id TEXT)');
      if (mode === 'incomplete') db.exec('CREATE TABLE agentwhen_runs (id TEXT)');
      if (mode === 'journal') db.exec('DROP TABLE eta_forecasts; CREATE TABLE eta_forecasts (id TEXT)');
      db.close();
    }
    const before = readFileSync(filename);
    const out = f.invoke(['doctor', '--db', filename]);
    assert.equal(out.status, 1);
    const r = JSON.parse(out.stdout);
    assert.equal(r.status, 'blocked');
    assert.equal(r.commands, null);
    assert.equal(r.history, null);
    assert.deepEqual(readFileSync(filename), before);
  }
  assert.equal(diagnose({ filename: f.dir }).error, 'DATABASE_NOT_FILE');
});

test('legacy runs-only schema is diagnosed without creating the missing journal', t => {
  const f = fixture(t), tracker = f.tracker();
  tracker.db.exec('DROP TABLE eta_forecasts');
  assert.equal(diagnose({ filename: f.filename }).status, 'ready');
  assert.equal(tracker.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='eta_forecasts'").get().n, 0);
});

test('invalid CLI arguments fail without initializing a store; alias has the same diagnosis', t => {
  const f = fixture(t);
  for (const args of [ ['--db', ''], ['--db', ':memory:'], ['--profile', 'PRIVATE TEXT'],
    ['--class', 'invented'], ['--port', '0'], ['--port', '65536'], ['--port', 'text'],
    ['extra-id'], ['--plan', 'x'], ['--outcome', 'failed'], ['--', 'unexpected'] ]) {
    const r = f.invoke(['doctor', ...args]);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(r.stderr.includes('PRIVATE TEXT'), false);
  }
  assert.deepEqual(readdirSync(f.dir), []);
  const options = ['doctor', '--db', f.filename, '--profile', 'wiring', '--class', 'review', '--port', '54321'];
  const current = JSON.parse(f.invoke(options).stdout);
  const old = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url)), ...options],
    { cwd: f.dir, env: f.env, encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  const legacy = JSON.parse(old.stdout); delete current.checkedAt; delete legacy.checkedAt;
  assert.deepEqual(current, legacy);
  assert.equal(current.dashboard.url, 'http://127.0.0.1:54321');
});
