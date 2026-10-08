import assert from "node:assert/strict";
import test from "node:test";

import { forecastRun } from "../src/core/estimator.js";

const NOW = "2026-08-29T01:00:00.000Z";

function plannedState(overrides = {}) {
  return {
    runId: "run-plan",
    status: "running",
    startedAt: "2026-08-29T00:50:00.000Z",
    activeElapsedMs: 10 * 60_000,
    provider: "codex",
    modelFamily: "gpt-demo",
    projectId: "eta",
    userId: "max",
    planRevision: 1,
    retryCount: 0,
    steps: [
      { id: "inspect", label: "Inspect", class: "inspect", status: "active", priorMinutes: 5 },
      { id: "edit", label: "Edit", class: "edit", status: "pending", priorMinutes: 9 },
      { id: "test", label: "Test", class: "test", status: "pending", priorMinutes: 7 },
    ],
    subruns: [],
    ...overrides,
  };
}

function forecast(state, history = [], seed = "fixed") {
  return forecastRun({ state, history, now: NOW, seed });
}

test("no-plan tasks use deterministic conditional-survival fallback", () => {
  const state = {
    runId: "fallback",
    status: "running",
    startedAt: "2026-08-29T00:55:00.000Z",
    activeElapsedMs: 5 * 60_000,
    steps: [],
  };
  const history = Array.from({ length: 12 }, (_, index) => ({ actualMinutes: 24 + index }));

  const first = forecast(state, history, "survival-seed");
  const again = forecast(state, history, "survival-seed");

  assert.deepEqual(first, again);
  assert.equal(first.mode, "run_fallback");
  assert.equal(first.status, "forecast");
  assert.equal(first.raw.source, "comparable_run_survival");
  assert.equal(first.raw.conditionalOnActiveMinutes, 5);
  assert.ok(first.lowerMinutes < first.p50Minutes);
  assert.ok(first.p50Minutes < first.p80Minutes);
});

test("conditional survival subtracts observed active time without going negative", () => {
  const history = Array.from({ length: 30 }, (_, index) => ({ actualMinutes: 28 + (index % 5) }));
  const cold = forecast({ status: "running", activeElapsedMs: 0, steps: [] }, history, "elapsed");
  const elapsed = forecast(
    { status: "running", activeElapsedMs: 10 * 60_000, steps: [] },
    history,
    "elapsed",
  );

  assert.ok(elapsed.p50Minutes < cold.p50Minutes, `${elapsed.p50Minutes} < ${cold.p50Minutes}`);
  assert.ok(elapsed.lowerMinutes > 0);
});

test("an active flat plan is summed sequentially and never treated as a DAG", () => {
  const result = forecast(plannedState());

  assert.equal(result.mode, "plan_conditioned");
  assert.equal(result.raw.source, "ordered_plan_sum");
  assert.equal(result.raw.remainingStepCount, 3);
  assert.equal(result.raw.sharedRunMultiplier, true);
  assert.equal(result.raw.learnedStepPriorsUsed, false);
  assert.ok(result.p50Minutes > 18);
});

test("within-run log pace shrinks toward one after each completed step", () => {
  const fastStep = { id: "inspect", class: "inspect", status: "completed", priorMinutes: 5, actualMinutes: 1 };
  const onTimeStep = { ...fastStep, actualMinutes: 5 };
  const slowStep = { ...fastStep, actualMinutes: 15 };
  const remaining = [
    { id: "edit", class: "edit", status: "active", priorMinutes: 9 },
    { id: "test", class: "test", status: "pending", priorMinutes: 7 },
  ];

  const fast = forecast(plannedState({ steps: [fastStep, ...remaining] }), [], "pace");
  const onTime = forecast(plannedState({ steps: [onTimeStep, ...remaining] }), [], "pace");
  const slow = forecast(plannedState({ steps: [slowStep, ...remaining] }), [], "pace");

  assert.ok(fast.paceMultiplier > 0.62 && fast.paceMultiplier < 1);
  assert.equal(onTime.paceMultiplier, 1);
  assert.ok(slow.paceMultiplier > 1 && slow.paceMultiplier < 1.65);
  assert.ok(fast.p50Minutes < onTime.p50Minutes);
  assert.ok(onTime.p50Minutes < slow.p50Minutes);
  assert.equal(fast.raw.completedPaceObservationCount, 1);
});

