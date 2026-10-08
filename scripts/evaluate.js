import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunState, reduceEvent } from '../src/core/reducer.js';
import { forecastRun } from '../src/core/estimator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(ROOT, 'fixtures/replays');
const OUTPUT_DIR = join(ROOT, 'outputs');

function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const spread = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) };
}

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')))
    .toSorted((a, b) => Date.parse(a.events[0].occurred_at) - Date.parse(b.events[0].occurred_at));
}

function baseline(values, fallback = 12) {
  return median(values) ?? fallback;
}

function actualMinutes(state) {
  if (Number.isFinite(state.activeElapsedMs) && state.activeElapsedMs > 0) {
    return state.activeElapsedMs / 60_000;
  }
  if (state.startedAt && state.finishedAt) {
    return (Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 60_000;
  }
  return null;
}

function taskClassOf(start) {
  return start.data?.task_class ?? 'other';
}

function frozenHistoryProfile(fixture) {
  if (fixture.historyProfile !== 'experienced-fast') return [];
  const start = fixture.events[0];
  const base = Date.parse('2026-08-01T00:00:00.000Z');
  return Array.from({ length: 24 }, (_, index) => {
    const startedAt = new Date(base + index * 86_400_000).toISOString();
    const actualMinutes = 7.2 + (index % 5) * 0.38;
    return {
      runId: `evaluation-history-fast-${index + 1}`,
      provider: start.provider,
      modelFamily: start.data?.model_family,
      projectId: start.data?.project_id,
      userId: start.data?.user_id,
      taskClass: taskClassOf(start),
      actualMinutes,
      durationMinutes: actualMinutes,
      initialForecastMinutes: 12.5 + (index % 3) * 0.4,
      modelSelfEtaMinutes: 10 + (index % 4),
      initialStepCount: 3,
      finalStepCount: 3,
      startedAt,
      finishedAt: new Date(Date.parse(startedAt) + actualMinutes * 60_000).toISOString(),
      steps: [
        { id: 'inspect', class: 'inspect', status: 'completed', actualMinutes: 1.5 },
        { id: 'edit', class: 'edit', status: 'completed', actualMinutes: 3.3 },
        { id: 'test', class: 'test', status: 'completed', actualMinutes: actualMinutes - 4.8 },
      ],
    };
  });
}

function evaluateChronologically(fixtures) {
  const history = [];
  const rows = [];

  for (const fixture of fixtures) {
    const start = fixture.events[0];
    // This profile is frozen local Demo data with timestamps before the target
    // run. It exercises the 20+ gate without leaking future fixture outcomes.
    const profileHistory = frozenHistoryProfile(fixture);
    if (profileHistory.length) history.push(...profileHistory);
    const knownDurations = history.map((run) => run.actualMinutes);
    const matchingDurations = history
      .filter((run) => run.taskClass === taskClassOf(start))
      .map((run) => run.actualMinutes);
    const predictions = {
      global_median: baseline(knownDurations),
      task_median: baseline(matchingDurations, baseline(knownDurations)),
      model_self_eta: Number(start.data?.model_self_eta_minutes ?? 12),
    };
    const intervals = {};
    let state = createRunState(start.run_id);
    let fallbackForecast = null;
    let planForecast = null;
    let initialPlanSteps = null;

    for (let index = 0; index < fixture.events.length; index += 1) {
      const event = fixture.events[index];
      state = reduceEvent(state, event);
      const forecast = forecastRun({
        state,
        history,
        now: new Date(event.occurred_at),
        seed: `evaluation:${fixture.id}:${index}`,
      });
      if (event.kind === 'run_started') fallbackForecast = forecast;
      if (!planForecast && ['plan_declared', 'plan_revised'].includes(event.kind)) {
        planForecast = forecast;
        initialPlanSteps = state.steps?.length ?? 0;
      }
    }

    const outcome = actualMinutes(state);
    if (!Number.isFinite(outcome)) continue;
    predictions.run_fallback = fallbackForecast?.p50Minutes ?? baseline(knownDurations);
    predictions.full_adaptive = planForecast?.p50Minutes ?? predictions.run_fallback;
    if (planForecast) predictions.plan_conditioned = planForecast.p50Minutes;
    intervals.run_fallback = {
      lower: fallbackForecast?.lowerMinutes,
      upper: fallbackForecast?.p80Minutes,
    };
    intervals.full_adaptive = planForecast
      ? { lower: planForecast.lowerMinutes, upper: planForecast.p80Minutes }
      : intervals.run_fallback;
    if (planForecast) {
      intervals.plan_conditioned = {
        lower: planForecast.lowerMinutes,
        upper: planForecast.p80Minutes,
      };
    }

    rows.push({
      fixtureId: fixture.id,
      startedAt: start.occurred_at,
      taskClass: taskClassOf(start),
      hasPlan: Boolean(planForecast),
      historyProfile: fixture.historyProfile ?? 'cold',
      actualMinutes: outcome,
      predictions,
      intervals,
    });

    history.push({
      runId: state.runId,
      provider: start.provider,
      modelFamily: start.data?.model_family,
      projectId: start.data?.project_id,
      userId: start.data?.user_id,
      taskClass: taskClassOf(start),
      actualMinutes: outcome,
      durationMinutes: outcome,
      initialForecastMinutes: predictions.full_adaptive,
      modelSelfEtaMinutes: predictions.model_self_eta,
      initialStepCount: initialPlanSteps,
      finalStepCount: state.steps?.length ?? initialPlanSteps,
      finishedAt: state.finishedAt,
      steps: state.steps ?? [],
    });
  }
  return rows;
}

function summarizeMethod(rows, method) {
  const comparable = rows.filter((row) => Number.isFinite(row.predictions[method]));
  const absoluteErrors = comparable.map((row) => Math.abs(row.predictions[method] - row.actualMinutes));
  const relativeErrors = comparable.map((row) => Math.abs(row.predictions[method] - row.actualMinutes) / Math.max(1, row.actualMinutes));
  const severeUnder = comparable.filter((row) => row.predictions[method] < row.actualMinutes * 0.5).length;
  const intervalRows = comparable.filter((row) => {
    const interval = row.intervals[method];
    return Number.isFinite(interval?.lower) && Number.isFinite(interval?.upper);
  });
  const covered = intervalRows.filter((row) => {
    const interval = row.intervals[method];
    return row.actualMinutes >= interval.lower && row.actualMinutes <= interval.upper;
  }).length;
  return {
    runs: comparable.length,
    medianAbsoluteErrorMinutes: median(absoluteErrors),
    meanAbsoluteErrorMinutes: mean(absoluteErrors),
    medianRelativeError: median(relativeErrors),
    severeUnderestimateRate: comparable.length ? severeUnder / comparable.length : null,
    p80Coverage: intervalRows.length ? covered / intervalRows.length : null,
    p80Wilson95: wilson(covered, intervalRows.length),
    meanIntervalWidthMinutes: mean(intervalRows.map((row) => row.intervals[method].upper - row.intervals[method].lower)),
  };
}

function bootstrapPlanGain(rows, samples = 2_000) {
  const planned = rows.filter((row) => Number.isFinite(row.predictions.plan_conditioned));
  if (!planned.length) return { plannedRuns: 0, samples: 0 };
  const random = mulberry32(0x0a9e7a);
  const gains = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let fallbackError = 0;
    let planError = 0;
    for (let index = 0; index < planned.length; index += 1) {
      const row = planned[Math.floor(random() * planned.length)];
      fallbackError += Math.abs(row.predictions.run_fallback - row.actualMinutes);
      planError += Math.abs(row.predictions.plan_conditioned - row.actualMinutes);
    }
    gains.push((fallbackError - planError) / planned.length);
  }
  return {
    plannedRuns: planned.length,
    samples,
    medianMaeGainMinutes: median(gains),
    probabilityPlanBeatsFallback: gains.filter((gain) => gain > 0).length / gains.length,
    interval95: [quantile(gains, 0.025), quantile(gains, 0.975)],
  };
}

