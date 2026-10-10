import { evaluateSnapshot, readEvaluationSnapshot, summarizeGroup } from './evaluate.js';
import { SHADOW_VERSION, historyFingerprint } from './shadow.js';

const round = value => Number(value.toFixed(6));
const ratio = (n, d) => d ? round(n / d) : null;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function checkShadow(payload, row) {
  const inputs = payload.comparisonInputs, shadow = payload.shadow;
  if (!inputs && !shadow) return { kind: 'missing', reason: 'missing_shadow' };
  if (!inputs || !shadow) return { kind: 'invalid', reason: 'invalid_shadow_inputs' };
  if (inputs.schema !== 'agent-eta.comparison-inputs/1' || shadow.schema !== 'agent-eta.shadow/1'
    || shadow.modelVersion !== SHADOW_VERSION || inputs.activeMs !== row.active_ms || shadow.activeMs !== row.active_ms
    || inputs.estimatedAt !== payload.estimatedAt || shadow.estimatedAt !== payload.estimatedAt
    || !Array.isArray(inputs.historyMinutes) || inputs.historyMinutes.length !== payload.historyCount
    || inputs.historyMinutes.length > 200 || inputs.historyMinutes.some(x => !nonnegative(x) || x === 0)
    || shadow.historyCount !== payload.historyCount || shadow.calibrated !== false
    || inputs.historyFingerprint !== historyFingerprint(inputs.historyMinutes)
    || shadow.historyFingerprint !== inputs.historyFingerprint) return { kind: 'invalid', reason: 'invalid_shadow_inputs' };
  const support = inputs.historyMinutes.filter(x => x > row.active_ms / 60_000).length;
  const expectedState = payload.estimateStatus !== 'experimental' ? payload.estimateStatus
    : support < 3 ? 'insufficient_tail' : 'experimental';
  if (shadow.state !== expectedState || shadow.conditionalCount !== support) return { kind: 'invalid', reason: 'invalid_shadow_state' };
  const q = shadow.remainingMinutes;
  if (shadow.state !== 'experimental') return q === null
    ? { kind: 'abstained', reason: shadow.state } : { kind: 'invalid', reason: 'numeric_shadow_abstention' };
  if (!q || ![q.p20, q.p50, q.p80].every(nonnegative) || q.p20 > q.p50 || q.p50 > q.p80) {
    return { kind: 'invalid', reason: 'invalid_shadow_quantiles' };
  }
  return { kind: 'numeric', reason: null, shadow, inputs };
}

function summarizeComparison(group, landmark) {
  const { pairs, ...identity } = group;
  const primary = summarizeGroup(group, landmark);
  const candidatePairs = pairs.map(pair => ({ ...pair, p20Minutes: pair.candidateP20Minutes,
    p50Minutes: pair.candidateP50Minutes, p80Minutes: pair.candidateP80Minutes }));
  const candidate = summarizeGroup({ ...identity, modelVersion: identity.candidateVersion, pairs: candidatePairs }, landmark);
  const vsPrimary = summarizeGroup({ ...identity, modelVersion: identity.candidateVersion,
    baselineVersion: identity.modelVersion,
    pairs: candidatePairs.map((pair, i) => ({ ...pair, baselineMinutes: pairs[i].p50Minutes })) }, landmark);
  return { ...identity, n: pairs.length, evidenceStatus: primary.evidenceStatus,
    primary: primary.model, candidate: candidate.model, medianBaseline: primary.baseline,
    candidateMinusPrimary: { meanAbsoluteErrorDifferenceMinutes: vsPrimary.pairedMeanAbsoluteErrorDifferenceMinutes,
      bootstrap95: vsPrimary.pairedDifferenceBootstrap95 },
    candidateMinusMedianBaseline: { meanAbsoluteErrorDifferenceMinutes: candidate.pairedMeanAbsoluteErrorDifferenceMinutes,
      bootstrap95: candidate.pairedDifferenceBootstrap95 },
    pairs: primary.pairs };
}

