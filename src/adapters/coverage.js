import { assertPrivacySafe } from "./privacy.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function requireCount(value, path, { optional = false } = {}) {
  if (value === undefined && optional) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(value, path) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${path} must be an ISO 8601 instant`);
  }
  return value;
}

function normalizeSession(scan, index) {
  const path = `sessions[${index}]`;
  if (scan === null || typeof scan !== "object" || Array.isArray(scan)) {
    throw new TypeError(`${path} must be an object`);
  }

  if (typeof scan.provider !== "string" || scan.provider.length === 0) {
    throw new TypeError(`${path}.provider must be a non-empty provider atom`);
  }
  if (typeof scan.sessionId !== "string" || scan.sessionId.length === 0) {
    throw new TypeError(`${path}.sessionId must be a non-empty opaque ID`);
  }

  const startedAt = requireTimestamp(scan.startedAt, `${path}.startedAt`);
  const endedAt = scan.endedAt === undefined
    ? startedAt
    : requireTimestamp(scan.endedAt, `${path}.endedAt`);
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new TypeError(`${path}.endedAt must not precede startedAt`);
  }

  const eventCount = requireCount(scan.eventCount, `${path}.eventCount`);
  const planEventCount = requireCount(
    scan.planEventCount,
    `${path}.planEventCount`,
    { optional: true },
  );
  const corruptEventCount = requireCount(
    scan.corruptEventCount,
    `${path}.corruptEventCount`,
    { optional: true },
  );
  if (planEventCount > eventCount) {
    throw new TypeError(`${path}.planEventCount cannot exceed eventCount`);
  }
  if (corruptEventCount > eventCount) {
    throw new TypeError(`${path}.corruptEventCount cannot exceed eventCount`);
  }
  if (scan.hasPlan !== undefined && typeof scan.hasPlan !== "boolean") {
    throw new TypeError(`${path}.hasPlan must be boolean when present`);
  }
  if (scan.hasPlan === false && planEventCount > 0) {
    throw new TypeError(`${path}.hasPlan contradicts planEventCount`);
  }
  if (
    scan.eligibleLargeTask !== undefined &&
    typeof scan.eligibleLargeTask !== "boolean"
  ) {
    throw new TypeError(`${path}.eligibleLargeTask must be boolean when present`);
  }

  return {
    provider: scan.provider,
    startedAt,
    endedAt,
    eventCount,
    planEventCount,
    corruptEventCount,
    hasPlan: scan.hasPlan === true || planEventCount > 0,
    eligibilityKnown: typeof scan.eligibleLargeTask === "boolean",
    eligibleLargeTask: scan.eligibleLargeTask === true,
  };
}

/**
 * Aggregate read-only, provider-neutral session scan metadata.
 *
 * Coverage uses eligible large tasks as its denominator only when every scan
 * carries an explicit boolean `eligibleLargeTask`, determined upstream from
 * safe structural metadata. Missing eligibility never triggers inspection of
 * prompts, messages, commands, code or filesystem paths; it makes the metric
 * unsupported instead.
 */
export function aggregateCoverage(sessionScans) {
  if (!Array.isArray(sessionScans)) {
    throw new TypeError("sessionScans must be an array");
  }

  // Reject accidental content-bearing adapter output before aggregation.
  assertPrivacySafe(sessionScans);
  const sessions = sessionScans.map(normalizeSession);

  const providers = new Set(sessions.map((session) => session.provider));
  const provider = providers.size === 0
    ? "unknown"
    : providers.size === 1
      ? providers.values().next().value
      : "mixed";

  const eligibilitySupported =
    sessions.length > 0 && sessions.every((session) => session.eligibilityKnown);
  const eligibleSessions = eligibilitySupported
    ? sessions.filter((session) => session.eligibleLargeTask).length
    : null;
  const eligiblePlanSessions = eligibilitySupported
    ? sessions.filter((session) => session.eligibleLargeTask && session.hasPlan).length
    : null;
  const planSessions = sessions.filter((session) => session.hasPlan).length;
  const totalEvents = sessions.reduce((sum, session) => sum + session.eventCount, 0);
  const corruptEvents = sessions.reduce(
    (sum, session) => sum + session.corruptEventCount,
    0,
  );

  const starts = sessions.map((session) => Date.parse(session.startedAt));
  const ends = sessions.map((session) => Date.parse(session.endedAt));

  const result = {
    provider,
    simulated: false,
    liveReadOnly: true,
    totalSessions: sessions.length,
    eligibility: {
      definition: "eligibleLargeTask_boolean",
      supported: eligibilitySupported,
      eligibleSessions,
    },
    planSessions,
    eligiblePlanSessions,
    coverage:
      eligibilitySupported && eligibleSessions > 0
        ? eligiblePlanSessions / eligibleSessions
        : null,
    events: {
      total: totalEvents,
      corrupt: corruptEvents,
      rate: totalEvents > 0 ? corruptEvents / totalEvents : null,
    },
    timeRange: {
      from: sessions.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
      to: sessions.length > 0 ? new Date(Math.max(...ends)).toISOString() : null,
    },
  };

  assertPrivacySafe(result);
  return result;
}
