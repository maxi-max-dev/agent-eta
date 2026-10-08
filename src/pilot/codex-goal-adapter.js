import { createHash } from 'node:crypto';

import {
  codexRunAlias,
  codexSessionAlias,
} from '../adapters/codex.js';

export const CODEX_GOAL_PILOT_ERRORS = Object.freeze({
  threadRequired: 'CODEX_GOAL_PILOT_THREAD_REQUIRED',
  invalidBranches: 'CODEX_GOAL_PILOT_INVALID_BRANCHES',
  sessionNotFound: 'CODEX_GOAL_PILOT_SESSION_NOT_FOUND',
  multipleSessionAliases: 'CODEX_GOAL_PILOT_MULTIPLE_SESSION_ALIASES',
  invalidSessionMeta: 'CODEX_GOAL_PILOT_INVALID_SESSION_META',
  malformedBranch: 'CODEX_GOAL_PILOT_MALFORMED_BRANCH',
  causalityViolation: 'CODEX_GOAL_PILOT_CAUSALITY_VIOLATION',
  lifecycleConflict: 'CODEX_GOAL_PILOT_LIFECYCLE_CONFLICT',
  goalIdentityConflict: 'CODEX_GOAL_PILOT_GOAL_IDENTITY_CONFLICT',
  branchConflict: 'CODEX_GOAL_PILOT_BRANCH_CONFLICT',
  stateConflict: 'CODEX_GOAL_PILOT_STATE_CONFLICT',
  goalBlocked: 'CODEX_GOAL_PILOT_BLOCKED',
  noActiveGoal: 'CODEX_GOAL_PILOT_NO_ACTIVE_GOAL',
  multipleActiveGoals: 'CODEX_GOAL_PILOT_MULTIPLE_ACTIVE_GOALS',
  noActiveRun: 'CODEX_GOAL_PILOT_NO_ACTIVE_RUN',
  multipleActiveRuns: 'CODEX_GOAL_PILOT_MULTIPLE_ACTIVE_RUNS',
});

const GOAL_TOOLS = new Set(['create_goal', 'get_goal', 'update_goal']);
const GOAL_STATUSES = new Set(['active', 'complete', 'blocked']);
const UPDATE_GOAL_STATUSES = new Set(['complete', 'blocked']);
const TERMINAL_GOAL_STATUSES = new Set(['complete']);
const TERMINAL_RUN_KINDS = new Set(['task_complete', 'turn_aborted']);
const GOAL_ALIAS = /^codex-goal-[0-9a-f]{20}$/;
const CONFIRMED_GOAL_IDS_BY_ERROR = new WeakMap();

function safeConfirmedGoalIds(values) {
  return Object.freeze(
    [...new Set(values ?? [])]
      .filter((value) => typeof value === 'string' && GOAL_ALIAS.test(value))
      .toSorted(),
  );
}

function fail(code, confirmedGoalIds = []) {
  const error = new Error(code);
  CONFIRMED_GOAL_IDS_BY_ERROR.set(error, safeConfirmedGoalIds(confirmedGoalIds));
  throw error;
}

/**
 * Recover only irreversible goal aliases that were structurally confirmed
 * before a parser failure. The WeakMap boundary means callers cannot forge
 * aliases by attaching fields to an arbitrary Error, and JSON serialization
 * cannot expose hidden parser state.
 */
export function confirmedCodexGoalIdsFromError(error) {
  return CONFIRMED_GOAL_IDS_BY_ERROR.get(error) ?? Object.freeze([]);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function epochToMilliseconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  return timestampToIso(milliseconds) === null ? null : milliseconds;
}

function timestampToIso(value) {
  let milliseconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableAlias(prefix, ...parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(part));
    hash.update('\0');
  }
  return `${prefix}-${hash.digest('hex').slice(0, 20)}`;
}

