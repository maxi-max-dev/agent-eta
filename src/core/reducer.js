import { assertValidEvent, isKnownEventKind } from "./contract.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function createRunState(runId) {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new TypeError("runId must be a non-empty string");
  }

  return {
    runId,
    provider: null,
    modelFamily: null,
    projectId: null,
    taskClass: null,
    userId: null,
    modelSelfEtaMinutes: null,
    initialStepCount: null,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    activeElapsedMs: 0,
    activeSinceAt: null,
    lastOccurredAt: null,
    currentStep: null,
    steps: [],
    planRevision: 0,
    retryCount: 0,
    reason: "等待任务开始",
    needsInput: null,
    providerWait: null,
    subruns: [],
    seenEventIds: [],
    lastEventId: null,
  };
}

function copyState(state) {
  return structuredClone(state);
}

function eventTime(event) {
  return Date.parse(event.occurred_at);
}

function isoAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function effectiveTime(state, event) {
  const eventMs = eventTime(event);
  const lastMs = state.lastOccurredAt === null ? eventMs : Date.parse(state.lastOccurredAt);
  return Math.max(eventMs, lastMs);
}

function advanceClock(state, effectiveMs) {
  if (state.activeSinceAt !== null && state.status === "running") {
    state.activeElapsedMs += Math.max(0, effectiveMs - Date.parse(state.activeSinceAt));
    state.activeSinceAt = isoAt(effectiveMs);
  }
  state.lastOccurredAt = isoAt(effectiveMs);
}

function currentStepFrom(steps) {
  return (
    steps.find((step) => step.status === "in_progress") ??
    steps.find((step) => step.status === "pending") ??
    null
  );
}

function refreshCurrentStep(state) {
  state.currentStep = currentStepFrom(state.steps);
}

function normalizeStep(input, revision, previous = null) {
  const explicitStatus = input.status;
  const retained = previous === null ? {} : previous;
  const step = {
    ...retained,
    id: input.id,
    label: input.label,
    class: input.class,
    status: explicitStatus ?? retained.status ?? "pending",
    planRevision: revision,
    prior_minutes: input.prior_minutes ?? retained.prior_minutes ?? null,
    startedAt: retained.startedAt ?? null,
    startedActiveElapsedMs: retained.startedActiveElapsedMs ?? null,
    completedAt: retained.completedAt ?? null,
    actualMinutes: retained.actualMinutes ?? null,
    attempts: retained.attempts ?? [],
    retryCount: retained.retryCount ?? 0,
  };

  if (step.status === "pending" && explicitStatus === "pending") {
    step.startedAt = null;
    step.startedActiveElapsedMs = null;
    step.completedAt = null;
    step.actualMinutes = null;
  }
  return step;
}

function replacePlan(state, event) {
  const nextRevision = event.data.revision ?? state.planRevision + 1;
  const previousById = new Map(state.steps.map((step) => [step.id, step]));
  state.steps = event.data.steps.map((step) =>
    normalizeStep(step, nextRevision, previousById.get(step.id) ?? null),
  );
  state.planRevision = nextRevision;
  refreshCurrentStep(state);
}

function completeStep(state, event, effectiveMs) {
  const step = state.steps.find((candidate) => candidate.id === event.data.step_id);
  if (step === undefined) return false;

  const durationMs =
    step.startedActiveElapsedMs === null
      ? null
      : Math.max(0, state.activeElapsedMs - step.startedActiveElapsedMs);
  const actualMinutes =
    Number.isFinite(event.data.actual_minutes) && event.data.actual_minutes >= 0
      ? event.data.actual_minutes
      : durationMs === null
        ? null
        : durationMs / 60_000;

  step.status = "completed";
  step.completedAt = isoAt(effectiveMs);
  step.actualMinutes = actualMinutes;
  step.attempts.push({
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    actualMinutes,
    outcome: event.data.outcome ?? "completed",
  });
  refreshCurrentStep(state);
  return true;
}

function beginRetry(state, event, effectiveMs) {
  const step = state.steps.find((candidate) => candidate.id === event.data.step_id);
  state.retryCount += 1;
  if (step === undefined) return;

  step.status = "in_progress";
  step.retryCount += 1;
  step.startedAt = isoAt(effectiveMs);
  step.startedActiveElapsedMs = state.activeElapsedMs;
  step.completedAt = null;
  step.actualMinutes = null;
  refreshCurrentStep(state);
}

function startSubrun(state, event, effectiveMs) {
  const existing = state.subruns.find((subrun) => subrun.id === event.data.subrun_id);
  const next = {
    ...(existing ?? {}),
    id: event.data.subrun_id,
    label: event.data.label ?? event.data.subrun_id,
    status: "running",
    startedAt: isoAt(effectiveMs),
    finishedAt: null,
    outcome: null,
    parallel: event.data.parallel !== false,
    estimatedMinutes: event.data.estimated_minutes ?? null,
    actualMinutes: null,
  };
  if (existing === undefined) state.subruns.push(next);
  else Object.assign(existing, next);
}

function finishSubrun(state, event, effectiveMs) {
  let subrun = state.subruns.find((candidate) => candidate.id === event.data.subrun_id);
  if (subrun === undefined) {
    subrun = {
      id: event.data.subrun_id,
      label: event.data.label ?? event.data.subrun_id,
      status: "running",
      startedAt: isoAt(effectiveMs),
      finishedAt: null,
      outcome: null,
      parallel: true,
      estimatedMinutes: event.data.estimated_minutes ?? null,
      actualMinutes: null,
    };
    state.subruns.push(subrun);
  }
  const actualMinutes =
    Number.isFinite(event.data.actual_minutes) && event.data.actual_minutes >= 0
      ? event.data.actual_minutes
      : Math.max(0, effectiveMs - Date.parse(subrun.startedAt)) / 60_000;
  subrun.status = event.data.outcome === "failed" ? "failed" : "finished";
  subrun.finishedAt = isoAt(effectiveMs);
  subrun.outcome = event.data.outcome ?? "succeeded";
  subrun.actualMinutes = actualMinutes;
}

