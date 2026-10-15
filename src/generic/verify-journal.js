import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const RUN_FIELDS = 'insertion_order id profile task_class status started_at finished_at active_ms active_since last_seen history_eligible'.split(' ');
const FORECAST_FIELDS = 'insertion_order id run_id estimated_at active_ms estimate_status model_version payload_json'.split(' ');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));
const countsValid = value => keys(value, ['runs', 'forecasts'])
  && Object.values(value).every(n => Number.isSafeInteger(n) && n >= 0);
const countsEqual = (a, b) => a.runs === b.runs && a.forecasts === b.forecasts;

/** Verify the saved bytes, without opening SQLite or interpreting forecast JSON. */
export async function verifyJournalExport(filename) {
  let file;
  let lineNumber = 0, bytes = 0, manifest, end, forecastPhase = false;
  const counts = { runs: 0, forecasts: 0 }, lastOrder = { run: -Infinity, forecast: -Infinity };
  const digest = createHash('sha256');
  // Reject invalid UTF-8, including an otherwise silently discarded BOM.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const invalid = reason => { throw new Error(`EXPORT_INVALID: ${reason} (line ${lineNumber})`); };
  const consume = raw => {
    lineNumber++;
    if (end) invalid('content_after_end');
    let record;
    try { record = JSON.parse(decoder.decode(raw)); } catch { invalid('invalid_json_or_utf8'); }
    if (!object(record)) invalid('invalid_record');
    if (!manifest) {
      if (!keys(record, ['type', 'schema', 'journal', 'counts', 'provenance'])
        || record.type !== 'manifest' || record.schema !== 'agent-eta.journal/1'
        || !['present', 'missing_journal'].includes(record.journal) || !countsValid(record.counts)
        || record.provenance !== 'supplied_receipts_not_independently_verified'
        || (record.journal === 'missing_journal' && record.counts.forecasts !== 0)) invalid('invalid_manifest');
      manifest = record;
    } else if (record.type === 'end') {
      if (!keys(record, ['type', 'counts', 'sha256', 'digestScope']) || !countsValid(record.counts)
        || record.digestScope !== 'all_previous_utf8_lines_including_lf'
        || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) invalid('invalid_end');
      if (!countsEqual(counts, manifest.counts) || !countsEqual(counts, record.counts)) invalid('count_mismatch');
      if (record.sha256 !== digest.digest('hex')) invalid('digest_mismatch');
      end = record;
      return;
    } else {
      const kind = record.type;
      if (!['run', 'forecast'].includes(kind) || !keys(record, ['type', 'row'])
        || !keys(record.row, kind === 'run' ? RUN_FIELDS : FORECAST_FIELDS)) invalid('invalid_row');
      if (kind === 'run' && forecastPhase) invalid('run_after_forecast');
      if (kind === 'forecast') forecastPhase = true;
      const row = record.row;
      if (Object.values(row).some(value => value !== null && typeof value !== 'string'
        && !(typeof value === 'number' && Number.isFinite(value)))) invalid('unsupported_row_value');
      if (!Number.isSafeInteger(row.insertion_order) || row.insertion_order <= lastOrder[kind]) invalid('invalid_insertion_order');
      lastOrder[kind] = row.insertion_order;
      counts[kind === 'run' ? 'runs' : 'forecasts']++;
      if (counts.runs > manifest.counts.runs || counts.forecasts > manifest.counts.forecasts) invalid('count_mismatch');
    }
    // Hash original bytes, including LF. Never reserialize or normalize lines.
    digest.update(raw);
  };
  try {
    if (!(await stat(filename)).isFile()) throw new Error('EXPORT_NOT_FILE');
    file = await open(filename, 'r');
    if (!(await file.stat()).isFile()) throw new Error('EXPORT_NOT_FILE');
    const stream = file.createReadStream({ autoClose: false });
    let pieces = [], length = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      let start = 0, newline;
      while ((newline = chunk.indexOf(10, start)) !== -1) {
        const piece = chunk.subarray(start, newline + 1);
        pieces.push(piece); length += piece.length;
        consume(pieces.length === 1 ? piece : Buffer.concat(pieces, length));
        pieces = []; length = 0; start = newline + 1;
      }
      if (start < chunk.length) { pieces.push(chunk.subarray(start)); length += chunk.length - start; }
    }
    if (length) invalid('missing_final_lf');
    if (!end) invalid('missing_end');
    return { schema: 'agent-eta.export-verification/1', status: 'complete', exportSchema: manifest.schema,
      journal: manifest.journal, counts, sha256: end.sha256, bytes, lines: lineNumber,
      provenance: 'file_integrity_only_not_source_authenticity', forecastValidity: 'not_checked',
      exportProcessExit: 'not_observed', sourceDatabase: 'not_checked' };
  } catch (error) {
    if (error.message.startsWith('EXPORT_')) throw error;
    throw new Error(error.code === 'ENOENT' ? 'EXPORT_NOT_FOUND' : 'EXPORT_READ_FAILED', { cause: error });
  } finally { await file?.close(); }
}
