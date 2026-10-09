import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AgentETA } from '../src/generic/tracker.js';
import { evaluateDatabase } from '../src/generic/evaluate.js';
import { exportJournal, journalUsage } from '../src/generic/journal.js';
import { afterCleanup } from '../test-support/cleanup.js';

// Synthetic clocks and rows only: none of these checks establish ETA accuracy.
const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-journal-'));
  afterCleanup(t, () => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'runs.sqlite');
  let now = 1_800_000_000_000;
  const tracker = new AgentETA({ filename, clock: () => now });
  afterCleanup(t, () => tracker.close());
  const advance = () => { now += 30_000; };
  const command = (name, path = filename) => spawnSync(process.execPath,
    ['--no-warnings', cli, name, '--db', path], { encoding: 'utf8' });
  return { dir, filename, tracker, advance, command };
}

function checkedExport(filename) {
  const lines = [...exportJournal(filename)];
  const records = lines.map(line => JSON.parse(line));
  const end = records.at(-1);
  assert.equal(end.type, 'end');
  assert.equal(end.sha256, createHash('sha256').update(lines.slice(0, -1).join('')).digest('hex'));
  assert.deepEqual(end.counts, records[0].counts);
  assert.equal(end.counts.runs, records.filter(r => r.type === 'run').length);
  assert.equal(end.counts.forecasts, records.filter(r => r.type === 'forecast').length);
  return { lines, records };
}

test('empty export and usage explicitly report zero records without inventing a receipt', t => {
  const f = fixture(t);
  const { records, lines } = checkedExport(f.filename);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].counts, { runs: 0, forecasts: 0 });
  assert.equal(records[0].journal, 'present');
  assert.deepEqual([...exportJournal(f.filename)], lines);
  const usage = journalUsage(f.filename);
  assert.deepEqual(usage.counts, { runs: 0, forecasts: 0 });
  assert.deepEqual(usage.receipts, { payloadBytes: 0, earliestEstimatedAtMs: null, latestEstimatedAtMs: null });
  assert.deepEqual(usage.retention, { mode: 'keep_all', automaticDeletion: false });
});

