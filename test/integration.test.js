import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 4322;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATABASE_PATH = resolve(ROOT, 'work/qa-agent-eta.sqlite');

function cleanDatabase() {
  for (const suffix of ['', '-shm', '-wal']) {
    rmSync(`${DATABASE_PATH}${suffix}`, { force: true });
  }
}

async function waitForExit(child, timeoutMs = 4_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // npm and the actual Node server share this isolated process group.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  try {
    await waitForExit(child);
  } catch {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await waitForExit(child);
  }
}

async function startServer() {
  const child = spawn('npm', ['start'], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      AGENT_ETA_PORT: String(PORT),
      AGENT_ETA_DB: DATABASE_PATH,
      AGENT_ETA_WATCH: '0',
      AGENT_ETA_WEEKLY_EVAL: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before becoming healthy (${child.exitCode})\n${output}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return child;
    } catch {
      // Startup races are expected for the first few probes.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  await stopServer(child);
  throw new Error(`server did not become healthy\n${output}`);
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text}`);
  return JSON.parse(text);
}

async function reset(fixtureId) {
  return requestJson('/api/replay/reset', { method: 'POST', body: { fixtureId } });
}

async function next() {
  return requestJson('/api/replay/next', { method: 'POST', body: {} });
}

async function advanceTo(cursor) {
  let projection = await requestJson('/api/state');
  while (projection.cursor < cursor) projection = await next();
  assert.equal(projection.cursor, cursor);
  return projection;
}

function inspectDatabase(callback) {
  const database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

test('one-command server drives all six frozen scenarios and persists an auditable replay', { timeout: 30_000 }, async (t) => {
  cleanDatabase();
  let server = await startServer();
  t.after(async () => {
    await stopServer(server);
    cleanDatabase();
  });

  const health = await requestJson('/api/health');
  assert.deepEqual(health, { ok: true, schemaVersion: 7, fixtures: 6 });
  const page = await fetch(BASE_URL);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(await page.text(), /预计|ETA/);

  const fixtureList = await requestJson('/api/fixtures');
  const fixtureIds = fixtureList.map((fixture) => fixture.id).toSorted();
  assert.deepEqual(fixtureIds, [
    'needs-input',
    'no-plan-fallback',
    'parallel-early-subrun',
    'plan-pace-cold',
    'plan-pace-personalized',
    'retry-replan',
  ]);
  assert.ok(fixtureList.every((fixture) => ['cold', 'experienced-fast'].includes(fixture.historyProfile)));

  // A: no-plan runs stay on conditional survival and every event changes state via replay.
  let projection = await reset('no-plan-fallback');
  const noPlanRunId = projection.runId;
  assert.equal(projection.cursor, 1);
  assert.equal(projection.forecast.mode, 'run_fallback');
  assert.equal(projection.forecast.raw.source, 'wide_public_prior');
  assert.equal(projection.state.steps.length, 0);
  const fallbackInitial = projection.forecast.p50Minutes;
  projection = await next();
  assert.equal(projection.cursor, 2);
  assert.ok(projection.forecast.p50Minutes < fallbackInitial);
  projection = await next();
  assert.ok(projection.forecast.p50Minutes < fallbackInitial);
  projection = await next();
  assert.equal(projection.state.status, 'succeeded');
  assert.equal(projection.forecast.status, 'terminal');
  assert.equal(projection.display.headline, '已完成');

  // B: completion of a fast first step supplies the within-run pace observation.
  projection = await reset('plan-pace-cold');
  projection = await advanceTo(2);
  const coldPlanEta = projection.forecast.p50Minutes;
  assert.equal(projection.forecast.mode, 'plan_conditioned');
  assert.equal(projection.forecast.raw.completedPaceObservationCount, 0);
  projection = await advanceTo(4);
  assert.equal(projection.forecast.raw.completedPaceObservationCount, 1);
  assert.ok(projection.forecast.paceMultiplier < 1);
  assert.ok(projection.forecast.p50Minutes < coldPlanEta);
  assert.match(projection.display.reason, /pace|速度/);

  // C: observed retry and replan each extend ETA and explain the new work.
  await reset('retry-replan');
  projection = await advanceTo(8);
  const failedAttemptEta = projection.forecast.p50Minutes;
  projection = await next();
  const retryEta = projection.forecast.p50Minutes;
  assert.equal(projection.state.retryCount, 1);
  assert.ok(retryEta > failedAttemptEta);
  assert.ok(projection.forecast.raw.retryPenaltyMinutes > 0);
  assert.match(projection.display.reason, /重试|失败|工作量/);
  projection = await next();
  assert.equal(projection.state.planRevision, 2);
  assert.ok(projection.forecast.p50Minutes > retryEta);
  assert.match(projection.display.reason, /诊断|计划|失败/);

  // D: a started subrun gets no speculative credit; only its finish shortens ETA.
  await reset('parallel-early-subrun');
  projection = await advanceTo(6);
  const activeSubrunEta = projection.forecast.p50Minutes;
  assert.equal(projection.state.subruns[0].status, 'running');
  assert.equal(projection.forecast.raw.appliedParallelCreditMinutes, 0);
  projection = await next();
  assert.equal(projection.state.subruns[0].status, 'finished');
  assert.ok(projection.forecast.raw.appliedParallelCreditMinutes > 0);
  assert.ok(projection.forecast.p50Minutes < activeSubrunEta);
  assert.match(projection.display.reason, /并行|提前/);

  // E: needs_input replaces the clock ETA and heartbeat time remains inactive.
  await reset('needs-input');
  projection = await advanceTo(4);
  const pausedActiveElapsed = projection.state.activeElapsedMs;
  assert.equal(projection.state.status, 'needs_input');
  assert.equal(projection.forecast.status, 'needs_input');
  assert.equal(projection.display.headline, '等你回复');
  assert.match(projection.display.range, /^回复后约 \d+–\d+ 分钟$/);
  assert.doesNotMatch(projection.display.headline, /预计.*完成/);
  projection = await next();
  assert.equal(projection.state.activeElapsedMs, pausedActiveElapsed);
  assert.equal(projection.display.headline, '等你回复');
  projection = await next();
  assert.equal(projection.state.status, 'running');
  assert.equal(projection.state.activeElapsedMs, pausedActiveElapsed);

  // Cold and 24-history variants share a plan but take visibly different paths.
  await reset('plan-pace-cold');
  projection = await advanceTo(2);
  const firstRun = projection.forecast;
  assert.equal(firstRun.personalMultiplier, 1);
  assert.equal(firstRun.raw.personalizationEligible, false);
  await reset('plan-pace-personalized');
  projection = await advanceTo(2);
  const personalized = projection.forecast;
  assert.equal(personalized.raw.historyCount, 24);
  assert.equal(personalized.raw.personalizationEligible, true);
  assert.ok(personalized.personalMultiplier < 1);
  assert.notEqual(personalized.p50Minutes, firstRun.p50Minutes);
  assert.ok(personalized.p50Minutes < firstRun.p50Minutes);

  // SQLite keeps raw input, per-event raw forecasts, current plan, calibration and outcome.
  inspectDatabase((database) => {
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map((row) => row.name);
    for (const required of [
      'events',
      'runs',
      'plan_steps',
      'forecast_snapshots',
      'calibration_state',
      'replay_state',
    ]) assert.ok(tables.includes(required), `missing table ${required}`);

    const completed = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(noPlanRunId);
    assert.equal(completed.status, 'succeeded');
    assert.ok(completed.finished_at);
    assert.ok(completed.outcome_minutes > 0);
    const rawEvent = database.prepare('SELECT payload_json FROM events WHERE run_id = ? ORDER BY occurred_at LIMIT 1').get(noPlanRunId);
    assert.equal(JSON.parse(rawEvent.payload_json).kind, 'run_started');
    const snapshots = database.prepare('SELECT forecast_json FROM forecast_snapshots WHERE run_id = ? ORDER BY snapshot_id').all(noPlanRunId);
    assert.equal(snapshots.length, 4);
    assert.ok(snapshots.every((row) => typeof JSON.parse(row.forecast_json).raw === 'object'));
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM plan_steps').get().count > 0);
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM calibration_state').get().count > 0);
  });

  // Restart restores the exact cursor and never creates a snapshot merely by reading state.
  await reset('plan-pace-cold');
  projection = await advanceTo(4);
  const restartRunId = projection.runId;
  const restartCursor = projection.cursor;
  const beforeRestart = inspectDatabase((database) => ({
    events: database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get(restartRunId).count,
    snapshots: database.prepare('SELECT COUNT(*) AS count FROM forecast_snapshots WHERE run_id = ?').get(restartRunId).count,
  }));
  await stopServer(server);
  server = await startServer();
  projection = await requestJson('/api/state');
  assert.equal(projection.runId, restartRunId);
  assert.equal(projection.cursor, restartCursor);
  await requestJson('/api/state');
  const afterRead = inspectDatabase((database) => ({
    events: database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get(restartRunId).count,
    snapshots: database.prepare('SELECT COUNT(*) AS count FROM forecast_snapshots WHERE run_id = ?').get(restartRunId).count,
  }));
  assert.deepEqual(afterRead, beforeRestart);
  projection = await next();
  assert.equal(projection.cursor, restartCursor + 1);
  const afterNext = inspectDatabase((database) => ({
    events: database.prepare('SELECT COUNT(*) AS count FROM events WHERE run_id = ?').get(restartRunId).count,
    snapshots: database.prepare('SELECT COUNT(*) AS count FROM forecast_snapshots WHERE run_id = ?').get(restartRunId).count,
  }));
  assert.deepEqual(afterNext, {
    events: beforeRestart.events + 1,
    snapshots: beforeRestart.snapshots + 1,
  });
});

test('evaluation is chronological, compares the five required baselines, bootstraps runs, and labels coverage simulated', () => {
  const evaluation = spawnSync(process.execPath, ['--no-warnings', 'scripts/evaluate.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(evaluation.status, 0, evaluation.stderr || evaluation.stdout);
  const report = JSON.parse(readFileSync(resolve(ROOT, 'outputs/evaluation-report.json'), 'utf8'));
  assert.equal(report.chronological, true);
  assert.equal(report.dataset, 'frozen replay fixtures / simulated contract');
  assert.equal(report.planCoverage.totalRuns, 6);
  assert.equal(report.planCoverage.liveReporterCoverage, null);
  assert.equal(report.planCoverage.liveReporterStatus, 'measured_separately_eligibility_unsupported');
  for (const method of [
    'global_median',
    'task_median',
    'model_self_eta',
    'run_fallback',
    'plan_conditioned',
  ]) assert.ok(report.methods[method], `missing evaluation method ${method}`);
  assert.equal(report.planBootstrap.samples, 2_000);
  assert.ok(report.planBootstrap.plannedRuns > 0);
  assert.equal(
    report.runs.map((run) => run.startedAt).join(','),
    report.runs.map((run) => run.startedAt).toSorted().join(','),
  );
});
