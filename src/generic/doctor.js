import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseSelection, eligibleHistory, MIN_HISTORY, TASK_CLASSES } from './tracker.js';

/** Diagnose one chosen local store. No tracker construction, writes or network. */
export function diagnose({ filename, profile = 'default', taskClass = 'other', port = 4318 } = {}, clock = Date.now) {
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profile)
    || !TASK_CLASSES.includes(taskClass)) throw new Error('INVALID_DOCTOR_SCOPE');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_DOCTOR_PORT');
  const selection = databaseSelection(filename);
  if (typeof selection.filename !== 'string' || !selection.filename || selection.filename === ':memory:') {
    throw new Error('INVALID_DOCTOR_DATABASE: select a persistent local database');
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new Error('INVALID_DOCTOR_CLOCK');
  const path = resolve(selection.filename);
  const cli = fileURLToPath(new URL('../../bin/agent-eta.js', import.meta.url));
  const report = { schema: 'agent-eta.doctor/1', checkedAt: new Date(now).toISOString(),
    nodeVersion: process.versions.node, status: 'not_initialized',
    database: { path, source: selection.source,
      dependsOnWorkingDirectory: ['working_directory', 'legacy_directory'].includes(selection.source) || !isAbsolute(selection.filename) },
    scope: { profile, taskClass }, history: null,
    dashboard: { url: `http://127.0.0.1:${port}`, status: 'not_checked' },
    commands: null, notes: [] };
  let db, count = 0;
  try {
    let exists = true;
    try { if (!statSync(path).isFile()) throw new Error('DATABASE_NOT_FILE'); }
    catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN');
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      if (!tables.has('agentwhen_runs')) throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
      try {
        db.prepare(`SELECT id, profile, task_class, status, started_at, finished_at,
          active_ms, active_since, last_seen, history_eligible FROM agentwhen_runs LIMIT 0`).all();
        if (tables.has('eta_forecasts')) db.prepare(`SELECT id, run_id, estimated_at,
          active_ms, estimate_status, model_version, payload_json FROM eta_forecasts LIMIT 0`).all();
        count = eligibleHistory(db, profile, taskClass, now).length;
      } catch { throw new Error('UNSUPPORTED_DATABASE_SCHEMA'); }
      db.exec('COMMIT');
      report.status = 'ready';
      if (!tables.has('eta_forecasts')) report.notes.push('The forecast journal will be created by the next tracking command.');
    }
  } catch (error) {
    report.status = 'blocked';
    report.error = ['UNSUPPORTED_DATABASE_SCHEMA', 'DATABASE_NOT_FILE'].includes(error.message)
      ? error.message : 'DATABASE_READ_FAILED';
    report.notes.push('Select a readable tracker database or a new file; doctor does not repair or replace data.');
    return report;
  } finally { db?.close(); }
  report.history = { eligibleRuns: count, maximumUsed: 200, minimumRequired: MIN_HISTORY,
    additionalRunsNeeded: Math.max(0, MIN_HISTORY - count),
    state: count < MIN_HISTORY ? 'cold_start' : 'experimental', calibrated: false };
  const command = name => [process.execPath, cli, name, '--db', path];
  // Argument arrays can be passed directly to spawn/subprocess without shell quoting.
  report.commands = {
    start: [...command('start'), '--profile', profile, '--class', taskClass],
    serve: [...command('serve'), '--port', String(port)], list: command('list'),
  };
  if (report.database.dependsOnWorkingDirectory) report.notes.push('Reuse the absolute database path in commands when changing directories.');
  if (report.status === 'not_initialized') report.notes.push('No database created. The first start/run command initializes this path.');
  report.notes.push(count < MIN_HISTORY
    ? 'History is insufficient for a number. Complete real comparable work; do not manufacture warm-up runs.'
    : 'The history threshold permits experimental estimates; it does not establish accuracy or guarantee a number for an existing run.');
  report.notes.push('Ready means readable schema only. Write permissions, dashboard availability and provider-native integrations are not tested.');
  return report;
}
