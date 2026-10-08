import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { EVENT_SCHEMA_VERSION } from "../core/contract.js";

const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

// These records are known Codex transcript containers but have no ETA-safe
// structural signal. Keeping an explicit list lets us distinguish normal
// privacy filtering from genuinely unknown future record types.
const KNOWN_IGNORED_ENVELOPES = new Set([
  "compacted",
  "inter_agent_communication_metadata",
  "turn_context",
  "world_state",
]);

const TERMINAL_SIGNAL_KINDS = new Set(["task_complete", "turn_aborted"]);
const SAFE_PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function stableHash(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableAlias(prefix, ...parts) {
  return `${prefix}-${stableHash(...parts).slice(0, 20)}`;
}

/**
 * Provider-owned wrappers use these helpers to derive the same irreversible
 * aliases as the read-only transcript adapter. Raw provider identifiers must
 * remain process-local and must never be included in Reporter envelopes.
 */
export function codexSessionAlias(nativeSessionId) {
  if (typeof nativeSessionId !== "string" || nativeSessionId.trim() === "") {
    throw new TypeError("nativeSessionId must be a non-empty string");
  }
  return stableAlias("codex-session", nativeSessionId);
}

export function codexRunAlias(nativeSessionAlias, nativeTurnId) {
  if (!/^codex-session-[a-f0-9]{20}$/.test(nativeSessionAlias ?? "")) {
    throw new TypeError("nativeSessionAlias must be a canonical Codex session alias");
  }
  if (typeof nativeTurnId !== "string" || nativeTurnId.trim() === "") {
    throw new TypeError("nativeTurnId must be a non-empty string");
  }
  return stableAlias("codex-run", nativeSessionAlias, nativeTurnId);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function timestampToIso(value) {
  let milliseconds;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim() !== "") {
    milliseconds = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function maxTimestamp(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function normalizeSince(since) {
  if (since === undefined || since === null) return Date.now() - DEFAULT_LOOKBACK_MS;
  if (since instanceof Date) {
    if (Number.isNaN(since.getTime())) throw new TypeError("since must be a valid date");
    return since.getTime();
  }
  if (typeof since === "number" && Number.isFinite(since)) return since;
  if (typeof since === "string" && !Number.isNaN(Date.parse(since))) return Date.parse(since);
  throw new TypeError("since must be a Date, epoch milliseconds, or ISO timestamp");
}

async function collectJsonlFiles(directory, files) {
  let entries;
  try {
    entries = await opendir(directory);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw error;
  }

  for await (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(candidate, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(candidate);
    }
  }
}

/**
 * Find local Codex JSONL transcripts by filesystem metadata only. Discovery
 * does not open transcript bodies. Callers should treat `file` as an ephemeral
 * local capability and must not persist it in reports or forecast storage.
 */
export async function discoverCodexSessions({ root, since } = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("root must be a non-empty directory path");
  }

  const threshold = normalizeSince(since);
  const candidates = [];
  await collectJsonlFiles(path.resolve(root), candidates);

  const discovered = [];
  for (const file of candidates) {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (fileStat.mtimeMs < threshold) continue;
    discovered.push({
      file,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size,
    });
  }

  return discovered.sort(
    (left, right) =>
      Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt) || left.file.localeCompare(right.file),
  );
}

function canonicalEvent({
  nativeSessionAlias,
  runId,
  turnKey,
  identityKey,
  ordinal = 0,
  occurredAt,
  observedAt,
  kind,
  data,
}) {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: stableAlias(
      "codex-event",
      nativeSessionAlias,
      turnKey,
      identityKey,
      ordinal,
      kind,
    ),
    run_id: runId,
    provider: "codex",
    native_session_id: nativeSessionAlias,
    occurred_at: occurredAt,
    observed_at: observedAt,
    kind,
    source: {
      adapter: "codex-jsonl",
      mode: "local_read_only",
      confidence: 1,
    },
    data,
  };
}

function planSteps(statuses, runId) {
  return statuses.map((status, index) => ({
    id: `${runId}-step-${index + 1}`,
    label: `步骤 ${index + 1}`,
    class: "other",
    status,
  }));
}

function parsePlanStatuses(argumentsValue) {
  let parsed;
  try {
    parsed = typeof argumentsValue === "string" ? JSON.parse(argumentsValue) : argumentsValue;
  } catch {
    return { valid: false, statuses: [], unknownStatuses: 0 };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plan)) {
    return { valid: false, statuses: [], unknownStatuses: 0 };
  }

  let unknownStatuses = 0;
  const statuses = parsed.plan.map((item) => {
    const status = isRecord(item) ? item.status : null;
    if (SAFE_PLAN_STATUSES.has(status)) return status;
    unknownStatuses += 1;
    return "pending";
  });
  return { valid: true, statuses, unknownStatuses };
}

