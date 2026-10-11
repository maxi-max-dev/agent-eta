import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MODEL_VERSION, TASK_CLASSES } from './tracker.js';
import { SHADOW_VERSION } from './shadow.js';
import { createCohortPlan, validateCohortPlan, readCohortSnapshot } from './cohort.js';
import { compareSnapshot } from './compare.js';
import { snapshotFingerprint, validRun } from './evaluate.js';

const PROTOCOL = 'agent-eta.candidate-review/1';
const VERSIONS = Object.freeze({ primary: MODEL_VERSION, baseline: 'cohort-median-minus-elapsed/1', candidate: SHADOW_VERSION });
const THRESHOLDS = Object.freeze({ minimumPairs: 30, minimumLongPairs: 10, longMinutes: 15,
  maeRatio: 0.9, severePrimaryRatio: 0.8, minimumCoverage: 0.8, maximumCoverageDrop: 0.02,
  maximumWidthRatio: 1.25, minimumNumericRate: 0.8, maximumNumericDrop: 0.05 });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const serialized = value => JSON.stringify(canonical(value));
const fields = ['schema', 'protocol', 'scope', 'versions', 'thresholds', 'cohortPlan'];
const idFor = plan => `eta-gate-${createHash('sha256').update(serialized(Object.fromEntries(fields.map(key => [key, plan[key]])))).digest('hex')}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const scopeValid = scope => scope && Object.keys(scope).length === 2
  && typeof scope.profile === 'string' && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(scope.profile) && TASK_CLASSES.includes(scope.taskClass);

/** Fresh future-only plan: existing, potentially inspected plans are not adopted. */
export function createGatePlan(filename, { profile, taskClass, holdoutStart, holdoutEnd }, clock = Date.now) {
  const scope = { profile, taskClass };
  if (!scopeValid(scope)) throw new Error('INVALID_GATE_SCOPE: provide a profile and task class');
  const cohortPlan = createCohortPlan(filename, { holdoutStart, holdoutEnd }, clock);
  const plan = { schema: 'agent-eta.gate-plan/1', protocol: PROTOCOL, scope,
    versions: { ...VERSIONS }, thresholds: { ...THRESHOLDS }, cohortPlan };
  return { ...plan, id: idFor(plan) };
}

export function validateGatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).length !== fields.length + 1
    || ![...fields, 'id'].every(key => Object.hasOwn(plan, key))
    || plan.schema !== 'agent-eta.gate-plan/1' || plan.protocol !== PROTOCOL || !scopeValid(plan.scope)
    || serialized(plan.versions) !== serialized(VERSIONS) || serialized(plan.thresholds) !== serialized(THRESHOLDS)
    || plan.id !== idFor(plan)) throw new Error('INVALID_GATE_PLAN');
  validateCohortPlan(plan.cohortPlan);
  return plan;
}

export function readGatePlan(filename) {
  let plan;
  try { plan = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { throw new Error('GATE_PLAN_READ_FAILED'); }
  return validateGatePlan(plan);
}

function select(source, predicate) {
  const runs = source.runs.filter(predicate), ids = new Set(runs.map(run => run.id));
  return { runs, receipts: source.receipts.filter(row => ids.has(row.run_id)), hasJournal: source.hasJournal };
}

function pointChecks(point, long = false) {
  const group = point.groups[0], primary = group?.primary, candidate = group?.candidate, baseline = group?.medianBaseline;
  const checks = [];
  const check = (name, value, operator, limit) => {
    const evaluable = finite(value) && finite(limit);
    const pass = evaluable && (operator === '<=' ? value <= limit : operator === '<' ? value < limit : value >= limit);
    checks.push({ name, value: value ?? null, operator, limit: finite(limit) ? limit : null,
      result: !evaluable ? 'not_evaluable' : pass ? 'met' : 'not_met' });
  };
  check('paired_runs', point.pairedRuns, '>=', long ? THRESHOLDS.minimumLongPairs : THRESHOLDS.minimumPairs);
  const factor = long ? 1 : THRESHOLDS.maeRatio;
  check('mae_vs_primary', candidate?.meanAbsoluteErrorMinutes, '<=', primary?.meanAbsoluteErrorMinutes * factor);
  check('mae_vs_baseline', candidate?.meanAbsoluteErrorMinutes, '<=', baseline?.meanAbsoluteErrorMinutes * factor);
  check('median_error_vs_primary', candidate?.medianAbsoluteErrorMinutes, '<=', primary?.medianAbsoluteErrorMinutes);
  check('median_error_vs_baseline', candidate?.medianAbsoluteErrorMinutes, '<=', baseline?.medianAbsoluteErrorMinutes);
  check('severe_vs_primary', candidate?.severeUnderestimateCount, '<=', primary?.severeUnderestimateCount * (long ? 1 : THRESHOLDS.severePrimaryRatio));
  check('severe_vs_baseline', candidate?.severeUnderestimateCount, '<=', baseline?.severeUnderestimateCount);
  if (!long) {
    check('paired_mae_upper_vs_primary', group?.candidateMinusPrimary.bootstrap95?.upper, '<', 0);
    check('paired_mae_upper_vs_baseline', group?.candidateMinusMedianBaseline.bootstrap95?.upper, '<', 0);
  }
  check('p80_coverage', candidate?.p80Coverage, '>=', THRESHOLDS.minimumCoverage);
  check('coverage_vs_primary', candidate?.p80Coverage, '>=', primary?.p80Coverage - THRESHOLDS.maximumCoverageDrop);
  check('interval_width', candidate?.meanIntervalWidthMinutes, '<=', primary?.meanIntervalWidthMinutes * THRESHOLDS.maximumWidthRatio);
  check('numeric_rate', point.candidateAvailability.numericRate, '>=', THRESHOLDS.minimumNumericRate);
  // Explicitly preserve null: a missing denominator is not zero availability.
  check('numeric_rate_vs_primary', point.candidateAvailability.numericRate, '>=',
    finite(point.primaryAvailability.numericRate) ? point.primaryAvailability.numericRate - THRESHOLDS.maximumNumericDrop : null);
  for (const [name, availability] of [['primary', point.primaryAvailability], ['candidate', point.candidateAvailability]]) {
    check(`${name}_missing_rate`, availability.missingRate, '<=', 0);
    check(`${name}_invalid_rate`, availability.invalidRate, '<=', 0);
    // A large denominator can round a nonzero rate to zero. No missing or
    // corrupt receipt may disappear through presentation rounding.
    check(`${name}_missing_count`, availability.counts.missing, '<=', 0);
    check(`${name}_invalid_count`, availability.counts.invalid, '<=', 0);
  }
  return { pairedRuns: point.pairedRuns, checks };
}

function versionsMatch(report, source) {
  const rows = new Map(source.receipts.map(row => [row.id, row]));
  for (const point of report.landmarks) {
    if (point.groups.some(group => group.modelVersion !== VERSIONS.primary || group.baselineVersion !== VERSIONS.baseline
      || group.candidateVersion !== VERSIONS.candidate)) return false;
    for (const selected of point.selections) {
      const row = rows.get(selected.forecastId);
      if (!row) continue;
      if (row.model_version !== VERSIONS.primary) return false;
      let payload;
      try { payload = JSON.parse(row.payload_json); } catch { continue; }
      if (payload?.modelVersion != null && payload.modelVersion !== VERSIONS.primary) return false;
      if (payload?.shadow?.modelVersion != null && payload.shadow.modelVersion !== VERSIONS.candidate) return false;
    }
  }
  return true;
}

/** Readout guards run before any error/accuracy aggregation. No model promotion. */
export function assessGateDatabase(filename, manifest, clock = Date.now) {
  const plan = validateGatePlan(manifest);
  const { source, membership, selected } = readCohortSnapshot(filename, plan.cohortPlan, 'holdout');
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new Error('INVALID_GATE_CLOCK');
  const matchesScope = run => run.profile === plan.scope.profile && run.task_class === plan.scope.taskClass;
  const scoped = select(selected, matchesScope);
  const ambiguousIds = new Set(membership.invalidStart);
  const ambiguousStarts = source.runs.filter(run => ambiguousIds.has(run.id) && matchesScope(run)).length;
  const invalid = scoped.runs.filter(run => !validRun(run)).length;
  const pending = scoped.runs.filter(run => validRun(run) && ['running', 'paused'].includes(run.status)).length;
  const envelope = { schema: 'agent-eta.gate-assessment/1', protocol: PROTOCOL, planId: plan.id,
    assessedAt: new Date(now).toISOString(), scope: plan.scope, versions: plan.versions, thresholds: plan.thresholds,
    window: { start: plan.cohortPlan.holdoutStart, end: plan.cohortPlan.holdoutEnd },
    provenance: 'supplied_plan_and_receipts_not_independently_verified', promotionEligible: false,
    defaultModelChanged: false, independentReviewRequired: true,
    sourceFingerprint: snapshotFingerprint(source), scopedFingerprint: snapshotFingerprint(scoped),
    population: { sourceRuns: source.runs.length, holdoutRuns: membership.holdout.length,
      outOfScopeRuns: selected.runs.length - scoped.runs.length, scopedRuns: scoped.runs.length,
      pendingRuns: pending, invalidRuns: invalid, ambiguousStartRuns: ambiguousStarts },
    membershipCounts: Object.fromEntries(Object.entries(membership).map(([key, ids]) => [key, ids.length])) };
  if (now < Date.parse(plan.cohortPlan.holdoutEnd)) return { ...envelope, status: 'awaiting_window' };
  if (invalid || ambiguousStarts || scoped.runs.some(run => run.started_at > now || (run.finished_at != null && run.finished_at > now))
    || scoped.receipts.some(row => !finite(row.estimated_at) || row.estimated_at > now)) {
    return { ...envelope, status: 'invalid_evidence', reason: 'invalid_run_or_future_timestamp' };
  }
  if (pending) return { ...envelope, status: 'awaiting_outcomes' };
  const comparison = compareSnapshot(scoped);
  if (!versionsMatch(comparison, scoped)) return { ...envelope, status: 'invalid_evidence', reason: 'model_version_mismatch' };
  const longRunComparison = compareSnapshot(select(scoped, run => run.active_ms > THRESHOLDS.longMinutes * 60_000));
  const evaluations = comparison.landmarks.map((point, i) => ({ landmarkMinutes: point.landmarkMinutes,
    overall: pointChecks(point), longRuns: pointChecks(longRunComparison.landmarks[i], true) }));
  const enough = evaluations.every(point => point.overall.pairedRuns >= THRESHOLDS.minimumPairs
    && point.longRuns.pairedRuns >= THRESHOLDS.minimumLongPairs);
  const passed = evaluations.every(point => [...point.overall.checks, ...point.longRuns.checks].every(check => check.result === 'met'));
  return { ...envelope, status: !enough ? 'insufficient_evidence' : passed ? 'numeric_targets_met_pending_review' : 'targets_not_met',
    evaluations, comparison, longRunComparison };
}
