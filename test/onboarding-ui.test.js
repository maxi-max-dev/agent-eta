import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { createApp } from '../src/server/main.js';
import { formatCommand, onboardingCommand } from '../public/command.js';
import { afterCleanup } from '../test-support/cleanup.js';

function shellRun(command, options = {}) {
  if (process.platform === 'win32') {
    const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ' + command;
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', ...options });
  }
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', ...options });
}
const shell = process.platform === 'win32' ? 'powershell' : 'posix';

test('clipboard quoting preserves literal spaces, apostrophes, Unicode and shell metacharacters', () => {
  const values = ['space here', "owner's path", '中文路径', '$(echo injected); & echo bad', '`literal`', '$HOME'];
  const command = formatCommand([process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...values], shell);
  const result = shellRun(command);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
});

test('unsupported shells, malformed setup and unsafe native marshalling produce no copyable command', () => {
  assert.equal(formatCommand(['echo', '\0']), '');
  assert.equal(formatCommand(['echo'], 'cmd'), '');
  assert.equal(formatCommand(['echo', '"quoted"'], 'powershell'), '');
  assert.equal(formatCommand(['echo', 'trailing\\'], 'powershell'), '');
  for (const setup of [null, {}, { status: 'blocked' }, { status: 'ready', commands: { start: ['node', 'cli', 'run'] } }]) {
    assert.equal(onboardingCommand(setup, shell), '');
  }
});

test('empty dashboard template starts a child in the actual store from another directory and creates no warm-up rows', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-ui-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "user's local store.sqlite"), other = join(dir, 'other working directory');
  mkdirSync(other);
  const app = createApp({ databasePath: join(dir, 'demo.sqlite'), trackerDatabasePath: filename });
  afterCleanup(t, () => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const load = () => fetch(`${base}/api/tracker/runs`).then(r => r.json());
  const body = await load();
  assert.deepEqual(body.runs, []);
  assert.equal(body.setup.database.path, filename);
  assert.equal(body.setup.history.eligibleRuns, 0);
  assert.deepEqual((await load()).runs, []);
  const template = onboardingCommand(body.setup, shell);
  assert.ok(template.endsWith(' COMMAND'));
  const childArgs = formatCommand([process.execPath, '-e', 'process.stdout.write(String.fromCharCode(87,73,82,73,78,71,95,79,78,76,89))'], shell).replace(/^& /, '');
  const result = shellRun(template.slice(0, -'COMMAND'.length) + childArgs, { cwd: other, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WIRING_ONLY');
  const states = result.stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(states[0].estimateStatus, 'cold_start');
  assert.equal(states[0].remainingMinutes, null);
  const after = await load();
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].runId, states[0].runId);
  assert.equal(after.runs[0].status, 'succeeded');
  assert.equal(after.setup, null);
  assert.equal(existsSync(join(other, '.agent-eta')), false);
  assert.equal((await fetch(`${base}/command.js`)).status, 200);
});

test('local-path onboarding payload keeps the host, origin, cross-site and read-only guards', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-ui-origin-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const app = createApp({ databasePath: join(dir, 'demo.sqlite'), trackerDatabasePath: join(dir, 'runs.sqlite') });
  afterCleanup(t, () => app.close());
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/tracker/runs`;
  for (const headers of [{ origin: 'https://unrelated.example' }, { host: 'unrelated.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    // fetch may normalize Host / Sec-Fetch-*; use raw HTTP for these guards.
    const response = await new Promise((resolve, reject) => {
      get(url, { headers }, res => {
        let body = ''; res.on('data', data => { body += data; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(Object.hasOwn(response.body, 'setup'), false);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(url)).headers.get('cache-control'), 'no-store');
});

test('in-memory tracker and disabled tracker never offer a misleading persistent-store command', async t => {
  for (const trackerDatabasePath of [null, ':memory:']) {
    const app = createApp({ databasePath: ':memory:', trackerDatabasePath });
    afterCleanup(t, () => app.close());
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const body = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/tracker/runs`)).json();
    assert.equal(body.setup, null);
    assert.deepEqual(body.runs, []);
  }
});
