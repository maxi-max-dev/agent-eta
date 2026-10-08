const MINUTE_MS = 60_000;
const SAMPLE_COUNT = 2_048;

const PUBLIC_STEP_PRIORS = Object.freeze({
  inspect: 5,
  edit: 9,
  test: 7,
  review: 5,
  external_wait: 10,
  other: 6,
});

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "completed",
  "complete",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
]);

const FINISHED_STEP_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "done",
  "skipped",
  "cancelled",
]);

export function forecastRun({ state = {}, history = [], now = new Date(), seed = 1 } = {}) {
  const allHistories = completedHistories(history);
  const histories = comparableHistories(allHistories, state);
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const hasPlan = steps.length > 0 && state.planActive !== false && state.planStale !== true;
  const mode = hasPlan ? "plan_conditioned" : "run_fallback";
  const historyCount = histories.length;

  if (isTerminal(state)) {
    return {
      mode,
      status: "terminal",
      p50Minutes: 0,
      p80Minutes: 0,
      lowerMinutes: 0,
      paceMultiplier: 1,
      personalMultiplier: 1,
      reason: terminalReason(state),
      raw: {
        historyCount,
        totalHistoryCount: allHistories.length,
        personalizationEligible: historyCount >= 20,
        sampleCount: 0,
        terminalStatus: state.status ?? "terminal",
      },
    };
  }

  const rng = createRng(seed);
  const context = stateContext(state);
  const hidden = estimateHiddenWork(histories);
  const personal = estimatePersonalResidual(histories, context, hidden);
  const parallel = observedParallelCredit(state);

  let result = hasPlan
    ? forecastPlan({ state, histories, rng, hidden, personal, parallel })
    : forecastFallback({ state, histories, rng, parallel, now });

  const needsInput = Boolean(state.needsInput) || state.status === "needs_input";
  if (needsInput) result = applyPostResponseRange(result, state.needsInput);
  return {
    mode,
    status: needsInput ? "needs_input" : result.status,
    p50Minutes: roundMinutes(result.p50Minutes),
    p80Minutes: roundMinutes(result.p80Minutes),
    lowerMinutes: roundMinutes(result.lowerMinutes),
    paceMultiplier: roundMultiplier(result.paceMultiplier),
    personalMultiplier: roundMultiplier(result.personalMultiplier),
    reason: forecastReason(state, result, needsInput),
    raw: {
      historyCount,
      totalHistoryCount: allHistories.length,
      personalizationEligible: historyCount >= 20,
      sampleCount: SAMPLE_COUNT,
      needsInputPostResponse: needsInput,
      ...result.raw,
    },
  };
}

function forecastFallback({ state, histories, rng, parallel, now }) {
  const totals = histories.map((row) => row.actualMinutes);
  const distribution = fitTotalDuration(totals);
  const elapsedMinutes = activeElapsedMinutes(state, now);
  const uncreditedSamples = [];

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const total = sampleConditionalLogNormal(
      distribution.mu,
      distribution.sigma,
      elapsedMinutes,
      rng,
    );
    uncreditedSamples.push(Math.max(0.05, total - elapsedMinutes));
  }

  const rawP50 = quantile(uncreditedSamples, 0.5);
  const parallelCreditMinutes = Math.min(parallel.minutes, rawP50 * 0.4);
  const samples = uncreditedSamples.map((value) => Math.max(0.05, value - parallelCreditMinutes));

  return {
    status: state.startedAt || state.status ? "forecast" : "warming_up",
    p50Minutes: quantile(samples, 0.5),
    p80Minutes: quantile(samples, 0.8),
    lowerMinutes: quantile(samples, 0.2),
    paceMultiplier: 1,
    personalMultiplier: 1,
    parallelCreditMinutes,
    raw: {
      source: totals.length > 0 ? "comparable_run_survival" : "wide_public_prior",
      conditionalOnActiveMinutes: elapsedMinutes,
      totalDurationLogMu: roundRaw(distribution.mu),
      totalDurationLogSigma: roundRaw(distribution.sigma),
      comparableDurationCount: totals.length,
      observedParallelMinutes: roundRaw(parallel.minutes),
      appliedParallelCreditMinutes: roundRaw(parallelCreditMinutes),
      parallelSubrunCount: parallel.count,
      sharedRunMultiplier: false,
      hiddenWorkMultiplier: 1,
      learnedStepPriorsEligible: histories.length >= 100,
    },
  };
}

