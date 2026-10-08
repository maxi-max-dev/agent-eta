import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createRunState, reduceEvent } from "../src/core/reducer.js";

const fixtureDirectory = new URL("../fixtures/replays/", import.meta.url);

async function loadFixture(id) {
  return JSON.parse(await readFile(new URL(`${id}.json`, fixtureDirectory), "utf8"));
}

function replay(events, count = events.length) {
  let state = createRunState(events[0].run_id);
  for (const event of events.slice(0, count)) state = reduceEvent(state, event);
  return state;
}

function event(overrides = {}) {
  return {
    schema_version: "agenteta.event/1",
    event_id: "event-1",
    run_id: "synthetic-run",
    provider: "generic",
    native_session_id: "synthetic",
    occurred_at: "2026-08-29T00:00:00.000Z",
    observed_at: "2026-08-29T00:00:00.000Z",
    kind: "heartbeat",
    source: { adapter: "test", mode: "simulated_contract", confidence: 1 },
    data: {},
    ...overrides,
  };
}

test("no-plan replay remains planless and records active outcome time", async () => {
  const fixture = await loadFixture("no-plan-fallback");
  const state = replay(fixture.events);
  assert.equal(state.status, "succeeded");
  assert.equal(state.steps.length, 0);
  assert.equal(state.planRevision, 0);
  assert.equal(state.activeElapsedMs, 14 * 60_000);
  assert.equal(state.finishedAt, "2026-08-29T01:14:00.000Z");
  assert.doesNotThrow(() => JSON.stringify(state));
});

test("plan completion captures within-run active pace without mutating prior state", async () => {
  const fixture = await loadFixture("plan-pace-cold");
  let state = createRunState(fixture.events[0].run_id);
  let beforeCompletion;
  for (const replayEvent of fixture.events) {
    if (replayEvent.event_id === "pace-cold-04") beforeCompletion = state;
    const next = reduceEvent(state, replayEvent);
    assert.notEqual(next, state);
    state = next;
  }

  assert.equal(beforeCompletion.steps[0].status, "in_progress");
  assert.equal(beforeCompletion.steps[0].attempts.length, 0);
  assert.deepEqual(
    state.steps.map((step) => step.actualMinutes),
    [2, 4, 3],
  );
  assert.equal(state.currentStep, null);
});

test("duplicate ids are idempotent and a terminal run cannot be resurrected", async () => {
  const fixture = await loadFixture("no-plan-fallback");
  const started = replay(fixture.events, 1);
  const duplicate = reduceEvent(started, fixture.events[0]);
  assert.equal(duplicate, started);
  assert.equal(duplicate.seenEventIds.length, 1);

  const terminal = replay(fixture.events);
  const lateResume = event({
    event_id: "late-resume",
    run_id: terminal.runId,
    kind: "resumed",
    occurred_at: "2026-08-29T01:20:00.000Z",
    observed_at: "2026-08-29T01:20:00.000Z",
  });
  const after = reduceEvent(terminal, lateResume);
  assert.equal(after.status, "succeeded");
  assert.equal(after.finishedAt, terminal.finishedAt);
  assert.equal(after.reason, terminal.reason);
  assert.equal(after.activeElapsedMs, terminal.activeElapsedMs);
  assert.ok(after.seenEventIds.includes("late-resume"));
});

test("retry and plan revision preserve observations while adding explicit work", async () => {
  const fixture = await loadFixture("retry-replan");
  const afterRetry = replay(fixture.events, 9);
  assert.equal(afterRetry.retryCount, 1);
  assert.equal(afterRetry.currentStep.id, "test");
  assert.equal(afterRetry.steps.find((step) => step.id === "test").attempts.length, 1);

  const revised = replay(fixture.events, 10);
  assert.equal(revised.planRevision, 2);
  assert.deepEqual(
    revised.steps.map((step) => step.id),
    ["inspect", "edit", "diagnose", "test"],
  );
  assert.equal(revised.steps.find((step) => step.id === "inspect").actualMinutes, 2);
  assert.equal(revised.steps.find((step) => step.id === "test").retryCount, 1);
  assert.match(revised.reason, /诊断/);

  const final = replay(fixture.events);
  const testStep = final.steps.find((step) => step.id === "test");
  assert.equal(final.status, "succeeded");
  assert.equal(testStep.attempts.length, 2);
  assert.equal(testStep.retryCount, 1);
});

test("needs_input and provider waits freeze active elapsed until explicit resume", async () => {
  const fixture = await loadFixture("needs-input");
  const waiting = replay(fixture.events, 4);
  const waitingHeartbeat = replay(fixture.events, 5);
  assert.equal(waiting.status, "needs_input");
  assert.equal(waitingHeartbeat.activeElapsedMs, waiting.activeElapsedMs);
  assert.equal(waitingHeartbeat.needsInput.prompt, "请选择兼容模式或严格模式");

  const resumed = replay(fixture.events, 6);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.needsInput, null);
  const final = replay(fixture.events);
  assert.equal(final.activeElapsedMs, 12 * 60_000 + 25_000);

  let providerState = createRunState("synthetic-run");
  providerState = reduceEvent(
    providerState,
    event({ event_id: "start", kind: "run_started" }),
  );
  providerState = reduceEvent(
    providerState,
    event({
      event_id: "wait",
      kind: "waiting_provider",
      occurred_at: "2026-08-29T00:02:00.000Z",
      observed_at: "2026-08-29T00:02:00.000Z",
      data: { reason: "Provider queue" },
    }),
  );
  providerState = reduceEvent(
    providerState,
    event({
      event_id: "resume",
      kind: "resumed",
      occurred_at: "2026-08-29T00:12:00.000Z",
      observed_at: "2026-08-29T00:12:00.000Z",
    }),
  );
  providerState = reduceEvent(
    providerState,
    event({
      event_id: "done",
      kind: "run_succeeded",
      occurred_at: "2026-08-29T00:15:00.000Z",
      observed_at: "2026-08-29T00:15:00.000Z",
    }),
  );
  assert.equal(providerState.activeElapsedMs, 5 * 60_000);
});

test("parallel work exists only after explicit subrun events and records early finish", async () => {
  const fixture = await loadFixture("parallel-early-subrun");
  const before = replay(fixture.events, 5);
  assert.deepEqual(before.subruns, []);

  const running = replay(fixture.events, 6);
  assert.equal(running.subruns[0].status, "running");
  assert.equal(running.subruns[0].parallel, true);
  assert.equal(running.subruns[0].estimatedMinutes, 8);

  const finished = replay(fixture.events, 7);
  assert.equal(finished.subruns[0].status, "finished");
  assert.equal(finished.subruns[0].actualMinutes, 3);
  assert.match(finished.reason, /提前五分钟/);
});

test("unknown future events are acknowledged but leave semantic projection unchanged", () => {
  let state = createRunState("synthetic-run");
  state = reduceEvent(state, event({ event_id: "start", kind: "run_started" }));
  const unknown = event({
    event_id: "future",
    kind: "new_native_signal",
    occurred_at: "2026-08-29T00:01:00.000Z",
    observed_at: "2026-08-29T00:01:00.000Z",
    data: { any: "shape" },
  });
  const after = reduceEvent(state, unknown);
  assert.equal(after.status, "running");
  assert.equal(after.reason, state.reason);
  assert.deepEqual(after.steps, state.steps);
  assert.ok(after.seenEventIds.includes("future"));
});

test("events cannot be reduced into a different run", () => {
  assert.throws(
    () => reduceEvent(createRunState("other-run"), event()),
    /does not match reducer state/,
  );
});
