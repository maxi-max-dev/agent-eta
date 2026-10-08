import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverClaudeSessions, scanClaudeSession } from "../src/adapters/claude.js";
import { validateEvent } from "../src/core/contract.js";

const fixture = new URL("../fixtures/adapter-shapes/claude-session.jsonl", import.meta.url);
const forbiddenOutputKeys = new Set([
  "subject",
  "description",
  "prompt",
  "command",
  "cwd",
  "file_path",
  "activeForm",
  "questions",
]);

function assertPrivacySafe(value) {
  if (Array.isArray(value)) {
    value.forEach(assertPrivacySafe);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbiddenOutputKeys.has(key), false, `forbidden output key: ${key}`);
    assertPrivacySafe(child);
  }
}

test("Claude JSONL scan emits canonical metadata events without transcript text", async () => {
  const first = await scanClaudeSession(fixture.pathname);
  const second = await scanClaudeSession(fixture.pathname);

  assert.equal(first.metadata.provider, "claude");
  assert.equal(first.metadata.sessionKind, "primary");
  assert.match(first.metadata.nativeSessionId, /^claude-session-[a-f0-9]{20}$/);
  assert.doesNotMatch(first.metadata.nativeSessionId, /00000000/);
  assert.equal(first.coverage.totalLines, 11);
  assert.equal(first.coverage.parsedLines, 10);
  assert.equal(first.coverage.malformedLines, 1);
  assert.equal(first.coverage.taskCreateCount, 2);
  assert.equal(first.coverage.mappedTaskCreateCount, 2);
  assert.equal(first.coverage.taskUpdateCount, 2);
  assert.equal(first.coverage.needsInputCount, 1);
  assert.equal(first.coverage.terminalDetected, true);
  assert.deepEqual(
    first.events.map((event) => event.kind),
    [
      "run_started",
      "plan_declared",
      "step_started",
      "needs_input",
      "resumed",
      "plan_revised",
      "step_completed",
      "run_succeeded",
    ],
  );
  assert.deepEqual(
    first.events.map((event) => event.event_id),
    second.events.map((event) => event.event_id),
  );
  for (const event of first.events) assert.deepEqual(validateEvent(event), { valid: true, errors: [] });

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SANITIZED/);
  assert.doesNotMatch(serialized, /00000000-0000-4000-8000-000000000001/);
  assert.doesNotMatch(serialized, /sourceFile/);
  assert.doesNotMatch(serialized, new RegExp(fixture.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const plan = first.events.find((event) => event.kind === "plan_revised");
  assert.deepEqual(
    plan.data.steps.map((step) => step.label),
    ["步骤 1", "步骤 2"],
  );
  assertPrivacySafe(first);
});

test("includeEvents false returns only safe metadata and coverage", async () => {
  const scan = await scanClaudeSession(fixture.pathname, { includeEvents: false });
  assert.deepEqual(Object.keys(scan), ["metadata", "coverage"]);
  assertPrivacySafe(scan);
});

test("discovery reports explicit primary and all-file plan denominators", async () => {
  const discovered = await discoverClaudeSessions({
    root: fixture.pathname,
    since: 0,
  });
  assert.equal(discovered.coverage.discoveredFiles, 1);
  assert.equal(discovered.coverage.primarySessionFiles, 1);
  assert.equal(discovered.coverage.sidechainSessionFiles, 0);
  assert.equal(discovered.coverage.primaryNativePlanFiles, 1);
  assert.equal(discovered.coverage.primaryPlanCoverage, 1);
  assert.equal(discovered.coverage.allFilePlanCoverage, 1);
  assert.equal(discovered.coverage.malformedLines, 1);
  assert.equal(discovered.sessions[0].events, undefined);
  assert.equal(typeof discovered.sessions[0].file, "string");
  assertPrivacySafe(discovered.sessions.map(({ file: _file, ...scan }) => scan));
});

test(
  "real Claude files satisfy the metadata-only privacy canary when available",
  { skip: !existsSync(path.join(os.homedir(), ".claude")), timeout: 30_000 },
  async () => {
    const discovered = await discoverClaudeSessions({
      root: path.join(os.homedir(), ".claude"),
      since: Date.now() - 30 * 86_400_000,
    });
    assert.ok(discovered.coverage.discoveredFiles > 0);
    assert.equal(
      discovered.coverage.primarySessionFiles +
        discovered.coverage.sidechainSessionFiles +
        discovered.coverage.metadataOnlyFiles,
      discovered.coverage.discoveredFiles,
    );
    assertPrivacySafe(discovered.sessions.map(({ file: _file, ...scan }) => scan));

    const candidate =
      discovered.sessions.find((session) => session.coverage.hasNativePlan) ?? discovered.sessions[0];
    const scan = await scanClaudeSession(candidate.file);
    assert.equal(scan.metadata.nativeSessionId, candidate.metadata.nativeSessionId);
    assertPrivacySafe(scan);
    for (const event of scan.events) {
      assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
      assert.match(event.native_session_id, /^claude-session-[a-f0-9]{20}$/);
      if (Array.isArray(event.data.steps)) {
        for (const [index, step] of event.data.steps.entries()) {
          assert.equal(step.label, `步骤 ${index + 1}`);
        }
      }
    }
  },
);
