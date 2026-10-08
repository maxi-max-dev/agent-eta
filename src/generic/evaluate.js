import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

export const PROTOCOL = 'agent-eta.prospective/1';
const LANDMARKS = [1, 5, 10];
const WINDOW_MS = 30_000;
const CLOSED = new Set(['succeeded', 'failed', 'cancelled']);
const STATES = ['experimental', 'cold_start', 'paused', 'stale', 'observation_gap'];
const hash = text => createHash('sha256').update(text).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonnegative = value => finite(value) && value >= 0;
const time = value => nonnegative(value) && value <= 8.64e15;
const round = value => Number(value.toFixed(6));
const ratio = (a, b) => b ? round(a / b) : null;
const mean = values => values.reduce((sum, value) => sum + value / values.length, 0);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] / 2 + sorted[Math.floor(sorted.length / 2)] / 2;
};

function validRun(run) {
  return typeof run.id === 'string' && typeof run.profile === 'string' && typeof run.task_class === 'string'
    && time(run.started_at) && nonnegative(run.active_ms)
    && [0, 1].includes(run.history_eligible)
    && (CLOSED.has(run.status)
      ? time(run.finished_at) && run.finished_at >= run.started_at
        && run.active_ms <= run.finished_at - run.started_at
      : ['running', 'paused'].includes(run.status) && run.finished_at === null);
}

function checkReceipt(row, run) {
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { return { error: 'invalid_json' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'invalid_payload' };
  if (row.id !== `eta-fc-${hash(row.payload_json)}`) return { error: 'hash_mismatch' };
  if (!time(row.estimated_at) || !nonnegative(row.active_ms)
    || row.estimated_at < run.started_at || row.estimated_at >= run.finished_at
    || row.active_ms > row.estimated_at - run.started_at) return { error: 'noncausal_timing' };
  if (payload.schema !== 'agentwhen.status/1' || payload.runId !== row.run_id
    || row.run_id !== run.id || payload.profile !== run.profile || payload.taskClass !== run.task_class
    || payload.estimateStatus !== row.estimate_status || !STATES.includes(row.estimate_status)
    || typeof row.model_version !== 'string' || !row.model_version
    || payload.modelVersion !== row.model_version
    || payload.estimatedAt !== new Date(row.estimated_at).toISOString()
    || payload.startedAt !== new Date(run.started_at).toISOString()
    || payload.finishedAt !== null || !['running', 'paused'].includes(payload.status)
    || payload.activeMinutes !== Math.round(row.active_ms / 60_000 * 1000) / 1000) {
    return { error: 'inconsistent_payload' };
  }
  const observed = Date.parse(payload.observedAt);
  if (!time(observed) || observed < run.started_at || observed > row.estimated_at) return { error: 'noncausal_observation' };
  if (row.estimate_status === 'experimental') {
    const r = payload.remainingMinutes;
    if (payload.status !== 'running' || payload.historyEligible !== true
      || row.estimated_at - observed > 60_000 || !Number.isInteger(payload.historyCount) || payload.historyCount < 3
      || !r || ![r.p20, r.p50, r.p80].every(nonnegative) || r.p20 > r.p50 || r.p50 > r.p80) {
      return { error: 'invalid_numeric_forecast' };
    }
  } else if (payload.remainingMinutes !== null || payload.baselineRemainingMinutes !== null) {
    return { error: 'numeric_abstention' };
  }
  return { payload };
}

function bootstrap(differences, key) {
  if (differences.length < 2) return null;
  let state = Number.parseInt(hash(key).slice(0, 8), 16) || 1;
  const randomIndex = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return Math.floor((state >>> 0) / 4294967296 * differences.length);
  };
  const samples = [];
  for (let sample = 0; sample < 2000; sample++) {
    let value = 0;
    for (let run = 0; run < differences.length; run++) value += differences[randomIndex()] / differences.length;
    samples.push(value);
  }
  samples.sort((a, b) => a - b);
  return { lower: round(samples[Math.ceil(0.025 * samples.length) - 1]),
    upper: round(samples[Math.ceil(0.975 * samples.length) - 1]), resamples: 2000, unit: 'run' };
}

