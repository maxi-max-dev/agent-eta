import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cpus, release } from 'node:os';
import { AgentETA } from '../src/generic/tracker.js';

// Synthetic performance fixtures only. Never open a user's tracking database.
// Keep generated databases and reports so the measurement can be inspected.
const [baselineModule, outputDirectory, ...extra] = process.argv.slice(2);
if (!baselineModule || !outputDirectory || extra.length) {
  throw new Error('Usage: node scripts/benchmark-list.js BASELINE_TRACKER_JS NEW_OUTPUT_DIRECTORY');
}
const { AgentETA: Baseline } = await import(pathToFileURL(resolve(baselineModule)));
const output = resolve(outputDirectory);
mkdirSync(output); // Refuse an existing destination; never replace old evidence.
const AT = 1_900_000_000_000;
const query = 'SELECT * FROM agentwhen_runs ORDER BY started_at DESC, rowid DESC LIMIT 50';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = tracker => ({
  runs: tracker.db.prepare('SELECT rowid, * FROM agentwhen_runs ORDER BY rowid').all(),
  forecasts: tracker.db.prepare('SELECT rowid, * FROM eta_forecasts ORDER BY rowid').all(),
});
const logicalBytes = tracker => tracker.db.prepare('PRAGMA page_count').get().page_count
  * tracker.db.prepare('PRAGMA page_size').get().page_size;
function seed(filename, count) {
  const tracker = new Baseline({ filename, clock: () => AT });
  try {
    const insert = tracker.db.prepare(`INSERT INTO agentwhen_runs
      VALUES (?, ?, 'coding', 'succeeded', ?, ?, 30000, NULL, ?, 1)`);
    tracker.db.exec('BEGIN');
    for (let i = 0; i < count; i++) {
      const at = 1_800_000_000_000 + Math.floor(i / 3) * 1000;
      insert.run(`aw-synthetic-${i}`, `synthetic-${i % 10}`, at, at + 30000, at + 30000);
    }
    tracker.db.exec('COMMIT');
    assert.equal(tracker.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='agentwhen_started'").get().n, 0,
      'Use a pre-index baseline, such as the fixed v0.9.0 release');
    return { rowDigest: digest(rows(tracker)), logicalBytes: logicalBytes(tracker) };
  } finally { tracker.close(); }
}
function open(Tracker, filename) {
  const started = performance.now();
  const tracker = new Tracker({ filename, clock: () => AT });
  return { tracker, openMs: performance.now() - started };
}
function pairedTimes(before, after) {
  for (let i = 0; i < 5; i++) { before(); after(); }
  const times = [[], []], methods = [before, after];
  for (let i = 0; i < 31; i++) {
    for (const which of i % 2 ? [1, 0] : [0, 1]) {
      const started = performance.now();
      methods[which]();
      times[which].push(performance.now() - started);
    }
  }
  const summarize = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[15], p95Ms: sorted[29], samplesMs: values };
  };
  return { before: summarize(times[0]), after: summarize(times[1]) };
}
const results = [];
for (const count of [1000, 10000, 100000]) {
  const baselineFile = join(output, `synthetic-${count}-baseline.sqlite`);
  const currentFile = join(output, `synthetic-${count}-current.sqlite`);
  const original = seed(baselineFile, count);
  assert.deepEqual(seed(currentFile, count), original);
  const baseline = open(Baseline, baselineFile);
  const current = open(AgentETA, currentFile);
  try {
    assert.equal(digest(rows(current.tracker)), original.rowDigest);
    assert.deepEqual(current.tracker.list(), baseline.tracker.list());
    const selection = pairedTimes(() => baseline.tracker.db.prepare(query).all(),
      () => current.tracker.db.prepare(query).all());
    const fullList = pairedTimes(() => baseline.tracker.list(), () => current.tracker.list());
    assert.equal(digest(rows(baseline.tracker)), original.rowDigest);
    assert.equal(digest(rows(current.tracker)), original.rowDigest);
    results.push({ count, selection, fullList,
      openMs: { before: baseline.openMs, afterIncludingIndexBuild: current.openMs },
      logicalBytes: { before: original.logicalBytes, after: logicalBytes(current.tracker) },
      queryPlans: { before: baseline.tracker.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(),
        after: current.tracker.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() },
      identicalDisplayedStatuses: true, unchangedRunAndForecastRows: true });
  } finally { baseline.tracker.close(); current.tracker.close(); }
}
const report = { schema: 'agent-eta.list-benchmark/1',
  evidence: 'synthetic terminal-run performance only; not real forecast accuracy or end-to-end browser latency',
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    osRelease: release(), cpu: cpus()[0]?.model },
  method: { rows: 'ten profiles, coding class, terminal successful runs; three equal start times per group',
    clock: AT, warmups: 5, pairedAlternatingSamples: 31, timingGate: false,
    predictionModelChanged: false, retentionChanged: false }, results };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report));