/** Only saved forecasts are scored. No predictor or history rebuild runs here. */
export function compareDatabase(filename) {
  const source = readEvaluationSnapshot(filename);
  const primary = evaluateSnapshot(source);
  const rows = new Map(source.receipts.map(row => [row.id, row]));
  const runs = new Map(source.runs.map(row => [row.id, row]));
  const landmarks = primary.landmarks.map(point => {
    const groups = new Map();
    const counts = { numeric: 0, abstained: 0, missing: 0, invalid: 0 };
    const reasons = {}, accuracyExclusions = {}, selections = [];
    for (const selected of point.selections) {
      let check, payload;
      const row = rows.get(selected.forecastId);
      if (selected.state === 'missing') check = { kind: 'missing', reason: 'missing_receipt' };
      else if (selected.state === 'invalid') check = { kind: 'invalid', reason: 'invalid_primary_receipt' };
      else {
        payload = JSON.parse(row.payload_json); // Already checked by prospective v1.
        check = checkShadow(payload, row);
      }
      counts[check.kind]++;
      if (check.reason) reasons[check.reason] = (reasons[check.reason] ?? 0) + 1;
      const exclusion = selected.accuracyExclusion ?? (check.kind !== 'numeric' ? check.reason : null);
      selections.push({ runId: selected.runId, forecastId: selected.forecastId, outcome: selected.outcome,
        candidateState: check.kind, candidateReason: check.reason, accuracyExclusion: exclusion });
      if (exclusion) { accuracyExclusions[exclusion] = (accuracyExclusions[exclusion] ?? 0) + 1; continue; }
      const run = runs.get(selected.runId);
      const identity = { profile: run.profile, taskClass: run.task_class, modelVersion: payload.modelVersion,
        baselineVersion: payload.baselineVersion, candidateVersion: check.shadow.modelVersion };
      const key = JSON.stringify(identity);
      if (!groups.has(key)) groups.set(key, { ...identity, pairs: [] });
      groups.get(key).pairs.push({ runId: run.id, forecastId: row.id, estimatedAt: payload.estimatedAt,
        activeMinutes: row.active_ms / 60_000, actualRemainingMinutes: (run.active_ms - row.active_ms) / 60_000,
        p20Minutes: payload.remainingMinutes.p20, p50Minutes: payload.remainingMinutes.p50,
        p80Minutes: payload.remainingMinutes.p80, baselineMinutes: payload.baselineRemainingMinutes,
        candidateP20Minutes: check.shadow.remainingMinutes.p20, candidateP50Minutes: check.shadow.remainingMinutes.p50,
        candidateP80Minutes: check.shadow.remainingMinutes.p80, historyFingerprint: check.inputs.historyFingerprint });
    }
    const summaries = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([, group]) => summarizeComparison(group, point.landmarkMinutes));
    const n = summaries.reduce((sum, group) => sum + group.n, 0);
    const denominator = point.availability.denominator;
    return { landmarkMinutes: point.landmarkMinutes, toleranceSeconds: point.toleranceSeconds,
      primaryAvailability: point.availability,
      candidateAvailability: { denominator, counts, reasons, numericRate: ratio(counts.numeric, denominator),
        abstentionRate: ratio(counts.abstained, denominator), missingRate: ratio(counts.missing, denominator),
        invalidRate: ratio(counts.invalid, denominator) },
      pairedRuns: n, evidenceStatus: n === 0 ? 'no_scorable_pairs' : n === 1 ? 'single_run_only' : 'descriptive_only',
      accuracyExclusions, groups: summaries, selections };
  });
  return { schema: 'agent-eta.comparison/1', protocol: 'agent-eta.shadow-comparison/1',
    selectionProtocol: primary.protocol, provenance: primary.provenance, units: primary.units,
    sourceFingerprint: primary.sourceFingerprint, journal: primary.journal, population: primary.population,
    candidateVersion: SHADOW_VERSION, promotionEligible: false,
    promotionReason: 'no_predeclared_untouched_holdout_or_promotion_gate_evaluated', landmarks };
}
