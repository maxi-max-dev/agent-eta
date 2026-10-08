import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverCodexSessions,
  scanCodexSession,
} from "../src/adapters/codex.js";
import { validateEvent } from "../src/core/contract.js";

const SESSION_METADATA_KEYS = [
  "lastObservedAt",
  "nativeSessionId",
  "provider",
  "startedAt",
];
const FORBIDDEN_OUTPUT_KEYS = new Set([
  "arguments",
  "base_instructions",
  "command",
  "content",
  "cwd",
  "explanation",
  "last_agent_message",
  "message",
  "path",
  "prompt",
  "reasoning",
  "step",
]);

function envelope(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function sanitizedTranscript() {
  return [
    envelope("2026-08-01T00:00:00.000Z", "session_meta", {
      id: "native-session-redacted",
      session_id: "native-session-redacted",
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd: "[redacted]",
      base_instructions: "[redacted]",
    }),
    envelope("2026-08-01T00:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-redacted-1",
      started_at: 1_775_001_601,
    }),
    envelope("2026-08-01T00:00:02.000Z", "response_item", {
      type: "message",
      content: "[redacted]",
    }),
    envelope("2026-08-01T00:00:03.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({
        explanation: "[redacted]",
        plan: [
          { step: "[redacted]", status: "in_progress" },
          { step: "[redacted]", status: "pending" },
        ],
      }),
    }),
    envelope("2026-08-01T00:01:03.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({
        plan: [
          { step: "[redacted]", status: "completed" },
          { step: "[redacted]", status: "in_progress" },
        ],
      }),
    }),
    envelope("2026-08-01T00:02:03.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({
        plan: [
          { step: "[redacted]", status: "completed" },
          { step: "[redacted]", status: "completed" },
        ],
      }),
    }),
    envelope("2026-08-01T00:02:04.000Z", "event_msg", {
      type: "task_complete",
      turn_id: "turn-redacted-1",
      started_at: 1_775_001_601,
      completed_at: 1_775_001_724,
      last_agent_message: "[redacted]",
    }),
    envelope("2026-08-01T00:03:00.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-redacted-2",
      started_at: 1_775_001_780,
    }),
    envelope("2026-08-01T00:03:30.000Z", "event_msg", {
      type: "turn_aborted",
      turn_id: "turn-redacted-2",
      started_at: 1_775_001_780,
      completed_at: 1_775_001_810,
      reason: "[redacted]",
    }),
    envelope("2026-08-01T00:04:00.000Z", "future_record", {}),
  ];
}

async function writeJsonl(file, records, { malformed = false } = {}) {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(file, `${body}${malformed ? "\n{broken-json" : ""}\n`, "utf8");
}

function assertNoForbiddenKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(FORBIDDEN_OUTPUT_KEYS.has(key), false, `forbidden output key: ${key}`);
    assertNoForbiddenKeys(nested);
  }
}

test("discoverCodexSessions filters by mtime without opening transcript content", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-eta-codex-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = path.join(directory, "sessions", "2026", "08");
  await mkdir(nested, { recursive: true });
  const recent = path.join(nested, "recent.jsonl");
  const old = path.join(nested, "old.jsonl");
  await writeFile(recent, "not opened during discovery\n", "utf8");
  await writeFile(old, "not opened during discovery\n", "utf8");
  await utimes(recent, new Date("2026-08-20T00:00:00Z"), new Date("2026-08-20T00:00:00Z"));
  await utimes(old, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));

  const sessions = await discoverCodexSessions({
    root: directory,
    since: "2026-08-01T00:00:00Z",
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].file, recent);
  assert.equal(typeof sessions[0].sizeBytes, "number");
});