function forecastPlan({ state, histories, rng, hidden, personal, parallel }) {
  const steps = state.steps;
  const unfinished = steps.filter((step) => !FINISHED_STEP_STATUSES.has(step.status));
  const pace = estimateWithinRunPace(steps);
  const priors = unfinished.map((step) => stepPrior(step, histories, state));
  const retryPenalty = estimateRetryPenalty(state, unfinished, priors);
  const closurePrior = unfinished.length === 0 ? 1.5 : 0;
  const deterministicMedian =
    (priors.reduce((total, prior) => total + prior.medianMinutes, 0) +
      retryPenalty.minutes +
      closurePrior) *
    pace.multiplier *
    hidden.multiplier *
    personal.multiplier;
  const parallelCreditMinutes = Math.min(parallel.minutes, deterministicMedian * 0.4);
  const samples = [];

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    // One shared draw keeps steps in a run correlated. Independent step noise is
    // deliberately smaller so adding steps cannot make the interval falsely tight.
    const sharedRunMultiplier = sampleLogNormalMedianOne(rng, 0.34);
    let sampledMinutes = closurePrior;
    for (const prior of priors) {
      sampledMinutes +=
        prior.medianMinutes * sampleLogNormalMedianOne(rng, prior.stepSigma ?? 0.2);
    }
    sampledMinutes += retryPenalty.minutes * sampleLogNormalMedianOne(rng, 0.16);
    sampledMinutes *=
      sharedRunMultiplier * pace.multiplier * hidden.multiplier * personal.multiplier;
    samples.push(Math.max(0.05, sampledMinutes - parallelCreditMinutes));
  }

  return {
    status: "forecast",
    p50Minutes: quantile(samples, 0.5),
    p80Minutes: quantile(samples, 0.8),
    lowerMinutes: quantile(samples, 0.2),
    paceMultiplier: pace.multiplier,
    personalMultiplier: personal.multiplier,
    parallelCreditMinutes,
    raw: {
      source: "ordered_plan_sum",
      remainingStepCount: unfinished.length,
      completedPaceObservationCount: pace.observationCount,
      paceLogMean: roundRaw(pace.logMean),
      paceShrinkage: roundRaw(pace.shrinkage),
      hiddenWorkMultiplier: roundRaw(hidden.multiplier),
      hiddenWorkStepRatioCount: hidden.stepRatioCount,
      hiddenWorkDurationRatioCount: hidden.durationRatioCount,
      hiddenWorkShrinkage: roundRaw(hidden.shrinkage),
      personalizationComponents: personal.components,
      retryPenaltyMinutes: roundRaw(retryPenalty.minutes),
      retryCountApplied: retryPenalty.count,
      observedParallelMinutes: roundRaw(parallel.minutes),
      appliedParallelCreditMinutes: roundRaw(parallelCreditMinutes),
      parallelSubrunCount: parallel.count,
      sharedRunMultiplier: true,
      sharedRunLogSigma: 0.34,
      independentStepLogSigma: 0.2,
      learnedStepPriorsEligible: histories.length >= 100,
      learnedStepPriorsUsed: priors.some((prior) => prior.learned),
      stepPriors: priors.map((prior) => ({
        stepId: prior.stepId,
        class: prior.className,
        medianMinutes: roundRaw(prior.medianMinutes),
        source: prior.source,
        sampleCount: prior.sampleCount,
      })),
    },
  };
}

function estimateWithinRunPace(steps) {
  const ratios = [];
  for (const step of steps) {
    if (!FINISHED_STEP_STATUSES.has(step.status)) continue;
    const actual = stepActualMinutes(step);
    const prior = explicitStepPrior(step) ?? PUBLIC_STEP_PRIORS[step.class] ?? PUBLIC_STEP_PRIORS.other;
    if (actual > 0 && prior > 0) ratios.push(clamp(Math.log(actual / prior), -1.1, 1.1));
  }

  if (ratios.length === 0) {
    return { multiplier: 1, observationCount: 0, logMean: 0, shrinkage: 0 };
  }

  const logMean = mean(ratios);
  const shrinkage = ratios.length / (ratios.length + 2);
  return {
    multiplier: clamp(Math.exp(logMean * shrinkage), 0.62, 1.65),
    observationCount: ratios.length,
    logMean,
    shrinkage,
  };
}

