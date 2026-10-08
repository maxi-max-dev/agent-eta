export const WORKSET_EVENT_SCHEMA_VERSION = 'agenteta.workset-event/1';

export const WORKSET_TYPES = Object.freeze(['task', 'project']);
export const WORKSET_STATUSES = Object.freeze([
  'pending',
  'running',
  'needs_input',
  'waiting_provider',
  'blocked',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
export const WORKSET_EVENT_KINDS = Object.freeze([
  'workset_declared',
  'workset_revised',
  'workset_status_changed',
  'workset_heartbeat',
  'workset_succeeded',
  'workset_failed',
  'workset_cancelled',
]);

const WORKSET_ID = /^(task|project)-workset-[a-f0-9]{20}$/;
const EVENT_ID = /^workset-event-[a-f0-9]{20}$/;
const MEMBER_ID = /^workset-member-[a-f0-9]{20}$/;
const RUN_ID = /^(codex|claude|generic)-run-[a-f0-9]{20}$/;
const PARALLEL_GROUP = /^parallel-group-[a-f0-9]{20}$/;
const TYPES = new Set(WORKSET_TYPES);
const STATUSES = new Set(WORKSET_STATUSES);
const KINDS = new Set(WORKSET_EVENT_KINDS);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const NONTERMINAL = new Set(WORKSET_STATUSES.filter((status) => !TERMINAL.has(status)));

export class WorksetContractError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'WorksetContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new WorksetContractError(code);
}

function record(value, code = 'WORKSET_INVALID_OBJECT') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(code);
  return value;
}

function exactKeys(value, allowed, code = 'WORKSET_UNKNOWN_FIELD') {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size) reject(code);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) reject(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) reject('WORKSET_ACCESSOR_FIELD');
  }
}

function timestamp(value, code = 'WORKSET_INVALID_TIMESTAMP') {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) reject(code);
  return new Date(value).toISOString();
}

function worksetIdentity(value, type, code = 'WORKSET_INVALID_ID') {
  if (typeof value !== 'string') reject(code);
  const match = WORKSET_ID.exec(value);
  if (!match || match[1] !== type) reject(code);
  return value;
}

function sanitizeMember(input, type) {
  const member = record(input, 'WORKSET_INVALID_MEMBER');
  exactKeys(member, new Set([
    'member_id',
    'child_type',
    'child_id',
    'order_index',
    'execution_group',
    'attached_at',
    'detached_at',
  ]), 'WORKSET_INVALID_MEMBER_FIELDS');

  if (typeof member.member_id !== 'string' || !MEMBER_ID.test(member.member_id)) {
    reject('WORKSET_INVALID_MEMBER_ID');
  }
  if (member.child_type !== 'run' && member.child_type !== 'workset') {
    reject('WORKSET_INVALID_CHILD_TYPE');
  }
  if (type === 'task' && member.child_type !== 'run') reject('WORKSET_TASK_CHILD_MUST_BE_RUN');
  if (type === 'project' && member.child_type !== 'workset') {
    reject('WORKSET_PROJECT_CHILD_MUST_BE_WORKSET');
  }
  if (member.child_type === 'run') {
    if (typeof member.child_id !== 'string' || !RUN_ID.test(member.child_id)) {
      reject('WORKSET_INVALID_CHILD_ID');
    }
  } else {
    worksetIdentity(member.child_id, 'task', 'WORKSET_PROJECT_CHILD_MUST_BE_TASK');
  }
  if (!Number.isInteger(member.order_index) || member.order_index < 0) {
    reject('WORKSET_INVALID_ORDER');
  }
  if (
    member.execution_group !== null
    && (typeof member.execution_group !== 'string' || !PARALLEL_GROUP.test(member.execution_group))
  ) {
    reject('WORKSET_INVALID_EXECUTION_GROUP');
  }
  const attachedAt = timestamp(member.attached_at);
  const detachedAt = member.detached_at === null ? null : timestamp(member.detached_at);
  if (detachedAt !== null && Date.parse(detachedAt) < Date.parse(attachedAt)) {
    reject('WORKSET_INVALID_DETACH_TIME');
  }
  return Object.freeze({
    memberId: member.member_id,
    childType: member.child_type,
    childId: member.child_id,
    orderIndex: member.order_index,
    executionGroup: member.execution_group,
    attachedAt,
    detachedAt,
  });
}