test("a shared run draw prevents many-step P80 from becoming falsely narrow", () => {
  const steps = Array.from({ length: 40 }, (_, index) => ({
    id: `step-${index}`,
    class: "other",
    status: index === 0 ? "active" : "pending",
    priorMinutes: 2,
  }));
  const result = forecast(plannedState({ steps }), [], "correlation");

  assert.equal(result.raw.sharedRunLogSigma, 0.34);
  assert.ok(result.p80Minutes / result.p50Minutes > 1.2);
});

test("retry and replan add work immediately and explain the extension", () => {
  const oneStep = [{ id: "test", class: "test", status: "active", priorMinutes: 7 }];
  const base = forecast(plannedState({ steps: oneStep, currentStep: "test" }), [], "change");
  const retry = forecast(
    plannedState({ steps: oneStep, currentStep: "test", retryCount: 1 }),
    [],
    "change",
  );
  const replan = forecast(
    plannedState({
      steps: [...oneStep, { id: "review", class: "review", status: "pending", priorMinutes: 5 }],
      planRevision: 2,
    }),
    [],
    "change",
  );

  assert.ok(retry.p50Minutes > base.p50Minutes);
  assert.ok(retry.raw.retryPenaltyMinutes > 0);
  assert.match(retry.reason, /重试|返工/);
  assert.ok(replan.p50Minutes > base.p50Minutes);
  assert.match(replan.reason, /计划已调整/);
});

test("needs_input pauses the clock but preserves a post-response range", () => {
  const result = forecast(
    plannedState({
      status: "needs_input",
      needsInput: { postResponseLowerMinutes: 7, postResponseP80Minutes: 13 },
    }),
  );

  assert.equal(result.status, "needs_input");
  assert.equal(result.lowerMinutes, 7);
  assert.equal(result.p50Minutes, 10);
  assert.equal(result.p80Minutes, 13);
  assert.equal(result.raw.needsInputPostResponse, true);
  assert.equal(result.raw.postResponseRangeSource, "event_contract");
  assert.match(result.reason, /等你回复/);
});

test("terminal runs return a zero ETA", () => {
  const result = forecast(
    plannedState({ status: "succeeded", finishedAt: "2026-08-29T01:00:00.000Z" }),
  );

  assert.equal(result.status, "terminal");
  assert.equal(result.p50Minutes, 0);
  assert.equal(result.p80Minutes, 0);
  assert.equal(result.lowerMinutes, 0);
});

test("only finished, observable subruns provide bounded parallel credit", () => {
  const baseState = plannedState({
    steps: [{ id: "edit", class: "edit", status: "active", priorMinutes: 20 }],
  });
  const active = forecast(
    { ...baseState, subruns: [{ id: "sub", status: "running", durationMinutes: 8 }] },
    [],
    "parallel",
  );
  const finished = forecast(
    { ...baseState, subruns: [{ id: "sub", status: "finished", durationMinutes: 8 }] },
    [],
    "parallel",
  );

  assert.equal(active.raw.appliedParallelCreditMinutes, 0);
  assert.ok(finished.raw.appliedParallelCreditMinutes > 0);
  assert.ok(finished.p50Minutes < active.p50Minutes);
  assert.match(finished.reason, /并行子任务/);
});

