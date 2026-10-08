import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { discoverClaudeSessions, scanClaudeSession, scanClaudeTurns } from "../src/adapters/claude.js";
import { validateEvent } from "../src/core/contract.js";

const baseFixture = new URL("../fixtures/adapter-shapes/claude-turns-base.jsonl", import.meta.url);
const appendedFixture = new URL("../fixtures/adapter-shapes/claude-turns-appended.jsonl", import.meta.url);
const branchFixture = new URL("../fixtures/adapter-shapes/claude-turns-branch.jsonl", import.meta.url);
const noSessionFixture = new URL("../fixtures/adapter-shapes/claude-turns-no-session.jsonl", import.meta.url);
const ambiguousFixture = new URL("../fixtures/adapter-shapes/claude-turns-ambiguous.jsonl", import.meta.url);

function runs(scan) {
  const grouped = new Map();
  for (const event of scan.events) {
    if (!grouped.has(event.run_id)) grouped.set(event.run_id, []);
    grouped.get(event.run_id).push(event);
  }
  return [...grouped.entries()]
    .map(([runId, events]) => ({ runId, events }))
    .sort((a, b) => Date.parse(a.events[0].occurred_at) - Date.parse(b.events[0].occurred_at));
}

function assertNoTranscriptPayload(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /SANITIZED/);
  assert.doesNotMatch(serialized, /human-[123]|assistant-1|done-[12]|branch-human/);
  assert.doesNotMatch(serialized, /11111111-1111-4111-8111-111111111111/);
  const forbiddenKeys = new Set(["prompt", "subject", "description", "questions", "command", "code", "cwd", "file_path"]);
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden output key: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("turn mode recognizes only primary human boundaries and fails closed on an unfinished turn", async () => {
  const scan = await scanClaudeTurns(fileURLToPath(baseFixture));
  const grouped = runs(scan);

  assert.equal(scan.coverage.turnSegmentation, "structural-ancestry-v1");
  assert.equal(scan.coverage.humanTurnCount, 2);
  assert.equal(scan.coverage.terminalHumanTurnCount, 1);
  assert.equal(scan.coverage.nonterminalHumanTurnCount, 1);
  assert.equal(scan.coverage.plannedHumanTurnCount, 1);
  assert.equal(scan.coverage.orphanConversationRecordCount, 0);
  assert.equal(scan.coverage.unsegmentableHumanBoundaryCount, 0);
  assert.equal(scan.coverage.metaConversationRecordCount, 1);
  assert.equal(scan.coverage.turnIdentityEligible, true);
  assert.equal(scan.coverage.mappedTaskCreateCount, 0);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].events.map((event) => event.kind), ["run_started", "plan_declared"]);
  assert.deepEqual(grouped[1].events.map((event) => event.kind), ["run_started", "needs_input"]);
  assert.equal(scan.events.filter((event) => event.kind === "run_succeeded").length, 0);
  for (const event of scan.events) assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
  assertNoTranscriptPayload(scan);
});

test("meta user envelopes never become turns and ambiguous terminal branches emit no events", async () => {
  const scan = await scanClaudeTurns(fileURLToPath(ambiguousFixture));
  assert.equal(scan.coverage.humanTurnCount, 3);
  assert.equal(scan.coverage.terminalHumanTurnCount, 0);
  assert.equal(scan.coverage.ambiguousHumanTurnCount, 3);
  assert.equal(scan.coverage.multipleTerminalHumanTurnCount, 2);
  assert.equal(scan.coverage.mixedTerminalLeafHumanTurnCount, 1);
  assert.equal(scan.coverage.duplicateRecordUuidCount, 1);
  assert.deepEqual(scan.events, []);
  assertNoTranscriptPayload(scan);
});

test("turn events fail closed when the stable native session component is absent", async () => {
  const scan = await scanClaudeTurns(fileURLToPath(noSessionFixture));
  assert.equal(scan.coverage.humanTurnCount, 1);
  assert.equal(scan.coverage.terminalHumanTurnCount, 1);
  assert.equal(scan.coverage.turnIdentityEligible, false);
  assert.deepEqual(scan.events, []);
  assertNoTranscriptPayload(scan);
});