test("scanCodexSession emits stable canonical lifecycle and sanitized plan events", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-eta-codex-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sanitized.jsonl");
  await writeJsonl(file, sanitizedTranscript(), { malformed: true });

  const first = await scanCodexSession(file);
  const second = await scanCodexSession(file);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.metadata).sort(), SESSION_METADATA_KEYS);
  assert.equal(first.metadata.provider, "codex");
  assert.match(first.metadata.nativeSessionId, /^codex-session-[a-f0-9]{20}$/);
  assert.equal(first.metadata.nativeSessionId.includes("redacted"), false);
  assert.deepEqual(
    first.events.map((event) => event.kind),
    [
      "run_started",
      "plan_declared",
      "step_started",
      "plan_revised",
      "step_completed",
      "step_started",
      "plan_revised",
      "step_completed",
      "run_succeeded",
      "run_started",
      "run_cancelled",
    ],
  );
  for (const event of first.events) {
    assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
    assert.match(event.event_id, /^codex-event-[a-f0-9]{20}$/);
    assert.match(event.run_id, /^codex-run-[a-f0-9]{20}$/);
    assert.equal(event.native_session_id, first.metadata.nativeSessionId);
  }
  const planEvents = first.events.filter((event) =>
    event.kind === "plan_declared" || event.kind === "plan_revised",
  );
  for (const event of planEvents) {
    event.data.steps.forEach((step, index) => {
      assert.equal(step.label, `步骤 ${index + 1}`);
      assert.equal(step.class, "other");
      assert.equal(Object.hasOwn(step, "prior_minutes"), false);
    });
  }
  assert.equal(first.coverage.runCount, 2);
  assert.equal(first.coverage.terminalRunCount, 2);
  assert.equal(first.coverage.plannedRunCount, 1);
  assert.equal(first.coverage.planUpdateCount, 3);
  assert.equal(first.coverage.planCoverage, 0.5);
  assert.equal(first.coverage.malformedLines, 1);
  assert.equal(first.coverage.unknownRecords, 1);
  assert.equal(Object.hasOwn(first.coverage, "eligibleLargeTask"), false);
  assertNoForbiddenKeys(first);
});

test("malformed and orphan plan records are skipped and counted", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-eta-codex-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sanitized-errors.jsonl");
  await writeJsonl(file, [
    envelope("2026-08-01T00:00:00.000Z", "session_meta", {
      id: "native-session-redacted",
      session_id: "native-session-redacted",
      timestamp: "2026-08-01T00:00:00.000Z",
    }),
    envelope("2026-08-01T00:00:01.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "[redacted]", status: "pending" }] }),
    }),
    envelope("2026-08-01T00:00:02.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: "not-json",
    }),
    envelope("2026-08-01T00:00:03.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn-redacted",
      started_at: 1_775_001_603,
    }),
    envelope("2026-08-01T00:00:04.000Z", "response_item", {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "[redacted]", status: "future" }] }),
    }),
  ]);

  const withoutEvents = await scanCodexSession(file, { includeEvents: false });
  assert.equal(Object.hasOwn(withoutEvents, "events"), false);
  assert.equal(withoutEvents.coverage.orphanPlanUpdates, 1);
  assert.equal(withoutEvents.coverage.planParseErrors, 1);
  assert.equal(withoutEvents.coverage.unknownPlanStatuses, 1);
  assert.equal(withoutEvents.coverage.plannedRunCount, 1);
  assert.equal(withoutEvents.coverage.canonicalEventCount, 2);
  assertNoForbiddenKeys(withoutEvents);
});

test("logical event ids survive copied branches and shifted line numbers", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-eta-codex-branch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstFile = path.join(directory, "first.jsonl");
  const secondFile = path.join(directory, "second.jsonl");
  const records = sanitizedTranscript().map((record) => {
    if (record.type !== "response_item" || record.payload?.name !== "update_plan") return record;
    return {
      ...record,
      payload: { ...record.payload, call_id: `call-${record.timestamp}` },
    };
  });
  await writeJsonl(firstFile, records);
  await writeJsonl(secondFile, [
    envelope("2026-07-31T23:59:59.000Z", "turn_context", {}),
    ...records,
  ]);

  const first = await scanCodexSession(firstFile);
  const shifted = await scanCodexSession(secondFile);
  assert.deepEqual(
    shifted.events.map((event) => event.event_id),
    first.events.map((event) => event.event_id),
  );
});

test("real Codex transcript canary exposes allowlisted fields only", async (t) => {
  const root = path.join(os.homedir(), ".codex", "sessions");
  try {
    await access(root);
  } catch {
    t.skip("no local Codex sessions directory");
    return;
  }

  const sessions = await discoverCodexSessions({ root });
  if (sessions.length === 0) {
    t.skip("no recent local Codex sessions");
    return;
  }
  const result = await scanCodexSession(sessions[0].file);
  assert.deepEqual(Object.keys(result.metadata).sort(), SESSION_METADATA_KEYS);
  assert.match(result.metadata.nativeSessionId, /^codex-session-[a-f0-9]{20}$/);
  assert.equal(Number.isInteger(result.coverage.lineCount), true);
  assert.equal(Number.isInteger(result.coverage.malformedLines), true);
  assert.equal(Number.isInteger(result.coverage.unknownRecords), true);
  for (const event of result.events) {
    assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
    if (event.kind === "plan_declared" || event.kind === "plan_revised") {
      event.data.steps.forEach((step, index) => {
        assert.equal(step.label, `步骤 ${index + 1}`);
        assert.equal(step.class, "other");
      });
    }
  }
  assertNoForbiddenKeys(result);
});
