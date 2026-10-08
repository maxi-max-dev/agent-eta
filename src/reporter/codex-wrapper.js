import { createReadStream } from 'node:fs';
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import {
  codexSessionAlias,
  scanCodexSession,
} from '../adapters/codex.js';
import { submitReporterReport } from './client.js';
import { REPORTER_SCHEMA_VERSION, sanitizeReporterReport } from './contract.js';

export const CODEX_REPORTER_ERRORS = Object.freeze({
  threadRequired: 'CODEX_REPORTER_THREAD_REQUIRED',
  rootRequired: 'CODEX_REPORTER_ROOT_REQUIRED',
  sessionNotFound: 'CODEX_REPORTER_SESSION_NOT_FOUND',
  multipleSessionAliases: 'CODEX_REPORTER_MULTIPLE_SESSION_ALIASES',
  noActiveRun: 'CODEX_REPORTER_NO_ACTIVE_RUN',
  multipleActiveRuns: 'CODEX_REPORTER_MULTIPLE_ACTIVE_RUNS',
  invalidObservation: 'CODEX_REPORTER_INVALID_OBSERVATION',
  scopeReadFailed: 'CODEX_REPORTER_SCOPE_READ_FAILED',
});

const OBSERVATION_KEYS = new Set([
  'reported_at',
  'task_class',
  'eligible_large_task',
  'model_self_eta_minutes',
  'plan_present',
  'plan_step_count',
  'plan_adherence',
]);

function fail(code) {
  throw new Error(code);
}

function exactObservation(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(CODEX_REPORTER_ERRORS.invalidObservation);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== OBSERVATION_KEYS.size) fail(CODEX_REPORTER_ERRORS.invalidObservation);
  for (const key of keys) {
    if (typeof key !== 'string' || !OBSERVATION_KEYS.has(key)) {
      fail(CODEX_REPORTER_ERRORS.invalidObservation);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(CODEX_REPORTER_ERRORS.invalidObservation);
  }
  return value;
}

async function matchingSessionFiles(directory, threadId, files) {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await matchingSessionFiles(candidate, threadId, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    if (entry.name === `${threadId}.jsonl` || entry.name.endsWith(`-${threadId}.jsonl`)) {
      files.push(candidate);
    }
  }
}

/**
 * Read only until the root session_meta envelope. In current native Codex
 * logs payload.id is the app thread identity used by the filename, while
 * payload.session_id is the stable identity used by the canonical adapter.
 * Both raw values remain process-local.
 */
async function rootSessionAlias(file, threadId) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
      if (record.type !== 'session_meta') continue;
      const payload = record.payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
      if (payload.id !== threadId) return null;
      if (typeof payload.session_id !== 'string' || payload.session_id.trim() === '') return null;
      return codexSessionAlias(payload.session_id);
    }
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Resolve only inside the explicitly supplied current Codex thread. Candidate
 * paths are selected by that exact thread suffix before a transcript is opened,
 * then session metadata must hash to the same alias. No global/latest fallback
 * is permitted. Copied branch files are safe because canonical run aliases are
 * deduplicated before the unique-active-run check.
 */
export async function resolveActiveCodexRun({ root, threadId } = {}) {
  if (typeof root !== 'string' || root.trim() === '') fail(CODEX_REPORTER_ERRORS.rootRequired);
  if (typeof threadId !== 'string' || threadId.trim() === '') {
    fail(CODEX_REPORTER_ERRORS.threadRequired);
  }

  const files = [];
  try {
    await matchingSessionFiles(path.resolve(root), threadId, files);
  } catch {
    fail(CODEX_REPORTER_ERRORS.scopeReadFailed);
  }
  const matchingScans = [];
  const sessionAliases = new Set();
  for (const file of files.toSorted()) {
    let expectedSessionAlias;
    let scan;
    try {
      expectedSessionAlias = await rootSessionAlias(file, threadId);
      if (expectedSessionAlias === null) continue;
      scan = await scanCodexSession(file);
    } catch {
      fail(CODEX_REPORTER_ERRORS.scopeReadFailed);
    }
    if (scan.metadata.nativeSessionId !== expectedSessionAlias) {
      fail(CODEX_REPORTER_ERRORS.scopeReadFailed);
    }
    sessionAliases.add(expectedSessionAlias);
    matchingScans.push(scan);
  }
  if (matchingScans.length === 0) fail(CODEX_REPORTER_ERRORS.sessionNotFound);
  if (sessionAliases.size > 1) fail(CODEX_REPORTER_ERRORS.multipleSessionAliases);

  const started = new Set();
  const terminal = new Set();
  for (const scan of matchingScans) {
    for (const event of scan.events) {
      if (event.kind === 'run_started') started.add(event.run_id);
      if (['run_succeeded', 'run_failed', 'run_cancelled'].includes(event.kind)) {
        terminal.add(event.run_id);
      }
    }
  }
  const active = [...started].filter((runId) => !terminal.has(runId)).toSorted();
  if (active.length === 0) fail(CODEX_REPORTER_ERRORS.noActiveRun);
  if (active.length > 1) fail(CODEX_REPORTER_ERRORS.multipleActiveRuns);
  return Object.freeze({ provider: 'codex', runId: active[0] });
}

export function buildCodexReporterReport(runId, observation) {
  const fields = exactObservation(observation);
  return sanitizeReporterReport({
    schema_version: REPORTER_SCHEMA_VERSION,
    provider: 'codex',
    run_id: runId,
    ...fields,
  });
}

export async function reportCurrentCodexRun({
  root,
  threadId,
  observation,
  baseUrl = 'http://127.0.0.1:4318',
  fetchImpl = fetch,
} = {}) {
  const resolved = await resolveActiveCodexRun({ root, threadId });
  const report = buildCodexReporterReport(resolved.runId, observation);
  return submitReporterReport(report, { baseUrl, fetchImpl });
}
