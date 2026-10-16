import { createWriteStream, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentETA } from '../src/generic/tracker.js';
import { evaluateDatabase } from '../src/generic/evaluate.js';
import { compareDatabase } from '../src/generic/compare.js';
import { exportJournal } from '../src/generic/journal.js';
import { verifyJournalExport } from '../src/generic/verify-journal.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const EVIDENCE = 'synthetic_scripted_clock_not_real_prediction_evidence';
const PROFILE = 'synthetic-demo-only';
const MINUTE = 60_000;

/** Demonstrate existing APIs in a fresh disposable store, never the user's DB. */
export async function runPortableDemo() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-synthetic-demo-'));
  const paths = Object.fromEntries(['runs.sqlite', 'journal.jsonl', 'evaluation.json', 'comparison.json', 'demo.json']
    .map(name => [name.split('.')[0], join(directory, `synthetic-${name}`)]));
  const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(directory, 'README.txt'),
    'SYNTHETIC DEMONSTRATION ONLY. Scripted clocks, durations and outcomes.\n'
    + 'Do not merge these runs into real history or use these reports as accuracy evidence.\n'
    + 'The demo uses a fresh temporary store; it does not open a configured tracker database.\n'
    + 'Files are retained for inspection; the operating system may later remove temporary files.\n', { flag: 'wx' });
  let now = Date.UTC(2026, 0, 1);
  const tracker = new AgentETA({ filename: paths.runs, clock: () => now });
  const steps = [];
  const start = () => tracker.start({ profile: PROFILE, taskClass: 'coding' });
  const record = (name, explanation, status) => steps.push({ name, evidence: EVIDENCE, explanation, status });
  const advance = (id, ms) => {
    for (let remaining = ms; remaining > 0;) {
      const step = Math.min(30_000, remaining);
      now += step; remaining -= step; tracker.ping(id);
    }
    return tracker.status(id);
  };
  let targetRunId;
  try {
    const cold = start();
    record('cold_start', 'No matching history: ETA is hidden.', cold);
    advance(cold.runId, 30_000); tracker.finish(cold.runId, 'cancelled');

    // Scripted warm-up is confined to this synthetic store, never real history.
    for (const minutes of [4, 8, 12]) {
      const history = start(); advance(history.runId, minutes * MINUTE); tracker.finish(history.runId);
    }
    const target = start(); targetRunId = target.runId;
    record('one_minute', 'Three synthetic histories permit an experimental number, not a calibrated promise.',
      advance(targetRunId, MINUTE));
    tracker.pause(targetRunId);
    now += 10 * MINUTE;
    record('paused', 'Ten scripted minutes of waiting add no active time.', tracker.status(targetRunId));
    tracker.resume(targetRunId);
    record('five_minutes', 'The resumed active clock reaches the five-minute forecast landmark.',
      advance(targetRunId, 4 * MINUTE));
    record('ten_minutes', 'A long run can outlive most history; the saved comparison exposes candidate abstentions.',
      advance(targetRunId, 5 * MINUTE));
    advance(targetRunId, 2 * MINUTE);
    record('terminal', 'The scripted outcome ends at twelve active minutes; ETA is hidden.', tracker.finish(targetRunId));

    const gap = start();
    now += 61_000;
    record('stale', 'A status read does not count as a heartbeat; the number disappears.', tracker.status(gap.runId));
    record('observation_gap', 'A new heartbeat cannot repair the earlier observation gap.', tracker.ping(gap.runId));
    now += 1000; tracker.finish(gap.runId, 'cancelled');
  } finally { tracker.close(); }

  // Reuse the shipped exporter/evaluators. No reconstructed past prediction.
  const evaluation = evaluateDatabase(paths.runs), comparison = compareDatabase(paths.runs);
  writeJSON(paths.evaluation, { evidence: EVIDENCE, report: evaluation });
  writeJSON(paths.comparison, { evidence: EVIDENCE, report: comparison });
  await pipeline(Readable.from(exportJournal(paths.runs)), createWriteStream(paths.journal, { flags: 'wx' }));
  const verification = await verifyJournalExport(paths.journal);
  const cli = fileURLToPath(new URL('../bin/agent-eta.js', import.meta.url));
  const command = (name, ...args) => [process.execPath, cli, name, ...args];
  const summary = { schema: 'agent-eta.synthetic-demo/1', evidence: EVIDENCE, directory, paths,
    scenario: { clock: 'scripted', profile: PROFILE, taskClass: 'coding',
      historyMinutes: [4, 8, 12], targetActiveMinutes: 12, pausedWallMinutes: 10, targetRunId },
    steps, verification,
    commands: { evaluate: command('evaluate', '--db', paths.runs), compare: command('compare', '--db', paths.runs),
      verifyExport: command('verify-export', paths.journal) },
    limits: ['All runs, clocks and outcomes are synthetic; no real agent was measured.',
      'These examples do not establish accuracy, user adoption or a competition result.',
      'Do not copy this database or profile into real collection. No original database was opened.',
      'Saved-report commands reproduce this store; a new demo gets new run IDs and may produce different estimates.'] };
  writeJSON(paths.demo, summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('The synthetic demo accepts no options or existing database path.');
  console.log('Agent ETA — SYNTHETIC WALKTHROUGH. Scripted clocks and outcomes; not real accuracy evidence.');
  const demo = await runPortableDemo();
  for (const [i, step] of demo.steps.entries()) {
    const status = step.status;
    const eta = status.remainingMinutes ? `experimental P50 ${status.remainingMinutes.p50.toFixed(2)} min` : 'ETA hidden';
    console.log(`${i + 1}. ${step.name}: ${status.estimateStatus}; active ${status.activeMinutes} min; ${eta}`);
    console.log(`   ${step.explanation}`);
  }
  console.log('Saved export: complete. This confirms file integrity only. All artifacts below are synthetic.');
  console.log(JSON.stringify({ directory: demo.directory, summary: demo.paths.demo }));
}