function exactJsonObject(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recordsFromBranch(branch) {
  if (typeof branch === 'string') {
    const records = [];
    const lines = branch.split(/\r?\n/);
    const hasTerminatingNewline = /(?:\r?\n)$/.test(branch);
    const lineCount = hasTerminatingNewline ? lines.length - 1 : lines.length;
    let ignoredTailPartialRecords = 0;
    for (let index = 0; index < lineCount; index += 1) {
      const line = lines[index];
      if (line.trim() === '') fail(CODEX_GOAL_PILOT_ERRORS.malformedBranch);
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        const isUnterminatedTail = !hasTerminatingNewline && index === lineCount - 1;
        if (!isUnterminatedTail) fail(CODEX_GOAL_PILOT_ERRORS.malformedBranch);
        // The sole recoverable syntax case is a final unterminated record seen
        // while Codex is appending. A terminated or interior bad line poisons
        // the whole branch instead of silently skipping evidence.
        ignoredTailPartialRecords += 1;
        continue;
      }
      if (!isRecord(record)) fail(CODEX_GOAL_PILOT_ERRORS.malformedBranch);
      records.push(record);
    }
    return {
      records,
      malformedLines: ignoredTailPartialRecords,
      ignoredTailPartialRecords,
    };
  }
  if (Array.isArray(branch) && branch.every(isRecord)) {
    return { records: branch, malformedLines: 0, ignoredTailPartialRecords: 0 };
  }
  fail(CODEX_GOAL_PILOT_ERRORS.invalidBranches);
}

function observationKind(status) {
  if (status === 'active') return 'goal_active';
  if (status === 'complete') return 'goal_completed';
  return 'goal_blocked';
}

function confirmedGoalIdsFromObservations(observations) {
  return [...observations]
    .map((observation) => observation.goalId)
    .filter((goalId) => goalId !== null);
}

function validatedGoalConfirmation({
  call,
  confirmedGoalIds,
  output,
  outputTimestamp,
  sessionAlias,
  threadId,
}) {
  const parsedOutput = exactJsonObject(output);
  if (parsedOutput === null || !Object.hasOwn(parsedOutput, 'goal')) return null;

  if (call.tool === 'get_goal' && parsedOutput.goal === null) {
    if (call.activeTurns.length !== 1 || outputTimestamp === null) return null;
    return {
      observationId: stableAlias(
        'codex-goal-observation',
        threadId,
        sessionAlias,
        call.callId,
      ),
      goalId: null,
      runId: codexRunAlias(sessionAlias, call.activeTurns[0]),
      observedAt: outputTimestamp,
      updatedAt: null,
      status: 'absent',
      kind: 'goal_absent',
      sourceTool: 'get_goal',
    };
  }

  const goal = isRecord(parsedOutput.goal) ? parsedOutput.goal : null;
  if (goal === null || goal.threadId !== threadId) return null;
  const objective = nonEmptyString(goal.objective);
  const createdAt = epochToMilliseconds(goal.createdAt);
  const updatedAt = epochToMilliseconds(goal.updatedAt);
  if (
    objective === null
    || createdAt === null
    || updatedAt === null
    || !GOAL_STATUSES.has(goal.status)
    || call.activeTurns.length !== 1
    || outputTimestamp === null
  ) {
    return null;
  }
  const outputReceivedAt = Date.parse(outputTimestamp);
  if (createdAt > updatedAt || updatedAt > outputReceivedAt) {
    fail(CODEX_GOAL_PILOT_ERRORS.causalityViolation, confirmedGoalIds);
  }

  if (call.tool === 'create_goal' && goal.status !== 'active') return null;
  // Readback confirms only the active state (or explicit absence above).
  // Blocked and complete are owner transitions and require matching
  // update_goal arguments plus structured output; a readback alone cannot
  // invent a wait or terminal truth.
  if (call.tool === 'get_goal' && goal.status !== 'active') return null;
  if (call.tool === 'update_goal') {
    const argumentsObject = exactJsonObject(call.arguments);
    if (
      argumentsObject === null
      || !UPDATE_GOAL_STATUSES.has(argumentsObject.status)
      || argumentsObject.status !== goal.status
    ) {
      return null;
    }
  }

  const goalId = stableAlias('codex-goal', threadId, sessionAlias, createdAt);
  return {
    observationId: stableAlias(
      'codex-goal-observation',
      threadId,
      sessionAlias,
      call.callId,
    ),
    goalId,
    semanticFingerprint: stableAlias('codex-goal-semantic', threadId, objective),
    runId: codexRunAlias(sessionAlias, call.activeTurns[0]),
    observedAt: outputTimestamp,
    updatedAt,
    status: goal.status,
    kind: observationKind(goal.status),
    sourceTool: call.tool,
  };
}