function fixed(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function markdown(report) {
  const lines = [
    '# Agent ETA Demo evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '> This is a frozen simulated-contract replay, not a measurement of a live Codex/Claude Reporter.',
    '',
    `Plan coverage in fixtures: ${report.planCoverage.plannedRuns}/${report.planCoverage.totalRuns} (${fixed(report.planCoverage.rate * 100, 1)}%). Live structural coverage is measured separately in live-coverage-report.md; large-task eligibility remains unsupported.`,
    '',
    '| Method | Runs | Median AE (min) | Mean AE (min) | Severe underestimate | P80 coverage |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const [method, metrics] of Object.entries(report.methods)) {
    lines.push(`| ${method} | ${metrics.runs} | ${fixed(metrics.medianAbsoluteErrorMinutes)} | ${fixed(metrics.meanAbsoluteErrorMinutes)} | ${fixed(metrics.severeUnderestimateRate * 100, 1)}% | ${Number.isFinite(metrics.p80Coverage) ? `${fixed(metrics.p80Coverage * 100, 1)}%` : 'n/a'} |`);
  }
  lines.push(
    '',
    '## Run-level bootstrap',
    '',
    `On ${report.planBootstrap.plannedRuns} planned fixture runs, median MAE gain of plan-conditioned over the same run-level fallback is ${fixed(report.planBootstrap.medianMaeGainMinutes)} minutes. The 95% run-level bootstrap interval is ${report.planBootstrap.interval95 ? report.planBootstrap.interval95.map((value) => fixed(value)).join(' to ') : 'n/a'}.`,
    '',
    'The sample is intentionally tiny and correlated with Demo design. It proves the evaluation path runs; it does not prove production accuracy.',
    '',
  );
  return lines.join('\n');
}

const rows = evaluateChronologically(loadFixtures());
const plannedRuns = rows.filter((row) => row.hasPlan).length;
const methods = Object.fromEntries([
  'global_median',
  'task_median',
  'model_self_eta',
  'run_fallback',
  'plan_conditioned',
  'full_adaptive',
].map((method) => [method, summarizeMethod(rows, method)]));
const report = {
  generatedAt: new Date().toISOString(),
  dataset: 'frozen replay fixtures / simulated contract',
  chronological: true,
  planCoverage: {
    plannedRuns,
    totalRuns: rows.length,
    rate: rows.length ? plannedRuns / rows.length : 0,
    liveReporterCoverage: null,
    liveReporterStatus: 'measured_separately_eligibility_unsupported',
  },
  methods,
  planBootstrap: bootstrapPlanGain(rows),
  runs: rows,
};

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'evaluation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(OUTPUT_DIR, 'evaluation-report.md'), `${markdown(report)}\n`);
console.log(markdown(report));
