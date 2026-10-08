import { createHash } from 'node:crypto';

import { ingestWorksetEvent, WorksetIngestError } from '../scopes/ingest.js';

const GOAL_ID = /^codex-goal-[a-f0-9]{20}$/;
const GOAL_EVENT_ID = /^codex-goal-event-[a-f0-9]{20}$/;
const RUN_ID = /^codex-run-[a-f0-9]{20}$/;
const GOAL_KINDS = new Set(['goal_active', 'goal_blocked', 'goal_completed']);
const INGEST_MODES = new Set(['backfill', 'live']);
const QUARANTINE_WORKSET_CODES = new Set([
  'WORKSET_EVENT_CONFLICT',
  'WORKSET_EVENT_OUT_OF_ORDER',
  'WORKSET_REVISION_MEMBERS_CONFLICT',
  'WORKSET_STATE_EVENT_MISMATCH',
  'WORKSET_SOURCE_CONFLICT',
  'WORKSET_SOURCE_STATUS_CONFLICT',
  'WORKSET_TERMINAL_IMMUTABLE',
]);
const SOURCE = Object.freeze({
  provider: 'codex',
  sourceKind: 'codex_goal_shadow',
  sourceStatus: 'verified_structural',
  taskClass: 'other',
  eligibleLargeTask: null,
});

function alias(prefix, ...parts) {
  const hash = createHash('sha256');
  hash.update('agenteta.codex-goal-shadow/1');
  for (const part of parts) {
    hash.update('\0');
    hash.update(String(part));
  }
  return `${prefix}-${hash.digest('hex').slice(0, 20)}`;
}

export function taskWorksetIdForGoal(goalId) {
  if (typeof goalId !== 'string' || !GOAL_ID.test(goalId)) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_GOAL_ID');
  }
  return alias('task-workset', goalId);
}

function worksetEventId(goalEventId, suffix = 'primary') {
  return alias('workset-event', goalEventId, suffix);
}

function memberId(goalId, runId) {
  return alias('workset-member', goalId, runId);
}

function timestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_TIMESTAMP');
  }
  return new Date(value).toISOString();
}

function safeGoalEvent(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_EVENT');
  }
  const allowed = new Set([
    'eventId', 'goalId', 'runId', 'occurredAt', 'kind', 'status', 'sourceTool',
  ]);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.size || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_EVENT_FIELDS');
  }
  if (!GOAL_EVENT_ID.test(input.eventId ?? '')) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_EVENT_ID');
  }
  if (!GOAL_ID.test(input.goalId ?? '') || !RUN_ID.test(input.runId ?? '')) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_IDENTITY');
  }
  if (!GOAL_KINDS.has(input.kind)) throw new TypeError('CODEX_GOAL_SHADOW_INVALID_KIND');
  const expectedStatus = ({
    goal_active: 'active',
    goal_blocked: 'blocked',
    goal_completed: 'complete',
  })[input.kind];
  if (input.status !== expectedStatus) throw new TypeError('CODEX_GOAL_SHADOW_STATUS_MISMATCH');
  if (!['get_goal', 'create_goal', 'update_goal'].includes(input.sourceTool)) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_SOURCE_TOOL');
  }
  return Object.freeze({
    eventId: input.eventId,
    goalId: input.goalId,
    runId: input.runId,
    occurredAt: timestamp(input.occurredAt),
    kind: input.kind,
    status: input.status,
    sourceTool: input.sourceTool,
  });
}

function fingerprint(event) {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function recordReceipt(database, event, receivedAt, ingestMode) {
  if (!INGEST_MODES.has(ingestMode)) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_INGEST_MODE');
  }
  const digest = fingerprint(event);
  const existing = database.db.prepare(`
    SELECT * FROM codex_goal_receipts WHERE receipt_id = ?
  `).get(event.eventId);
  if (existing) {
    database.db.prepare(`
      UPDATE codex_goal_receipts
      SET last_received_at = CASE
            WHEN julianday(?) > julianday(last_received_at) THEN ?
            ELSE last_received_at
          END,
          quarantined = CASE WHEN fingerprint <> ? THEN 1 ELSE quarantined END
      WHERE receipt_id = ?
    `).run(receivedAt, receivedAt, digest, event.eventId);
    return {
      conflict: existing.fingerprint !== digest,
      existingGoalId: existing.goal_id,
      applied: Boolean(existing.applied),
      censored: Boolean(existing.censored),
      quarantined: Boolean(existing.quarantined) || existing.fingerprint !== digest,
      firstIngestMode: existing.first_ingest_mode,
    };
  }
  database.db.prepare(`
    INSERT INTO codex_goal_receipts(
      receipt_id, goal_id, run_id, occurred_at, first_received_at,
      last_received_at, first_ingest_mode, kind, fingerprint, workset_id, applied,
      censored, quarantined
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0)
  `).run(
    event.eventId,
    event.goalId,
    event.runId,
    event.occurredAt,
    receivedAt,
    receivedAt,
    ingestMode,
    event.kind,
    digest,
  );
  return {
    conflict: false,
    existingGoalId: event.goalId,
    applied: false,
    censored: false,
    quarantined: false,
    firstIngestMode: ingestMode,
  };
}