function scanBranch(branch, { threadId }) {
  const { records, malformedLines, ignoredTailPartialRecords } = recordsFromBranch(branch);
  const activeTurns = new Set();
  const lifecycleByTurn = new Map();
  const startedRuns = new Set();
  const terminalRuns = new Set();
  const goalCallsById = new Map();
  const orphanOutputs = new Set();
  const observations = [];
  const sessionAliases = new Set();
  let currentSessionAlias = null;
  let currentNativeThreadId = null;
  let currentNativeSessionId = null;
  let matched = false;
  let goalCalls = 0;
  let pairedGoalOutputs = 0;
  let duplicateGoalReceipts = 0;
  let invalidGoalReceipts = 0;

  for (const record of records) {
    const payload = isRecord(record.payload) ? record.payload : null;
    if (record.type === 'session_meta') {
      const nextNativeThreadId = nonEmptyString(payload?.id);
      const nextNativeSessionId = nonEmptyString(payload?.session_id);
      if (
        nextNativeThreadId !== null
        && nextNativeThreadId === currentNativeThreadId
        && nextNativeSessionId !== null
        && nextNativeSessionId === currentNativeSessionId
      ) {
        // Repeated metadata for the same identity is not a scope switch.
        continue;
      }
      // An identity change starts a new segment. State from a root segment
      // must never bleed into a child segment, even when both expose the same
      // native session component.
      activeTurns.clear();
      lifecycleByTurn.clear();
      goalCallsById.clear();
      orphanOutputs.clear();
      currentSessionAlias = null;
      currentNativeThreadId = nextNativeThreadId;
      currentNativeSessionId = nextNativeSessionId;
      if (nextNativeThreadId !== threadId) continue;
      if (nextNativeSessionId === null) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.invalidSessionMeta,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      currentSessionAlias = codexSessionAlias(nextNativeSessionId);
      sessionAliases.add(currentSessionAlias);
      if (sessionAliases.size > 1) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.multipleSessionAliases,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      matched = true;
      continue;
    }
    if (currentSessionAlias === null) continue;

    if (record.type === 'event_msg' && payload?.type === 'task_started') {
      const turnId = nonEmptyString(payload.turn_id);
      const envelopeAt = timestampToIso(record.timestamp);
      const startedAt = Object.hasOwn(payload, 'started_at')
        ? timestampToIso(payload.started_at)
        : envelopeAt;
      if (
        turnId === null
        || envelopeAt === null
        || startedAt === null
        || Date.parse(startedAt) > Date.parse(envelopeAt)
      ) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.lifecycleConflict,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      const runId = codexRunAlias(currentSessionAlias, turnId);
      if (
        activeTurns.has(turnId)
        || startedRuns.has(runId)
        || terminalRuns.has(runId)
      ) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.lifecycleConflict,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      activeTurns.add(turnId);
      lifecycleByTurn.set(turnId, { startedAt });
      startedRuns.add(runId);
      continue;
    }
    if (record.type === 'event_msg' && TERMINAL_RUN_KINDS.has(payload?.type)) {
      const turnId = nonEmptyString(payload.turn_id);
      const envelopeAt = timestampToIso(record.timestamp);
      const terminalAt = Object.hasOwn(payload, 'completed_at')
        ? timestampToIso(payload.completed_at)
        : envelopeAt;
      const lifecycle = turnId === null ? null : lifecycleByTurn.get(turnId);
      if (
        turnId === null
        || envelopeAt === null
        || terminalAt === null
        || lifecycle === null
        || lifecycle === undefined
        || !activeTurns.has(turnId)
        || Date.parse(terminalAt) < Date.parse(lifecycle.startedAt)
        || Date.parse(terminalAt) > Date.parse(envelopeAt)
      ) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.lifecycleConflict,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      activeTurns.delete(turnId);
      lifecycleByTurn.delete(turnId);
      terminalRuns.add(codexRunAlias(currentSessionAlias, turnId));
      continue;
    }
    if (
      record.type === 'response_item'
      && payload?.type === 'function_call'
      && GOAL_TOOLS.has(payload.name)
    ) {
      goalCalls += 1;
      const callId = nonEmptyString(payload.call_id);
      const callAt = timestampToIso(record.timestamp);
      if (callId === null || callAt === null) {
        invalidGoalReceipts += 1;
        continue;
      }
      if (orphanOutputs.has(callId)) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.causalityViolation,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      if (goalCallsById.has(callId)) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.branchConflict,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      goalCallsById.set(callId, {
        callId,
        tool: payload.name,
        arguments: payload.arguments,
        callAt,
        activeTurns: [...activeTurns].toSorted(),
        receiptFingerprint: null,
      });
      continue;
    }
    if (
      record.type === 'response_item'
      && payload?.type === 'function_call_output'
    ) {
      const callId = nonEmptyString(payload.call_id);
      if (callId === null) continue;
      const call = goalCallsById.get(callId);
      if (call === undefined) {
        orphanOutputs.add(callId);
        continue;
      }
      const outputTimestamp = timestampToIso(record.timestamp);
      if (
        outputTimestamp === null
        || Date.parse(call.callAt) > Date.parse(outputTimestamp)
      ) {
        fail(
          CODEX_GOAL_PILOT_ERRORS.causalityViolation,
          confirmedGoalIdsFromObservations(observations),
        );
      }
      const receiptFingerprint = stableAlias(
        'codex-goal-receipt',
        call.tool,
        typeof payload.output,
        payload.output,
      );
      if (call.receiptFingerprint !== null) {
        if (call.receiptFingerprint !== receiptFingerprint) {
          fail(
            CODEX_GOAL_PILOT_ERRORS.branchConflict,
            confirmedGoalIdsFromObservations(observations),
          );
        }
        duplicateGoalReceipts += 1;
        continue;
      }
      call.receiptFingerprint = receiptFingerprint;
      pairedGoalOutputs += 1;
      const confirmation = validatedGoalConfirmation({
        call,
        confirmedGoalIds: confirmedGoalIdsFromObservations(observations),
        output: payload.output,
        outputTimestamp,
        sessionAlias: currentSessionAlias,
        threadId,
      });
      if (confirmation === null) invalidGoalReceipts += 1;
      else observations.push(confirmation);
    }
  }

  if (!matched) {
    return {
      matched: false,
      malformedLines,
      ignoredTailPartialRecords,
      goalCalls: 0,
      pairedGoalOutputs: 0,
      duplicateGoalReceipts: 0,
      invalidGoalReceipts: 0,
      activeRuns: [],
      terminalRuns: [],
      observations: [],
    };
  }

  const [sessionAlias] = sessionAliases;

  return {
    matched: true,
    sessionAlias,
    malformedLines,
    ignoredTailPartialRecords,
    goalCalls,
    pairedGoalOutputs,
    duplicateGoalReceipts,
    invalidGoalReceipts,
    activeRuns: currentSessionAlias === null
      ? []
      : [...activeTurns].map((turnId) => codexRunAlias(currentSessionAlias, turnId)),
    terminalRuns: [...terminalRuns],
    observations,
  };
}

