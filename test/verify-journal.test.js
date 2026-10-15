import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AgentETA } from '../src/generic/tracker.js';
import { exportJournal } from '../src/generic/journal.js';
import { verifyJournalExport } from '../src/generic/verify-journal.js';
import { afterCleanup } from '../test-support/cleanup.js';

const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-verify-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'runs.sqlite'), filename = join(dir, 'saved export.jsonl');
  const tracker = new AgentETA({ filename: database, clock: () => 1_800_000_000_000 });
  afterCleanup(t, () => tracker.close());
  const save = data => { writeFileSync(filename, data); return filename; };
  const lines = () => [...exportJournal(database)];
  return { dir, database, filename, tracker, save, lines };
}
const seal = records => {
  const before = records.slice(0, -1).map(record => `${JSON.stringify(record)}\n`).join('');
  return before + JSON.stringify({ ...records.at(-1), sha256: createHash('sha256').update(before).digest('hex') }) + '\n';
};

test('saved real exporter output verifies empty, terminal, paused and legacy journals without changing source bytes', async t => {
  const f = fixture(t);
  const check = async () => {
    const saved = f.lines().join(''); f.save(saved);
    const database = readFileSync(f.database);
    const first = await verifyJournalExport(f.filename);
    assert.equal(first.status, 'complete');
    assert.equal(first.bytes, Buffer.byteLength(saved));
    assert.equal(first.lines, first.counts.runs + first.counts.forecasts + 2);
    assert.equal(first.provenance, 'file_integrity_only_not_source_authenticity');
    assert.equal(first.forecastValidity, 'not_checked');
    assert.equal(first.exportProcessExit, 'not_observed');
    assert.equal(first.sourceDatabase, 'not_checked');
    assert.deepEqual(await verifyJournalExport(f.filename), first);
    assert.equal(readFileSync(f.filename, 'utf8'), saved);
    assert.deepEqual(readFileSync(f.database), database);
    return first;
  };
  assert.deepEqual((await check()).counts, { runs: 0, forecasts: 0 });
  for (const outcome of ['succeeded', 'failed', 'cancelled']) f.tracker.finish(f.tracker.start().runId, outcome);
  f.tracker.pause(f.tracker.start().runId);
  assert.equal((await check()).counts.runs, 4);
  f.tracker.db.exec('DROP TABLE eta_forecasts');
  const legacy = await check();
  assert.equal(legacy.journal, 'missing_journal');
  assert.equal(legacy.counts.forecasts, 0);
});

test('large Unicode lines, damaged inner forecast JSON and orphan rows stay intact across chunk boundaries', async t => {
  const f = fixture(t);
  f.tracker.start();
  const payload = '{ "synthetic evidence": "' + '中文🐈'.repeat(30_000) + '", broken: }';
  f.tracker.db.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('invalid-hash', 'orphan', 1, 2, 'unknown', 'unknown', payload);
  f.tracker.db.exec('UPDATE eta_forecasts SET rowid = rowid + 40');
  f.save(f.lines().join(''));
  const result = await verifyJournalExport(f.filename);
  assert.equal(result.counts.forecasts, 2);
  assert.equal(result.forecastValidity, 'not_checked');
  assert.equal(JSON.parse(readFileSync(f.filename, 'utf8').trim().split('\n').at(-2)).row.payload_json, payload);
});

test('truncation, changed bytes, line-ending conversion and invalid UTF-8 never verify as complete', async t => {
  const f = fixture(t); f.tracker.start();
  const lines = f.lines(), saved = lines.join('');
  const cases = [
    ['', /missing_end/],
    [lines.slice(0, -1).join(''), /missing_end/],
    [saved.slice(0, -1), /missing_final_lf/],
    [saved.slice(0, -8), /missing_final_lf/],
    [saved.replace('"default"', '"changed"'), /digest_mismatch/],
    [saved.replaceAll('\n', '\r\n'), /digest_mismatch/],
    [Buffer.concat([Buffer.from([0xff]), Buffer.from(saved)]), /invalid_json_or_utf8/],
    ['\ufeff' + saved, /invalid_json_or_utf8/],
  ];
  for (const [content, error] of cases) {
    f.save(content);
    await assert.rejects(verifyJournalExport(f.filename), error);
    assert.deepEqual(readFileSync(f.filename), Buffer.from(content));
  }
});

test('extra content after the completion marker is rejected even if the initial export was valid', async t => {
  const f = fixture(t), lines = f.lines(), saved = lines.join('');
  for (const suffix of ['\n', lines.at(-1), saved, 'partial']) {
    await assert.rejects(verifyJournalExport(f.save(saved + suffix)), /content_after_end|missing_final_lf/);
  }
});

test('a recomputed digest cannot hide incorrect counts, order, duplicate rows or unsupported envelopes', async t => {
  const f = fixture(t); f.tracker.start(); f.tracker.start();
  const original = f.lines().map(JSON.parse);
  const cases = [
    [rows => { rows[0].counts.runs++; }, /count_mismatch/],
    [rows => { rows.at(-1).counts.forecasts++; }, /count_mismatch/],
    [rows => { [rows[2], rows[3]] = [rows[3], rows[2]]; }, /run_after_forecast/],
    [rows => { rows[2] = structuredClone(rows[1]); }, /invalid_insertion_order/],
    [rows => { rows[0].schema = 'unsupported'; }, /invalid_manifest/],
    [rows => { rows[0].journal = 'missing_journal'; }, /invalid_manifest/],
    [rows => { rows[1].row.unexpected = 'field'; }, /invalid_row/],
    [rows => { rows[1].row.status = {}; }, /unsupported_row_value/],
    [rows => { rows[1].type = 'manifest'; }, /invalid_row/],
    [rows => { rows.at(-1).digestScope = 'different'; }, /invalid_end/],
  ];
  for (const [change, error] of cases) {
    const rows = structuredClone(original); change(rows);
    await assert.rejects(verifyJournalExport(f.save(seal(rows))), error);
  }
});

test('CLI and legacy alias verify one explicit file across directories without creating a database', t => {
  const f = fixture(t); f.save(f.lines().join(''));
  const missingDb = join(f.dir, 'not-created', 'runs.sqlite');
  const invoke = (entry, ...args) => spawnSync(process.execPath, ['--no-warnings', entry, 'verify-export', ...args], {
    cwd: f.dir, encoding: 'utf8', env: { ...process.env, AGENT_ETA_TRACKER_DB: missingDb },
  });
  const result = invoke(cli, f.filename);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'complete');
  const legacy = invoke(fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url)), 'saved export.jsonl');
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, result.stdout);
  for (const args of [[], [f.filename, 'extra'], [f.filename, '--db', missingDb], [f.filename, '--interval', '1'], ['missing.jsonl'], [f.dir]]) {
    const failed = invoke(cli, ...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(typeof JSON.parse(failed.stderr).error, 'string');
  }
  f.save(f.lines().slice(0, -1).join(''));
  const truncated = invoke(cli, f.filename);
  assert.equal(truncated.status, 1);
  assert.match(JSON.parse(truncated.stderr).error, /missing_end/);
  assert.equal(existsSync(join(f.dir, 'not-created')), false);
  assert.equal(existsSync(join(f.dir, '.agent-eta')), false);
});
