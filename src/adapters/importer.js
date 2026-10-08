import { assertValidEvent, isKnownEventKind } from '../core/contract.js';
import { calibrateForecastP80, estimateP80Calibration } from '../core/calibration.js';
import { forecastRun } from '../core/estimator.js';
import { createRunState, reduceEvent } from '../core/reducer.js';
import { reconcileCodexGoalPilot } from '../pilot/ingest.js';
import { reconcileReporterObservations } from '../reporter/ingest.js';
import { makeDisplay } from '../server/main.js';

const SAFE_ATOM = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const ORDINAL_LABEL = /^步骤 [1-9]\d*$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const PROVIDER_CONTRACT = Object.freeze({
  codex: {
    event: /^codex-event-[a-f0-9]{20}$/,
    run: /^codex-run-[a-f0-9]{20}$/,
    session: /^codex-session-[a-f0-9]{20}$/,
    adapter: 'codex-jsonl',
    mode: 'local_read_only',
  },
  claude: {
    event: /^claude-event-[a-f0-9]{24}$/,
    run: /^claude-run-[a-f0-9]{20}$/,
    session: /^claude-session-[a-f0-9]{20}$/,
    adapter: 'claude-code-jsonl',
    mode: 'local_readonly_metadata',
  },
});

function plainRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, path) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${path}.${String(key)} is not allowed in live persistence`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`${path}.${key} cannot be an accessor`);
    }
  }
}

function safeString(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${path} is not a safe structural token`);
  }
  return value;
}