function observationFingerprint(observation) {
  return JSON.stringify([
    observation.goalId,
    observation.runId,
    observation.observedAt,
    observation.updatedAt,
    observation.status,
    observation.kind,
    observation.sourceTool,
    observation.semanticFingerprint,
  ]);
}

function goalProjection(observations) {
  const stateByGoal = new Map();
  const runsByGoal = new Map();
  const semanticByGoal = new Map();
  let lastAbsentAt = null;

  for (const observation of observations) {
    if (observation.status === 'absent') {
      lastAbsentAt = observation.observedAt;
      for (const state of stateByGoal.values()) {
        if (state.status === 'active' || state.status === 'blocked') state.status = 'absent';
      }
      continue;
    }

    const previous = stateByGoal.get(observation.goalId) ?? null;
    const previousSemantic = semanticByGoal.get(observation.goalId) ?? null;
    if (
      previousSemantic !== null
      && previousSemantic !== observation.semanticFingerprint
    ) {
      fail(CODEX_GOAL_PILOT_ERRORS.goalIdentityConflict, stateByGoal.keys());
    }
    if (
      previous !== null
      && (
        (TERMINAL_GOAL_STATUSES.has(previous.status) && observation.status !== 'complete')
        || previous.status === 'absent'
        || observation.updatedAt < previous.updatedAt
      )
    ) {
      fail(CODEX_GOAL_PILOT_ERRORS.stateConflict, stateByGoal.keys());
    }
    semanticByGoal.set(observation.goalId, observation.semanticFingerprint);

    const firstObservedAt = previous?.firstObservedAt ?? observation.observedAt;
    stateByGoal.set(observation.goalId, {
      goalId: observation.goalId,
      status: observation.status,
      firstObservedAt,
      lastObservedAt: observation.observedAt,
      updatedAt: observation.updatedAt,
      latestObservationRunId: observation.runId,
    });
    const goalRuns = runsByGoal.get(observation.goalId) ?? new Set();
    goalRuns.add(observation.runId);
    runsByGoal.set(observation.goalId, goalRuns);
  }

  const goals = [...stateByGoal.values()]
    .map((goal) => ({
      ...goal,
      observedRunCount: runsByGoal.get(goal.goalId)?.size ?? 0,
    }))
    .toSorted((left, right) => left.goalId.localeCompare(right.goalId));

  return {
    goals,
    activeGoals: goals.filter((goal) => goal.status === 'active'),
    blockedGoals: goals.filter((goal) => goal.status === 'blocked'),
    lastAbsentAt,
  };
}