function estimateHiddenWork(histories) {
  const stepLogs = [];
  const durationLogs = [];
  for (const row of histories) {
    const initialSteps = positiveNumber(row.original, ["initialStepCount", "initial_steps", "initialSteps"]);
    const finalSteps = positiveNumber(row.original, ["finalStepCount", "final_steps", "finalSteps"]);
    if (initialSteps && finalSteps) {
      stepLogs.push(clamp(Math.log(finalSteps / initialSteps), -0.7, 1.1));
    }

    const initialForecast = positiveNumber(row.original, [
      "initialForecastMinutes",
      "initial_forecast_minutes",
      "initialEtaMinutes",
      "baselineMinutes",
    ]);
    if (initialForecast) {
      durationLogs.push(clamp(Math.log(row.actualMinutes / initialForecast), -0.7, 1.1));
    }
  }

  const components = [];
  if (stepLogs.length > 0) components.push(mean(stepLogs));
  if (durationLogs.length > 0) components.push(mean(durationLogs));
  const populationLog = components.length > 0 ? mean(components) : 0;
  const evidenceCount = stepLogs.length + durationLogs.length;
  const shrinkage = evidenceCount / (evidenceCount + 12);
  // Hidden work represents latent expansion, not a generic speed-up correction.
  const multiplier = clamp(Math.exp(Math.max(0, populationLog * shrinkage)), 1, 1.75);

  return {
    multiplier,
    populationLog,
    shrunkLog: Math.log(multiplier),
    shrinkage,
    stepRatioCount: stepLogs.length,
    durationRatioCount: durationLogs.length,
  };
}

function estimatePersonalResidual(histories, context, hidden) {
  if (histories.length < 20) return { multiplier: 1, components: [] };

  const dimensions = [
    ["user", context.userId, ["userId", "user_id", "user"]],
    ["provider", context.provider, ["provider"]],
    ["model", context.model, ["modelFamily", "model_family", "model", "modelId", "model_id"]],
    ["project", context.projectId, ["projectId", "project_id", "project"]],
  ];
  const components = [];

  for (const [name, target, keys] of dimensions) {
    if (target == null || target === "") continue;
    const matched = histories.filter((row) => stringValue(row.original, keys) === String(target));
    const residual = residualComponent(name, matched, hidden);
    if (residual) components.push(residual);
  }

  // Callers may already have selected a comparable cohort without retaining
  // dimension columns. Treat it as one scalar cohort, still behind the 20-run gate.
  if (components.length === 0) {
    const comparable = residualComponent("comparable_cohort", histories, hidden);
    if (comparable) components.push(comparable);
  }

  if (components.length === 0) return { multiplier: 1, components: [] };
  const combinedLog = mean(components.map((component) => Math.log(component.multiplier)));
  return {
    multiplier: clamp(Math.exp(combinedLog), 0.68, 1.58),
    components,
  };
}

function residualComponent(name, histories, hidden) {
  if (histories.length < 20) return null;
  const logs = [];
  for (const row of histories) {
    const explicit = positiveNumber(row.original, ["residualMultiplier", "residual_multiplier"]);
    if (explicit) {
      logs.push(clamp(Math.log(explicit), -0.7, 0.7));
      continue;
    }

    const baseline = positiveNumber(row.original, [
      "baselineForecastMinutes",
      "baseline_forecast_minutes",
      "initialForecastMinutes",
      "initial_forecast_minutes",
      "initialEtaMinutes",
    ]);
    if (baseline) {
      logs.push(clamp(Math.log(row.actualMinutes / baseline) - hidden.shrunkLog, -0.7, 0.7));
    }
  }
  if (logs.length < 20) return null;
  const shrinkage = logs.length / (logs.length + 10);
  const multiplier = clamp(Math.exp(mean(logs) * shrinkage), 0.72, 1.5);
  return { name, sampleCount: logs.length, multiplier: roundMultiplier(multiplier) };
}