function receiptIngestMode(event, configuredMode, liveSinceMs) {
  if (configuredMode === 'backfill') return 'backfill';
  if (liveSinceMs === null) return 'live';
  return Date.parse(event.occurredAt) >= liveSinceMs ? 'live' : 'backfill';
}

function markReceipt(database, eventId, {
  worksetId = null,
  applied = false,
  censored = false,
  quarantined = false,
} = {}) {
  database.db.prepare(`
    UPDATE codex_goal_receipts
    SET workset_id = COALESCE(workset_id, ?),
        applied = CASE WHEN ? THEN 1 ELSE applied END,
        censored = CASE WHEN ? THEN 1 ELSE censored END,
        quarantined = CASE WHEN ? THEN 1 ELSE quarantined END
    WHERE receipt_id = ?
  `).run(
    worksetId,
    applied ? 1 : 0,
    censored ? 1 : 0,
    quarantined ? 1 : 0,
    eventId,
  );
}

function payload({ eventId, worksetId, occurredAt, kind, data }) {
  return {
    schema_version: 'agenteta.workset-event/1',
    event_id: eventId,
    workset_id: worksetId,
    workset_type: 'task',
    occurred_at: occurredAt,
    kind,
    data,
  };
}

function revisionMembers(workset, goalId, runId, occurredAt) {
  const existing = workset?.members ?? [];
  if (existing.some((member) => member.childId === runId && member.detachedAt === null)) {
    return null;
  }
  return [
    ...existing.map((member) => ({
      member_id: member.memberId,
      child_type: member.childType,
      child_id: member.childId,
      order_index: member.orderIndex,
      execution_group: member.executionGroup,
      attached_at: member.attachedAt,
      detached_at: member.detachedAt,
    })),
    {
      member_id: memberId(goalId, runId),
      child_type: 'run',
      child_id: runId,
      order_index: existing.length,
      execution_group: null,
      attached_at: occurredAt,
      detached_at: null,
    },
  ];
}

function ensureCodexRun(database, runId) {
  const run = database.loadRun(runId);
  return run?.provider === 'codex' ? run : null;
}

function quarantine(database, goalId, receivedAt) {
  database.saveCodexGoalQuarantine(goalId, { receivedAt });
  const worksetId = taskWorksetIdForGoal(goalId);
  if (!database.loadWorkset(worksetId)) return false;
  if (database.loadWorksetSource(worksetId)?.sourceStatus === 'quarantined') return false;
  database.saveWorksetSource(worksetId, { ...SOURCE, sourceStatus: 'quarantined' }, { receivedAt });
  return true;
}

function ingest(database, input, receivedAt) {
  return ingestWorksetEvent(database, input, { receivedAt, source: SOURCE });
}