test("appending and reopening preserves every event of already completed turns", async () => {
  const [before, after] = await Promise.all([scanClaudeTurns(fileURLToPath(baseFixture)), scanClaudeTurns(fileURLToPath(appendedFixture))]);
  const beforeRuns = runs(before);
  const afterRuns = runs(after);

  assert.equal(after.coverage.humanTurnCount, 3);
  assert.equal(after.coverage.terminalHumanTurnCount, 2);
  assert.equal(after.coverage.nonterminalHumanTurnCount, 1);
  assert.equal(afterRuns.length, 3);
  assert.equal(beforeRuns[0].runId, afterRuns[0].runId);
  assert.deepEqual(beforeRuns[0].events, afterRuns[0].events);
  assert.equal(beforeRuns[1].runId, afterRuns[1].runId);
  assert.deepEqual(
    beforeRuns[1].events,
    afterRuns[1].events.slice(0, beforeRuns[1].events.length),
  );
  assert.equal(afterRuns[1].events.at(-1).kind, "resumed");
  assert.notEqual(afterRuns[2].events.at(-1).kind, "run_succeeded");
  assert.deepEqual(afterRuns[2].events.map((event) => event.kind), ["run_started"]);
  assertNoTranscriptPayload(after);
});

test("a copied branch preserves shared turn identity without merging its divergent turn", async () => {
  const [base, branch] = await Promise.all([scanClaudeTurns(fileURLToPath(baseFixture)), scanClaudeTurns(fileURLToPath(branchFixture))]);
  const baseRuns = runs(base);
  const branchRuns = runs(branch);

  assert.equal(baseRuns[0].runId, branchRuns[0].runId);
  assert.deepEqual(baseRuns[0].events, branchRuns[0].events);
  assert.notEqual(baseRuns[1].runId, branchRuns[1].runId);
  assert.equal(branchRuns[1].events.at(-1).kind, "run_started");
  assertNoTranscriptPayload(branch);
});

test("turn mode never emits an irreversible terminal from mutable transcript envelopes", async () => {
  const [before, after, branch] = await Promise.all([
    scanClaudeTurns(fileURLToPath(baseFixture)),
    scanClaudeTurns(fileURLToPath(appendedFixture)),
    scanClaudeTurns(fileURLToPath(branchFixture)),
  ]);
  for (const scan of [before, after, branch]) {
    assert.equal(scan.events.some((event) => event.kind.startsWith("run_") && event.kind !== "run_started"), false);
  }
});

test("legacy session events remain the default and explicit turn option matches helper", async () => {
  const legacy = await scanClaudeSession(fileURLToPath(baseFixture));
  const explicit = await scanClaudeSession(fileURLToPath(baseFixture), { segmentation: "turns" });
  const helper = await scanClaudeTurns(fileURLToPath(baseFixture));

  assert.equal(new Set(legacy.events.map((event) => event.run_id)).size, 1);
  assert.deepEqual(explicit.events, helper.events);
  await assert.rejects(
    scanClaudeSession(fileURLToPath(baseFixture), { segmentation: "messages" }),
    /segmentation must be either/,
  );
});

test("discovery exposes aggregate turn eligibility without event or transcript payloads", async () => {
  const discovery = await discoverClaudeSessions({ root: fileURLToPath(appendedFixture), since: 0 });
  assert.equal(discovery.coverage.humanTurns, 3);
  assert.equal(discovery.coverage.terminalHumanTurns, 2);
  assert.equal(discovery.coverage.nonterminalHumanTurns, 1);
  assert.equal(discovery.coverage.plannedHumanTurns, 1);
  assert.equal(discovery.coverage.humanTurnPlanCoverage, 1 / 3);
  assert.equal(discovery.coverage.orphanConversationRecords, 0);
  assert.equal(discovery.coverage.unsegmentableHumanBoundaries, 0);
  assert.equal(discovery.coverage.metaConversationRecords, 1);
  assertNoTranscriptPayload(discovery.sessions.map(({ file: _file, ...scan }) => scan));
});