function stepPrior(step, histories, state) {
  const explicit = explicitStepPrior(step);
  const className = PUBLIC_STEP_PRIORS[step.class] ? step.class : "other";
  if (explicit) {
    return {
      stepId: step.id ?? null,
      className,
      medianMinutes: explicit,
      source: "declared",
      sampleCount: 0,
      learned: false,
    };
  }

  const publicMedian = PUBLIC_STEP_PRIORS[className];
  if (histories.length < 100) {
    return {
      stepId: step.id ?? null,
      className,
      medianMinutes: publicMedian,
      source: "public_class_prior",
      sampleCount: 0,
      learned: false,
    };
  }

  const provider = stateContext(state).provider;
  const providerSamples = collectStepSamples(histories, className, provider);
  const pooledSamples = collectStepSamples(histories, className, null);
  const samples = providerSamples.length >= 15 ? providerSamples : pooledSamples;
  if (samples.length < 15) {
    return {
      stepId: step.id ?? null,
      className,
      medianMinutes: publicMedian,
      source: "public_class_prior",
      sampleCount: samples.length,
      learned: false,
    };
  }

  const sampleMedian = median(samples);
  const weight = samples.length / (samples.length + 20);
  const medianMinutes = Math.exp(Math.log(publicMedian) * (1 - weight) + Math.log(sampleMedian) * weight);
  return {
    stepId: step.id ?? null,
    className,
    medianMinutes,
    source: providerSamples.length >= 15 ? "class_provider_history" : "pooled_class_history",
    sampleCount: samples.length,
    learned: true,
  };
}

function collectStepSamples(histories, className, provider) {
  const values = [];
  for (const row of histories) {
    if (provider != null) {
      const rowProvider = stringValue(row.original, ["provider"]);
      if (rowProvider !== String(provider)) continue;
    }
    const steps = Array.isArray(row.original.steps) ? row.original.steps : [];
    for (const step of steps) {
      const stepClass = PUBLIC_STEP_PRIORS[step.class] ? step.class : "other";
      if (stepClass !== className) continue;
      const actual = stepActualMinutes(step);
      if (actual > 0) values.push(actual);
    }
  }
  return values;
}

function estimateRetryPenalty(state, unfinished, priors) {
  const count = activeRetryCount(state);
  if (count === 0 || unfinished.length === 0) return { count: 0, minutes: 0 };
  const currentIndex = unfinished.findIndex((step) => step.id === state.currentStep?.id || step.id === state.currentStep);
  const prior = priors[currentIndex >= 0 ? currentIndex : 0]?.medianMinutes ?? PUBLIC_STEP_PRIORS.other;
  return { count, minutes: prior * 0.55 * count };
}

function observedParallelCredit(state) {
  const explicit = positiveNumber(state, ["parallelCreditMinutes", "subrunCreditMinutes"]);
  const subruns = Array.isArray(state.subruns)
    ? state.subruns
    : state.subruns && typeof state.subruns === "object"
      ? Object.values(state.subruns)
      : [];
  let minutes = explicit ?? 0;
  let count = explicit ? 1 : 0;

  for (const subrun of subruns) {
    const status = String(subrun.status ?? "");
    const finished =
      Boolean(subrun.finishedAt ?? subrun.finished_at) ||
      ["finished", "completed", "succeeded", "failed"].includes(status);
    if (!finished) continue;
    let duration = positiveNumber(subrun, [
      "creditedMinutes",
      "workMinutes",
      "actualMinutes",
      "durationMinutes",
    ]);
    if (!duration) {
      const durationMs = positiveNumber(subrun, ["durationMs", "activeElapsedMs"]);
      if (durationMs) duration = durationMs / MINUTE_MS;
    }
    if (!duration) {
      const startedAt = Date.parse(subrun.startedAt ?? subrun.started_at ?? "");
      const finishedAt = Date.parse(subrun.finishedAt ?? subrun.finished_at ?? "");
      if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt) {
        duration = (finishedAt - startedAt) / MINUTE_MS;
      }
    }
    if (duration > 0) {
      minutes += duration;
      count += 1;
    }
  }
  return { minutes, count };
}