function safeTimestamp(value, path) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO-compatible timestamp`);
  }
  return new Date(value).toISOString();
}

function safeStepId(value, provider, runId, path) {
  safeString(value, SAFE_ID, path);
  const valid = provider === 'codex'
    ? value.startsWith(`${runId}-step-`) && /^\d+$/.test(value.slice(`${runId}-step-`.length))
    : /^claude-step-[a-f0-9]{16}$/.test(value);
  if (!valid) throw new TypeError(`${path} must be a hashed or run-scoped step alias`);
  return value;
}

function sanitizeStep(step, path, provider, runId) {
  plainRecord(step, path);
  exactKeys(step, new Set(['id', 'label', 'class', 'status', 'prior_minutes']), path);
  const sanitized = {
    id: safeStepId(step.id, provider, runId, `${path}.id`),
    label: safeString(step.label, ORDINAL_LABEL, `${path}.label`),
    class: safeString(step.class, SAFE_ATOM, `${path}.class`),
    status: safeString(step.status, SAFE_ATOM, `${path}.status`),
  };
  if (step.prior_minutes !== undefined) {
    if (!Number.isFinite(step.prior_minutes) || step.prior_minutes < 0) {
      throw new TypeError(`${path}.prior_minutes must be non-negative`);
    }
    sanitized.prior_minutes = step.prior_minutes;
  }
  return sanitized;
}

function sanitizeData(event) {
  const data = plainRecord(event.data, 'event.data');
  if (event.kind === 'run_started') {
    exactKeys(data, new Set(['model_family', 'task_class']), 'event.data');
    const sanitized = {};
    if (data.model_family !== undefined) {
      sanitized.model_family = safeString(data.model_family, SAFE_ATOM, 'event.data.model_family');
    }
    if (data.task_class !== undefined) {
      sanitized.task_class = safeString(data.task_class, SAFE_ATOM, 'event.data.task_class');
    }
    return sanitized;
  }
  if (event.kind === 'plan_declared' || event.kind === 'plan_revised') {
    exactKeys(data, new Set(['revision', 'steps']), 'event.data');
    if (!Number.isInteger(data.revision) || data.revision < 1 || !Array.isArray(data.steps)) {
      throw new TypeError('live plan data requires a positive revision and steps array');
    }
    return {
      revision: data.revision,
      steps: data.steps.map((step, index) =>
        sanitizeStep(step, `event.data.steps[${index}]`, event.provider, event.run_id)),
    };
  }
  if (['step_started', 'step_completed', 'retry_started'].includes(event.kind)) {
    exactKeys(data, new Set(['step_id']), 'event.data');
    return {
      step_id: safeStepId(data.step_id, event.provider, event.run_id, 'event.data.step_id'),
    };
  }
  if (['needs_input', 'resumed', 'run_succeeded', 'run_failed', 'run_cancelled', 'heartbeat'].includes(event.kind)) {
    exactKeys(data, new Set(), 'event.data');
    return {};
  }
  throw new TypeError(`live adapter event kind ${event.kind} is not persistence-approved`);
}

/**
 * Convert adapter output to the only canonical subset allowed into SQLite.
 * This is deliberately stricter than the forward-compatible public contract:
 * free text, native IDs, filesystem paths and unknown fields fail closed.
 */
export function sanitizeLiveEvent(input) {
  const event = plainRecord(input, 'event');
  exactKeys(
    event,
    new Set([
      'schema_version',
      'event_id',
      'run_id',
      'provider',
      'native_session_id',
      'occurred_at',
      'observed_at',
      'kind',
      'source',
      'data',
    ]),
    'event',
  );
  if (!isKnownEventKind(event.kind)) {
    throw new TypeError(`unknown event kind ${String(event.kind)} cannot enter live persistence`);
  }
  const provider = safeString(event.provider, /^(?:codex|claude)$/, 'event.provider');
  const providerContract = PROVIDER_CONTRACT[provider];
  const eventId = safeString(event.event_id, providerContract.event, 'event.event_id');
  const runId = safeString(event.run_id, providerContract.run, 'event.run_id');
  const nativeSessionId = safeString(
    event.native_session_id,
    providerContract.session,
    'event.native_session_id',
  );

  const source = plainRecord(event.source, 'event.source');
  exactKeys(source, new Set(['adapter', 'mode', 'confidence']), 'event.source');
  if (source.adapter !== providerContract.adapter || source.mode !== providerContract.mode) {
    throw new TypeError('event.source does not match its approved provider adapter');
  }
  if (!Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) {
    throw new TypeError('event.source.confidence must be between 0 and 1');
  }

  const sanitized = {
    schema_version: event.schema_version,
    event_id: eventId,
    run_id: runId,
    provider,
    native_session_id: nativeSessionId,
    occurred_at: safeTimestamp(event.occurred_at, 'event.occurred_at'),
    observed_at: safeTimestamp(event.observed_at, 'event.observed_at'),
    kind: safeString(event.kind, SAFE_ATOM, 'event.kind'),
    source: {
      adapter: source.adapter,
      mode: source.mode,
      confidence: source.confidence,
    },
    data: sanitizeData(event),
  };
  assertValidEvent(sanitized);
  return sanitized;
}

function compareEvents(left, right) {
  const priority = {
    run_started: 0,
    plan_declared: 1,
    plan_revised: 2,
    step_started: 3,
    step_completed: 4,
    retry_started: 5,
    needs_input: 6,
    resumed: 7,
    run_succeeded: 9,
    run_failed: 9,
    run_cancelled: 9,
  };
  return Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || (priority[left.kind] ?? 8) - (priority[right.kind] ?? 8)
    || (Number(left.data?.revision ?? 0) - Number(right.data?.revision ?? 0))
    || left.event_id.localeCompare(right.event_id);
}

function semanticFingerprint(event) {
  const { observed_at: _observedAt, ...semantic } = event;
  return JSON.stringify(semantic);
}

function finalState(events) {
  let state = createRunState(events[0].run_id);
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

function learningEligible(state) {
  return state.status === 'succeeded'
    && state.provider === 'codex'
    && Number.isFinite(Date.parse(state.startedAt ?? ''))
    && Number.isFinite(Date.parse(state.finishedAt ?? ''))
    && Date.parse(state.finishedAt) > Date.parse(state.startedAt);
}

/**
 * Persist privacy-minimized canonical events and forecast snapshots.
 * Only successful Codex lifecycle runs are currently eligible for learning;
 * Claude remains coverage-only until its mutable session files have stable
 * turn segmentation/retraction semantics.
 */
function importLiveScansTransaction({ database, scans }) {
  if (!database || typeof database.insertEvent !== 'function') {
    throw new TypeError('database must be an AgentEtaDatabase');
  }
  if (!Array.isArray(scans)) throw new TypeError('scans must be an array');

  const sanitized = [];
  let scannedEvents = 0;
  const quarantine = {
    invalidOrUnsupported: 0,
    conflictingSourceEvent: 0,
    conflictingStoredEvent: 0,
  };
  for (const scan of scans) {
    if (!scan || !Array.isArray(scan.events)) continue;
    for (const event of scan.events) {
      scannedEvents += 1;
      try {
        sanitized.push(sanitizeLiveEvent(event));
      } catch {
        // Keep rejected input completely outside persistence. Aggregate counters
        // are enough to detect schema drift without retaining unsafe payloads.
        quarantine.invalidOrUnsupported += 1;
      }
    }
  }
  sanitized.sort(compareEvents);

  const uniqueEvents = new Map();
  for (const event of sanitized) {
    const previous = uniqueEvents.get(event.event_id);
    if (previous && semanticFingerprint(previous) !== semanticFingerprint(event)) {
      quarantine.conflictingSourceEvent += 1;
      continue;
    }
    if (!previous || Date.parse(event.observed_at) < Date.parse(previous.observed_at)) {
      uniqueEvents.set(event.event_id, event);
    }
  }

  const newEventIds = new Set();
  const touchedRunIds = new Set();
  let alreadyStoredEvents = 0;
  for (const event of uniqueEvents.values()) {
    if (database.insertEvent(event)) {
      newEventIds.add(event.event_id);
      touchedRunIds.add(event.run_id);
    } else {
      const stored = database.loadEvent(event.event_id);
      if (semanticFingerprint(stored) !== semanticFingerprint(event)) {
        quarantine.conflictingStoredEvent += 1;
        continue;
      }
      alreadyStoredEvents += 1;
    }
  }

  // Make terminal truth available before chronological forecasting so each
  // event can query every outcome that genuinely finished before it.
  for (const runId of touchedRunIds) {
    const events = database.listEvents(runId);
    if (events.length === 0) continue;
    const state = finalState(events);
    const lastEvent = events.at(-1);
    const isLearningEligible = learningEligible(state);
    database.saveRun(state, lastEvent, {
      isHistory: isLearningEligible,
      historySource: isLearningEligible ? 'live_adapter' : null,
    });
    database.savePlanSteps(state);
  }

  const states = new Map();
  const chronological = [...touchedRunIds]
    .flatMap((runId) => database.listEvents(runId))
    .sort(compareEvents);
  let savedForecasts = 0;
  for (const event of chronological) {
    const previous = states.get(event.run_id) ?? createRunState(event.run_id);
    const state = reduceEvent(previous, event);
    states.set(event.run_id, state);
    if (!newEventIds.has(event.event_id)) continue;

    const history = database.loadHistory({
      before: event.occurred_at,
      observedBefore: event.observed_at,
      source: 'live_adapter',
    });
    const rawForecast = forecastRun({
      state,
      history,
      now: new Date(event.occurred_at),
      seed: event.event_id,
    });
    const p80Calibration = estimateP80Calibration(
      database.listP80CalibrationObservations({
        before: event.occurred_at,
        source: 'live_adapter',
        mode: rawForecast.mode,
      }),
    );
    const forecast = calibrateForecastP80(rawForecast, p80Calibration);
    const display = makeDisplay(state, forecast, new Date(event.occurred_at));
    const isLearningEligible = learningEligible(state);
    database.saveRun(state, event, {
      isHistory: isLearningEligible,
      historySource: isLearningEligible ? 'live_adapter' : null,
    });
    database.savePlanSteps(state);
    database.saveForecast({
      runId: state.runId,
      eventId: event.event_id,
      observedAt: event.observed_at,
      forecast,
      display,
    });
    if (Number.isFinite(forecast.p50Minutes)) {
      database.setInitialForecast(state.runId, forecast.p50Minutes);
    }
    database.saveCalibration(
      `live/${state.provider ?? event.provider}/${state.modelFamily ?? 'unknown'}/${state.taskClass ?? 'other'}`,
      'personal_residual',
      Number(forecast.raw?.historyCount ?? 0),
      Number(forecast.personalMultiplier ?? 1),
      { eligible: Boolean(forecast.raw?.personalizationEligible) },
      'live_adapter',
    );
    database.saveCalibration(
      `live/${state.provider ?? event.provider}/${rawForecast.mode}`,
      'p80_upper_multiplier',
      p80Calibration.sampleCount,
      p80Calibration.multiplier,
      {
        targetCoverage: p80Calibration.targetCoverage,
        minimumSamples: p80Calibration.minimumSamples,
        eligible: p80Calibration.eligible,
        rawQuantileMultiplier: p80Calibration.rawQuantileMultiplier,
        shrinkage: p80Calibration.shrinkage,
        observedRawCoverage: p80Calibration.observedRawCoverage,
        observedCalibratedCoverage: p80Calibration.observedCalibratedCoverage,
        samplingUnit: 'run_first_forecast',
        historyRule: 'finished_at_strictly_before_forecast_event',
      },
      'live_adapter',
    );
    savedForecasts += 1;
  }

  let terminalOutcomes = 0;
  let learningOutcomes = 0;
  for (const runId of touchedRunIds) {
    const state = states.get(runId) ?? finalState(database.listEvents(runId));
    if (TERMINAL.has(state.status)) terminalOutcomes += 1;
    if (learningEligible(state)) learningOutcomes += 1;
  }
  const reporterReconciliation = reconcileReporterObservations(database, touchedRunIds);
  return {
    simulated: false,
    liveReadOnly: true,
    scannedEvents,
    acceptedEvents:
      scannedEvents - Object.values(quarantine).reduce((sum, count) => sum + count, 0),
    quarantinedEvents: Object.values(quarantine).reduce((sum, count) => sum + count, 0),
    quarantine,
    uniqueScannedEvents: uniqueEvents.size,
    uniqueScannedRuns: new Set([...uniqueEvents.values()].map((event) => event.run_id)).size,
    sourceDuplicateEvents:
      sanitized.length - uniqueEvents.size - quarantine.conflictingSourceEvent,
    insertedEvents: newEventIds.size,
    alreadyStoredEvents,
    duplicateEvents:
      sanitized.length - uniqueEvents.size - quarantine.conflictingSourceEvent + alreadyStoredEvents,
    touchedRuns: touchedRunIds.size,
    savedForecasts,
    terminalOutcomes,
    learningOutcomes,
    reconciledReporterObservations: reporterReconciliation.observations,
    reconciledReporterForecasts: reporterReconciliation.savedForecasts,
    persistedEvents: database.countEventsByAdapter('codex-jsonl'),
    persistedLearningOutcomes: database.countHistory('live_adapter'),
    claudeImportPolicy: 'coverage_only_until_stable_turn_segmentation',
  };
}

/**
 * Import is atomic across raw events, reducer state, forecasts and calibration.
 * A retry after an exception must see none of the failed attempt, otherwise a
 * durable event_id could suppress the forecast it was meant to produce.
 */
export function importLiveScans({
  database,
  scans,
  receivedAt = new Date().toISOString(),
  goalPilotMode = 'backfill',
  goalPilotLiveSinceAt = null,
}) {
  if (!database || typeof database.transaction !== 'function') {
    throw new TypeError('database must be an AgentEtaDatabase');
  }
  return database.transaction(() => {
    const live = importLiveScansTransaction({ database, scans });
    const goalPilot = reconcileCodexGoalPilot(database, scans, {
      receivedAt,
      ingestMode: goalPilotMode,
      liveSinceAt: goalPilotLiveSinceAt,
    });
    return {
      ...live,
      insertedRunEvents: live.insertedEvents,
      savedRunForecasts: live.savedForecasts,
      insertedEvents: live.insertedEvents + goalPilot.insertedWorksetEvents,
      savedForecasts: live.savedForecasts + goalPilot.savedWorksetForecasts,
      goalPilot,
    };
  });
}
