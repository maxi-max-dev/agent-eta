import {
  WorksetContractError,
  sanitizeWorksetEvent,
  worksetEventPayload,
} from './contract.js';
import {
  createWorksetState,
  forecastWorkset,
  reduceWorksetEvent,
} from './projection.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const BLOCKING = new Set(['needs_input', 'waiting_provider', 'blocked', 'paused']);
const MAX_CASCADE_EVENTS = 16;

export class WorksetIngestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WorksetIngestError';
    this.code = code;
  }
}

function fail(code) {
  throw new WorksetIngestError(code);
}

function canonicalError(error) {
  if (error instanceof WorksetContractError || error instanceof WorksetIngestError) return error;
  const code = typeof error?.message === 'string' && /^WORKSET_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : error?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
      ? 'WORKSET_CHILD_NOT_FOUND'
      : 'WORKSET_INGEST_FAILED';
  return new WorksetIngestError(code);
}

function replayState(database, event) {
  let state = createWorksetState(event.worksetId, event.worksetType);
  for (const stored of database.listWorksetEvents(event.worksetId)) {
    state = reduceWorksetEvent(state, stored.event);
  }
  return reduceWorksetEvent(state, worksetEventPayload(event));
}

function runStatus(run, forecast) {
  if (!run) return 'unknown';
  if (TERMINAL.has(run.status)) return run.status;
  if (BLOCKING.has(run.status)) return run.status;
  if (forecast?.forecast_status === 'needs_input') return 'needs_input';
  if (forecast?.forecast_status === 'terminal') return 'succeeded';
  if (run.status === 'pending') return 'pending';
  return forecast ? 'running' : 'unknown';
}

function activeAgeMinutes(observedAt, asOf, status) {
  if (status !== 'running') return 0;
  const observed = Date.parse(observedAt);
  const landmark = Date.parse(asOf);
  if (!Number.isFinite(observed) || !Number.isFinite(landmark)) return 0;
  return Math.max(0, (landmark - observed) / 60_000);
}

function agedMinutes(value, age) {
  return Number.isFinite(value) ? Math.max(0, Number(value) - age) : null;
}

function latestRunProjection(database, member, asOf) {
  const run = database.loadRun(member.childId);
  const latest = database.db.prepare(`
    SELECT * FROM forecast_snapshots
    WHERE run_id = ?
    ORDER BY julianday(observed_at) DESC, snapshot_id DESC
    LIMIT 1
  `).get(member.childId);
  const status = runStatus(run, latest);
  if (status === 'succeeded') {
    return {
      memberId: member.memberId,
      status,
      lowerMinutes: 0,
      p50Minutes: 0,
      p80Minutes: 0,
    };
  }
  if (!latest || ['pending', 'unknown', 'failed', 'cancelled'].includes(status)) {
    return {
      memberId: member.memberId,
      status,
      lowerMinutes: null,
      p50Minutes: null,
      p80Minutes: null,
    };
  }
  const age = activeAgeMinutes(latest.observed_at, asOf, status);
  return {
    memberId: member.memberId,
    status,
    lowerMinutes: agedMinutes(latest.lower_minutes, age),
    p50Minutes: agedMinutes(latest.p50_minutes, age),
    p80Minutes: agedMinutes(latest.p80_minutes, age),
  };
}

function latestWorksetProjection(database, member, asOf) {
  const child = database.loadWorkset(member.childId);
  const latest = database.listWorksetForecasts(member.childId).at(-1);
  if (!child || !latest) {
    return {
      memberId: member.memberId,
      status: 'unknown',
      lowerMinutes: null,
      p50Minutes: null,
      p80Minutes: null,
    };
  }
  if (child.status === 'succeeded') {
    return {
      memberId: member.memberId,
      status: 'succeeded',
      lowerMinutes: 0,
      p50Minutes: 0,
      p80Minutes: 0,
    };
  }
  if (child.status === 'failed' || child.status === 'cancelled') {
    return {
      memberId: member.memberId,
      status: child.status,
      lowerMinutes: null,
      p50Minutes: null,
      p80Minutes: null,
    };
  }
  const saved = latest.forecast;
  if (BLOCKING.has(child.status)) {
    const lower = saved.resumeLowerMinutes ?? null;
    const upper = saved.resumeUpperMinutes ?? null;
    return {
      memberId: member.memberId,
      status: child.status,
      lowerMinutes: lower,
      p50Minutes: lower !== null && upper !== null ? (lower + upper) / 2 : null,
      p80Minutes: upper,
    };
  }
  if (saved.status !== 'forecast') {
    return {
      memberId: member.memberId,
      status: 'unknown',
      lowerMinutes: null,
      p50Minutes: null,
      p80Minutes: null,
    };
  }
  const age = activeAgeMinutes(latest.observed_at, asOf, child.status);
  return {
    memberId: member.memberId,
    status: 'running',
    lowerMinutes: agedMinutes(saved.lowerMinutes, age),
    p50Minutes: agedMinutes(saved.p50Minutes, age),
    // A multi-member child deliberately has no calibrated joint P80. Its
    // conservative upper remains safe input to the next explicit level.
    p80Minutes: agedMinutes(saved.p80Minutes ?? saved.upperMinutes, age),
  };
}

