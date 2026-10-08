#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AgentETA, defaultDatabasePath } from '../src/generic/tracker.js';
import { evaluateDatabase } from '../src/generic/evaluate.js';

const HELP = `Agent ETA — How long will your agent take?

Usage: agent-eta <command> [run-id] [options]
  start                   Begin a run; returns JSON with runId
  status <id>             Read a fresh estimate (does not send a heartbeat)
  list                    Read the latest 50 runs
  serve                   Open a local dashboard for the same database
  evaluate                Read-only prospective evaluation as JSON (existing database)
  ping <id>               Report that the caller is still active
  pause <id>              Stop active time while waiting for input
  resume <id>             Resume active time
  finish <id>             Record a terminal outcome
  watch <id>              Stream status JSON until terminal; Ctrl+C stops watching
  run [options] -- cmd    Wrap a process, heartbeat automatically, preserve its exit code

Options:
  --db <path>             Database (or AGENT_ETA_TRACKER_DB; default .agent-eta/runs.sqlite)
  --port <number>         Dashboard port, 1–65535 (serve only; default: 4318)
  --profile <identifier>  Separate agent/workflow history (default: default)
  --class <class>         coding, research, review, writing, other (default: other)
  --outcome <outcome>     succeeded, failed, cancelled (finish only)
  --interval <seconds>   watch/run refresh interval, 1–30 (default: 5)
  --help                 Show this help

No network, API key or provider plugin. Requires Node.js >= 22.13.
Cold start: fewer than 3 successful same-profile/class runs => no numeric ETA.
Wrapper status goes to stderr; child stdout/stderr pass through unchanged.
`;

function emit(value, stream = process.stdout) { stream.write(`${JSON.stringify(value)}\n`); }

async function serveDashboard(values) {
  const port = Number(values.port ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/start-demo.js', import.meta.url))], {
    stdio: 'inherit', env: { ...process.env, AGENT_ETA_PORT: String(port),
      ...(values.db ? { AGENT_ETA_TRACKER_DB: values.db } : {}) },
  });
  const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of signals) process.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
  }
}

async function runProcess(tracker, values, command, interval) {
  if (!command.length) throw new Error('run needs a command after --');
  const run = tracker.start({ profile: values.profile, taskClass: values.class });
  emit(run, process.stderr);
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false });
  let interrupted = null;
  let trackerError = false;
  const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
    interrupted = signal;
    child.kill(signal);
  }]));
  for (const [signal, handler] of signals) process.on(signal, handler);
  const timer = setInterval(() => {
    try { emit(tracker.ping(run.runId), process.stderr); }
    catch { trackerError = true; clearInterval(timer); process.stderr.write('Agent ETA: heartbeat unavailable; child continues.\n'); }
  }, interval * 1000);
  const result = await new Promise(resolve => {
    child.once('error', () => resolve({ code: 127, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(timer);
  for (const [signal, handler] of signals) process.off(signal, handler);
  const signal = interrupted || result.signal;
  try { emit(tracker.finish(run.runId, signal ? 'cancelled' : result.code === 0 ? 'succeeded' : 'failed'), process.stderr); }
  catch { trackerError = true; process.stderr.write('Agent ETA: final status unavailable.\n'); }
  if (trackerError) process.stderr.write('Agent ETA: tracking was incomplete.\n');
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : result.code ?? 1;
}

let tracker;
try {
  const argv = process.argv.slice(2);
  const boundary = argv.indexOf('--');
  const { values, positionals } = parseArgs({
    args: boundary < 0 ? argv : argv.slice(0, boundary), allowPositionals: true, strict: true,
    options: { db: { type: 'string' }, profile: { type: 'string' }, class: { type: 'string' },
      outcome: { type: 'string' }, interval: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, id] = positionals;
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
  } else {
    const known = ['start', 'status', 'list', 'ping', 'pause', 'resume', 'finish', 'watch', 'run', 'serve', 'evaluate'];
    if (!known.includes(command)) throw new Error('Unknown command; use --help');
    const requiresId = !['start', 'list', 'run', 'serve', 'evaluate'].includes(command);
    if (positionals.length !== (requiresId ? 2 : 1)) throw new Error('Unexpected or missing argument; use --help');
    if (boundary >= 0 && command !== 'run') throw new Error('-- is only supported with run');
    const interval = Number(values.interval ?? 5);
    if (!Number.isFinite(interval) || interval < 1 || interval > 30) throw new Error('Interval must be between 1 and 30 seconds');
    if (values.outcome && command !== 'finish') throw new Error('--outcome is only supported with finish');
    if (values.port && command !== 'serve') throw new Error('--port is only supported with serve');
    if ((values.profile || values.class) && !['start', 'run'].includes(command)) throw new Error('--profile and --class are only supported with start/run');
    if (command === 'evaluate') emit(evaluateDatabase(values.db ?? defaultDatabasePath()));
    else if (command === 'serve') process.exitCode = await serveDashboard(values);
    else {
      tracker = new AgentETA({ filename: values.db });
      if (command === 'run') process.exitCode = await runProcess(tracker, values, boundary < 0 ? [] : argv.slice(boundary + 1), interval);
      else if (command === 'start') emit(tracker.start({ profile: values.profile, taskClass: values.class }));
      else if (command === 'list') emit(tracker.list());
      else if (command === 'finish') emit(tracker.finish(id, values.outcome));
      else if (command === 'watch') {
        while (true) {
          const value = tracker.status(id);
          emit(value);
          if (value.estimateStatus === 'terminal') break;
          await delay(interval * 1000);
        }
      } else emit(tracker[command](id));
    }
  }
} catch (error) {
  emit({ error: error.message }, process.stderr);
  process.exitCode = 1;
} finally {
  tracker?.close();
}
