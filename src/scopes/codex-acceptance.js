import { createHash } from 'node:crypto';

import { resolveActiveCodexRun } from '../reporter/codex-wrapper.js';
import { ingestWorksetCascade } from './ingest.js';

export const CURRENT_CODEX_ACCEPTANCE_SCOPE = 'current_project_acceptance';
export const CURRENT_CODEX_ACCEPTANCE_ACTIONS = Object.freeze([
  'declare',
  'heartbeat',
  'status',
  'succeeded',
]);

const ACTIONS = new Set(CURRENT_CODEX_ACCEPTANCE_ACTIONS);
const STATUSES = new Set([
  'pending',
  'running',
  'needs_input',
  'waiting_provider',
  'blocked',
  'paused',
]);

function fail(code) {
  throw new Error(code);
}

function alias(prefix, ...parts) {
  const hash = createHash('sha256');
  hash.update(CURRENT_CODEX_ACCEPTANCE_SCOPE);
  for (const part of parts) {
    hash.update('\0');
    hash.update(String(part));
  }
  return `${prefix}-${hash.digest('hex').slice(0, 20)}`;
}

function timestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail('CODEX_ACCEPTANCE_INVALID_TIMESTAMP');
  }
  return new Date(value).toISOString();
}

function event({ worksetId, worksetType, runId, occurredAt, action, member = null, status = null }) {
  const kind = action === 'declare'
    ? 'workset_declared'
    : action === 'heartbeat'
      ? 'workset_heartbeat'
      : action === 'status'
        ? 'workset_status_changed'
        : 'workset_succeeded';
  const data = action === 'declare'
    ? { revision: 1, workset_closed: true, members: [member] }
    : action === 'status'
      ? { status }
      : {};
  return {
    schema_version: 'agenteta.workset-event/1',
    event_id: alias('workset-event', worksetType, runId, action, occurredAt, status ?? 'none'),
    workset_id: worksetId,
    workset_type: worksetType,
    occurred_at: occurredAt,
    kind,
    data,
  };
}

function safeResult(action, cascade) {
  const [task, project] = cascade.results;
  return Object.freeze({
    accepted: true,
    action,
    task: Object.freeze({
      accepted: task.accepted,
      inserted: task.inserted,
      forecastStatus: task.status,
    }),
    project: Object.freeze({
      accepted: project.accepted,
      inserted: project.inserted,
      forecastStatus: project.status,
    }),
  });
}

/**
 * Bind only the exact active turn resolved inside CODEX_THREAD_ID to one
 * deterministic local task and project. Native IDs and paths remain inside
 * the provider resolver and are never returned or persisted.
 */
export async function acceptCurrentCodexProject({
  database,
  root,
  threadId,
  action = 'declare',
  status = null,
  occurredAt = new Date().toISOString(),
  receivedAt = new Date().toISOString(),
} = {}) {
  if (!database) fail('CODEX_ACCEPTANCE_DATABASE_REQUIRED');
  if (!ACTIONS.has(action)) fail('CODEX_ACCEPTANCE_INVALID_ACTION');
  if (action === 'status') {
    if (!STATUSES.has(status)) fail('CODEX_ACCEPTANCE_INVALID_STATUS');
  } else if (status !== null) {
    fail('CODEX_ACCEPTANCE_UNEXPECTED_STATUS');
  }
  const resolved = await resolveActiveCodexRun({ root, threadId });
  const run = database.loadRun(resolved.runId);
  if (!run) fail('CODEX_ACCEPTANCE_RUN_NOT_IMPORTED');
  const observedAt = timestamp(receivedAt);
  const commandAt = action === 'declare'
    ? timestamp(run.started_at)
    : timestamp(occurredAt);

  const taskId = alias('task-workset', resolved.runId);
  const projectId = alias('project-workset', resolved.runId);
  const taskMember = {
    member_id: alias('workset-member', 'task', resolved.runId),
    child_type: 'run',
    child_id: resolved.runId,
    order_index: 0,
    execution_group: null,
    attached_at: timestamp(run.started_at),
    detached_at: null,
  };
  const projectMember = {
    member_id: alias('workset-member', 'project', resolved.runId),
    child_type: 'workset',
    child_id: taskId,
    order_index: 0,
    execution_group: null,
    attached_at: timestamp(run.started_at),
    detached_at: null,
  };
  const taskEvent = event({
    worksetId: taskId,
    worksetType: 'task',
    runId: resolved.runId,
    occurredAt: commandAt,
    action,
    member: taskMember,
    status,
  });
  const projectEvent = event({
    worksetId: projectId,
    worksetType: 'project',
    runId: resolved.runId,
    occurredAt: commandAt,
    action,
    member: projectMember,
    status,
  });
  const cascade = ingestWorksetCascade(database, [taskEvent, projectEvent], {
    receivedAt: observedAt,
    source: {
      provider: 'codex',
      sourceKind: 'controlled_wrapper',
      sourceStatus: 'contract_only',
      taskClass: 'other',
      eligibleLargeTask: null,
    },
  });
  return safeResult(action, cascade);
}