export function childProjectionsForWorkset(database, state, { asOf = new Date().toISOString() } = {}) {
  return (state.members ?? [])
    .filter((member) => member.detachedAt === null)
    .map((member) => member.childType === 'run'
      ? latestRunProjection(database, member, asOf)
      : latestWorksetProjection(database, member, asOf));
}

function acceptedProjection({ inserted, forecast }) {
  return Object.freeze({
    accepted: true,
    inserted,
    scope: forecast.worksetRevision > 0 ? 'workset' : 'unknown',
    revision: forecast.worksetRevision,
    status: forecast.status,
    mode: forecast.mode,
    evidence: forecast.evidence,
    lowerMinutes: forecast.lowerMinutes,
    p50Minutes: forecast.p50Minutes,
    p80Minutes: forecast.p80Minutes,
    upperMinutes: forecast.upperMinutes,
    resumeLowerMinutes: forecast.resumeLowerMinutes ?? null,
    resumeUpperMinutes: forecast.resumeUpperMinutes ?? null,
    reasonCode: forecast.reasonCode,
    jointP80Claimed: forecast.jointP80Claimed,
  });
}

/**
 * Accept one canonical structural event and persist its materialized state and
 * computed scope forecast in one SQLite transaction. No run/workset ID is
 * returned to callers.
 */
export function ingestWorksetEvent(database, input, {
  receivedAt = new Date().toISOString(),
  parentSurvival = null,
  source = null,
} = {}) {
  try {
    const event = sanitizeWorksetEvent(input);
    const receivedMs = typeof receivedAt === 'string' ? Date.parse(receivedAt) : Number.NaN;
    if (!Number.isFinite(receivedMs)) fail('WORKSET_INVALID_RECEIPT_TIME');
    if (receivedMs < Date.parse(event.occurredAt)) fail('WORKSET_RECEIPT_PRECEDES_EVENT');
    const payload = worksetEventPayload(event);
    const existing = database.db.prepare(`
      SELECT payload_json FROM workset_events WHERE event_id = ?
    `).get(event.eventId);
    if (existing) {
      if (existing.payload_json !== JSON.stringify(payload)) fail('WORKSET_EVENT_CONFLICT');
      const latest = database.db.prepare(`
        SELECT forecast_json FROM workset_forecast_snapshots
        WHERE workset_id = ? AND event_id = ?
      `).get(event.worksetId, event.eventId);
      if (!latest) fail('WORKSET_FORECAST_MISSING');
      const forecast = JSON.parse(latest.forecast_json);
      if (forecast.reasonCode === 'awaiting_forecast') fail('WORKSET_FORECAST_PENDING');
      if (source !== null) {
        database.saveWorksetSource(event.worksetId, source, { receivedAt });
      }
      return acceptedProjection({ inserted: false, forecast });
    }

    const state = replayState(database, event);
    const forecast = forecastWorkset({
      state,
      childProjections: childProjectionsForWorkset(database, state, { asOf: receivedAt }),
      parentSurvival,
    });
    const saved = database.saveWorksetProjection(state, payload, {
      receivedAt,
      forecast,
      source,
    });
    return acceptedProjection({ inserted: saved.inserted, forecast });
  } catch (error) {
    throw canonicalError(error);
  }
}

/**
 * Apply an explicit ordered cascade, normally task heartbeat followed by its
 * project heartbeat. A failed retry can safely submit the identical cascade:
 * already-accepted event IDs are idempotent and later events continue.
 */
export function ingestWorksetCascade(database, inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_CASCADE_EVENTS) {
    fail('WORKSET_CASCADE_INVALID_LENGTH');
  }
  const events = inputs.map((input) => {
    try {
      return sanitizeWorksetEvent(input);
    } catch (error) {
      throw canonicalError(error);
    }
  });
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    fail('WORKSET_CASCADE_DUPLICATE_EVENT');
  }
  for (let index = 1; index < events.length; index += 1) {
    if (Date.parse(events[index].occurredAt) < Date.parse(events[index - 1].occurredAt)) {
      fail('WORKSET_CASCADE_OUT_OF_ORDER');
    }
  }
  return Object.freeze({
    accepted: true,
    results: events.map((event) => ingestWorksetEvent(database, worksetEventPayload(event), options)),
  });
}

export function safeWorksetIngestCode(error) {
  return canonicalError(error).code;
}
