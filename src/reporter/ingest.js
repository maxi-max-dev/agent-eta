import { calibrateForecastP80, estimateP80Calibration } from '../core/calibration.js';
import { forecastRun } from '../core/estimator.js';
import { createRunState, reduceEvent } from '../core/reducer.js';
import { sanitizeReporterReport } from './contract.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function timestamp(value, code) {
  const milliseconds = Date.parse(value ?? '');
  if (!Number.isFinite(milliseconds)) throw new TypeError(code);
  return new Date(milliseconds).toISOString();
}

function causalState(database, runId, receivedAt) {
  const cutoff = Date.parse(receivedAt);
  const events = database.listEvents(runId).filter((event) => {
    const occurredAt = Date.parse(event.occurred_at);
    const observedAt = Date.parse(event.observed_at);
    return Number.isFinite(occurredAt)
      && Number.isFinite(observedAt)
      && occurredAt <= cutoff
      && observedAt <= cutoff;
  });
  if (!events.some((event) => event.kind === 'run_started')) return null;
  let state = createRunState(runId);
  for (const event of events) state = reduceEvent(state, event);
  return state;
}

function clockAfter(iso, minutes) {
  if (!Number.isFinite(minutes)) return null;
  return new Date(Date.parse(iso) + Math.max(0, minutes) * 60_000);
}