function applyGoalEvent(database, event, receivedAt) {
  const worksetId = taskWorksetIdForGoal(event.goalId);
  let workset = database.loadWorkset(worksetId);
  if (!ensureCodexRun(database, event.runId)) return { deferred: true, inserted: 0 };

  const members = revisionMembers(workset, event.goalId, event.runId, event.occurredAt);
  let inserted = 0;
  if (workset === null) {
    // A completion first seen only during backfill has no causal start
    // landmark and therefore cannot become a measured task outcome.
    if (event.kind === 'goal_completed') return { terminalWithoutStart: true, inserted: 0 };
    const declared = payload({
      eventId: worksetEventId(event.eventId),
      worksetId,
      occurredAt: event.occurredAt,
      kind: 'workset_declared',
      data: { revision: 1, workset_closed: false, members },
    });
    if (ingest(database, declared, receivedAt).inserted) inserted += 1;
    workset = database.loadWorkset(worksetId);
    if (event.kind === 'goal_blocked') {
      const blocked = payload({
        eventId: worksetEventId(event.eventId, 'blocked'),
        worksetId,
        occurredAt: event.occurredAt,
        kind: 'workset_status_changed',
        data: { status: 'blocked' },
      });
      if (ingest(database, blocked, receivedAt).inserted) inserted += 1;
    }
    return { inserted };
  }

  if (workset.ownerTerminal) return { inserted: 0 };
  let primaryKind;
  let primaryData;
  if (members !== null) {
    primaryKind = 'workset_revised';
    primaryData = {
      revision: workset.revision + 1,
      workset_closed: false,
      members,
    };
  } else if (event.kind === 'goal_completed') {
    primaryKind = 'workset_succeeded';
    primaryData = {};
  } else if (event.kind === 'goal_blocked') {
    primaryKind = workset.status === 'blocked' ? 'workset_heartbeat' : 'workset_status_changed';
    primaryData = primaryKind === 'workset_status_changed' ? { status: 'blocked' } : {};
  } else if (workset.status !== 'running') {
    primaryKind = 'workset_status_changed';
    primaryData = { status: 'running' };
  } else {
    primaryKind = 'workset_heartbeat';
    primaryData = {};
  }
  const primary = payload({
    eventId: worksetEventId(event.eventId),
    worksetId,
    occurredAt: event.occurredAt,
    kind: primaryKind,
    data: primaryData,
  });
  if (ingest(database, primary, receivedAt).inserted) inserted += 1;

  // A new turn can both expand the member set and resume a blocked goal.
  if (members !== null && event.kind === 'goal_active' && workset.status !== 'running') {
    const resumed = payload({
      eventId: worksetEventId(event.eventId, 'resume'),
      worksetId,
      occurredAt: event.occurredAt,
      kind: 'workset_status_changed',
      data: { status: 'running' },
    });
    if (ingest(database, resumed, receivedAt).inserted) inserted += 1;
  } else if (members !== null && event.kind === 'goal_blocked') {
    const blocked = payload({
      eventId: worksetEventId(event.eventId, 'blocked'),
      worksetId,
      occurredAt: event.occurredAt,
      kind: 'workset_status_changed',
      data: { status: 'blocked' },
    });
    if (ingest(database, blocked, receivedAt).inserted) inserted += 1;
  } else if (members !== null && event.kind === 'goal_completed') {
    const terminal = payload({
      eventId: worksetEventId(event.eventId, 'terminal'),
      worksetId,
      occurredAt: event.occurredAt,
      kind: 'workset_succeeded',
      data: {},
    });
    if (ingest(database, terminal, receivedAt).inserted) inserted += 1;
  }
  return { inserted };
}

/**
 * Materialize structurally verified Codex Goal receipts into open task scopes.
 * Goal scopes never create projects. The workset remains open while active so
 * an observed current run cannot masquerade as all future task work.
 */