test('export preserves original JSON bytes, insertion gaps, abstentions and orphan rows', t => {
  const f = fixture(t);
  const run = f.tracker.start();
  f.advance(); f.tracker.pause(run.runId);
  f.tracker.db.exec('UPDATE eta_forecasts SET rowid = rowid + 40');
  const raw = '{ "original": "中文\\nreceipt", "broken": }';
  f.tracker.db.prepare(`INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('synthetic-invalid-hash', 'orphan', 1, 2, 'unknown', 'unrecognized', raw);
  const original = f.tracker.db.prepare('SELECT rowid AS insertion_order, * FROM eta_forecasts ORDER BY rowid').all();
  const { records } = checkedExport(f.filename);
  assert.deepEqual(records.filter(r => r.type === 'forecast').map(r => r.row), original.map(r => ({ ...r })));
  assert.equal(records.at(-2).row.payload_json, raw);
  assert.equal(records.at(-2).row.id, 'synthetic-invalid-hash');
  assert.equal(records.filter(r => r.type === 'forecast')[1].row.estimate_status, 'paused');
});

test('export uses one snapshot even if the tracker writes after the manifest', t => {
  const f = fixture(t);
  const old = f.tracker.start();
  const iterator = exportJournal(f.filename);
  const header = JSON.parse(iterator.next().value);
  assert.deepEqual(header.counts, { runs: 1, forecasts: 1 });
  f.tracker.start({ profile: 'future' });
  const rest = [...iterator].map(line => JSON.parse(line));
  assert.deepEqual(rest.at(-1).counts, header.counts);
  assert.deepEqual(rest.filter(r => r.type === 'run').map(r => r.row.id), [old.runId]);
  assert.equal(journalUsage(f.filename).counts.runs, 2);
});

test('non-JSON SQLite values fail instead of certifying a lossy complete export', t => {
  const f = fixture(t);
  f.tracker.start();
  f.tracker.db.prepare('UPDATE eta_forecasts SET payload_json = ?').run(Buffer.from([0, 255, 2]));
  const result = f.command('export');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'EXPORT_UNSUPPORTED_VALUE');
  assert.ok(result.stdout.trim().split('\n').map(JSON.parse).every(row => row.type !== 'end'));
  assert.deepEqual([...f.tracker.db.prepare('SELECT payload_json FROM eta_forecasts').get().payload_json], [0, 255, 2]);
});

test('cancelling an export closes its reader and never emits a completion marker', t => {
  const f = fixture(t);
  f.tracker.start();
  const iterator = exportJournal(f.filename);
  iterator.next(); iterator.next();
  assert.equal(iterator.return().done, true);
  assert.equal(iterator.next().done, true);
  // A leaked read transaction would prevent a complete WAL checkpoint.
  assert.equal(f.tracker.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
});

test('portable rows can be reconstructed with exactly the same evaluation report', t => {
  const f = fixture(t);
  for (const ticks of [4, 6, 8, 3]) {
    const { runId } = f.tracker.start({ profile: 'synthetic' });
    for (let i = 0; i < ticks; i++) { f.advance(); f.tracker.ping(runId); }
    f.tracker.finish(runId);
  }
  const expected = evaluateDatabase(f.filename);
  assert.equal(expected.landmarks[0].pairedRuns, 1);
  const { records } = checkedExport(f.filename);
  const copy = new AgentETA({ filename: join(f.dir, 'reconstructed.sqlite') });
  afterCleanup(t, () => copy.close());
  for (const record of records.filter(r => ['run', 'forecast'].includes(r.type))) {
    const { insertion_order, ...row } = record.row;
    const table = record.type === 'run' ? 'agentwhen_runs' : 'eta_forecasts';
    const fields = Object.keys(row);
    // Test-only reconstruction of trusted fixture fields; no import command.
    copy.db.prepare(`INSERT INTO ${table} (rowid, ${fields.join(',')}) VALUES (${Array(fields.length + 1).fill('?').join(',')})`)
      .run(insertion_order, ...Object.values(row));
  }
  assert.deepEqual(evaluateDatabase(join(f.dir, 'reconstructed.sqlite')), expected);
});

test('usage measures UTF-8 payload bytes and WAL separately without checkpointing', t => {
  const f = fixture(t);
  f.tracker.db.exec('PRAGMA wal_autocheckpoint = 0');
  f.tracker.start();
  f.tracker.db.prepare('UPDATE eta_forecasts SET payload_json = ?').run('中文');
  const before = {
    main: readFileSync(f.filename), wal: readFileSync(`${f.filename}-wal`),
    walSize: statSync(`${f.filename}-wal`).size,
  };
  const usage = journalUsage(f.filename);
  assert.equal(usage.receipts.payloadBytes, Buffer.byteLength('中文', 'utf8'));
  assert.equal(usage.files.wal.bytes, before.walSize);
  assert.ok(usage.files.wal.bytes > 0);
  assert.equal(usage.files.database.bytes, before.main.length);
  assert.equal(usage.totalFileBytes, Object.values(usage.files).reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(usage.sqlite.logicalBytes, usage.sqlite.pageCount * usage.sqlite.pageSize);
  assert.equal(usage.sqlite.freeListBytes, usage.sqlite.freeListPages * usage.sqlite.pageSize);
  checkedExport(f.filename);
  assert.deepEqual(readFileSync(f.filename), before.main);
  assert.deepEqual(readFileSync(`${f.filename}-wal`), before.wal);
});

test('usage distinguishes free pages within a file from a shrinking file', t => {
  const f = fixture(t);
  // Allocate and release test-only pages, never user records.
  f.tracker.db.exec('CREATE TABLE test_pages (b BLOB); INSERT INTO test_pages VALUES (zeroblob(100000)); DROP TABLE test_pages;');
  const usage = journalUsage(f.filename);
  assert.ok(usage.sqlite.freeListPages > 0);
  assert.ok(usage.sqlite.freeListBytes < usage.sqlite.logicalBytes);
  assert.equal(usage.retention.automaticDeletion, false);
});

test('legacy missing journal is explicit; unsupported tables cause no migration', t => {
  const f = fixture(t);
  f.tracker.start();
  f.tracker.db.exec('DROP TABLE eta_forecasts');
  const { records } = checkedExport(f.filename);
  assert.equal(records[0].journal, 'missing_journal');
  assert.deepEqual(records[0].counts, { runs: 1, forecasts: 0 });
  assert.equal(journalUsage(f.filename).journal, 'missing_journal');
  assert.equal(f.tracker.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'eta_forecasts'").get().n, 0);
  f.tracker.db.exec('ALTER TABLE agentwhen_runs RENAME COLUMN last_seen TO unsupported');
  assert.throws(() => [...exportJournal(f.filename)], /UNSUPPORTED_DATABASE_SCHEMA/);
  assert.throws(() => journalUsage(f.filename), /UNSUPPORTED_DATABASE_SCHEMA/);
  const result = f.command('export');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'UNSUPPORTED_DATABASE_SCHEMA');
});

test('missing or unrelated databases fail without creating files or leaking paths', t => {
  const f = fixture(t);
  const missing = join(f.dir, 'missing', 'runs.sqlite');
  for (const command of ['export', 'usage']) {
    const result = f.command(command, missing);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /DATABASE_NOT_FOUND/);
    assert.equal(result.stderr.includes(f.dir), false);
  }
  assert.equal(existsSync(join(f.dir, 'missing')), false);
  const unrelated = join(f.dir, 'unrelated.sqlite');
  new DatabaseSync(unrelated).close();
  assert.throws(() => [...exportJournal(unrelated)], /UNSUPPORTED_DATABASE_SCHEMA/);
  assert.throws(() => journalUsage(unrelated), /UNSUPPORTED_DATABASE_SCHEMA/);
});

test('CLI streams deterministic JSONL and legacy alias output matches', t => {
  const f = fixture(t);
  f.tracker.start();
  const result = f.command('export');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [...exportJournal(f.filename)].join(''));
  assert.equal(f.command('export').stdout, result.stdout);
  const alias = fileURLToPath(new URL('../bin/agentwhen.js', import.meta.url));
  const old = spawnSync(process.execPath, ['--no-warnings', alias, 'export', '--db', f.filename], { encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.stdout, result.stdout);
  const usage = f.command('usage');
  assert.equal(usage.status, 0, usage.stderr);
  assert.deepEqual(JSON.parse(usage.stdout), journalUsage(f.filename));
});

function largeJournal(f) {
  f.tracker.db.exec('BEGIN');
  const insert = f.tracker.db.prepare('INSERT INTO eta_forecasts VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 2048; i++) insert.run(`synthetic-${i}`, 'orphan', i, i, 'cold_start', 'test', 'x'.repeat(512));
  f.tracker.db.exec('COMMIT');
}

test('large export respects a slow consumer and verifies without collecting all rows', async t => {
  const f = fixture(t);
  largeJournal(f);
  const digest = createHash('sha256');
  let count = 0, bytes = 0;
  const sink = new Writable({ highWaterMark: 64, write(chunk, encoding, done) {
    const row = JSON.parse(chunk);
    bytes += chunk.length;
    if (row.type === 'end') {
      assert.equal(row.sha256, digest.digest('hex'));
      assert.equal(row.counts.forecasts, count);
    } else { digest.update(chunk); if (row.type === 'forecast') count++; }
    setImmediate(done);
  } });
  await pipeline(Readable.from(exportJournal(f.filename)), sink);
  assert.equal(count, 2048);
  assert.ok(bytes > 1_000_000);
});

test('an interrupted pipe exits unsuccessfully with no uncaught exception or completion claim', async t => {
  const f = fixture(t);
  largeJournal(f);
  const child = spawn(process.execPath, ['--no-warnings', cli, 'export', '--db', f.filename]);
  afterCleanup(t, () => { if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stdout.once('data', () => child.stdout.destroy());
  assert.equal(await exited, 1);
  assert.equal(JSON.parse(stderr).error, 'EXPORT_OUTPUT_CLOSED');
  assert.equal(f.tracker.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
});