function formatClock(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function reporterDisplay(state, forecast, receivedAt) {
  const reason = '已收到当前运行的结构化 Reporter 观察，ETA 已按接收时点重算';
  const pausedStatus = forecast.status === 'needs_input'
    ? 'needs_input'
    : ['needs_input', 'waiting_provider', 'blocked', 'paused'].includes(state.status)
      ? state.status
      : null;
  if (pausedStatus) {
    const low = Math.max(1, Math.round(forecast.lowerMinutes ?? forecast.p50Minutes ?? 1));
    const high = Math.max(low, Math.round(forecast.p80Minutes ?? low));
    const copy = {
      needs_input: {
        headline: '等你回复',
        prefix: '回复后',
        currentStep: 'Agent 已暂停主动工作',
      },
      waiting_provider: {
        headline: '等待服务',
        prefix: '恢复后',
        currentStep: 'Agent 正在等待外部服务',
      },
      blocked: {
        headline: '暂时阻塞',
        prefix: '解除后',
        currentStep: 'Agent 正在等待阻塞解除',
      },
      paused: {
        headline: '已暂停',
        prefix: '继续后',
        currentStep: 'Agent 已暂停主动工作',
      },
    }[pausedStatus];
    return {
      headline: copy.headline,
      range: `${copy.prefix}约 ${low}–${high} 分钟`,
      currentStep: state.currentStep?.label ? `停在：${state.currentStep.label}` : copy.currentStep,
      reason,
      tone: 'waiting',
    };
  }
  const expected = clockAfter(receivedAt, forecast.p50Minutes);
  const lower = clockAfter(receivedAt, forecast.lowerMinutes ?? forecast.p50Minutes);
  const upper = clockAfter(receivedAt, forecast.p80Minutes ?? forecast.p50Minutes);
  return {
    headline: expected ? `预计 ${formatClock(expected)} 完成` : '正在判断',
    range: lower && upper ? `大致 ${formatClock(lower)}–${formatClock(upper)}` : '正在收集结构事件',
    currentStep: state.currentStep?.label ? `正在${state.currentStep.label}` : '正在执行任务',
    reason,
    tone: 'working',
  };
}

function existingReceiptForecast(database, report, receipt) {
  return database.listForecasts(report.run_id).find((snapshot) => {
    const landmark = snapshot.forecast?.raw?.reporterReceiptLandmark;
    return landmark?.reportedAt === report.reported_at && landmark?.receivedAt === receipt;
  }) ?? null;
}

function applySavedReporterObservation(database, report, receipt, { inserted }) {
  const run = database.loadRun(report.run_id);
  if (!run || run.provider !== report.provider) {
    return Object.freeze({
      inserted,
      matched: false,
      forecastSaved: false,
      snapshotId: null,
      landmark: 'receipt',
    });
  }
  const existing = existingReceiptForecast(database, report, receipt);
  if (existing) {
    return Object.freeze({
      inserted,
      matched: true,
      forecastSaved: false,
      snapshotId: Number(existing.snapshot_id),
      landmark: 'receipt',
    });
  }

  const state = causalState(database, report.run_id, receipt);
  if (!state || TERMINAL.has(state.status)) {
    return Object.freeze({
      inserted,
      matched: true,
      forecastSaved: false,
      snapshotId: null,
      landmark: 'receipt',
    });
  }
  const reporterState = {
    ...state,
    taskClass: report.task_class,
    modelSelfEtaMinutes: report.model_self_eta_minutes ?? state.modelSelfEtaMinutes,
  };
  const history = database.loadHistory({
    before: receipt,
    observedBefore: receipt,
    source: 'live_adapter',
  }).filter((row) => row.runId !== report.run_id);
  const rawForecast = forecastRun({
    state: reporterState,
    history,
    now: new Date(receipt),
    seed: `reporter:${report.run_id}:${report.reported_at}:${receipt}`,
  });
  const calibration = estimateP80Calibration(database.listP80CalibrationObservations({
    before: receipt,
    source: 'live_adapter',
    mode: rawForecast.mode,
  }));
  const calibrated = calibrateForecastP80(rawForecast, calibration);
  const forecast = {
    ...calibrated,
    reason: 'Reporter receipt landmark: structural labels received; remaining ETA recalculated',
    raw: {
      ...(calibrated.raw ?? {}),
      reporterReceiptLandmark: {
        schemaVersion: report.schema_version,
        reportedAt: report.reported_at,
        receivedAt: receipt,
        taskClassApplied: report.task_class,
        planDeclared: report.plan_present,
        planStepCount: report.plan_step_count,
        planSynthesized: false,
      },
    },
  };
  const display = reporterDisplay(reporterState, forecast, receipt);
  const snapshotId = database.saveForecast({
    runId: report.run_id,
    eventId: null,
    observedAt: receipt,
    forecast,
    display,
  });
  return Object.freeze({
    inserted,
    matched: true,
    forecastSaved: true,
    snapshotId,
    landmark: 'receipt',
  });
}

/**
 * Persist one strict Reporter observation and, only when its canonical run is
 * already known, save a new forecast at the immutable local receipt landmark.
 * The reducer is rebuilt from events observed by that cutoff, so a later plan
 * or terminal event already present during a backfill cannot leak backwards.
 */
export function applyReporterObservation(database, input, {
  receivedAt = new Date().toISOString(),
} = {}) {
  if (!database || typeof database.transaction !== 'function') {
    throw new TypeError('database must be an AgentEtaDatabase');
  }
  const report = sanitizeReporterReport(input);
  const receipt = timestamp(receivedAt, 'REPORTER_INVALID_RECEIPT_TIMESTAMP');

  return database.transaction(() => {
    const saved = database.saveReporterObservation(report, { receivedAt: receipt });
    const stored = database.listReporterObservations(report.run_id)
      .find((observation) => observation.report.reported_at === report.reported_at);
    const immutableReceipt = timestamp(
      stored?.receivedAt ?? receipt,
      'REPORTER_INVALID_RECEIPT_TIMESTAMP',
    );
    return applySavedReporterObservation(database, report, immutableReceipt, {
      inserted: saved.inserted,
    });
  });
}

/**
 * Reconcile observations that arrived before the watcher persisted their run.
 * The caller may already own a larger import transaction; this function never
 * starts one and always reuses the immutable first local receipt timestamp.
 */
export function reconcileReporterObservations(database, runIds) {
  const results = [];
  for (const runId of new Set(runIds ?? [])) {
    for (const observation of database.listReporterObservations(runId)) {
      const report = sanitizeReporterReport(observation.report);
      results.push(applySavedReporterObservation(
        database,
        report,
        timestamp(observation.receivedAt, 'REPORTER_INVALID_RECEIPT_TIMESTAMP'),
        { inserted: false },
      ));
    }
  }
  return Object.freeze({
    observations: results.length,
    matched: results.filter((result) => result.matched).length,
    savedForecasts: results.filter((result) => result.forecastSaved).length,
  });
}