export function reconcileCodexGoalPilot(database, scans, {
  receivedAt = new Date().toISOString(),
  ingestMode = 'backfill',
  liveSinceAt = null,
} = {}) {
  const received = timestamp(receivedAt);
  if (!INGEST_MODES.has(ingestMode)) {
    throw new TypeError('CODEX_GOAL_SHADOW_INVALID_INGEST_MODE');
  }
  const liveSince = liveSinceAt === null ? null : timestamp(liveSinceAt);
  const liveSinceMs = liveSince === null ? null : Date.parse(liveSince);
  const merged = new Map();
  const gapSignals = new Map();
  const censorSignals = new Map();
  const conflictedGoalIds = new Set();
  const quarantinedGoalIds = new Set();
  let scanErrors = 0;
  let absentGoalReceipts = 0;
  for (const scan of scans ?? []) {
    const pilot = scan?.goalPilot;
    if (!pilot) continue;
    scanErrors += Array.isArray(pilot.errorCodes) ? pilot.errorCodes.length : 0;
    for (const goalId of pilot.quarantinedGoalIds ?? []) {
      if (GOAL_ID.test(goalId)) quarantinedGoalIds.add(goalId);
    }
    for (const projection of pilot.projections ?? []) {
      for (const rawEvent of projection.events ?? []) {
        if (rawEvent?.kind === 'goal_absent' && rawEvent?.goalId === null) {
          absentGoalReceipts += 1;
          continue;
        }
        const event = safeGoalEvent(rawEvent);
        const previous = merged.get(event.eventId);
        if (previous && fingerprint(previous) !== fingerprint(event)) {
          conflictedGoalIds.add(previous.goalId);
          conflictedGoalIds.add(event.goalId);
          merged.delete(event.eventId);
        } else if (!previous) {
          merged.set(event.eventId, event);
        }
      }
      const absent = (projection.events ?? [])
        .filter((event) => event.kind === 'goal_absent' && event.goalId === null)
        .toSorted((left, right) =>
          Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
          || right.eventId.localeCompare(left.eventId))[0];
      if (absent) {
        for (const goal of (projection.goals ?? []).filter((candidate) => candidate.status === 'absent')) {
          if (!GOAL_ID.test(goal.goalId ?? '') || !RUN_ID.test(absent.runId ?? '')) continue;
          const eventId = alias('codex-goal-event', absent.eventId, goal.goalId, 'censored');
          censorSignals.set(eventId, {
            eventId,
            goalId: goal.goalId,
            runId: absent.runId,
            occurredAt: timestamp(absent.occurredAt),
            kind: 'goal_absent',
            status: 'absent',
            sourceTool: 'get_goal',
          });
        }
      }
      if (projection.activeGoalCount === 1 && projection.activeRunCount === 0) {
        const [activeGoal] = (projection.goals ?? []).filter((goal) => goal.status === 'active');
        if (activeGoal && GOAL_ID.test(activeGoal.goalId ?? '')) {
          const knownRuns = new Set((projection.events ?? [])
            .filter((event) => event.goalId === activeGoal.goalId && RUN_ID.test(event.runId ?? ''))
            .map((event) => event.runId));
          const terminal = (scan.events ?? [])
            .filter((event) =>
              knownRuns.has(event.run_id)
              && ['run_succeeded', 'run_failed', 'run_cancelled'].includes(event.kind))
            .toSorted((left, right) =>
              Date.parse(right.observed_at) - Date.parse(left.observed_at)
              || right.event_id.localeCompare(left.event_id))[0];
          if (terminal && Date.parse(terminal.observed_at) >= Date.parse(activeGoal.lastObservedAt)) {
            const eventId = alias('workset-event', activeGoal.goalId, terminal.event_id, 'turn-gap');
            gapSignals.set(eventId, {
              eventId,
              goalId: activeGoal.goalId,
              occurredAt: timestamp(terminal.observed_at),
            });
          }
        }
      }
    }
  }
  for (const goalId of conflictedGoalIds) quarantinedGoalIds.add(goalId);
  const receivedMs = Date.parse(received);
  const receiptCausalityGoalIds = new Set();
  for (const event of merged.values()) {
    if (Date.parse(event.occurredAt) > receivedMs) receiptCausalityGoalIds.add(event.goalId);
  }
  for (const signal of [...gapSignals.values(), ...censorSignals.values()]) {
    if (Date.parse(signal.occurredAt) > receivedMs) receiptCausalityGoalIds.add(signal.goalId);
  }
  for (const goalId of receiptCausalityGoalIds) quarantinedGoalIds.add(goalId);
  const observedGoalIds = new Set([
    ...quarantinedGoalIds,
    ...[...merged.values()].map((event) => event.goalId),
    ...[...gapSignals.values()].map((signal) => signal.goalId),
    ...[...censorSignals.values()].map((signal) => signal.goalId),
  ]);
  for (const goalId of observedGoalIds) {
    if (database.loadCodexGoalQuarantine(goalId)) quarantinedGoalIds.add(goalId);
  }

  let quarantinedTasks = 0;
  for (const goalId of quarantinedGoalIds) {
    if (quarantine(database, goalId, received)) quarantinedTasks += 1;
  }

  let insertedWorksetEvents = 0;
  let liveGoalReceipts = 0;
  let backfillGoalReceipts = 0;
  let deferredReceipts = 0;
  let terminalWithoutStart = 0;
  let rejectedReceipts = new Set([
    ...conflictedGoalIds,
    ...receiptCausalityGoalIds,
  ]).size;
  const ordered = [...merged.values()].toSorted((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.eventId.localeCompare(right.eventId));
  for (const event of ordered) {
    if (conflictedGoalIds.has(event.goalId) || quarantinedGoalIds.has(event.goalId)) continue;
    const receipt = recordReceipt(
      database,
      event,
      received,
      receiptIngestMode(event, ingestMode, liveSinceMs),
    );
    if (receipt.firstIngestMode === 'live') liveGoalReceipts += 1;
    else backfillGoalReceipts += 1;
    if (receipt.conflict) {
      quarantinedGoalIds.add(receipt.existingGoalId);
      quarantinedGoalIds.add(event.goalId);
      if (quarantine(database, receipt.existingGoalId, received)) quarantinedTasks += 1;
      if (event.goalId !== receipt.existingGoalId && quarantine(database, event.goalId, received)) {
        quarantinedTasks += 1;
      }
      rejectedReceipts += 1;
      continue;
    }
    if (receipt.quarantined || receipt.applied || receipt.censored) continue;
    try {
      const applied = applyGoalEvent(database, event, received);
      insertedWorksetEvents += applied.inserted ?? 0;
      if (applied.deferred) {
        deferredReceipts += 1;
      } else if (applied.terminalWithoutStart) {
        terminalWithoutStart += 1;
        markReceipt(database, event.eventId, { censored: true });
      } else {
        markReceipt(database, event.eventId, {
          worksetId: taskWorksetIdForGoal(event.goalId),
          applied: true,
        });
      }
    } catch (error) {
      if (!(error instanceof WorksetIngestError)) throw error;
      if (!QUARANTINE_WORKSET_CODES.has(error.code)) throw error;
      if (quarantine(database, event.goalId, received)) quarantinedTasks += 1;
      markReceipt(database, event.eventId, { quarantined: true });
      rejectedReceipts += 1;
    }
  }
  let pausedTurnGaps = 0;
  for (const gap of [...gapSignals.values()].toSorted((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.eventId.localeCompare(right.eventId))) {
    if (quarantinedGoalIds.has(gap.goalId)) continue;
    const worksetId = taskWorksetIdForGoal(gap.goalId);
    const workset = database.loadWorkset(worksetId);
    if (!workset || workset.ownerTerminal || workset.status !== 'running') continue;
    try {
      const result = ingest(database, payload({
        eventId: gap.eventId,
        worksetId,
        occurredAt: gap.occurredAt,
        kind: 'workset_status_changed',
        data: { status: 'paused' },
      }), received);
      if (result.inserted) {
        insertedWorksetEvents += 1;
        pausedTurnGaps += 1;
      }
    } catch (error) {
      if (!(error instanceof WorksetIngestError)) throw error;
      if (!QUARANTINE_WORKSET_CODES.has(error.code)) throw error;
      if (quarantine(database, gap.goalId, received)) quarantinedTasks += 1;
      rejectedReceipts += 1;
    }
  }
  let censoredGoals = 0;
  for (const signal of [...censorSignals.values()].toSorted((left, right) =>
    Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || left.eventId.localeCompare(right.eventId))) {
    if (quarantinedGoalIds.has(signal.goalId)) continue;
    const receipt = recordReceipt(
      database,
      signal,
      received,
      receiptIngestMode(signal, ingestMode, liveSinceMs),
    );
    if (receipt.firstIngestMode === 'live') liveGoalReceipts += 1;
    else backfillGoalReceipts += 1;
    if (receipt.conflict || receipt.quarantined) {
      if (quarantine(database, receipt.existingGoalId, received)) quarantinedTasks += 1;
      markReceipt(database, signal.eventId, { quarantined: true });
      rejectedReceipts += 1;
      continue;
    }
    if (receipt.censored) continue;
    const worksetId = taskWorksetIdForGoal(signal.goalId);
    const workset = database.loadWorkset(worksetId);
    if (workset && !workset.ownerTerminal && workset.status !== 'paused') {
      try {
        const result = ingest(database, payload({
          eventId: worksetEventId(signal.eventId, 'censored'),
          worksetId,
          occurredAt: signal.occurredAt,
          kind: 'workset_status_changed',
          data: { status: 'paused' },
        }), received);
        if (result.inserted) insertedWorksetEvents += 1;
      } catch (error) {
        if (!(error instanceof WorksetIngestError)) throw error;
        if (!QUARANTINE_WORKSET_CODES.has(error.code)) throw error;
        if (quarantine(database, signal.goalId, received)) quarantinedTasks += 1;
        markReceipt(database, signal.eventId, { quarantined: true });
        rejectedReceipts += 1;
        continue;
      }
    }
    markReceipt(database, signal.eventId, {
      worksetId: workset ? worksetId : null,
      censored: true,
    });
    censoredGoals += 1;
  }
  return Object.freeze({
    scannedGoalReceipts: ordered.length,
    liveGoalReceipts,
    backfillGoalReceipts,
    absentGoalReceipts,
    insertedWorksetEvents,
    savedWorksetForecasts: insertedWorksetEvents,
    deferredReceipts,
    terminalWithoutStart,
    rejectedReceipts,
    scanErrors,
    quarantinedTasks,
    pausedTurnGaps,
    censoredGoals,
  });
}
