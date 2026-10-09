import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';

const RUNS = `SELECT rowid AS insertion_order, id, profile, task_class, status,
  started_at, finished_at, active_ms, active_since, last_seen, history_eligible
  FROM agentwhen_runs ORDER BY rowid`;
const FORECASTS = `SELECT rowid AS insertion_order, id, run_id, estimated_at,
  active_ms, estimate_status, model_version, payload_json FROM eta_forecasts ORDER BY rowid`;

function databasePath(filename) {
  try {
    const path = realpathSync(filename);
    if (!statSync(path).isFile()) throw new Error('not a file');
    return path;
  } catch (error) {
    if (!filename || error.code === 'ENOENT') throw new Error('DATABASE_NOT_FOUND: select an existing tracker database with --db');
    throw new Error('DATABASE_READ_FAILED: cannot read the selected tracker database');
  }
}

function readError(error) {
  return ['UNSUPPORTED_DATABASE_SCHEMA', 'EXPORT_UNSUPPORTED_VALUE'].includes(error.message) ? error
    : new Error('DATABASE_READ_FAILED: cannot read the selected tracker database', { cause: error });
}

function openSnapshot(filename) {
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN');
    // Reading the schema pins the snapshot before counting or streaming rows.
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has('agentwhen_runs')) throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
    const hasJournal = tables.has('eta_forecasts');
    let runs, forecasts;
    try {
      runs = db.prepare(RUNS);
      forecasts = hasJournal ? db.prepare(FORECASTS) : null;
    } catch { throw new Error('UNSUPPORTED_DATABASE_SCHEMA'); }
    const counts = {
      runs: db.prepare('SELECT COUNT(*) AS n FROM agentwhen_runs').get().n,
      forecasts: hasJournal ? db.prepare('SELECT COUNT(*) AS n FROM eta_forecasts').get().n : 0,
    };
    return { db, runs, forecasts, counts, journal: hasJournal ? 'present' : 'missing_journal' };
  } catch (error) {
    db?.close();
    throw readError(error);
  }
}

/** JSONL over one snapshot. The caller must exhaust or close the iterator. */
export function* exportJournal(filename) {
  const { db, runs, forecasts, counts, journal } = openSnapshot(databasePath(filename));
  const digest = createHash('sha256');
  const line = value => {
    if (value.row && Object.values(value.row).some(item => item !== null
      && typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item)))) {
      // SQLite permits BLOBs and infinities even in these declared columns;
      // JSON would silently lose their type/value. Preserve the source, fail
      // the stream without an end marker, and do not certify a lossy export.
      throw new Error('EXPORT_UNSUPPORTED_VALUE');
    }
    const text = `${JSON.stringify(value)}\n`;
    digest.update(text, 'utf8');
    return text;
  };
  let end;
  try {
    yield line({ type: 'manifest', schema: 'agent-eta.journal/1', journal, counts,
      provenance: 'supplied_receipts_not_independently_verified' });
    let runCount = 0;
    for (const row of runs.iterate()) { runCount++; yield line({ type: 'run', row }); }
    let forecastCount = 0;
    if (forecasts) {
      for (const row of forecasts.iterate()) {
        forecastCount++;
        // Do not parse, normalize, repair or re-sign the stored receipt JSON.
        yield line({ type: 'forecast', row });
      }
    }
    if (runCount !== counts.runs || forecastCount !== counts.forecasts) throw new Error('incomplete snapshot');
    db.exec('COMMIT');
    end = { type: 'end', counts, sha256: digest.digest('hex'), digestScope: 'all_previous_utf8_lines_including_lf' };
  } catch (error) { throw readError(error); }
  finally { db.close(); }
  // No completion marker is emitted after a failed read or cancelled iterator.
  yield `${JSON.stringify(end)}\n`;
}

function fileSize(path) {
  try { return { present: true, bytes: statSync(path).size }; }
  catch (error) {
    return error.code === 'ENOENT' ? { present: false, bytes: 0 }
      : { present: null, bytes: null, error: 'unavailable' };
  }
}

/** Logical SQLite counts and separately sampled file lengths; no checkpoint. */
export function journalUsage(filename) {
  const path = databasePath(filename);
  // Sample before opening SQLite: a reader may participate in WAL shared-memory
  // coordination. These filesystem measurements are not a SQL-atomic snapshot.
  const files = { database: fileSize(path), wal: fileSize(`${path}-wal`),
    shm: fileSize(`${path}-shm`), rollbackJournal: fileSize(`${path}-journal`) };
  const { db, counts, journal } = openSnapshot(path);
  try {
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const freeListPages = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const receipts = journal === 'present'
      ? db.prepare(`SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payloadBytes,
          MIN(estimated_at) AS earliestEstimatedAtMs, MAX(estimated_at) AS latestEstimatedAtMs FROM eta_forecasts`).get()
      : { payloadBytes: 0, earliestEstimatedAtMs: null, latestEstimatedAtMs: null };
    db.exec('COMMIT');
    const sizes = Object.values(files).map(file => file.bytes);
    return { schema: 'agent-eta.usage/1', journal, counts, receipts: { ...receipts },
      sqlite: { pageSize, pageCount, freeListPages, logicalBytes: pageSize * pageCount,
        freeListBytes: pageSize * freeListPages },
      files, totalFileBytes: sizes.some(size => size === null) ? null : sizes.reduce((a, b) => a + b, 0),
      fileSizeConsistency: 'sampled_before_sql_snapshot_not_atomic_with_writers',
      retention: { mode: 'keep_all', automaticDeletion: false } };
  } catch (error) { throw readError(error); }
  finally { db.close(); }
}