function latestActiveTurn(activeTurnStack, terminalTurns) {
  for (let index = activeTurnStack.length - 1; index >= 0; index -= 1) {
    const turnKey = activeTurnStack[index];
    if (!terminalTurns.has(turnKey)) return turnKey;
  }
  return null;
}

function removeActiveTurn(activeTurnStack, turnKey) {
  const index = activeTurnStack.lastIndexOf(turnKey);
  if (index !== -1) activeTurnStack.splice(index, 1);
}

/**
 * Parse one Codex transcript into privacy-minimized structure events.
 *
 * Deliberate non-inputs: message/content/reasoning text, prompt text, command
 * bodies, code, tool outputs, cwd/project paths, plan labels and explanations.
 * Plan labels are replaced by positional aliases and every step class is
 * `other`. Native session/turn identifiers are only used transiently to make
 * stable, irreversible aliases.
 */
export async function scanCodexSession(file, { includeEvents = true } = {}) {
  if (typeof file !== "string" || file.trim() === "") {
    throw new TypeError("file must be a non-empty JSONL path");
  }

  const counts = {
    lineCount: 0,
    parsedRecords: 0,
    malformedLines: 0,
    unknownRecords: 0,
    ignoredRecords: 0,
    invalidSignalRecords: 0,
    planParseErrors: 0,
    unknownPlanStatuses: 0,
    orphanPlanUpdates: 0,
  };
  const signals = [];
  let rawNativeSessionId = null;
  let sessionStartedAt = null;
  let lastObservedAt = null;

  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    counts.lineCount += 1;
    if (line.trim() === "") {
      counts.malformedLines += 1;
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      counts.malformedLines += 1;
      continue;
    }
    if (!isRecord(record)) {
      counts.malformedLines += 1;
      continue;
    }
    counts.parsedRecords += 1;

    const envelopeTimestamp = timestampToIso(record.timestamp);
    lastObservedAt = maxTimestamp(lastObservedAt, envelopeTimestamp);
    const payload = isRecord(record.payload) ? record.payload : null;

    if (record.type === "session_meta") {
      if (payload === null) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      const sessionId = nonEmptyString(payload.session_id) ?? nonEmptyString(payload.id);
      rawNativeSessionId ??= sessionId;
      sessionStartedAt ??= timestampToIso(payload.timestamp) ?? envelopeTimestamp;
      continue;
    }

    if (record.type === "event_msg") {
      if (payload === null) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      if (
        payload.type !== "task_started" &&
        payload.type !== "task_complete" &&
        payload.type !== "turn_aborted"
      ) {
        counts.ignoredRecords += 1;
        continue;
      }
      const turnKey = nonEmptyString(payload.turn_id);
      if (turnKey === null || envelopeTimestamp === null) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      const lifecycleTimestamp =
        payload.type === "task_started"
          ? timestampToIso(payload.started_at)
          : timestampToIso(payload.completed_at);
      signals.push({
        type: payload.type,
        turnKey,
        lineNumber: counts.lineCount,
        occurredAt: lifecycleTimestamp ?? envelopeTimestamp,
        observedAt: envelopeTimestamp,
      });
      continue;
    }

    if (record.type === "response_item") {
      if (
        payload?.type !== "function_call" ||
        payload.name !== "update_plan"
      ) {
        counts.ignoredRecords += 1;
        continue;
      }
      if (envelopeTimestamp === null) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      const plan = parsePlanStatuses(payload.arguments);
      if (!plan.valid) {
        counts.planParseErrors += 1;
        continue;
      }
      counts.unknownPlanStatuses += plan.unknownStatuses;
      signals.push({
        type: "plan_update",
        statuses: plan.statuses,
        identityKey:
          nonEmptyString(payload.call_id) ??
          `plan:${envelopeTimestamp}:${plan.statuses.join(',')}`,
        lineNumber: counts.lineCount,
        occurredAt: envelopeTimestamp,
        observedAt: envelopeTimestamp,
      });
      continue;
    }

    if (KNOWN_IGNORED_ENVELOPES.has(record.type)) counts.ignoredRecords += 1;
    else counts.unknownRecords += 1;
  }

  const pathFallbackId = path.basename(file, path.extname(file));
  const nativeSessionAlias = codexSessionAlias(rawNativeSessionId ?? pathFallbackId);
  const events = [];
  const activeTurnStack = [];
  const terminalTurns = new Set();
  const runByTurn = new Map();
  const planStateByTurn = new Map();
  const plannedTurns = new Set();
  let planUpdateCount = 0;
  let terminalRunCount = 0;

  for (const signal of signals) {
    if (signal.type === "task_started") {
      if (runByTurn.has(signal.turnKey)) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      const runId = codexRunAlias(nativeSessionAlias, signal.turnKey);
      runByTurn.set(signal.turnKey, runId);
      activeTurnStack.push(signal.turnKey);
      events.push(
        canonicalEvent({
          nativeSessionAlias,
          runId,
          turnKey: signal.turnKey,
          identityKey: `lifecycle:${signal.type}`,
          occurredAt: signal.occurredAt,
          observedAt: signal.observedAt,
          kind: "run_started",
          data: { task_class: "other" },
        }),
      );
      continue;
    }

    if (signal.type === "plan_update") {
      const turnKey = latestActiveTurn(activeTurnStack, terminalTurns);
      if (turnKey === null) {
        counts.orphanPlanUpdates += 1;
        continue;
      }
      const runId = runByTurn.get(turnKey);
      if (runId === undefined) {
        counts.orphanPlanUpdates += 1;
        continue;
      }

      const previous = planStateByTurn.get(turnKey) ?? null;
      const revision = (previous?.revision ?? 0) + 1;
      const steps = planSteps(signal.statuses, runId);
      const planKind = previous === null ? "plan_declared" : "plan_revised";
      events.push(
        canonicalEvent({
          nativeSessionAlias,
          runId,
          turnKey,
          identityKey: signal.identityKey,
          occurredAt: signal.occurredAt,
          observedAt: signal.observedAt,
          kind: planKind,
          data: { revision, steps },
        }),
      );

      for (let index = 0; index < signal.statuses.length; index += 1) {
        const status = signal.statuses[index];
        const previousStatus = previous?.statuses[index] ?? null;
        let transitionKind = null;
        if (status === "in_progress" && previousStatus === "completed") {
          transitionKind = "retry_started";
        } else if (status === "in_progress" && previousStatus !== "in_progress") {
          transitionKind = "step_started";
        } else if (status === "completed" && previousStatus === "in_progress") {
          transitionKind = "step_completed";
        }
        if (transitionKind === null) continue;
        events.push(
          canonicalEvent({
            nativeSessionAlias,
            runId,
            turnKey,
            identityKey: signal.identityKey,
            ordinal: index + 1,
            occurredAt: signal.occurredAt,
            observedAt: signal.observedAt,
            kind: transitionKind,
            data: { step_id: steps[index].id },
          }),
        );
      }

      planStateByTurn.set(turnKey, { revision, statuses: signal.statuses });
      plannedTurns.add(turnKey);
      planUpdateCount += 1;
      continue;
    }

    if (TERMINAL_SIGNAL_KINDS.has(signal.type)) {
      const runId = runByTurn.get(signal.turnKey);
      if (runId === undefined || terminalTurns.has(signal.turnKey)) {
        counts.invalidSignalRecords += 1;
        continue;
      }
      terminalTurns.add(signal.turnKey);
      removeActiveTurn(activeTurnStack, signal.turnKey);
      terminalRunCount += 1;
      events.push(
        canonicalEvent({
          nativeSessionAlias,
          runId,
          turnKey: signal.turnKey,
          identityKey: `lifecycle:${signal.type}`,
          occurredAt: signal.occurredAt,
          observedAt: signal.observedAt,
          kind: signal.type === "task_complete" ? "run_succeeded" : "run_cancelled",
          data: {},
        }),
      );
    }
  }

  const runCount = runByTurn.size;
  const plannedRunCount = plannedTurns.size;
  const result = {
    metadata: {
      provider: "codex",
      nativeSessionId: nativeSessionAlias,
      startedAt: sessionStartedAt,
      lastObservedAt,
    },
    coverage: {
      ...counts,
      runCount,
      terminalRunCount,
      plannedRunCount,
      planUpdateCount,
      planCoverage: runCount === 0 ? null : plannedRunCount / runCount,
      canonicalEventCount: events.length,
    },
  };
  if (includeEvents) result.events = events;
  return result;
}