function fitTotalDuration(totals) {
  if (totals.length === 0) return { mu: Math.log(28), sigma: 0.82 };
  const logs = totals.map(Math.log);
  if (logs.length < 3) return { mu: median(logs), sigma: 0.65 };
  const mu = mean(logs);
  const variance = mean(logs.map((value) => (value - mu) ** 2));
  return { mu, sigma: clamp(Math.sqrt(variance) + 0.12, 0.28, 0.9) };
}

function sampleConditionalLogNormal(mu, sigma, elapsedMinutes, rng) {
  if (!(elapsedMinutes > 0)) return Math.exp(mu + sigma * sampleStandardNormal(rng));
  const threshold = (Math.log(elapsedMinutes) - mu) / sigma;
  const lowerCdf = normalCdf(threshold);
  // Sampling the truncated normal analytically avoids rejection failure for
  // unusually long runs while preserving conditional survival semantics.
  const probability = lowerCdf + rng() * Math.max(Number.EPSILON, 1 - lowerCdf);
  const z = inverseNormalCdf(clamp(probability, Number.EPSILON, 1 - Number.EPSILON));
  return Math.max(elapsedMinutes + 1e-6, Math.exp(mu + sigma * z));
}

function activeElapsedMinutes(state, now) {
  let milliseconds = Math.max(0, finiteNumber(state.activeElapsedMs) ?? 0);
  const activeSince = state.activeSinceAt ?? state.activeSince ?? state.active_since;
  const paused =
    Boolean(state.needsInput) ||
    ["needs_input", "waiting_provider", "paused"].includes(String(state.status ?? ""));
  if (activeSince && !paused) {
    const start = Date.parse(activeSince);
    const end = new Date(now).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) milliseconds += end - start;
  }
  return milliseconds / MINUTE_MS;
}

function completedHistories(history) {
  if (!Array.isArray(history)) return [];
  const rows = [];
  for (const original of history) {
    const actualMinutes = durationMinutes(original);
    if (actualMinutes > 0) rows.push({ original, actualMinutes });
  }
  return rows;
}

function comparableHistories(histories, state) {
  const taskClass = state.taskClass ?? state.task_class ?? state.context?.taskClass;
  if (taskClass == null || taskClass === "") return histories;
  return histories.filter((row) => {
    const rowClass = stringValue(row.original, ["taskClass", "task_class"]);
    // Missing metadata means the caller already selected this cohort.
    return rowClass === null || rowClass === String(taskClass);
  });
}

function applyPostResponseRange(result, needsInput) {
  if (!needsInput || typeof needsInput !== "object") return result;
  const lower = positiveNumber(needsInput, ["postResponseLowerMinutes", "post_response_lower_minutes"]);
  const upper = positiveNumber(needsInput, ["postResponseP80Minutes", "post_response_p80_minutes"]);
  if (!(lower > 0) || !(upper >= lower)) return result;
  return {
    ...result,
    lowerMinutes: lower,
    p50Minutes: (lower + upper) / 2,
    p80Minutes: upper,
    raw: {
      ...result.raw,
      calculatedPostResponseRange: {
        lowerMinutes: roundMinutes(result.lowerMinutes),
        p50Minutes: roundMinutes(result.p50Minutes),
        p80Minutes: roundMinutes(result.p80Minutes),
      },
      postResponseRangeSource: "event_contract",
    },
  };
}

function durationMinutes(value) {
  const minutes = positiveNumber(value, [
    "actualMinutes",
    "actualDurationMinutes",
    "durationMinutes",
    "totalMinutes",
    "actual_minutes",
    "actual_duration_minutes",
  ]);
  if (minutes) return minutes;
  const milliseconds = positiveNumber(value, ["actualDurationMs", "durationMs", "activeElapsedMs"]);
  if (milliseconds) return milliseconds / MINUTE_MS;
  const startedAt = Date.parse(value.startedAt ?? value.started_at ?? "");
  const finishedAt = Date.parse(value.finishedAt ?? value.finished_at ?? "");
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt
    ? (finishedAt - startedAt) / MINUTE_MS
    : 0;
}