test("personal/provider/model/project residuals stay disabled until 20 histories", () => {
  const makeHistory = (count) =>
    Array.from({ length: count }, () => ({
      actualMinutes: 12,
      initialForecastMinutes: 12,
      residualMultiplier: 1.5,
      initialStepCount: 2,
      finalStepCount: 2,
      provider: "codex",
      modelFamily: "gpt-demo",
      projectId: "eta",
      userId: "max",
    }));
  const cold = forecast(plannedState(), makeHistory(19), "personal");
  const personalized = forecast(plannedState(), makeHistory(20), "personal");

  assert.equal(cold.raw.historyCount, 19);
  assert.equal(cold.raw.personalizationEligible, false);
  assert.equal(cold.personalMultiplier, 1);
  assert.equal(personalized.raw.historyCount, 20);
  assert.equal(personalized.raw.personalizationEligible, true);
  assert.ok(personalized.personalMultiplier > 1.15);
  assert.ok(personalized.p50Minutes > cold.p50Minutes);
  assert.ok(personalized.raw.personalizationComponents.length >= 1);
  assert.ok(personalized.raw.personalizationComponents.some((component) => component.name === "model"));
});

test("the 20-run gate counts only comparable task histories", () => {
  const target = Array.from({ length: 19 }, () => ({
    actualMinutes: 10,
    initialForecastMinutes: 10,
    residualMultiplier: 1.4,
    taskClass: "coding",
  }));
  const unrelated = Array.from({ length: 20 }, () => ({
    actualMinutes: 60,
    initialForecastMinutes: 10,
    residualMultiplier: 1.5,
    taskClass: "research",
  }));
  const result = forecast(plannedState({ taskClass: "coding" }), [...target, ...unrelated]);

  assert.equal(result.raw.totalHistoryCount, 39);
  assert.equal(result.raw.historyCount, 19);
  assert.equal(result.raw.personalizationEligible, false);
  assert.equal(result.personalMultiplier, 1);
});

test("activeSinceAt advances fallback survival only while the run is active", () => {
  const history = Array.from({ length: 20 }, () => ({ actualMinutes: 30 }));
  const result = forecast(
    {
      status: "running",
      activeElapsedMs: 0,
      activeSinceAt: "2026-08-29T00:50:00.000Z",
      steps: [],
    },
    history,
    "active-since",
  );

  assert.equal(result.raw.conditionalOnActiveMinutes, 10);
});

test("hidden-work step and duration log-ratios are EB-shrunk", () => {
  const histories = Array.from({ length: 8 }, () => ({
    actualMinutes: 24,
    initialForecastMinutes: 12,
    initialStepCount: 2,
    finalStepCount: 4,
  }));
  const cold = forecast(plannedState(), [], "hidden");
  const learned = forecast(plannedState(), histories, "hidden");

  assert.equal(learned.raw.hiddenWorkStepRatioCount, 8);
  assert.equal(learned.raw.hiddenWorkDurationRatioCount, 8);
  assert.ok(learned.raw.hiddenWorkMultiplier > 1);
  assert.ok(learned.raw.hiddenWorkMultiplier < 2);
  assert.ok(learned.p50Minutes > cold.p50Minutes);
});

test("class-by-provider step priors activate only at 100 completed runs", () => {
  const makeHistory = (count) =>
    Array.from({ length: count }, () => ({
      actualMinutes: 20,
      provider: "codex",
      steps: [{ id: "test", class: "test", status: "completed", actualMinutes: 20 }],
    }));
  const state = plannedState({
    steps: [{ id: "test", class: "test", status: "active" }],
  });
  const before = forecast(state, makeHistory(99), "step-prior");
  const after = forecast(state, makeHistory(100), "step-prior");

  assert.equal(before.raw.learnedStepPriorsEligible, false);
  assert.equal(before.raw.learnedStepPriorsUsed, false);
  assert.equal(after.raw.learnedStepPriorsEligible, true);
  assert.equal(after.raw.learnedStepPriorsUsed, true);
  assert.equal(after.raw.stepPriors[0].source, "class_provider_history");
  assert.ok(after.p50Minutes > before.p50Minutes);
});
