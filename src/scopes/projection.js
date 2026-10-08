import { sanitizeWorksetEvent } from './contract.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const BLOCKING = new Set(['needs_input', 'waiting_provider', 'blocked', 'paused']);
const FORECASTABLE_CHILD = new Set(['running', 'scheduled']);
const UNKNOWN_CHILD = new Set(['pending', 'unknown', 'failed', 'cancelled']);

export function createWorksetState(worksetId, worksetType) {
  if (typeof worksetId !== 'string' || typeof worksetType !== 'string') {
    throw new TypeError('workset identity is required');
  }
  return {
    worksetId,
    worksetType,
    status: 'pending',
    revision: 0,
    worksetClosed: false,
    ownerTerminal: false,
    startedAt: null,
    finishedAt: null,
    activeElapsedMs: 0,
    activeSinceAt: null,
    lastOccurredAt: null,
    members: [],
    seenEventIds: [],
    lastEventId: null,
    reasonCode: 'awaiting_workset_declaration',
  };
}

function effectiveMilliseconds(state, occurredAt) {
  const current = Date.parse(occurredAt);
  const last = Date.parse(state.lastOccurredAt ?? occurredAt);
  return Math.max(current, last);
}

function advanceClock(state, milliseconds) {
  if (state.status === 'running' && state.activeSinceAt !== null) {
    state.activeElapsedMs += Math.max(0, milliseconds - Date.parse(state.activeSinceAt));
    state.activeSinceAt = new Date(milliseconds).toISOString();
  }
  state.lastOccurredAt = new Date(milliseconds).toISOString();
}

function changeStatus(state, status, milliseconds) {
  if (status === 'running') {
    if (state.status !== 'running') state.activeSinceAt = new Date(milliseconds).toISOString();
  } else {
    state.activeSinceAt = null;
  }
  state.status = status;
}

export function reduceWorksetEvent(previousState, input) {
  const event = sanitizeWorksetEvent(input);
  if (previousState.worksetId !== event.worksetId || previousState.worksetType !== event.worksetType) {
    throw new TypeError('WORKSET_EVENT_IDENTITY_MISMATCH');
  }
  if (previousState.seenEventIds.includes(event.eventId)) return previousState;

  const state = structuredClone(previousState);
  const milliseconds = effectiveMilliseconds(state, event.occurredAt);
  advanceClock(state, milliseconds);
  state.seenEventIds.push(event.eventId);
  state.lastEventId = event.eventId;
  if (state.ownerTerminal) return state;
  if (state.revision === 0 && event.kind !== 'workset_declared') {
    throw new TypeError('WORKSET_NOT_DECLARED');
  }

  if (event.kind === 'workset_declared') {
    if (state.revision !== 0) throw new TypeError('WORKSET_ALREADY_DECLARED');
    state.revision = 1;
    state.worksetClosed = event.data.worksetClosed;
    state.members = structuredClone(event.data.members);
    state.startedAt = event.occurredAt;
    changeStatus(state, 'running', milliseconds);
    state.reasonCode = state.worksetClosed ? 'workset_declared_closed' : 'workset_declared_open';
  } else if (event.kind === 'workset_revised') {
    if (event.data.revision !== state.revision + 1) {
      throw new TypeError('WORKSET_REVISION_MUST_INCREMENT');
    }
    state.revision = event.data.revision;
    state.worksetClosed = event.data.worksetClosed;
    state.members = structuredClone(event.data.members);
    state.reasonCode = 'workset_revised';
  } else if (event.kind === 'workset_status_changed') {
    changeStatus(state, event.data.status, milliseconds);
    state.reasonCode = `workset_status_${event.data.status}`;
  } else if (event.kind === 'workset_heartbeat') {
    state.reasonCode = 'workset_heartbeat';
  } else {
    const status = event.kind.slice('workset_'.length);
    changeStatus(state, status, milliseconds);
    state.ownerTerminal = true;
    state.finishedAt = new Date(milliseconds).toISOString();
    state.reasonCode = `owner_terminal_${status}`;
  }
  return state;
}

function unknown(reasonCode, state, extra = {}) {
  return Object.freeze({
    mode: 'workset_unknown',
    status: 'unknown',
    evidence: 'unavailable',
    lowerMinutes: null,
    p50Minutes: null,
    p80Minutes: null,
    upperMinutes: null,
    reasonCode,
    worksetRevision: state.revision,
    jointP80Claimed: false,
    raw: Object.freeze({ ...extra }),
  });
}