function summarizeGroup(group, landmark) {
  const { pairs, ...identity } = group;
  const modelErrors = pairs.map(p => Math.abs(p.p50Minutes - p.actualRemainingMinutes));
  const baselineErrors = pairs.map(p => Math.abs(p.baselineMinutes - p.actualRemainingMinutes));
  const metrics = (errors, field) => {
    const severe = pairs.filter(p => p[field] < p.actualRemainingMinutes / 2).length;
    return { meanAbsoluteErrorMinutes: round(mean(errors)), medianAbsoluteErrorMinutes: round(median(errors)),
      severeUnderestimateCount: severe, severeUnderestimateRate: ratio(severe, pairs.length) };
  };
  const covered = pairs.filter(p => p.actualRemainingMinutes <= p.p80Minutes).length;
  const differences = modelErrors.map((error, i) => error - baselineErrors[i]);
  return { ...identity, n: pairs.length, evidenceStatus: pairs.length === 1 ? 'single_run_only' : 'descriptive_only',
    model: { ...metrics(modelErrors, 'p50Minutes'), p80CoverageCount: covered, p80Coverage: ratio(covered, pairs.length),
      meanIntervalWidthMinutes: round(mean(pairs.map(p => p.p80Minutes - p.p20Minutes))) },
    baseline: metrics(baselineErrors, 'baselineMinutes'),
    pairedMeanAbsoluteErrorDifferenceMinutes: round(mean(differences)),
    pairedDifferenceBootstrap95: bootstrap(differences, JSON.stringify([PROTOCOL, landmark, identity])),
    pairs: pairs.map(pair => Object.fromEntries(Object.entries(pair).map(([key, value]) =>
      [key, typeof value === 'number' ? round(value) : value]))) };
}

function landmarkReport(runs, byRun, landmarkMinutes) {
  const threshold = landmarkMinutes * 60_000;
  const counts = Object.fromEntries([...STATES, 'missing', 'invalid'].map(state => [state, 0]));
  const outcomes = { succeeded: 0, failed: 0, cancelled: 0 };
  const exclusions = {};
  const groups = new Map();
  const selections = [];
  let atRisk = 0;
  let observationGapOutcomes = 0;
  for (const run of runs) {
    if (run.active_ms <= threshold) continue;
    atRisk++;
    outcomes[run.status]++;
    if (run.history_eligible !== 1) observationGapOutcomes++;
    // Receipt order is frozen SQL insertion order for timestamp ties. Choose
    // before validation so neither a later numeric forecast nor lower error wins.
    const row = (byRun.get(run.id) ?? []).find(item => nonnegative(item.active_ms)
      && item.active_ms >= threshold && item.active_ms <= threshold + WINDOW_MS && item.active_ms < run.active_ms);
    const selected = { runId: run.id, outcome: run.status, forecastId: row?.id ?? null };
    let exclusion;
    if (!row) { counts.missing++; selected.state = 'missing'; exclusion = 'missing_receipt'; }
    else {
      const { payload, error } = checkReceipt(row, run);
      if (error) { counts.invalid++; selected.state = 'invalid'; exclusion = error; }
      else {
        counts[row.estimate_status]++;
        selected.state = row.estimate_status;
        if (row.estimate_status !== 'experimental') exclusion = `abstention_${row.estimate_status}`;
        else if (run.status !== 'succeeded') exclusion = `outcome_${run.status}`;
        else if (run.history_eligible !== 1) exclusion = 'observation_gap_outcome';
        else if (!nonnegative(payload.baselineRemainingMinutes)
          || typeof payload.baselineVersion !== 'string' || !payload.baselineVersion) exclusion = 'missing_baseline';
        else {
          const identity = { profile: run.profile, taskClass: run.task_class,
            modelVersion: payload.modelVersion, baselineVersion: payload.baselineVersion };
          const key = JSON.stringify(identity);
          if (!groups.has(key)) groups.set(key, { ...identity, pairs: [] });
          groups.get(key).pairs.push({ runId: run.id, forecastId: row.id,
            estimatedAt: payload.estimatedAt, activeMinutes: row.active_ms / 60_000,
            actualRemainingMinutes: (run.active_ms - row.active_ms) / 60_000,
            p20Minutes: payload.remainingMinutes.p20, p50Minutes: payload.remainingMinutes.p50,
            p80Minutes: payload.remainingMinutes.p80, baselineMinutes: payload.baselineRemainingMinutes });
        }
      }
    }
    selected.accuracyExclusion = exclusion ?? null;
    if (exclusion) exclusions[exclusion] = (exclusions[exclusion] ?? 0) + 1;
    selections.push(selected);
  }
  const accuracy = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, group]) => summarizeGroup(group, landmarkMinutes));
  const n = accuracy.reduce((sum, group) => sum + group.n, 0);
  const abstentions = STATES.filter(state => state !== 'experimental').reduce((sum, state) => sum + counts[state], 0);
  return { landmarkMinutes, toleranceSeconds: WINDOW_MS / 1000,
    availability: { denominator: atRisk, notReached: runs.length - atRisk, outcomes, observationGapOutcomes,
      counts, numericRate: ratio(counts.experimental, atRisk), abstentionRate: ratio(abstentions, atRisk),
      missingRate: ratio(counts.missing, atRisk), invalidRate: ratio(counts.invalid, atRisk) },
    pairedRuns: n, evidenceStatus: n === 0 ? 'no_scorable_pairs' : n === 1 ? 'single_run_only' : 'descriptive_only',
    accuracyExclusions: exclusions, groups: accuracy, selections };
}

