import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AgentETA, AgentWhen } from '../src/generic/tracker.js';
import { createApp } from '../src/server/main.js';
import { presentation } from '../public/tracker.js';

const BASE = 1_800_000_000_000;

test('forecast receipts are immutable, versioned and contain only the baseline available at prediction time', t => {
  let now = BASE;
  const tracker = new AgentETA({ filename: ':memory:', clock: () => now });
  t.after(() => tracker.close());
  for (const duration of [20_000, 30_000, 40_000]) {
    const run = tracker.start(); now += duration; tracker.finish(run.runId);
  }
  const run = tracker.start();
  assert.equal(run.estimateStatus, 'experimental');
  const receipt = tracker.db.prepare('SELECT * FROM eta_forecasts WHERE id = ?').get(run.forecastId);
  const payload = JSON.parse(receipt.payload_json);
  assert.deepEqual(payload.remainingMinutes, run.remainingMinutes);
  assert.equal(payload.baselineRemainingMinutes, 0.5);
  assert.equal(payload.modelVersion, 'conditional-lognormal/1');
  assert.equal(receipt.active_ms, 0);
  const count = tracker.db.prepare('SELECT COUNT(*) AS n FROM eta_forecasts').get().n;
  assert.equal(tracker.status(run.runId).forecastId, run.forecastId);
  assert.equal(tracker.db.prepare('SELECT COUNT(*) AS n FROM eta_forecasts').get().n, count);
  now += 10_000;
  const updated = tracker.status(run.runId);
  assert.notEqual(updated.forecastId, run.forecastId);
  assert.equal(updated.observedAt, run.observedAt);
  now += 10_000; tracker.finish(run.runId);
  assert.equal(tracker.db.prepare('SELECT payload_json FROM eta_forecasts WHERE id = ?').get(run.forecastId).payload_json, receipt.payload_json);
  assert.equal(tracker.status(run.runId).forecastId, null);
});

test('renamed SDK retains existing database and run identities', t => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  const old = new AgentWhen({ filename, clock: () => BASE });
  const run = old.start({ profile: 'existing-user' });
  old.close();
  const current = new AgentETA({ filename, clock: () => BASE + 1000 });
  try {
    assert.equal(current.status(run.runId).profile, 'existing-user');
    assert.equal(current.finish(run.runId).status, 'succeeded');
  } finally { current.close(); }
});

test('dashboard shows portable runs and journals refreshed predictions without sending heartbeats', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-dashboard-'));
  let now = BASE;
  const filename = join(dir, 'portable.sqlite');
  const caller = new AgentETA({ filename, clock: () => now });
  const run = caller.start({ profile: 'another-agent', taskClass: 'research' });
  const app = createApp({ databasePath: join(dir, 'demo.sqlite'), trackerDatabasePath: filename, wallClock: () => new Date(now) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(); caller.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const load = () => fetch(`${base}/api/tracker/runs`).then(r => r.json());
  let body = await load();
  assert.equal(body.enabled, true);
  assert.equal(body.runs[0].runId, run.runId);
  now += 10_000;
  body = await load();
  assert.equal(body.runs[0].observedAt, run.observedAt);
  assert.equal(body.runs[0].activeMinutes, 0.167);
  now += 51_000;
  assert.equal((await load()).runs[0].estimateStatus, 'stale');
  caller.ping(run.runId);
  assert.equal((await load()).runs[0].estimateStatus, 'observation_gap');
  assert.equal((await fetch(`${base}/api/tracker/runs`, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/tracker/runs`, { method: 'POST' })).status, 405);
  const page = await (await fetch(base)).text();
  assert.match(page, /tracker.js/);
  for (const asset of ['/tracker.js', '/tracker.css', '/styles.css', '/favicon.svg']) {
    assert.equal((await fetch(`${base}${asset}`)).status, 200, `asset must load: ${asset}`);
  }
  assert.notEqual((await fetch(`${base}/../package.json`)).status, 200);
  assert.match(await (await fetch(`${base}/demo`)).text(), /app.js/);
});

test('UI withholds stale/paused/gap numbers even if a cached payload contains an estimate', () => {
  const cached = { remainingMinutes: { p20: 1, p50: 2, p80: 3 }, historyCount: 3, minimumHistory: 3 };
  for (const estimateStatus of ['stale', 'paused', 'observation_gap', 'cold_start', 'terminal', 'unknown']) {
    assert.equal(presentation({ ...cached, estimateStatus }).numeric, false);
  }
  assert.equal(presentation({ ...cached, estimateStatus: 'experimental' }).numeric, true);
  assert.equal(presentation(null).numeric, false);
});