function sanitizeMembers(value, type) {
  if (!Array.isArray(value)) reject('WORKSET_MEMBERS_REQUIRED');
  const members = value.map((member) => sanitizeMember(member, type));
  const active = members.filter((member) => member.detachedAt === null);
  const unique = (values, code) => {
    if (new Set(values).size !== values.length) reject(code);
  };
  unique(members.map((member) => member.memberId), 'WORKSET_DUPLICATE_MEMBER_ID');
  unique(active.map((member) => member.childId), 'WORKSET_DUPLICATE_ACTIVE_CHILD');
  unique(active.map((member) => member.orderIndex), 'WORKSET_DUPLICATE_ACTIVE_ORDER');
  return Object.freeze(members.toSorted((left, right) =>
    left.orderIndex - right.orderIndex || left.memberId.localeCompare(right.memberId)));
}

function sanitizeRevisionData(data, type, declared) {
  exactKeys(data, new Set(['revision', 'workset_closed', 'members']));
  if (!Number.isInteger(data.revision) || data.revision < 1) reject('WORKSET_INVALID_REVISION');
  if (declared && data.revision !== 1) reject('WORKSET_INITIAL_REVISION_MUST_BE_ONE');
  if (typeof data.workset_closed !== 'boolean') reject('WORKSET_INVALID_CLOSED_FLAG');
  return Object.freeze({
    revision: data.revision,
    worksetClosed: data.workset_closed,
    members: sanitizeMembers(data.members, type),
  });
}

export function sanitizeWorksetEvent(input) {
  const event = record(input);
  exactKeys(event, new Set([
    'schema_version',
    'event_id',
    'workset_id',
    'workset_type',
    'occurred_at',
    'kind',
    'data',
  ]));
  if (event.schema_version !== WORKSET_EVENT_SCHEMA_VERSION) reject('WORKSET_INVALID_SCHEMA');
  if (typeof event.event_id !== 'string' || !EVENT_ID.test(event.event_id)) {
    reject('WORKSET_INVALID_EVENT_ID');
  }
  if (!TYPES.has(event.workset_type)) reject('WORKSET_INVALID_TYPE');
  const worksetId = worksetIdentity(event.workset_id, event.workset_type);
  const occurredAt = timestamp(event.occurred_at);
  if (!KINDS.has(event.kind)) reject('WORKSET_INVALID_EVENT_KIND');
  const data = record(event.data);

  let sanitizedData;
  if (event.kind === 'workset_declared' || event.kind === 'workset_revised') {
    sanitizedData = sanitizeRevisionData(data, event.workset_type, event.kind === 'workset_declared');
  } else if (event.kind === 'workset_status_changed') {
    exactKeys(data, new Set(['status']));
    if (!NONTERMINAL.has(data.status)) reject('WORKSET_INVALID_NONTERMINAL_STATUS');
    sanitizedData = Object.freeze({ status: data.status });
  } else {
    exactKeys(data, new Set());
    sanitizedData = Object.freeze({});
  }

  return Object.freeze({
    schemaVersion: WORKSET_EVENT_SCHEMA_VERSION,
    eventId: event.event_id,
    worksetId,
    worksetType: event.workset_type,
    occurredAt,
    kind: event.kind,
    data: sanitizedData,
  });
}

export function validateWorksetEvent(input) {
  try {
    return { valid: true, code: null, value: sanitizeWorksetEvent(input) };
  } catch (error) {
    if (error instanceof WorksetContractError) {
      return { valid: false, code: error.code, value: null };
    }
    throw error;
  }
}

export function worksetEventPayload(event) {
  const sanitized = event?.schemaVersion === WORKSET_EVENT_SCHEMA_VERSION
    ? event
    : sanitizeWorksetEvent(event);
  const data = sanitized.kind === 'workset_declared' || sanitized.kind === 'workset_revised'
    ? {
        revision: sanitized.data.revision,
        workset_closed: sanitized.data.worksetClosed,
        members: sanitized.data.members.map((member) => ({
          member_id: member.memberId,
          child_type: member.childType,
          child_id: member.childId,
          order_index: member.orderIndex,
          execution_group: member.executionGroup,
          attached_at: member.attachedAt,
          detached_at: member.detachedAt,
        })),
      }
    : sanitized.kind === 'workset_status_changed'
      ? { status: sanitized.data.status }
      : {};
  return {
    schema_version: sanitized.schemaVersion,
    event_id: sanitized.eventId,
    workset_id: sanitized.worksetId,
    workset_type: sanitized.worksetType,
    occurred_at: sanitized.occurredAt,
    kind: sanitized.kind,
    data,
  };
}
