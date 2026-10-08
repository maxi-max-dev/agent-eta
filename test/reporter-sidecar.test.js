import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { submitReporterReport } from '../src/reporter/client.js';
import { createApp } from '../src/server/main.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function reporterFixture(name) {
  return JSON.parse(await readFile(join(ROOT, 'fixtures/reporter', name), 'utf8'));
}

test('Reporter sidecar persists idempotent structural observations and never echoes IDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-reporter-sidecar-'));
  const filename = join(directory, 'reporter.sqlite');
  const app = createApp({
    databasePath: filename,
    wallClock: () => new Date('2026-08-29T08:00:00.000Z'),
  });
  const planned = await reporterFixture('valid-planned.json');
  app.database.saveRun({
    runId: planned.run_id,
    provider: 'codex',
    status: 'running',
    startedAt: '2026-08-28T18:05:00.000Z',
    finishedAt: null,
    activeElapsedMs: 0,
    steps: [],
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const empty = await (await fetch(`${baseUrl}/api/reporter/status`)).json();
    assert.deepEqual(empty, {
      kind: 'reporter_status',
      connectionStatus: 'local_sidecar',
      officialProviderIntegration: false,
      acceptsBrowserOrigins: false,
      observations: 0,
      reportedRuns: 0,
      attachedRuns: 0,
      unattachedRuns: 0,
      selfEtaObservations: 0,
      adherenceObservations: 0,
      latestReportedAt: null,
    });

    const browserAttempt = await fetch(`${baseUrl}/api/reporter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.test' },
      body: JSON.stringify(planned),
    });
    assert.equal(browserAttempt.status, 400);
    assert.deepEqual(await browserAttempt.json(), { error: 'REPORTER_BROWSER_ORIGIN_REJECTED' });

    const invalid = await fetch(`${baseUrl}/api/reporter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...planned, prompt: 'private report body' }),
    });
    const invalidBody = await invalid.json();
    assert.deepEqual(invalidBody, { error: 'REPORTER_MISSING_OR_UNKNOWN_FIELD' });
    assert.doesNotMatch(JSON.stringify(invalidBody), /private report body/);

    const first = await submitReporterReport(planned, { baseUrl });
    assert.equal(first.accepted, true);
    assert.equal(first.inserted, true);
    assert.equal(first.reforecasted, false);
    assert.equal(first.attachedRuns, 1);
    assert.doesNotMatch(JSON.stringify(first), /codex-run|0123456789abcdefabcd/);

    const repeated = await submitReporterReport(planned, { baseUrl });
    assert.equal(repeated.inserted, false);
    await assert.rejects(
      submitReporterReport({ ...planned, task_class: 'research' }, { baseUrl }),
      /REPORTER_OBSERVATION_CONFLICT/,
    );

    const cli = await execFileAsync(process.execPath, [
      '--no-warnings',
      'scripts/report.js',
      '--file',
      'fixtures/reporter/valid-unplanned.json',
      '--url',
      baseUrl,
    ], { cwd: ROOT });
    const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.accepted, true);
    assert.equal(cliResult.inserted, true);
    assert.doesNotMatch(cli.stdout, /generic-run|fedcba/);

    const status = await (await fetch(`${baseUrl}/api/reporter/status`)).json();
    assert.equal(status.observations, 2);
    assert.equal(status.reportedRuns, 2);
    assert.equal(status.attachedRuns, 1);
    assert.equal(status.unattachedRuns, 1);
    assert.equal(status.selfEtaObservations, 1);
    assert.equal(status.adherenceObservations, 1);

    const saveReporterObservation = app.database.saveReporterObservation.bind(app.database);
    app.database.saveReporterObservation = () => {
      throw new Error('/Users/private/reporter.sqlite failed with private body');
    };
    const failed = await fetch(`${baseUrl}/api/reporter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...planned, reported_at: '2026-08-28T18:06:06.000Z' }),
    });
    const failedBody = await failed.json();
    assert.deepEqual(failedBody, { error: 'REPORTER_PERSIST_FAILED' });
    assert.doesNotMatch(JSON.stringify(failedBody), /Users|private|sqlite/);
    app.database.saveReporterObservation = saveReporterObservation;
  } finally {
    await app.close();
  }

  const database = new AgentEtaDatabase(filename);
  try {
    assert.equal(database.listReporterObservations().length, 2);
    assert.equal(database.reporterStatus().attachedRuns, 1);
    assert.equal(
      database.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value,
      '7',
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Reporter client refuses non-loopback destinations', async () => {
  const planned = await reporterFixture('valid-planned.json');
  await assert.rejects(
    submitReporterReport(planned, { baseUrl: 'https://example.test' }),
    /REPORTER_LOOPBACK_REQUIRED/,
  );
});