function numeric(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : null;
}

function sanitizeChildProjection(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('WORKSET_INVALID_CHILD_PROJECTION');
  }
  const allowed = new Set(['memberId', 'status', 'lowerMinutes', 'p50Minutes', 'p80Minutes']);
  const keys = Reflect.ownKeys(input);
  if (keys.length !== allowed.size || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('WORKSET_INVALID_CHILD_PROJECTION_FIELDS');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('WORKSET_CHILD_ACCESSOR_FIELD');
  }
  const status = String(input.status);
  const lower = numeric(input.lowerMinutes);
  const p50 = numeric(input.p50Minutes);
  const p80 = numeric(input.p80Minutes);
  if (status === 'succeeded') {
    return { memberId: input.memberId, status, lower: 0, p50: 0, p80: 0 };
  }
  if (FORECASTABLE_CHILD.has(status) || BLOCKING.has(status)) {
    if (lower === null || p50 === null || p80 === null || lower > p50 || p50 > p80) {
      throw new TypeError('WORKSET_INVALID_CHILD_RANGE');
    }
  }
  return { memberId: input.memberId, status, lower, p50, p80 };
}

function sanitizeParentSurvival(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('WORKSET_INVALID_PARENT_SURVIVAL');
  }
  const allowed = new Set(['lowerMinutes', 'p50Minutes', 'p80Minutes']);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('WORKSET_INVALID_PARENT_SURVIVAL_FIELDS');
  }
  const lower = numeric(value.lowerMinutes);
  const p50 = numeric(value.p50Minutes);
  const p80 = numeric(value.p80Minutes);
  if (lower === null || p50 === null || p80 === null || lower > p50 || p50 > p80) {
    throw new TypeError('WORKSET_INVALID_PARENT_SURVIVAL_RANGE');
  }
  return { lower, p50, p80 };
}

function blockingProjection(status, state, children, reasonCode) {
  const remaining = children.filter((child) => child.status !== 'succeeded');
  const lower = remaining.every((child) => child.lower !== null)
    ? remaining.reduce((sum, child) => sum + child.lower, 0)
    : null;
  const upper = remaining.every((child) => child.p80 !== null)
    ? remaining.reduce((sum, child) => sum + child.p80, 0)
    : null;
  return Object.freeze({
    mode: 'workset_blocked',
    status,
    evidence: state.worksetClosed ? 'explicit_workset' : 'unavailable',
    lowerMinutes: null,
    p50Minutes: null,
    p80Minutes: null,
    upperMinutes: null,
    resumeLowerMinutes: lower,
    resumeUpperMinutes: upper,
    reasonCode,
    worksetRevision: state.revision,
    jointP80Claimed: false,
    raw: Object.freeze({ blockingClockEta: true }),
  });
}

function aggregationUnits(members, children) {
  const byMember = new Map(children.map((child) => [child.memberId, child]));
  const grouped = new Map();
  const sequential = [];
  for (const member of members) {
    const child = byMember.get(member.memberId);
    if (member.executionGroup === null) sequential.push({ member, child });
    else {
      const group = grouped.get(member.executionGroup) ?? [];
      group.push({ member, child });
      grouped.set(member.executionGroup, group);
    }
  }
  const units = sequential.map(({ member, child }) => ({
    order: member.orderIndex,
    kind: 'sequential',
    children: [child],
  }));
  for (const [groupId, entries] of grouped) {
    const orders = entries.map(({ member }) => member.orderIndex).toSorted((a, b) => a - b);
    if (entries.length < 2 || orders.at(-1) - orders[0] + 1 !== entries.length) {
      return { valid: false, reasonCode: 'parallel_group_ambiguous' };
    }
    if (entries.some(({ child }) => child.status !== 'running' && child.status !== 'succeeded')) {
      return { valid: false, reasonCode: 'parallel_group_not_observed_running' };
    }
    units.push({
      order: orders[0],
      kind: 'parallel_observed',
      groupId,
      children: entries.map(({ child }) => child),
    });
  }
  return { valid: true, units: units.toSorted((left, right) => left.order - right.order) };
}

