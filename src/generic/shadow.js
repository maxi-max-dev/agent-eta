import { createHash } from 'node:crypto';

export const SHADOW_VERSION = 'empirical-conditional/1';
export const historyFingerprint = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** No extrapolation: fewer than three surviving examples means abstention. */
export function empiricalConditional(historyMinutes, activeMs, primaryState = 'experimental') {
  if (!Array.isArray(historyMinutes) || historyMinutes.some(x => !Number.isFinite(x) || x <= 0)
    || !Number.isFinite(activeMs) || activeMs < 0) throw new Error('INVALID_SHADOW_INPUT');
  const residuals = historyMinutes.filter(total => total > activeMs / 60_000)
    .map(total => total - activeMs / 60_000).sort((a, b) => a - b);
  const state = primaryState !== 'experimental' ? primaryState
    : residuals.length < 3 ? 'insufficient_tail' : 'experimental';
  const quantile = q => residuals[Math.ceil(q * residuals.length) - 1];
  return { state, conditionalCount: residuals.length, remainingMinutes: state === 'experimental'
    ? { p20: quantile(0.2), p50: quantile(0.5), p80: quantile(0.8) } : null };
}

export function captureShadow(history, activeMs, estimatedAt, primaryState) {
  const historyMinutes = history.map(row => row.actualMinutes);
  const fingerprint = historyFingerprint(historyMinutes);
  const comparisonInputs = { schema: 'agent-eta.comparison-inputs/1', activeMs, estimatedAt,
    historyMinutes, historyFingerprint: fingerprint };
  let candidate;
  try { candidate = empiricalConditional(historyMinutes, activeMs, primaryState); }
  catch { candidate = { state: 'invalid_inputs', conditionalCount: 0, remainingMinutes: null }; }
  return { comparisonInputs, shadow: { schema: 'agent-eta.shadow/1', modelVersion: SHADOW_VERSION,
    activeMs, estimatedAt, historyFingerprint: fingerprint, historyCount: historyMinutes.length,
    ...candidate, calibrated: false } };
}