/**
 * Pure, deterministic truth projection. The input state is never mutated.
 * Callers persist the raw event separately; unknown kinds are acknowledged in
 * `seenEventIds` but intentionally do not change semantic state.
 */
export function reduceEvent(previousState, event) {
  assertValidEvent(event);
  if (previousState?.runId !== event.run_id) {
    throw new TypeError(`Event run_id ${event.run_id} does not match reducer state`);
  }
  if (previousState.seenEventIds.includes(event.event_id)) return previousState;

  const state = copyState(previousState);
  const effectiveMs = effectiveTime(state, event);
  advanceClock(state, effectiveMs);
  state.seenEventIds.push(event.event_id);
  state.lastEventId = event.event_id;

  // The first terminal truth wins. Later events remain deduplicated/auditable
  // without being able to resurrect or rewrite an already finished run.
  if (TERMINAL_STATUSES.has(previousState.status)) return state;
  if (!isKnownEventKind(event.kind)) return state;

  switch (event.kind) {
    case "run_started":
      state.status = "running";
      state.startedAt ??= isoAt(effectiveMs);
      state.activeSinceAt = isoAt(effectiveMs);
      state.provider = event.provider;
      state.modelFamily = event.data.model_family ?? null;
      state.projectId = event.data.project_id ?? null;
      state.taskClass = event.data.task_class ?? null;
      state.userId = event.data.user_id ?? null;
      state.modelSelfEtaMinutes = event.data.model_self_eta_minutes ?? null;
      state.reason = event.data.reason ?? "任务已开始";
      break;
    case "plan_declared":
      replacePlan(state, event);
      state.initialStepCount ??= event.data.steps.length;
      state.reason = event.data.reason ?? "已读取计划，按剩余步骤重算";
      break;
    case "plan_revised":
      replacePlan(state, event);
      state.reason = event.data.reason ?? "计划已调整，剩余工作发生变化";
      break;
    case "step_started": {
      const step = state.steps.find((candidate) => candidate.id === event.data.step_id);
      if (step !== undefined) {
        step.status = "in_progress";
        step.startedAt = isoAt(effectiveMs);
        step.startedActiveElapsedMs = state.activeElapsedMs;
        step.completedAt = null;
        step.actualMinutes = null;
        refreshCurrentStep(state);
        state.reason = event.data.reason ?? `开始${step.label}`;
      }
      break;
    }
    case "step_completed": {
      const label = state.steps.find((step) => step.id === event.data.step_id)?.label;
      if (completeStep(state, event, effectiveMs)) {
        state.reason =
          event.data.reason ?? `${label}已完成，已按本轮实际速度更新`;
      }
      break;
    }
    case "retry_started": {
      const label = state.steps.find((step) => step.id === event.data.step_id)?.label;
      beginRetry(state, event, effectiveMs);
      state.reason = event.data.reason ?? `${label ?? event.data.step_id}正在重试，预计用时延长`;
      break;
    }
    case "scope_expanded": {
      const revision = event.data.revision ?? state.planRevision + 1;
      const existingIds = new Set(state.steps.map((step) => step.id));
      const additions = event.data.steps
        .filter((step) => !existingIds.has(step.id))
        .map((step) => normalizeStep(step, revision));
      state.steps.push(...additions);
      state.planRevision = revision;
      refreshCurrentStep(state);
      state.reason = event.data.reason ?? "工作范围扩大，预计用时延长";
      break;
    }
    case "waiting_provider":
      state.status = "waiting_provider";
      state.activeSinceAt = null;
      state.providerWait = {
        since: isoAt(effectiveMs),
        provider: event.data.provider ?? event.provider,
        reason: event.data.reason ?? null,
      };
      state.reason = event.data.reason ?? "正在等待服务，主动工作计时已暂停";
      break;
    case "needs_input":
      state.status = "needs_input";
      state.activeSinceAt = null;
      state.providerWait = null;
      state.needsInput = {
        since: isoAt(effectiveMs),
        prompt: event.data.prompt ?? null,
        postResponseLowerMinutes: event.data.post_response_lower_minutes ?? null,
        postResponseP80Minutes: event.data.post_response_p80_minutes ?? null,
      };
      state.reason = event.data.reason ?? "正在等你回复，倒计时已暂停";
      break;
    case "resumed":
      state.status = "running";
      state.activeSinceAt = isoAt(effectiveMs);
      state.needsInput = null;
      state.providerWait = null;
      state.reason = event.data.reason ?? "已收到回复，按主动工作时间继续估算";
      break;
    case "subrun_started":
      startSubrun(state, event, effectiveMs);
      state.reason = event.data.reason ?? "并行子任务已开始";
      break;
    case "subrun_finished":
      finishSubrun(state, event, effectiveMs);
      state.reason = event.data.reason ?? "并行子任务已完成，ETA 已更新";
      break;
    case "run_succeeded":
    case "run_failed":
    case "run_cancelled":
      state.status = event.kind.slice("run_".length).replace("cancelled", "cancelled");
      state.finishedAt = isoAt(effectiveMs);
      state.activeSinceAt = null;
      state.needsInput = null;
      state.providerWait = null;
      state.currentStep = null;
      state.reason =
        event.data.reason ??
        (event.kind === "run_succeeded"
          ? "任务已完成"
          : event.kind === "run_failed"
            ? "任务运行失败"
            : "任务已取消");
      break;
    case "heartbeat":
      break;
  }

  return state;
}