/**
 * Pure, privacy-minimized projection over already scoped Codex JSONL branches.
 *
 * Raw thread/session/turn/call identifiers are used only for equality checks
 * and irreversible aliases. Objective, prompt, message, command, code, path,
 * reasoning and tool-output prose are never returned. A bare create_goal call
 * is not evidence: active state needs a structured goal receipt (normally
 * get_goal), while terminal state needs a matching update_goal receipt.
 */
export function projectCodexGoalBranches({ branches, threadId } = {}) {
  if (nonEmptyString(threadId) === null) fail(CODEX_GOAL_PILOT_ERRORS.threadRequired);
  if (!Array.isArray(branches) || branches.length === 0) {
    fail(CODEX_GOAL_PILOT_ERRORS.invalidBranches);
  }

  const scans = [];
  for (const branch of branches) {
    try {
      scans.push(scanBranch(branch, { threadId }));
    } catch (error) {
      const code = error?.message;
      if (!Object.values(CODEX_GOAL_PILOT_ERRORS).includes(code)) throw error;
      fail(code, [
        ...scans.flatMap((scan) => confirmedGoalIdsFromObservations(scan.observations)),
        ...confirmedCodexGoalIdsFromError(error),
      ]);
    }
  }
  const matchedScans = scans.filter((scan) => scan.matched);
  if (matchedScans.length === 0) fail(CODEX_GOAL_PILOT_ERRORS.sessionNotFound);
  const sessionAliases = new Set(matchedScans.map((scan) => scan.sessionAlias));
  if (sessionAliases.size !== 1) {
    fail(
      CODEX_GOAL_PILOT_ERRORS.multipleSessionAliases,
      matchedScans.flatMap((scan) => confirmedGoalIdsFromObservations(scan.observations)),
    );
  }
  const [sessionId] = sessionAliases;

  const activeRuns = new Set(matchedScans.flatMap((scan) => scan.activeRuns));
  const terminalRuns = new Set(matchedScans.flatMap((scan) => scan.terminalRuns));
  const currentActiveRunIds = [...activeRuns]
    .filter((runId) => !terminalRuns.has(runId))
    .toSorted();

  const observationsById = new Map();
  let duplicateGoalObservations = 0;
  for (const observation of matchedScans.flatMap((scan) => scan.observations)) {
    const previous = observationsById.get(observation.observationId);
    if (previous === undefined) {
      observationsById.set(observation.observationId, observation);
      continue;
    }
    if (observationFingerprint(previous) !== observationFingerprint(observation)) {
      fail(
        CODEX_GOAL_PILOT_ERRORS.branchConflict,
        confirmedGoalIdsFromObservations([
          ...observationsById.values(),
          observation,
        ]),
      );
    }
    duplicateGoalObservations += 1;
  }

  const observations = [...observationsById.values()].toSorted(
    (left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.observationId.localeCompare(right.observationId),
  );
  const projected = goalProjection(observations);
  const events = observations.map((observation) => ({
    eventId: stableAlias('codex-goal-event', observation.observationId, observation.kind),
    goalId: observation.goalId,
    runId: observation.runId,
    occurredAt: observation.observedAt,
    kind: observation.kind,
    status: observation.status,
    sourceTool: observation.sourceTool,
  }));

  return {
    provider: 'codex',
    sessionId,
    goals: projected.goals,
    events,
    currentActiveRunIds,
    activeGoalCount: projected.activeGoals.length,
    blockedGoalCount: projected.blockedGoals.length,
    activeRunCount: currentActiveRunIds.length,
    lastAbsentAt: projected.lastAbsentAt,
    coverage: {
      branchCount: branches.length,
      matchedBranchCount: matchedScans.length,
      malformedLines: scans.reduce((sum, scan) => sum + scan.malformedLines, 0),
      ignoredTailPartialRecords: scans.reduce(
        (sum, scan) => sum + scan.ignoredTailPartialRecords,
        0,
      ),
      goalCalls: matchedScans.reduce((sum, scan) => sum + scan.goalCalls, 0),
      pairedGoalOutputs: matchedScans.reduce((sum, scan) => sum + scan.pairedGoalOutputs, 0),
      duplicateGoalReceipts: matchedScans.reduce(
        (sum, scan) => sum + scan.duplicateGoalReceipts,
        0,
      ),
      invalidGoalReceipts: matchedScans.reduce((sum, scan) => sum + scan.invalidGoalReceipts, 0),
      uniqueGoalObservations: observations.length,
      duplicateGoalObservations,
    },
  };
}

/**
 * Convenience boundary for the existing Codex adapter, which may already
 * hold parsed records. JSON syntax corruption is not representable after
 * parsing; callers must apply the string boundary first when that distinction
 * matters. No filesystem capability or transcript prose is added here.
 */
export function projectCodexGoalRecords({ records, threadId } = {}) {
  if (!Array.isArray(records) || !records.every(isRecord)) {
    fail(CODEX_GOAL_PILOT_ERRORS.invalidBranches);
  }
  return projectCodexGoalBranches({ branches: [records], threadId });
}

/**
 * Bind exactly one structurally confirmed active goal to exactly one current
 * canonical Codex run. There is deliberately no global/latest fallback.
 */
export function resolveActiveCodexGoal(options) {
  const projection = projectCodexGoalBranches(options);
  const activeGoals = projection.goals.filter((goal) => goal.status === 'active');
  const blockedGoals = projection.goals.filter((goal) => goal.status === 'blocked');
  if (activeGoals.length + blockedGoals.length > 1) {
    fail(CODEX_GOAL_PILOT_ERRORS.multipleActiveGoals);
  }
  if (activeGoals.length === 0 && blockedGoals.length === 1) {
    fail(CODEX_GOAL_PILOT_ERRORS.goalBlocked);
  }
  if (activeGoals.length === 0) fail(CODEX_GOAL_PILOT_ERRORS.noActiveGoal);
  if (activeGoals.length > 1) fail(CODEX_GOAL_PILOT_ERRORS.multipleActiveGoals);
  if (projection.currentActiveRunIds.length === 0) fail(CODEX_GOAL_PILOT_ERRORS.noActiveRun);
  if (projection.currentActiveRunIds.length > 1) {
    fail(CODEX_GOAL_PILOT_ERRORS.multipleActiveRuns);
  }

  const goal = activeGoals[0];
  const runId = projection.currentActiveRunIds[0];
  return {
    provider: 'codex',
    sessionId: projection.sessionId,
    goalId: goal.goalId,
    runId,
    status: 'active',
    lastObservedAt: goal.lastObservedAt,
    observedRunCount: goal.observedRunCount,
    continuedAcrossTurns:
      goal.observedRunCount > 1 || goal.latestObservationRunId !== runId,
  };
}