export function forecastWorkset({ state, childProjections = [], parentSurvival = null } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('workset state is required');
  if (state.ownerTerminal) {
    return Object.freeze({
      mode: 'workset_terminal',
      status: 'terminal',
      evidence: 'owner_terminal',
      lowerMinutes: 0,
      p50Minutes: 0,
      p80Minutes: 0,
      upperMinutes: 0,
      reasonCode: state.reasonCode,
      worksetRevision: state.revision,
      jointP80Claimed: true,
      raw: Object.freeze({ ownerTerminal: true }),
    });
  }

  const children = childProjections.map(sanitizeChildProjection);
  const activeMembers = (state.members ?? []).filter((member) => member.detachedAt === null);
  const memberIds = new Set(activeMembers.map((member) => member.memberId));
  if (children.length !== activeMembers.length
      || children.some((child) => !memberIds.has(child.memberId))
      || new Set(children.map((child) => child.memberId)).size !== children.length) {
    return unknown('member_projection_incomplete', state);
  }

  const directBlocking = BLOCKING.has(state.status) ? state.status : null;
  const childBlocking = children.find((child) => BLOCKING.has(child.status))?.status ?? null;
  if (directBlocking || childBlocking) {
    const status = directBlocking ?? childBlocking;
    return blockingProjection(status, state, children, `workset_${status}`);
  }
  if (state.status === 'pending') return unknown('workset_pending_semantics_unknown', state);
  const uncertain = children.find((child) => UNKNOWN_CHILD.has(child.status));
  if (uncertain) return unknown('child_pending_or_terminal_semantics_unknown', state);

  if (!state.worksetClosed) {
    const survival = sanitizeParentSurvival(parentSurvival);
    if (!survival) return unknown('open_workset_without_parent_survival', state);
    return Object.freeze({
      mode: 'workset_parent_survival',
      status: 'forecast',
      evidence: 'history_backed',
      lowerMinutes: survival.lower,
      p50Minutes: survival.p50,
      p80Minutes: survival.p80,
      upperMinutes: survival.p80,
      reasonCode: 'open_workset_parent_survival',
      worksetRevision: state.revision,
      jointP80Claimed: true,
      raw: Object.freeze({ aggregationUsed: false }),
    });
  }
  if (children.some((child) =>
    FORECASTABLE_CHILD.has(child.status) && (child.lower === null || child.p50 === null || child.p80 === null))) {
    return unknown('child_forecast_unavailable', state);
  }

  const grouped = aggregationUnits(activeMembers, children);
  if (!grouped.valid) return unknown(grouped.reasonCode, state);
  let lower = 0;
  let p50 = 0;
  let conservativeUpper = 0;
  let unfinishedCount = 0;
  let parallelGroupCount = 0;
  for (const unit of grouped.units) {
    const unfinished = unit.children.filter((child) => child.status !== 'succeeded');
    if (!unfinished.length) continue;
    unfinishedCount += unfinished.length;
    if (unit.kind === 'parallel_observed') {
      parallelGroupCount += 1;
      lower += Math.max(...unfinished.map((child) => child.lower));
      p50 += Math.max(...unfinished.map((child) => child.p50));
      conservativeUpper += unfinished.reduce((sum, child) => sum + child.p80, 0);
    } else {
      lower += unfinished[0].lower;
      p50 += unfinished[0].p50;
      conservativeUpper += unfinished[0].p80;
    }
  }
  if (unfinishedCount === 0) return unknown('awaiting_owner_terminal', state);
  const jointP80 = unfinishedCount <= 1 ? conservativeUpper : null;
  return Object.freeze({
    mode: 'workset_aggregate',
    status: 'forecast',
    evidence: 'explicit_workset',
    lowerMinutes: lower,
    p50Minutes: p50,
    p80Minutes: jointP80,
    upperMinutes: conservativeUpper,
    reasonCode: parallelGroupCount ? 'closed_workset_explicit_parallel' : 'closed_workset_sequential',
    worksetRevision: state.revision,
    jointP80Claimed: jointP80 !== null,
    raw: Object.freeze({
      aggregationUsed: true,
      unfinishedMemberCount: unfinishedCount,
      parallelGroupCount,
      upperBoundKind: unfinishedCount <= 1 ? 'child_p80' : 'conservative_sum_of_child_p80',
    }),
  });
}