/** Read the supplied database only; never instantiate the writing tracker. */
export function evaluateDatabase(filename) {
  if (!filename || !existsSync(filename)) throw new Error('DATABASE_NOT_FOUND: select an existing tracker database with --db');
  let db;
  let runs, receipts, hasJournal;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has('agentwhen_runs')) throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
    hasJournal = tables.has('eta_forecasts');
    try {
      runs = db.prepare(`SELECT id, profile, task_class, status, started_at, finished_at, active_ms, history_eligible
        FROM agentwhen_runs ORDER BY id`).all();
      receipts = hasJournal ? db.prepare(`SELECT rowid AS insertion_order, id, run_id, estimated_at, active_ms,
        estimate_status, model_version, payload_json FROM eta_forecasts ORDER BY run_id, estimated_at, rowid`).all() : [];
    } catch { throw new Error('UNSUPPORTED_DATABASE_SCHEMA'); }
    db.exec('COMMIT');
  } catch (error) {
    if (error.message === 'UNSUPPORTED_DATABASE_SCHEMA') throw error;
    throw new Error('DATABASE_READ_FAILED: cannot read the selected tracker database', { cause: error });
  } finally { db?.close(); }

  const valid = runs.filter(validRun);
  const closed = valid.filter(run => CLOSED.has(run.status));
  const byRun = new Map();
  for (const row of receipts) {
    if (!byRun.has(row.run_id)) byRun.set(row.run_id, []);
    byRun.get(row.run_id).push(row);
  }
  const runIds = new Set(runs.map(run => run.id));
  const outcomes = { succeeded: 0, failed: 0, cancelled: 0, running: 0, paused: 0, unknown: 0 };
  for (const run of runs) outcomes[Object.hasOwn(outcomes, run.status) ? run.status : 'unknown']++;
  return { schema: 'agent-eta.evaluation/1', protocol: PROTOCOL, units: 'active_minutes',
    provenance: 'supplied_receipts_not_independently_verified',
    sourceFingerprint: hash(JSON.stringify({ runs, receipts })), journal: hasJournal ? 'present' : 'missing_journal',
    population: { totalRuns: runs.length, outcomes, closedRuns: closed.length, pendingRuns: valid.length - closed.length,
      invalidRuns: runs.length - valid.length, receipts: receipts.length,
      orphanReceipts: receipts.filter(row => !runIds.has(row.run_id)).length },
    landmarks: LANDMARKS.map(landmark => landmarkReport(closed, byRun, landmark)) };
}
