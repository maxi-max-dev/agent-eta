export const REPORTER_SCHEMA_VERSION = 'agenteta.reporter/1';
export const REPORTER_CONNECTION_STATUS = 'local_sidecar';

export const REPORTER_TASK_CLASSES = Object.freeze([
  'coding',
  'research',
  'writing',
  'operations',
  'other',
]);

export const REPORTER_PLAN_ADHERENCE = Object.freeze([
  'not_applicable',
  'unknown',
  'following',
  'replanned',
  'departed',
]);

const ALLOWED_KEYS = new Set([
  'schema_version',
  'provider',
  'run_id',
  'reported_at',
  'task_class',
  'eligible_large_task',
  'model_self_eta_minutes',
  'plan_present',
  'plan_step_count',
  'plan_adherence',
]);
const PROVIDERS = new Set(['codex', 'claude', 'generic']);
const TASK_CLASSES = new Set(REPORTER_TASK_CLASSES);
const ADHERENCE = new Set(REPORTER_PLAN_ADHERENCE);
const RUN_ID = /^(codex|claude|generic)-run-[a-f0-9]{20}$/;
const MAX_ETA_MINUTES = 7 * 24 * 60;
const MAX_PLAN_STEPS = 1_000;

export class ReporterContractError extends TypeError {
  constructor(code) {
    super(code);
    this.name = 'ReporterContractError';
    this.code = code;
  }
}

function reject(code) {
  throw new ReporterContractError(code);
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject('REPORTER_INVALID_OBJECT');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject('REPORTER_INVALID_OBJECT');
  return value;
}

/**
 * Validate an explicit, structure-only Reporter envelope.
 *
 * This is a local sidecar contract, not an official Codex/Claude event
 * connection. Unknown keys, accessors, free text, paths and native IDs are
 * rejected rather than stripped.
 */
export function sanitizeReporterReport(input) {
  const report = plainRecord(input);
  const keys = Reflect.ownKeys(report);
  if (keys.length !== ALLOWED_KEYS.size) reject('REPORTER_MISSING_OR_UNKNOWN_FIELD');
  for (const key of keys) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      reject('REPORTER_MISSING_OR_UNKNOWN_FIELD');
    }
    const descriptor = Object.getOwnPropertyDescriptor(report, key);
    if (!descriptor || !('value' in descriptor)) reject('REPORTER_ACCESSOR_FIELD');
  }

  if (report.schema_version !== REPORTER_SCHEMA_VERSION) reject('REPORTER_INVALID_SCHEMA');
  if (!PROVIDERS.has(report.provider)) reject('REPORTER_INVALID_PROVIDER');
  if (typeof report.run_id !== 'string') reject('REPORTER_INVALID_RUN_ALIAS');
  const runMatch = RUN_ID.exec(report.run_id);
  if (runMatch === null || runMatch[1] !== report.provider) reject('REPORTER_INVALID_RUN_ALIAS');
  if (typeof report.reported_at !== 'string' || Number.isNaN(Date.parse(report.reported_at))) {
    reject('REPORTER_INVALID_TIMESTAMP');
  }
  if (!TASK_CLASSES.has(report.task_class)) reject('REPORTER_INVALID_TASK_CLASS');
  if (typeof report.eligible_large_task !== 'boolean' || typeof report.plan_present !== 'boolean') {
    reject('REPORTER_INVALID_BOOLEAN');
  }
  if (
    report.model_self_eta_minutes !== null
    && (
      !Number.isFinite(report.model_self_eta_minutes)
      || report.model_self_eta_minutes < 0
      || report.model_self_eta_minutes > MAX_ETA_MINUTES
    )
  ) {
    reject('REPORTER_INVALID_SELF_ETA');
  }
  if (
    !Number.isInteger(report.plan_step_count)
    || report.plan_step_count < 0
    || report.plan_step_count > MAX_PLAN_STEPS
  ) {
    reject('REPORTER_INVALID_PLAN_COUNT');
  }
  if (!ADHERENCE.has(report.plan_adherence)) reject('REPORTER_INVALID_ADHERENCE');
  if (
    (!report.plan_present && report.plan_step_count !== 0)
    || (!report.plan_present && report.plan_adherence !== 'not_applicable')
    || (report.plan_present && report.plan_step_count < 1)
    || (report.plan_present && report.plan_adherence === 'not_applicable')
  ) {
    reject('REPORTER_INCONSISTENT_PLAN');
  }

  return Object.freeze({
    schema_version: REPORTER_SCHEMA_VERSION,
    provider: report.provider,
    run_id: report.run_id,
    reported_at: new Date(report.reported_at).toISOString(),
    task_class: report.task_class,
    eligible_large_task: report.eligible_large_task,
    model_self_eta_minutes: report.model_self_eta_minutes,
    plan_present: report.plan_present,
    plan_step_count: report.plan_step_count,
    plan_adherence: report.plan_adherence,
  });
}

export function validateReporterReport(input) {
  try {
    const value = sanitizeReporterReport(input);
    return { valid: true, code: null, value };
  } catch (error) {
    if (error instanceof ReporterContractError) {
      return { valid: false, code: error.code, value: null };
    }
    throw error;
  }
}
