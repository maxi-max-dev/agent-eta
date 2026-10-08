export const EVENT_SCHEMA_VERSION = "agenteta.event/1";

export const PROVIDERS = Object.freeze(["codex", "claude", "generic"]);

export const KNOWN_EVENT_KINDS = Object.freeze([
  "run_started",
  "plan_declared",
  "plan_revised",
  "step_started",
  "step_completed",
  "retry_started",
  "scope_expanded",
  "waiting_provider",
  "needs_input",
  "resumed",
  "subrun_started",
  "subrun_finished",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "heartbeat",
]);

export const TERMINAL_EVENT_KINDS = Object.freeze([
  "run_succeeded",
  "run_failed",
  "run_cancelled",
]);

export const STEP_CLASSES = Object.freeze([
  "inspect",
  "edit",
  "test",
  "review",
  "external_wait",
  "other",
]);

export const STEP_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "cancelled",
]);

const knownKinds = new Set(KNOWN_EVENT_KINDS);
const providers = new Set(PROVIDERS);
const stepClasses = new Set(STEP_CLASSES);
const stepStatuses = new Set(STEP_STATUSES);

export function isKnownEventKind(kind) {
  return knownKinds.has(kind);
}

export function isTerminalEventKind(kind) {
  return TERMINAL_EVENT_KINDS.includes(kind);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value, path, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}

function requireTimestamp(value, path, errors) {
  requireNonEmptyString(value, path, errors);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be an ISO-compatible timestamp`);
  }
}

function validatePlanStep(step, index, errors) {
  const path = `data.steps[${index}]`;
  if (!isRecord(step)) {
    errors.push(`${path} must be an object`);
    return;
  }

  requireNonEmptyString(step.id, `${path}.id`, errors);
  requireNonEmptyString(step.label, `${path}.label`, errors);
  if (!stepClasses.has(step.class)) {
    errors.push(`${path}.class must be one of ${STEP_CLASSES.join(", ")}`);
  }
  if (!stepStatuses.has(step.status)) {
    errors.push(`${path}.status must be one of ${STEP_STATUSES.join(", ")}`);
  }
  if (
    step.prior_minutes !== undefined &&
    (!Number.isFinite(step.prior_minutes) || step.prior_minutes < 0)
  ) {
    errors.push(`${path}.prior_minutes must be a non-negative finite number`);
  }
}

/**
 * Validates the stable contract without stripping unknown fields or event kinds.
 * Unknown `kind` values are intentionally valid so newer adapters can be stored
 * and replayed by older builds without data loss.
 */
export function validateEvent(event) {
  const errors = [];
  if (!isRecord(event)) {
    return { valid: false, errors: ["event must be an object"] };
  }

  if (event.schema_version !== EVENT_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${EVENT_SCHEMA_VERSION}`);
  }
  requireNonEmptyString(event.event_id, "event_id", errors);
  requireNonEmptyString(event.run_id, "run_id", errors);
  if (!providers.has(event.provider)) {
    errors.push(`provider must be one of ${PROVIDERS.join(", ")}`);
  }
  requireNonEmptyString(event.native_session_id, "native_session_id", errors);
  requireTimestamp(event.occurred_at, "occurred_at", errors);
  requireTimestamp(event.observed_at, "observed_at", errors);
  requireNonEmptyString(event.kind, "kind", errors);

  if (!isRecord(event.source)) {
    errors.push("source must be an object");
  } else {
    requireNonEmptyString(event.source.adapter, "source.adapter", errors);
    requireNonEmptyString(event.source.mode, "source.mode", errors);
    if (
      !Number.isFinite(event.source.confidence) ||
      event.source.confidence < 0 ||
      event.source.confidence > 1
    ) {
      errors.push("source.confidence must be a finite number between 0 and 1");
    }
  }

  if (!isRecord(event.data)) {
    errors.push("data must be an object");
  } else if (isKnownEventKind(event.kind)) {
    if (event.kind === "plan_declared" || event.kind === "plan_revised") {
      if (!Array.isArray(event.data.steps)) {
        errors.push("data.steps must be an array");
      } else {
        event.data.steps.forEach((step, index) => validatePlanStep(step, index, errors));
      }
      if (
        event.data.revision !== undefined &&
        (!Number.isInteger(event.data.revision) || event.data.revision < 1)
      ) {
        errors.push("data.revision must be a positive integer");
      }
    }

    if (["step_started", "step_completed", "retry_started"].includes(event.kind)) {
      requireNonEmptyString(event.data.step_id, "data.step_id", errors);
    }

    if (event.kind === "scope_expanded") {
      if (!Array.isArray(event.data.steps) || event.data.steps.length === 0) {
        errors.push("data.steps must be a non-empty array");
      } else {
        event.data.steps.forEach((step, index) => validatePlanStep(step, index, errors));
      }
    }

    if (event.kind === "subrun_started" || event.kind === "subrun_finished") {
      requireNonEmptyString(event.data.subrun_id, "data.subrun_id", errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidEvent(event) {
  const result = validateEvent(event);
  if (!result.valid) {
    throw new TypeError(`Invalid canonical event: ${result.errors.join("; ")}`);
  }
  return event;
}
