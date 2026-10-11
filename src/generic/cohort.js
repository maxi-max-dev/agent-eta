import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readEvaluationSnapshot, snapshotFingerprint, validRun } from './evaluate.js';
import { compareSnapshot } from './compare.js';

const PROTOCOL = 'agent-eta.time-split/1';
const PLAN_FIELDS = ['schema', 'protocol', 'declaredAt', 'holdoutStart', 'holdoutEnd', 'sourceFingerprint',
  'knownRunIds', 'tuningRunIds', 'tuningReceiptIds', 'tuningFingerprint', 'tuningJournal'];
const CLOSED = new Set(['succeeded', 'failed', 'cancelled']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const planId = plan => `eta-plan-${digest(Object.fromEntries(PLAN_FIELDS.map(key => [key, plan[key]])))}`;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const sortedIds = rows => rows.map(row => row.id).sort();
const validIds = ids => Array.isArray(ids) && ids.every((id, i) => typeof id === 'string'
  && (i === 0 || ids[i - 1] < id));

function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('INVALID_COHORT_TIME: use an ISO UTC timestamp ending in Z');
  }
  const ms = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!timestamp(ms) || new Date(ms).toISOString() !== canonical) throw new Error('INVALID_COHORT_TIME');
  return ms;
}

function subset(source, runIds, receiptIds) {
  return { runs: source.runs.filter(run => runIds.has(run.id)),
    receipts: source.receipts.filter(row => runIds.has(row.run_id) && (!receiptIds || receiptIds.has(row.id))),
    hasJournal: source.hasJournal };
}

/** Declares a future window, without evaluating any outcomes or writing a DB. */
export function createCohortPlan(filename, { holdoutStart, holdoutEnd }, clock = Date.now) {
  const start = utc(holdoutStart), end = utc(holdoutEnd);
  const source = readEvaluationSnapshot(filename);
  const now = clock();
  if (!timestamp(now) || start <= now || end <= start) {
    throw new Error('INVALID_COHORT_WINDOW: require declaration < holdout start < holdout end');
  }
  const knownRunIds = sortedIds(source.runs);
  if (!validIds(knownRunIds)) throw new Error('INVALID_COHORT_RUN_IDS');
  const tuningRunIds = sortedIds(source.runs.filter(run => validRun(run) && CLOSED.has(run.status) && run.finished_at <= now));
  const tuning = subset(source, new Set(tuningRunIds));
  const tuningReceiptIds = sortedIds(tuning.receipts);
  if (!validIds(tuningReceiptIds)) throw new Error('INVALID_COHORT_RECEIPT_IDS');
  const plan = { schema: 'agent-eta.cohort-plan/1', protocol: PROTOCOL, declaredAt: new Date(now).toISOString(),
    holdoutStart: new Date(start).toISOString(), holdoutEnd: new Date(end).toISOString(),
    sourceFingerprint: snapshotFingerprint(source), knownRunIds, tuningRunIds, tuningReceiptIds,
    tuningFingerprint: snapshotFingerprint(tuning), tuningJournal: source.hasJournal };
  return { ...plan, id: planId(plan) };
}

export function validateCohortPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).length !== PLAN_FIELDS.length + 1
    || ![...PLAN_FIELDS, 'id'].every(key => Object.hasOwn(plan, key))
    || plan.schema !== 'agent-eta.cohort-plan/1' || plan.protocol !== PROTOCOL
    || !validHash(plan.sourceFingerprint) || !validHash(plan.tuningFingerprint)
    || typeof plan.tuningJournal !== 'boolean'
    || !validIds(plan.knownRunIds) || !validIds(plan.tuningRunIds) || !validIds(plan.tuningReceiptIds)
    || plan.id !== planId(plan)) throw new Error('INVALID_COHORT_PLAN');
  const known = new Set(plan.knownRunIds);
  if (plan.tuningRunIds.some(id => !known.has(id))
    || utc(plan.declaredAt) >= utc(plan.holdoutStart) || utc(plan.holdoutStart) >= utc(plan.holdoutEnd)) {
    throw new Error('INVALID_COHORT_PLAN');
  }
  return plan;
}

export function readCohortPlan(filename) {
  let plan;
  try { plan = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('COHORT_PLAN_READ_FAILED'); }
  return validateCohortPlan(plan);
}

function durationBand(run) {
  if (!validRun(run) || !CLOSED.has(run.status)) return 'unknown';
  return run.active_ms <= 5 * 60_000 ? 'up_to_5m' : run.active_ms <= 15 * 60_000 ? '5_to_15m' : 'over_15m';
}

/** Keeps each run in one cohort; never chooses using prediction error. */
export function compareCohortDatabase(filename, manifest, cohort) {
  if (!['tuning', 'holdout'].includes(cohort)) throw new Error('INVALID_COHORT: choose tuning or holdout');
  const plan = validateCohortPlan(manifest);
  const source = readEvaluationSnapshot(filename);
  const known = new Set(plan.knownRunIds), tuningIds = new Set(plan.tuningRunIds);
  const existing = new Set(source.runs.map(run => run.id));
  if (plan.knownRunIds.some(id => !existing.has(id))) throw new Error('COHORT_SOURCE_MISMATCH: a known run is missing');
  const tuning = subset(source, tuningIds, new Set(plan.tuningReceiptIds));
  if (snapshotFingerprint(tuning) !== plan.tuningFingerprint) throw new Error('COHORT_TUNING_CHANGED: frozen rows differ');
  tuning.hasJournal = plan.tuningJournal;
  const start = utc(plan.holdoutStart), end = utc(plan.holdoutEnd);
  const membership = { tuning: [], holdout: [], preexistingExcluded: [], outsideWindow: [], invalidStart: [] };
  for (const run of source.runs) {
    const key = tuningIds.has(run.id) ? 'tuning' : known.has(run.id) ? 'preexistingExcluded'
      : !timestamp(run.started_at) ? 'invalidStart'
        : run.started_at >= start && run.started_at < end ? 'holdout' : 'outsideWindow';
    membership[key].push(run.id);
  }
  const selected = cohort === 'tuning' ? tuning : subset(source, new Set(membership.holdout));
  const comparison = compareSnapshot(selected);
  const strata = new Map();
  for (const run of selected.runs) {
    const identity = { profile: run.profile, taskClass: run.task_class, durationBand: durationBand(run) };
    const key = JSON.stringify(identity);
    if (!strata.has(key)) strata.set(key, { ...identity, ids: new Set() });
    strata.get(key).ids.add(run.id);
  }
  return { schema: 'agent-eta.cohort-comparison/1', protocol: PROTOCOL, plan, cohort,
    provenance: 'supplied_plan_and_receipts_not_independently_verified', promotionEligible: false,
    promotionReason: 'no_promotion_gate_or_independently_verified_untouched_holdout_evaluated',
    source: { fingerprint: snapshotFingerprint(source), runs: source.runs.length, receipts: source.receipts.length,
      orphanReceipts: source.receipts.filter(row => !existing.has(row.run_id)).length },
    membership: Object.fromEntries(Object.entries(membership).map(([key, ids]) => [key, { count: ids.length, runIds: ids }])),
    comparison,
    strata: [...strata.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, { ids, ...identity }]) => {
      const report = compareSnapshot(subset(selected, ids));
      return { ...identity, population: report.population, landmarks: report.landmarks };
    }) };
}