function stepActualMinutes(step) {
  const minutes = positiveNumber(step, [
    "actualMinutes",
    "durationMinutes",
    "activeMinutes",
    "actual_minutes",
  ]);
  if (minutes) return minutes;
  const milliseconds = positiveNumber(step, ["actualDurationMs", "durationMs", "activeElapsedMs"]);
  if (milliseconds) return milliseconds / MINUTE_MS;
  const startedAt = Date.parse(step.startedAt ?? step.started_at ?? "");
  const completedAt = Date.parse(step.completedAt ?? step.finishedAt ?? step.completed_at ?? "");
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt > startedAt
    ? (completedAt - startedAt) / MINUTE_MS
    : 0;
}

function explicitStepPrior(step) {
  return positiveNumber(step, ["priorMinutes", "prior_minutes", "estimatedMinutes"]);
}

function stateContext(state) {
  const context = state.context && typeof state.context === "object" ? state.context : {};
  return {
    userId: state.userId ?? state.user_id ?? context.userId ?? context.user_id,
    provider: state.provider ?? context.provider,
    model:
      state.modelFamily ??
      state.model_family ??
      state.model ??
      state.modelId ??
      context.modelFamily ??
      context.model_family ??
      context.model ??
      context.modelId,
    projectId: state.projectId ?? state.project_id ?? context.projectId ?? context.project_id,
  };
}

function forecastReason(state, result, needsInput) {
  if (needsInput) return "等你回复；回复后按剩余有效工作时间估算";
  const status = String(state.status ?? "");
  if (status === "waiting_provider") return "正在等待服务；等待时间不计入有效工作倒计时";
  if (activeRetryCount(state) > 0) {
    return "检测到测试失败或重试，已加入可观测返工时间";
  }
  if ((finiteNumber(state.planRevision) ?? 0) > 1) return "计划已调整，已按当前顺序步骤重新计算";
  if (result.parallelCreditMinutes > 0) return "并行子任务已完成，按其可观测工作量缩短剩余时间";
  if (result.paceMultiplier > 1.04) return "本轮已完成步骤比先验更慢，已按实际速度延长";
  if (result.paceMultiplier < 0.96) return "本轮已完成步骤比先验更快，已按实际速度缩短";
  if (state.reason) return String(state.reason);
  return result.raw.source === "ordered_plan_sum"
    ? "按剩余步骤、当前节奏和历史校准计算"
    : "无活跃计划，按同类任务的条件生存时间计算";
}

function activeRetryCount(state) {
  const currentIsObject = Boolean(state.currentStep) && typeof state.currentStep === "object";
  const currentRetryCount = currentIsObject ? finiteNumber(state.currentStep.retryCount) ?? 0 : null;
  const value =
    finiteNumber(state.pendingRetryCount) ??
    (currentIsObject ? currentRetryCount : finiteNumber(state.retryCount)) ??
    0;
  return Math.max(0, value);
}

function terminalReason(state) {
  const status = String(state.status ?? "");
  if (status.includes("fail")) return "任务已失败，ETA 归零";
  if (status.includes("cancel")) return "任务已取消，ETA 归零";
  return "任务已完成，ETA 归零";
}

function isTerminal(state) {
  return Boolean(state.finishedAt) || TERMINAL_STATUSES.has(String(state.status ?? ""));
}

function positiveNumber(object, keys) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value > 0) return value;
  }
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== null && value !== undefined && value !== "") return String(value);
  }
  return null;
}

function createRng(seed) {
  let value = hashSeed(seed);
  return function random() {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed) {
  const text = String(seed);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function sampleStandardNormal(rng) {
  const first = Math.max(Number.EPSILON, rng());
  const second = rng();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function sampleLogNormalMedianOne(rng, sigma) {
  return Math.exp(sampleStandardNormal(rng) * sigma);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
    t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

// Peter J. Acklam's rational approximation, sufficient for deterministic MC.
function inverseNormalCdf(probability) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;

  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function quantile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function median(values) {
  return quantile(values, 0.5);
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundMinutes(value) {
  return Math.round(value * 10) / 10;
}

function roundMultiplier(value) {
  return Math.round(value * 1_000) / 1_000;
}

function roundRaw(value) {
  return Math.round(value * 10_000) / 10_000;
}
