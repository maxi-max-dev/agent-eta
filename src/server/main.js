import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertValidEvent } from '../core/contract.js';
import { createRunState, reduceEvent } from '../core/reducer.js';
import { forecastRun } from '../core/estimator.js';
import { createWeeklyEvaluationScheduler } from '../evaluation/scheduler.js';
import { createCodexShadowWatcher } from '../live/watcher.js';
import {
  REPORTER_CONNECTION_STATUS,
  ReporterContractError,
  sanitizeReporterReport,
} from '../reporter/contract.js';
import { applyReporterObservation } from '../reporter/ingest.js';
import { AgentEtaDatabase } from '../storage/database.js';
import { AgentETA, defaultDatabasePath } from '../generic/tracker.js';
import { writeWeeklyEvaluation } from '../../scripts/evaluate-weekly.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PUBLIC_DIR = join(ROOT, 'public');
const FIXTURE_DIR = join(ROOT, 'fixtures/replays');
const DEFAULT_DB = join(ROOT, 'data/agent-eta-demo.sqlite');
const DEFAULT_CODEX_ROOT = join(homedir(), '.codex', 'sessions');
const OUTPUT_DIR = join(ROOT, 'outputs');
const LIVE_TERMINAL_GRACE_MS = 15 * 60_000;
const LIVE_SELECTION_PATTERN = /^sel-[a-f0-9]{20}$/;
const PAUSED_STATUSES = new Set(['needs_input', 'waiting_provider', 'blocked', 'paused']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readFixtures(directory = FIXTURE_DIR) {
  const fixtures = new Map();
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.json')).sort()) {
    const fixture = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (!fixture.id || !Array.isArray(fixture.events) || fixture.events.length === 0) {
      throw new Error(`Invalid fixture envelope: ${name}`);
    }
    for (const event of fixture.events) assertValidEvent(event);
    fixtures.set(fixture.id, fixture);
  }
  if (fixtures.size < 4) throw new Error('At least four frozen replay fixtures are required.');
  return fixtures;
}

function responseJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function assertReporterRequest(request) {
  if (request.headers.origin !== undefined) {
    throw new Error('REPORTER_BROWSER_ORIGIN_REJECTED');
  }
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new Error('REPORTER_CONTENT_TYPE_REQUIRED');
  }
}

async function readReporterJson(request) {
  try {
    return await readJson(request);
  } catch {
    throw new Error('REPORTER_INVALID_JSON');
  }
}

function reporterStatusProjection(database) {
  const status = database.reporterStatus();
  return {
    kind: 'reporter_status',
    connectionStatus: REPORTER_CONNECTION_STATUS,
    officialProviderIntegration: false,
    acceptsBrowserOrigins: false,
    ...status,
  };
}

function safeReporterError(error) {
  if (error instanceof ReporterContractError) return error;
  if (new Set([
    'REPORTER_BROWSER_ORIGIN_REJECTED',
    'REPORTER_CONTENT_TYPE_REQUIRED',
    'REPORTER_INVALID_JSON',
    'REPORTER_OBSERVATION_CONFLICT',
  ]).has(error?.message)) return error;
  return new Error('REPORTER_PERSIST_FAILED');
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  return Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
}

function seedExperiencedFastHistory(database, fixture) {
  if (fixture.historyProfile !== 'experienced-fast') return;
  const base = Date.parse('2026-08-01T00:00:00.000Z');
  for (let index = 0; index < 24; index += 1) {
    const started = new Date(base + index * 86_400_000).toISOString();
    const duration = 7.2 + (index % 5) * 0.38;
    const finished = new Date(Date.parse(started) + duration * 60_000).toISOString();
    const inspect = 1.4 + (index % 3) * 0.08;
    const edit = 3.1 + (index % 4) * 0.12;
    const test = Math.max(1.2, duration - inspect - edit);
    const state = {
      runId: `history-fast-${String(index + 1).padStart(2, '0')}`,
      provider: fixture.events[0].provider,
      modelFamily: fixture.events[0].data?.model_family ?? 'demo-model',
      projectId: fixture.events[0].data?.project_id ?? 'eta-demo',
      taskClass: fixture.events[0].data?.task_class ?? 'coding',
      userId: fixture.events[0].data?.user_id ?? 'max-demo',
      status: 'succeeded',
      startedAt: started,
      finishedAt: finished,
      activeElapsedMs: duration * 60_000,
      initialForecastMinutes: 12.5 + (index % 3) * 0.4,
      modelSelfEtaMinutes: 10 + (index % 4),
      initialStepCount: 3,
      planRevision: 1,
      steps: [
        { id: 'inspect', class: 'inspect', status: 'done', actualMinutes: inspect },
        { id: 'edit', class: 'edit', status: 'done', actualMinutes: edit },
        { id: 'test', class: 'test', status: 'done', actualMinutes: test },
      ],
    };
    database.saveRun(
      state,
      { observed_at: finished, provider: state.provider, data: {} },
      { isHistory: true, historySource: 'frozen_demo' },
    );
  }
  database.saveCalibration(
    'max-demo/codex/demo-model/eta-demo',
    'pace',
    24,
    0.72,
    { source: 'frozen_demo_history', eligible: true },
    'frozen_demo',
  );
}

function clockAfter(now, minutes) {
  if (!Number.isFinite(minutes)) return null;
  return new Date(now.getTime() + Math.max(0, minutes) * 60_000);
}

function formatClock(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function terminalStatus(status) {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function selectionIdFor(runId) {
  return `sel-${createHash('sha256').update(`agent-eta-selection\0${runId}`).digest('hex').slice(0, 20)}`;
}

function worksetSelectionIdFor(worksetId) {
  return `sel-${createHash('sha256').update(`agent-eta-workset-selection\0${worksetId}`).digest('hex').slice(0, 20)}`;
}

function liveStatus(status, forecastStatus = null) {
  if (['failed', 'cancelled', 'needs_input', 'waiting_provider', 'blocked', 'paused'].includes(status)) {
    return status;
  }
  if (forecastStatus === 'needs_input') return 'needs_input';
  if (status === 'succeeded' || forecastStatus === 'terminal') return 'succeeded';
  return status ? 'working' : 'unknown';
}

function evidenceConfidence({ mode, historyCount, status }) {
  if (['unknown', 'succeeded', 'failed', 'cancelled'].includes(status)) return 'unavailable';
  if (mode === 'plan_conditioned') return 'plan_observed';
  if (Number(historyCount) >= 20) return 'history_backed';
  return 'prior_only';
}

function confidenceLabel(confidence) {
  return {
    plan_observed: '证据：已观察计划',
    history_backed: '证据：历史支持',
    prior_only: '证据：先验估计',
    unavailable: '证据：暂不可用',
  }[confidence] ?? '证据：暂不可用';
}

function statusLabel(status) {
  return {
    working: '工作中',
    needs_input: '等你回复',
    waiting_provider: '等待服务',
    blocked: '暂时阻塞',
    paused: '已暂停',
    succeeded: '已完成',
    failed: '运行失败',
    cancelled: '已取消',
    stale: '等待新事件',
    unknown: '状态未知',
  }[status] ?? '状态未知';
}

function roundedMinutes(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
}

function activeRange(forecast, prefix) {
  const low = Math.max(1, Math.round(forecast.lowerMinutes ?? forecast.p50Minutes ?? 1));
  const high = Math.max(low, Math.round(forecast.p80Minutes ?? low + 2));
  const median = Math.max(low, Math.round(forecast.p50Minutes ?? (low + high) / 2));
  return {
    remaining: `${prefix}还需约 ${median} 分钟`,
    range: `${prefix}约 ${low}–${high} 分钟`,
  };
}

function findCurrentStep(state) {
  const candidate = state.currentStep;
  if (candidate && typeof candidate === 'object') return candidate;
  const steps = state.steps ?? [];
  if (candidate) return steps.find((step) => step.id === candidate) ?? { label: String(candidate) };
  return steps.find((step) => ['active', 'in_progress', 'working'].includes(step.status))
    ?? steps.find((step) => step.status === 'pending')
    ?? null;
}

export function makeDisplay(state, forecast, wallNow = new Date()) {
  const current = findCurrentStep(state);
  const currentStep = current?.label
    ? `正在${current.label}`
    : state.status === 'active_planning'
      ? '正在规划路线'
      : state.status === 'succeeded'
        ? '全部步骤完成'
        : '正在执行任务';
  const reason = state.reason ?? forecast.reason ?? '已收到新的运行事件，ETA 已重算';

  if (state.status === 'succeeded') {
    const actual = minutesBetween(state.startedAt, state.finishedAt);
    return {
      headline: '已完成',
      remaining: Number.isFinite(actual) ? `实际用时 ${actual.toFixed(actual < 10 ? 1 : 0)} 分钟` : '运行已结束',
      range: Number.isFinite(actual) ? `实际用时 ${actual.toFixed(actual < 10 ? 1 : 0)} 分钟` : '运行已结束',
      currentStep: '全部步骤完成',
      reason,
      tone: 'done',
      status: 'succeeded',
      statusLabel: statusLabel('succeeded'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  if (state.status === 'failed' || state.status === 'cancelled') {
    return {
      headline: state.status === 'failed' ? '运行失败' : '已取消',
      remaining: '没有继续倒计时',
      range: '没有继续倒计时',
      currentStep,
      reason,
      tone: 'failed',
      status: state.status,
      statusLabel: statusLabel(state.status),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  const pausedStatus = state.needsInput || forecast.status === 'needs_input'
    ? 'needs_input'
    : PAUSED_STATUSES.has(state.status)
      ? state.status
      : null;
  if (pausedStatus) {
    const pause = {
      needs_input: { headline: '等你回复', prefix: '回复后', step: 'Agent 已暂停主动工作' },
      waiting_provider: { headline: '等待服务', prefix: '恢复后', step: 'Agent 正在等待外部服务' },
      blocked: { headline: '暂时阻塞', prefix: '解除后', step: 'Agent 当前无法继续' },
      paused: { headline: '已暂停', prefix: '恢复后', step: 'Agent 已暂停主动工作' },
    }[pausedStatus];
    const range = activeRange(forecast, pause.prefix);
    const confidence = evidenceConfidence({
      mode: forecast.mode,
      historyCount: forecast.raw?.historyCount,
      status: pausedStatus,
    });
    return {
      headline: pause.headline,
      remaining: range.remaining,
      range: range.range,
      currentStep: current?.label ? `停在：${current.label}` : pause.step,
      reason,
      tone: 'waiting',
      status: pausedStatus,
      statusLabel: statusLabel(pausedStatus),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      comparison: null,
    };
  }
  if (forecast.status === 'terminal') {
    return {
      headline: '运行已结束',
      remaining: '没有继续倒计时',
      range: '没有继续倒计时',
      currentStep,
      reason,
      tone: 'done',
      status: 'succeeded',
      statusLabel: statusLabel('succeeded'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  if (!Number.isFinite(forecast.p50Minutes)) {
    return {
      headline: '正在判断',
      remaining: '剩余时间暂不可用',
      range: '再收到一个运行事件后给出范围',
      currentStep,
      reason,
      tone: 'working',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }

  const expected = clockAfter(wallNow, forecast.p50Minutes);
  const lower = clockAfter(wallNow, forecast.lowerMinutes ?? forecast.p50Minutes);
  const upper = clockAfter(wallNow, forecast.p80Minutes ?? forecast.p50Minutes);
  const confidence = evidenceConfidence({
    mode: forecast.mode,
    historyCount: forecast.raw?.historyCount,
    status: 'working',
  });
  return {
    headline: `预计 ${formatClock(expected)} 完成`,
    remaining: `还剩约 ${roundedMinutes(forecast.p50Minutes)} 分钟`,
    range: `大致 ${formatClock(lower)}–${formatClock(upper)}`,
    currentStep,
    reason,
    tone: 'working',
    status: 'working',
    statusLabel: statusLabel('working'),
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    comparison: null,
  };
}

function fixtureSummary(fixture) {
  return {
    id: fixture.id,
    title: fixture.title,
    description: fixture.description,
    eventCount: fixture.events.length,
    historyProfile: fixture.historyProfile ?? 'cold',
  };
}

function liveReason(kind, mode, status) {
  if (status === 'succeeded') return '扫描时任务已完成；这是保存下来的最终结果';
  if (status === 'failed') return '扫描时任务已失败；没有继续倒计时';
  if (status === 'cancelled') return '扫描时任务已取消；没有继续倒计时';
  const byEvent = {
    run_started: '扫描时任务刚开始；当前页不会自动推进时间',
    plan_declared: '扫描时检测到显式计划；ETA 已按步骤重算',
    plan_revised: '扫描时计划发生变化；ETA 已按新步骤重算',
    step_started: '扫描时一个计划步骤开始执行',
    step_completed: '扫描时一个计划步骤刚完成；剩余 ETA 已更新',
    retry_started: '扫描时发生重试；ETA 已计入新增工作',
    needs_input: '扫描时 Agent 正在等待回复',
    waiting_provider: '扫描时 Agent 正在等待外部服务；恢复时间不进入 ETA',
    blocked: '扫描时任务已明确阻塞；解除时间不进入 ETA',
    paused: '扫描时任务已暂停；恢复时间不进入 ETA',
    resumed: '扫描时任务已恢复执行',
    subrun_finished: '扫描时并行 subrun 已完成；ETA 已缩短',
  };
  if (byEvent[kind]) return byEvent[kind];
  if (mode === 'plan_conditioned') return '扫描时存在有效计划；ETA 来自步骤进度';
  return '扫描时未检测到有效计划；ETA 来自 run-level 估计';
}

function liveCurrentStep(status, stepLabel) {
  if (status === 'succeeded') return '全部步骤完成';
  if (status === 'failed') return '运行已失败';
  if (status === 'cancelled') return '运行已取消';
  if (status === 'needs_input') return 'Agent 已暂停主动工作';
  if (status === 'waiting_provider') return 'Agent 正在等待外部服务';
  if (status === 'blocked') return 'Agent 当前无法继续';
  if (status === 'paused') return 'Agent 已暂停主动工作';
  if (/^步骤 [1-9]\d*$/.test(stepLabel ?? '')) return `正在${stepLabel}`;
  return '正在执行任务';
}

function liveSnapshotDisplay(row, stepLabel, comparison = null) {
  const forecast = {
    p50Minutes: Number.isFinite(row.p50_minutes) ? row.p50_minutes : null,
    p80Minutes: Number.isFinite(row.p80_minutes) ? row.p80_minutes : null,
    lowerMinutes: Number.isFinite(row.lower_minutes) ? row.lower_minutes : null,
  };
  const status = liveStatus(row.status, row.forecast_status);
  const currentStep = liveCurrentStep(status, stepLabel);
  const reason = liveReason(row.latest_event_kind, row.mode, status);
  const confidence = evidenceConfidence({
    mode: row.mode,
    historyCount: row.history_count,
    status,
  });

  if (status === 'succeeded') {
    const actual = Number.isFinite(row.outcome_minutes)
      ? `实际用时 ${row.outcome_minutes.toFixed(row.outcome_minutes < 10 ? 1 : 0)} 分钟`
      : '运行已结束';
    return {
      headline: '已完成',
      remaining: actual,
      range: comparison?.range ?? actual,
      currentStep,
      reason: comparison?.reason ?? reason,
      tone: 'done',
      status,
      statusLabel: statusLabel(status),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: comparison?.data ?? null,
    };
  }
  if (status === 'failed' || status === 'cancelled') {
    const actual = Number.isFinite(row.outcome_minutes)
      ? `实际用时 ${row.outcome_minutes.toFixed(row.outcome_minutes < 10 ? 1 : 0)} 分钟`
      : '运行已结束';
    return {
      headline: status === 'failed' ? '运行失败' : '已取消',
      remaining: actual,
      range: comparison?.range ?? actual,
      currentStep,
      reason: comparison?.reason ?? reason,
      tone: 'failed',
      status,
      statusLabel: statusLabel(status),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: comparison?.data ?? null,
    };
  }
  if (PAUSED_STATUSES.has(status) || row.forecast_status === 'needs_input') {
    const effectiveStatus = row.forecast_status === 'needs_input' ? 'needs_input' : status;
    const pause = {
      needs_input: { headline: '等你回复', prefix: '回复后' },
      waiting_provider: { headline: '等待服务', prefix: '恢复后' },
      blocked: { headline: '暂时阻塞', prefix: '解除后' },
      paused: { headline: '已暂停', prefix: '恢复后' },
    }[effectiveStatus];
    const range = activeRange(forecast, pause.prefix);
    return {
      headline: pause.headline,
      remaining: range.remaining,
      range: range.range,
      currentStep,
      reason,
      tone: 'waiting',
      status: effectiveStatus,
      statusLabel: statusLabel(effectiveStatus),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      comparison: null,
    };
  }
  if (!Number.isFinite(forecast.p50Minutes) || !row.observed_at) {
    return {
      headline: '正在判断',
      remaining: '剩余时间暂不可用',
      range: '这次扫描还没有可用的 ETA 范围',
      currentStep,
      reason,
      tone: 'working',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }

  const captured = new Date(row.observed_at);
  const expected = clockAfter(captured, forecast.p50Minutes);
  const lower = clockAfter(captured, forecast.lowerMinutes ?? forecast.p50Minutes);
  const upper = clockAfter(captured, forecast.p80Minutes ?? forecast.p50Minutes);
  return {
    headline: `预计 ${formatClock(expected)} 完成`,
    remaining: `还剩约 ${roundedMinutes(forecast.p50Minutes)} 分钟`,
    range: `大致 ${formatClock(lower)}–${formatClock(upper)}`,
    currentStep,
    reason,
    tone: 'working',
    status,
    statusLabel: statusLabel(status),
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    comparison: null,
  };
}

function snapshotTimestamp(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '采集时间未知';
  return `采集于 ${new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))}`;
}

function liveSnapshotRows(database) {
  return database.db.prepare(`
    SELECT
      r.run_id AS internal_run_id,
      r.status,
      r.started_at,
      r.finished_at,
      r.outcome_minutes,
      f.snapshot_id,
      f.observed_at,
      f.mode,
      f.forecast_status,
      f.p50_minutes,
      f.p80_minutes,
      f.lower_minutes,
      CAST(json_extract(f.forecast_json, '$.raw.historyCount') AS INTEGER) AS history_count,
      fe.kind AS latest_event_kind
    FROM runs r
    JOIN forecast_snapshots f ON f.snapshot_id = (
      SELECT f2.snapshot_id FROM forecast_snapshots f2
      WHERE f2.run_id = r.run_id
      ORDER BY julianday(f2.observed_at) DESC, f2.snapshot_id DESC
      LIMIT 1
    )
    LEFT JOIN events fe ON fe.event_id = f.event_id AND fe.run_id = r.run_id
    WHERE r.provider = 'codex'
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.run_id = r.run_id
          AND json_extract(e.source_json, '$.adapter') = 'codex-jsonl'
      )
    ORDER BY julianday(f.observed_at) DESC, f.snapshot_id DESC
  `).all();
}

function emptyLiveSnapshot({
  headline = '暂无实机快照',
  remaining = '剩余时间暂不可用',
  range = '运行本机扫描后，这里会显示已保存的 ETA',
  reason = '这里只读取 SQLite 快照，不会假装实时监听',
  selectionId = null,
  scope = 'run',
  revision = null,
} = {}) {
  return {
    kind: 'live_snapshot',
    available: false,
    isRealtime: false,
    provider: 'Codex',
    selectionId,
    scope,
    status: 'unknown',
    projectionRevision: revision,
    capturedAt: null,
    capturedLabel: '尚未导入',
    display: {
      headline,
      remaining,
      range,
      currentStep: '—',
      reason,
      tone: 'empty',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    },
    forecast: {
      mode: 'unavailable',
      status: 'unavailable',
      p50Minutes: null,
      p80Minutes: null,
      lowerMinutes: null,
      confidence: 'unavailable',
    },
  };
}

function initialComparison(database, row) {
  if (!terminalStatus(liveStatus(row.status, row.forecast_status)) || !row.finished_at) return null;
  const initial = database.db.prepare(`
    SELECT observed_at, p50_minutes, p80_minutes, lower_minutes
    FROM forecast_snapshots
    WHERE run_id = ?
      AND p50_minutes > 0
      AND forecast_status NOT IN ('terminal', 'needs_input')
    ORDER BY julianday(observed_at), snapshot_id
    LIMIT 1
  `).get(row.internal_run_id);
  if (!initial || !Number.isFinite(initial.p50_minutes)) return null;
  const anchor = new Date(initial.observed_at);
  const actual = new Date(row.finished_at);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(actual.getTime())) return null;
  const expected = clockAfter(anchor, initial.p50_minutes);
  const lower = clockAfter(anchor, initial.lower_minutes ?? initial.p50_minutes);
  const upper = clockAfter(anchor, initial.p80_minutes ?? initial.p50_minutes);
  const deltaMinutes = (actual.getTime() - expected.getTime()) / 60_000;
  const direction = Math.abs(deltaMinutes) < 0.5
    ? '与初次预计基本一致'
    : deltaMinutes > 0
      ? `比初次 P50 晚 ${Math.round(deltaMinutes)} 分钟`
      : `比初次 P50 早 ${Math.round(Math.abs(deltaMinutes))} 分钟`;
  return {
    range: `初次预计 ${formatClock(lower)}–${formatClock(upper)} · 实际 ${formatClock(actual)}`,
    reason: direction,
    data: {
      initialExpectedAt: expected.toISOString(),
      initialLowerAt: lower.toISOString(),
      initialUpperAt: upper.toISOString(),
      actualAt: actual.toISOString(),
      deltaMinutes: Number(deltaMinutes.toFixed(2)),
    },
  };
}

function unavailableScope(row, selectionId, scope, reason = null) {
  const noun = scope === 'task' ? '任务' : '项目';
  return emptyLiveSnapshot({
    headline: `${noun} ETA 暂不可用`,
    remaining: '没有显式工作集合',
    range: '当前不显示推测完成时间',
    reason: reason ?? `宿主尚未提供唯一显式 ${scope} workset 与 owner terminal`,
    selectionId,
    scope,
    revision: Number(row.snapshot_id),
  });
}

function parentWorksetRows(database, childType, childId, worksetType) {
  return database.db.prepare(`
    SELECT
      w.workset_id AS internal_workset_id,
      w.workset_type,
      w.status,
      w.revision,
      w.workset_closed,
      w.owner_terminal,
      w.started_at,
      w.finished_at,
      w.outcome_minutes,
      w.updated_at,
      wf.snapshot_id,
      wf.observed_at,
      wf.mode,
      wf.forecast_status,
      wf.evidence,
      wf.lower_minutes,
      wf.p50_minutes,
      wf.p80_minutes,
      wf.upper_minutes,
      wf.reason_code,
      ws.source_kind,
      ws.source_status,
      ws.first_received_at AS source_first_received_at,
      ws.last_received_at AS source_last_received_at,
      EXISTS (
        SELECT 1
        FROM codex_goal_receipts AS receipt
        WHERE receipt.workset_id = w.workset_id
          AND receipt.applied = 1
          AND receipt.censored = 0
          AND receipt.quarantined = 0
          AND receipt.first_ingest_mode = 'live'
          AND NOT EXISTS (
            SELECT 1 FROM codex_goal_quarantines AS quarantine
            WHERE quarantine.goal_id = receipt.goal_id
          )
      ) AS has_live_goal_receipt,
      CAST(json_extract(wf.forecast_json, '$.resumeLowerMinutes') AS REAL) AS resume_lower_minutes,
      CAST(json_extract(wf.forecast_json, '$.resumeUpperMinutes') AS REAL) AS resume_upper_minutes
    FROM worksets w
    JOIN workset_members m
      ON m.parent_workset_id = w.workset_id
      AND m.revision = w.revision
      AND m.child_type = ?
      AND m.detached_at IS NULL
      AND CASE WHEN ? = 'run' THEN m.child_run_id ELSE m.child_workset_id END = ?
    LEFT JOIN workset_forecast_snapshots wf ON wf.snapshot_id = (
      SELECT MAX(wf2.snapshot_id)
      FROM workset_forecast_snapshots wf2
      WHERE wf2.workset_id = w.workset_id
    )
    LEFT JOIN workset_sources ws ON ws.workset_id = w.workset_id
    WHERE w.workset_type = ?
    ORDER BY julianday(COALESCE(wf.observed_at, w.updated_at)) DESC, w.workset_id
  `).all(childType, childType, childId, worksetType);
}

function taskWorksetRows(database) {
  return database.db.prepare(`
    SELECT
      w.workset_id AS internal_workset_id,
      w.workset_type,
      w.status,
      w.revision,
      w.workset_closed,
      w.owner_terminal,
      w.started_at,
      w.finished_at,
      w.outcome_minutes,
      w.updated_at,
      wf.snapshot_id,
      wf.observed_at,
      wf.mode,
      wf.forecast_status,
      wf.evidence,
      wf.lower_minutes,
      wf.p50_minutes,
      wf.p80_minutes,
      wf.upper_minutes,
      wf.reason_code,
      ws.source_kind,
      ws.source_status,
      ws.first_received_at AS source_first_received_at,
      ws.last_received_at AS source_last_received_at,
      EXISTS (
        SELECT 1
        FROM codex_goal_receipts AS receipt
        WHERE receipt.workset_id = w.workset_id
          AND receipt.applied = 1
          AND receipt.censored = 0
          AND receipt.quarantined = 0
          AND receipt.first_ingest_mode = 'live'
          AND NOT EXISTS (
            SELECT 1 FROM codex_goal_quarantines AS quarantine
            WHERE quarantine.goal_id = receipt.goal_id
          )
      ) AS has_live_goal_receipt,
      CAST(json_extract(wf.forecast_json, '$.resumeLowerMinutes') AS REAL) AS resume_lower_minutes,
      CAST(json_extract(wf.forecast_json, '$.resumeUpperMinutes') AS REAL) AS resume_upper_minutes
    FROM worksets w
    LEFT JOIN workset_forecast_snapshots wf ON wf.snapshot_id = (
      SELECT MAX(wf2.snapshot_id)
      FROM workset_forecast_snapshots wf2
      WHERE wf2.workset_id = w.workset_id
    )
    LEFT JOIN workset_sources ws ON ws.workset_id = w.workset_id
    WHERE w.workset_type = 'task'
    ORDER BY julianday(COALESCE(wf.observed_at, w.updated_at)) DESC, w.workset_id
  `).all();
}

function quarantinedWorkset(row) {
  return row?.source_status === 'quarantined';
}

function verifiedGoalWorkset(row) {
  return row?.source_kind === 'codex_goal_shadow'
    && row?.source_status === 'verified_structural';
}

function backfillOnlyGoalWorkset(row) {
  return verifiedGoalWorkset(row) && !Boolean(row?.has_live_goal_receipt);
}

function unpromotedProviderShadow(row) {
  return row?.source_status === 'verified_structural'
    && ['codex_goal_shadow', 'explicit_project_shadow'].includes(row?.source_kind);
}

function selectEvidenceWorkset(rows) {
  const eligible = rows.filter((row) => !quarantinedWorkset(row));
  if (eligible.length === 1) return { row: eligible[0], count: 1 };
  if (eligible.length > 1) return { row: null, count: eligible.length };
  if (rows.length === 1) return { row: rows[0], count: 1 };
  return { row: null, count: rows.length };
}

function worksetMemberRunRows(database, worksetRow, liveRowsById) {
  return database.db.prepare(`
    SELECT child_run_id
    FROM workset_members
    WHERE parent_workset_id = ?
      AND revision = ?
      AND child_type = 'run'
      AND detached_at IS NULL
    ORDER BY order_index, member_id
  `).all(worksetRow.internal_workset_id, worksetRow.revision)
    .map(({ child_run_id: runId }) => liveRowsById.get(runId))
    .filter(Boolean)
    .toSorted((left, right) =>
      Date.parse(right.observed_at) - Date.parse(left.observed_at)
      || Number(right.snapshot_id) - Number(left.snapshot_id));
}

function selectedWorksetChain(database, runId) {
  const tasks = parentWorksetRows(database, 'run', runId, 'task');
  const selectedTask = selectEvidenceWorkset(tasks);
  if (!selectedTask.row) {
    return { task: null, project: null, taskCount: selectedTask.count, projectCount: 0 };
  }
  const projects = parentWorksetRows(
    database,
    'workset',
    selectedTask.row.internal_workset_id,
    'project',
  );
  const selectedProject = selectEvidenceWorkset(projects);
  return {
    task: selectedTask.row,
    project: selectedProject.row,
    taskCount: 1,
    projectCount: selectedProject.count,
  };
}

function worksetInitialComparison(database, row) {
  if (!terminalStatus(row.status) || !row.finished_at) return null;
  const initial = database.db.prepare(`
    SELECT observed_at, p50_minutes, p80_minutes, lower_minutes
    FROM workset_forecast_snapshots
    WHERE workset_id = ?
      AND p50_minutes > 0
      AND forecast_status NOT IN ('terminal', 'needs_input')
    ORDER BY julianday(observed_at), snapshot_id
    LIMIT 1
  `).get(row.internal_workset_id);
  if (!initial) return null;
  const anchor = new Date(initial.observed_at);
  const actual = new Date(row.finished_at);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(actual.getTime())) return null;
  const expected = clockAfter(anchor, initial.p50_minutes);
  const lower = clockAfter(anchor, initial.lower_minutes ?? initial.p50_minutes);
  const upper = clockAfter(anchor, initial.p80_minutes ?? initial.p50_minutes);
  const deltaMinutes = (actual.getTime() - expected.getTime()) / 60_000;
  return {
    range: `初次预计 ${formatClock(lower)}–${formatClock(upper)} · 实际 ${formatClock(actual)}`,
    reason: Math.abs(deltaMinutes) < 0.5
      ? '与初次预计基本一致'
      : deltaMinutes > 0
        ? `比初次 P50 晚 ${Math.round(deltaMinutes)} 分钟`
        : `比初次 P50 早 ${Math.round(Math.abs(deltaMinutes))} 分钟`,
    data: {
      initialExpectedAt: expected.toISOString(),
      initialLowerAt: lower.toISOString(),
      initialUpperAt: upper.toISOString(),
      actualAt: actual.toISOString(),
      deltaMinutes: Number(deltaMinutes.toFixed(2)),
    },
  };
}

function worksetDisplay(database, row) {
  const noun = row.workset_type === 'task' ? '任务' : '项目';
  const status = liveStatus(row.status, row.forecast_status);
  if (quarantinedWorkset(row)) {
    return {
      headline: '结构证据冲突，ETA 不可用',
      remaining: '此前 ETA 与完成断言已停用',
      range: '当前不显示推测完成时间',
      currentStep: `${noun}身份待重新确认`,
      reason: '结构事件发生冲突；已停止使用此前 ETA 与完成断言',
      tone: 'empty',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  if (backfillOnlyGoalWorkset(row)) {
    return {
      headline: '历史结构观察',
      remaining: '不代表当前活跃任务',
      range: '当前不显示推测完成时间',
      currentStep: '仅保留离线 outcome / coverage 证据',
      reason: '该 Goal 首次来自历史回放；只有 watcher 实时收到新的结构 receipt 后才进入实时任务列表',
      tone: 'empty',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  const shadowUnpromoted = unpromotedProviderShadow(row);
  const comparison = shadowUnpromoted ? null : worksetInitialComparison(database, row);
  if (terminalStatus(status)) {
    const actual = Number.isFinite(row.outcome_minutes)
      ? `实际用时 ${row.outcome_minutes.toFixed(row.outcome_minutes < 10 ? 1 : 0)} 分钟`
      : '工作集合已结束';
    return {
      headline: status === 'succeeded' ? `${noun}已完成` : status === 'failed' ? `${noun}失败` : `${noun}已取消`,
      remaining: actual,
      range: comparison?.range ?? actual,
      currentStep: `显式${noun}工作集合已终止`,
      reason: comparison?.reason ?? (shadowUnpromoted
        ? 'owner terminal 已保存；shadow 尚未通过 promotion gate，不展示预测对比'
        : 'owner terminal 已保存；没有继续倒计时'),
      tone: status === 'succeeded' ? 'done' : 'failed',
      status,
      statusLabel: statusLabel(status),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: comparison?.data ?? null,
    };
  }
  if (PAUSED_STATUSES.has(status)) {
    const prefix = status === 'needs_input' ? '回复后' : status === 'blocked' ? '解除后' : '恢复后';
    const low = !shadowUnpromoted && Number.isFinite(row.resume_lower_minutes)
      ? Math.max(1, Math.round(row.resume_lower_minutes))
      : null;
    const high = !shadowUnpromoted && Number.isFinite(row.resume_upper_minutes)
      ? Math.max(low ?? 1, Math.round(row.resume_upper_minutes))
      : null;
    const hasResumeEstimate = low !== null && high !== null;
    const confidence = hasResumeEstimate ? 'prior_only' : 'unavailable';
    return {
      headline: status === 'needs_input' ? '等你回复' : status === 'waiting_provider' ? '等待服务' : status === 'blocked' ? '暂时阻塞' : '已暂停',
      remaining: hasResumeEstimate ? `${prefix}还需约 ${Math.round((low + high) / 2)} 分钟` : `${prefix} active 时间暂不可用`,
      range: hasResumeEstimate ? `${prefix}约 ${low}–${high} 分钟` : '不预测等待何时结束',
      currentStep: `${noun}工作集合已停止主动推进`,
      reason: '等待时间不进入 ETA；只保留恢复后的 active 范围',
      tone: 'waiting',
      status,
      statusLabel: statusLabel(status),
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      comparison: null,
    };
  }
  if (shadowUnpromoted && row.status === 'running') {
    return {
      headline: `${noun}进行中`,
      remaining: 'ETA 证据不足',
      range: '当前不显示推测完成时间',
      currentStep: `已确认结构化 ${noun} shadow`,
      reason: '真实结构状态已确认；30/50 样本 promotion gate 尚未通过，数字 ETA 保持关闭',
      tone: 'working',
      status: 'working',
      statusLabel: statusLabel('working'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  if (row.status === 'pending' || !Number.isFinite(row.p50_minutes) || row.forecast_status === 'unknown') {
    return {
      headline: `${noun} ETA 暂不可用`,
      remaining: '剩余时间暂不可用',
      range: '当前不显示推测完成时间',
      currentStep: `显式${noun}工作集合`,
      reason: row.reason_code === 'open_workset_without_parent_survival'
        ? '工作集合仍开放且没有 parent survival'
        : '成员或调度语义不足，按合同返回 unknown',
      tone: 'empty',
      status: 'unknown',
      statusLabel: statusLabel('unknown'),
      confidence: 'unavailable',
      confidenceLabel: confidenceLabel('unavailable'),
      comparison: null,
    };
  }
  const anchor = new Date(row.observed_at ?? row.updated_at);
  const expected = clockAfter(anchor, row.p50_minutes);
  const lower = clockAfter(anchor, row.lower_minutes ?? row.p50_minutes);
  const upper = clockAfter(anchor, row.p80_minutes ?? row.upper_minutes ?? row.p50_minutes);
  return {
    headline: `预计 ${formatClock(expected)} 完成`,
    remaining: `还剩约 ${roundedMinutes(row.p50_minutes)} 分钟`,
    range: `大致 ${formatClock(lower)}–${formatClock(upper)}`,
    currentStep: `显式${noun}工作集合`,
    reason: row.reason_code === 'closed_workset_explicit_parallel'
      ? '显式并行成员均已运行；中位数取较慢分支，上界保守相加'
      : '显式顺序成员已顺序合成；多成员上界保守相加',
    tone: 'working',
    status: 'working',
    statusLabel: statusLabel('working'),
    confidence: 'prior_only',
    confidenceLabel: confidenceLabel('prior_only'),
    comparison: null,
  };
}

function worksetSnapshot(database, runRow, worksetRow, { selectionId, scope }) {
  const display = worksetDisplay(database, worksetRow);
  const confidence = display.confidence;
  const quarantined = quarantinedWorkset(worksetRow);
  const historicalBackfill = backfillOnlyGoalWorkset(worksetRow);
  const shadowStatusOnly = unpromotedProviderShadow(worksetRow);
  const capturedAt = quarantined
    ? worksetRow.source_last_received_at
    : worksetRow.observed_at ?? worksetRow.updated_at ?? runRow?.observed_at ?? null;
  return {
    kind: 'live_snapshot',
    available: display.status !== 'unknown',
    isRealtime: false,
    provider: 'Codex',
    selectionId,
    scope,
    status: display.status,
    projectionRevision: Number(worksetRow.snapshot_id ?? worksetRow.revision),
    capturedAt,
    capturedLabel: snapshotTimestamp(capturedAt),
    display,
    forecast: {
      mode: quarantined || historicalBackfill || shadowStatusOnly ? 'unavailable' : worksetRow.mode ?? 'workset_unknown',
      status: quarantined ? 'quarantined' : historicalBackfill ? 'historical_backfill' : shadowStatusOnly ? 'status_only' : worksetRow.forecast_status ?? 'unknown',
      p50Minutes: quarantined || historicalBackfill || shadowStatusOnly || !Number.isFinite(worksetRow.p50_minutes) ? null : worksetRow.p50_minutes,
      p80Minutes: quarantined || historicalBackfill || shadowStatusOnly || !Number.isFinite(worksetRow.p80_minutes) ? null : worksetRow.p80_minutes,
      lowerMinutes: quarantined || historicalBackfill || shadowStatusOnly || !Number.isFinite(worksetRow.lower_minutes) ? null : worksetRow.lower_minutes,
      upperMinutes: quarantined || historicalBackfill || shadowStatusOnly || !Number.isFinite(worksetRow.upper_minutes) ? null : worksetRow.upper_minutes,
      confidence,
    },
  };
}

function unavailableRunForTask(selectionId) {
  return emptyLiveSnapshot({
    headline: '本轮 ETA 暂不可用',
    remaining: '当前没有可显示的 active run',
    range: '任务状态仍可在“任务”范围查看',
    reason: '不会从任务状态伪造一个 run，也不会改用其他任务的 ETA',
    selectionId,
    scope: 'run',
  });
}

function liveSnapshotFromTask(database, task, runRow, { selectionId, scope }) {
  if (scope === 'task') {
    return worksetSnapshot(database, runRow, task, { selectionId, scope });
  }
  if (scope === 'project') {
    if (quarantinedWorkset(task)) {
      return worksetSnapshot(database, runRow, task, { selectionId, scope });
    }
    const projects = parentWorksetRows(
      database,
      'workset',
      task.internal_workset_id,
      'project',
    );
    const selected = selectEvidenceWorkset(projects);
    if (!selected.row) {
      const reason = selected.count > 1
        ? '发现多个显式 project workset；无法唯一选择，按合同返回 unknown'
        : null;
      return unavailableScope(task, selectionId, scope, reason);
    }
    return worksetSnapshot(database, runRow, selected.row, { selectionId, scope });
  }
  return runRow
    ? liveSnapshotFromRow(database, runRow, { selectionId, scope: 'run' })
    : unavailableRunForTask(selectionId);
}

function liveSnapshotFromRow(database, row, { selectionId, scope }) {
  if (scope !== 'run') {
    const chain = selectedWorksetChain(database, row.internal_run_id);
    if (scope === 'project' && quarantinedWorkset(chain.task)) {
      return worksetSnapshot(database, row, chain.task, { selectionId, scope });
    }
    const workset = scope === 'task' ? chain.task : chain.project;
    if (!workset) {
      const count = scope === 'task' ? chain.taskCount : chain.projectCount;
      const reason = count > 1
        ? `发现多个显式 ${scope} workset；无法唯一选择，按合同返回 unknown`
        : null;
      return unavailableScope(row, selectionId, scope, reason);
    }
    return worksetSnapshot(database, row, workset, { selectionId, scope });
  }
  const step = database.db.prepare(`
    SELECT label FROM plan_steps
    WHERE run_id = ?
      AND revision = (SELECT MAX(revision) FROM plan_steps WHERE run_id = ?)
      AND status IN ('active', 'in_progress', 'working', 'pending')
    ORDER BY CASE status
      WHEN 'active' THEN 0 WHEN 'in_progress' THEN 0 WHEN 'working' THEN 0 ELSE 1 END,
      rowid
    LIMIT 1
  `).get(row.internal_run_id, row.internal_run_id);
  const display = liveSnapshotDisplay(row, step?.label, initialComparison(database, row));
  const status = display.status ?? liveStatus(row.status, row.forecast_status);
  const confidence = display.confidence ?? evidenceConfidence({
    mode: row.mode,
    historyCount: row.history_count,
    status,
  });
  return {
    kind: 'live_snapshot',
    available: true,
    isRealtime: false,
    provider: 'Codex',
    selectionId,
    scope,
    status,
    projectionRevision: Number(row.snapshot_id),
    capturedAt: row.observed_at,
    capturedLabel: snapshotTimestamp(row.observed_at),
    display,
    forecast: {
      mode: row.mode ?? 'run_fallback',
      status: row.forecast_status ?? 'forecast',
      p50Minutes: Number.isFinite(row.p50_minutes) ? row.p50_minutes : null,
      p80Minutes: Number.isFinite(row.p80_minutes) ? row.p80_minutes : null,
      lowerMinutes: Number.isFinite(row.lower_minutes) ? row.lower_minutes : null,
      confidence,
    },
  };
}

function liveRunRowFresh(row, now) {
  const status = liveStatus(row.status, row.forecast_status);
  const tone = PAUSED_STATUSES.has(status)
    ? 'waiting'
    : terminalStatus(status)
      ? status === 'succeeded' ? 'done' : 'failed'
      : 'working';
  return isLiveSnapshotFresh({
    available: true,
    capturedAt: row.observed_at,
    display: { tone },
    forecast: { p80Minutes: row.p80_minutes },
  }, now);
}

function selectedLiveRow(rows, selectionId) {
  if (selectionId === null || selectionId === undefined || selectionId === '') return rows[0] ?? null;
  if (!LIVE_SELECTION_PATTERN.test(selectionId)) return null;
  return rows.find((row) => selectionIdFor(row.internal_run_id) === selectionId) ?? null;
}

function selectedTaskWorkset(database, selectionId) {
  if (!LIVE_SELECTION_PATTERN.test(selectionId ?? '')) return null;
  return taskWorksetRows(database)
    .find((row) => worksetSelectionIdFor(row.internal_workset_id) === selectionId) ?? null;
}

/**
 * Build a fail-closed browser projection from persisted live-adapter rows.
 * Native/session/run IDs and stored free text are intentionally never returned.
 */
export function buildLatestLiveSnapshot(database, { selectionId = null, scope = 'run' } = {}) {
  if (!['run', 'task', 'project'].includes(scope)) {
    return emptyLiveSnapshot({
      headline: '范围不可用',
      reason: '请求的范围不受支持',
      selectionId: null,
      scope: 'run',
    });
  }
  const rows = liveSnapshotRows(database);
  const row = selectedLiveRow(rows, selectionId);

  if (!row && selectionId) {
    const task = selectedTaskWorkset(database, selectionId);
    if (task) {
      const liveRowsById = new Map(rows.map((candidate) => [candidate.internal_run_id, candidate]));
      const [runRow = null] = worksetMemberRunRows(database, task, liveRowsById);
      return liveSnapshotFromTask(database, task, runRow, { selectionId, scope });
    }
  }

  if (!row) {
    return emptyLiveSnapshot(selectionId
      ? {
          headline: '所选对象暂不可用',
          reason: '不会改用另一个任务的 ETA',
          selectionId,
          scope,
        }
      : {});
  }
  const resolvedSelection = selectionIdFor(row.internal_run_id);
  return liveSnapshotFromRow(database, row, { selectionId: resolvedSelection, scope });
}

export function buildActiveLiveSelections(database, now = new Date()) {
  const rows = liveSnapshotRows(database);
  const liveRowsById = new Map(rows.map((row) => [row.internal_run_id, row]));
  const boundRunIds = new Set();
  const taskRelations = taskWorksetRows(database).flatMap((task) => {
    if (quarantinedWorkset(task)) return [];
    const memberRows = worksetMemberRunRows(database, task, liveRowsById);
    const runRow = memberRows[0] ?? null;
    // A realtime task selector still needs one persisted Codex-adapter run as
    // structural lineage. A standalone/manual workset must never appear as a
    // live Codex task merely because its status is waiting or terminal.
    if (!runRow) return [];
    return [{ task, runRow, memberRows }];
  });
  // Identity uniqueness is structural, not a freshness heuristic. A stale or
  // currently unforecastable non-quarantined parent still makes the mapping
  // ambiguous and must prevent automatic replacement of its shared run.
  const taskParentCounts = new Map();
  for (const relation of taskRelations) {
    for (const member of relation.memberRows) {
      taskParentCounts.set(
        member.internal_run_id,
        (taskParentCounts.get(member.internal_run_id) ?? 0) + 1,
      );
    }
  }
  const projectedTasks = taskRelations.flatMap(({ task, runRow, memberRows }) => {
    if (backfillOnlyGoalWorkset(task)) return [];
    const projects = parentWorksetRows(database, 'workset', task.internal_workset_id, 'project');
    const project = selectEvidenceWorkset(projects).row;
    const display = worksetDisplay(database, task);
    const activityCandidates = [
      task.observed_at ?? task.updated_at,
      project?.observed_at ?? project?.updated_at,
      runRow.observed_at,
    ].filter((value) => Number.isFinite(Date.parse(value)));
    const activityObservedAt = activityCandidates.toSorted((left, right) =>
      Date.parse(right) - Date.parse(left))[0] ?? task.updated_at;
    const taskFresh = isLiveSnapshotFresh({
      available: display.status !== 'unknown',
      capturedAt: task.observed_at ?? task.updated_at,
      display,
      forecast: { p80Minutes: task.p80_minutes ?? task.upper_minutes },
    }, now);
    const taskObservedMs = Date.parse(task.observed_at ?? task.updated_at);
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const pausedWithinGrace = task.status !== 'paused'
      || (
        Number.isFinite(taskObservedMs)
        && Number.isFinite(nowMs)
        && Math.max(0, nowMs - taskObservedMs) <= LIVE_TERMINAL_GRACE_MS
      );
    const statusOnlyOnFreshMember = verifiedGoalWorkset(task)
      && display.status === 'working'
      && !Number.isFinite(task.p50_minutes)
      && memberRows.some((member) => liveRunRowFresh(member, now));
    const fresh = pausedWithinGrace && (taskFresh || statusOnlyOnFreshMember);
    if (!fresh) return [];
    return [{
      kind: 'task',
      task,
      runRow,
      memberRows,
      project,
      display,
      activityObservedAt,
      scopeRank: project ? 2 : 1,
    }];
  });
  const taskCandidates = projectedTasks.filter((candidate) => {
    // Two eligible task parents for the same seed run are semantically
    // ambiguous. Neither may replace that run or become the implicit default.
    return taskParentCounts.get(candidate.runRow.internal_run_id) === 1;
  });
  for (const candidate of taskCandidates) {
    for (const member of candidate.memberRows) {
      if (taskParentCounts.get(member.internal_run_id) === 1) {
        boundRunIds.add(member.internal_run_id);
      }
    }
  }
  const runCandidates = rows
    .filter((row) => !boundRunIds.has(row.internal_run_id))
    .map((row) => {
      const status = liveStatus(row.status, row.forecast_status);
      const chain = selectedWorksetChain(database, row.internal_run_id);
      return {
        kind: 'run',
        row,
        chain,
        status,
        activityObservedAt: row.observed_at,
        scopeRank: 0,
        fresh: liveRunRowFresh(row, now),
      };
    })
    .filter(({ fresh }) => fresh);
  const compareCandidates = (left, right) =>
      right.scopeRank - left.scopeRank
      || Date.parse(right.activityObservedAt) - Date.parse(left.activityObservedAt)
      || Number(right.task?.snapshot_id ?? right.row?.snapshot_id ?? 0)
        - Number(left.task?.snapshot_id ?? left.row?.snapshot_id ?? 0);
  const ranked = [...taskCandidates, ...runCandidates].toSorted(compareCandidates);
  const limited = ranked.slice(0, 8);
  if (runCandidates.length > 0 && !limited.some((candidate) => candidate.kind === 'run')) {
    const latestRun = runCandidates.toSorted((left, right) =>
      Date.parse(right.activityObservedAt) - Date.parse(left.activityObservedAt)
      || Number(right.row?.snapshot_id ?? 0) - Number(left.row?.snapshot_id ?? 0))[0];
    if (limited.length < 8) limited.push(latestRun);
    else limited[limited.length - 1] = latestRun;
  }
  const selections = limited
    .toSorted(compareCandidates)
    .map((candidate) => {
      if (candidate.kind === 'task') {
        const { task, runRow, project, display, activityObservedAt } = candidate;
        return {
          selectionId: worksetSelectionIdFor(task.internal_workset_id),
          status: display.status,
          observedAt: activityObservedAt,
          projectionRevision: Number(task.snapshot_id ?? task.revision),
          meta: {
            provider: 'codex',
            planObserved: runRow?.mode === 'plan_conditioned',
            evidenceConfidence: display.confidence,
            defaultScope: 'task',
            replacesSelectionId: selectionIdFor(runRow.internal_run_id),
            scopeAvailability: {
              run: runRow ? 'available' : 'unknown',
              task: 'available',
              project: project ? 'available' : 'unknown',
            },
          },
        };
      }
      const { row, chain, status, activityObservedAt } = candidate;
      return {
        selectionId: selectionIdFor(row.internal_run_id),
        status,
        observedAt: activityObservedAt,
        projectionRevision: Date.parse(activityObservedAt),
        meta: {
          provider: 'codex',
          planObserved: row.mode === 'plan_conditioned',
          defaultScope: 'run',
          evidenceConfidence: evidenceConfidence({
            mode: row.mode,
            historyCount: row.history_count,
            status,
          }),
          scopeAvailability: {
            run: 'available',
            task: chain.task
              && !quarantinedWorkset(chain.task)
              && !backfillOnlyGoalWorkset(chain.task)
              ? 'available'
              : 'unknown',
            project: chain.project
              && !quarantinedWorkset(chain.task)
              && !backfillOnlyGoalWorkset(chain.task)
              && !quarantinedWorkset(chain.project)
              ? 'available'
              : 'unknown',
          },
        },
      };
    });
  return {
    kind: 'live_active',
    defaultSelectionId: selections[0]?.selectionId ?? null,
    selections,
  };
}

export function buildLiveWatchStatus({ watcher = null, enabled = false, rootAvailable = true } = {}) {
  if (enabled && !rootAvailable) {
    return {
      kind: 'live_watch_status',
      enabled: true,
      running: false,
      status: 'degraded',
      lastScanAt: null,
      lastSuccessAt: null,
      lastChangeAt: null,
      errorCode: 'WATCH_ROOT_UNAVAILABLE',
      pollIntervalMs: null,
    };
  }
  if (!watcher) {
    return {
      kind: 'live_watch_status',
      enabled: false,
      running: false,
      status: 'disabled',
      lastScanAt: null,
      lastSuccessAt: null,
      lastChangeAt: null,
      errorCode: null,
      pollIntervalMs: null,
    };
  }
  const status = watcher.getStatus();
  const projection = {
    kind: 'live_watch_status',
    enabled: status.enabled === true,
    running: status.running === true,
    status: status.status,
    lastScanAt: status.lastScanAt,
    lastSuccessAt: status.lastSuccessAt,
    lastChangeAt: status.lastChangeAt,
    errorCode: status.errorCode,
    pollIntervalMs: status.pollIntervalMs,
  };
  if (status.goalPilot) projection.goalPilot = status.goalPilot;
  return projection;
}

export function isLiveSnapshotFresh(snapshot, now = new Date()) {
  if (!snapshot?.available || !snapshot.capturedAt) return false;
  const capturedAt = Date.parse(snapshot.capturedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(nowMs)) return false;
  const ageMs = Math.max(0, nowMs - capturedAt);
  const tone = snapshot.display?.tone;
  if (tone === 'waiting') return true;
  if (tone === 'done' || tone === 'failed') return ageMs <= LIVE_TERMINAL_GRACE_MS;
  const p80Minutes = Number(snapshot.forecast?.p80Minutes);
  const forecastHorizonMs = Number.isFinite(p80Minutes) && p80Minutes >= 0
    ? p80Minutes * 60_000
    : 0;
  return ageMs <= forecastHorizonMs + LIVE_TERMINAL_GRACE_MS;
}

export function createApp({
  databasePath = process.env.AGENT_ETA_DB || DEFAULT_DB,
  trackerDatabasePath = null,
  fixtureDirectory = FIXTURE_DIR,
  wallClock = () => new Date(),
  liveWatchEnabled = false,
  liveWatchRoot = DEFAULT_CODEX_ROOT,
  liveWatchIntervalMs = 2_000,
  liveWatchOperations = {},
  weeklyEvaluationEnabled = false,
  weeklyOutputDirectory = OUTPUT_DIR,
} = {}) {
  const database = new AgentEtaDatabase(databasePath);
  const tracker = trackerDatabasePath === null ? null : new AgentETA({
    filename: trackerDatabasePath, clock: () => Number(wallClock()),
  });
  const fixtures = readFixtures(fixtureDirectory);
  const sseClients = new Set();
  let projection = null;
  const liveWatchRootAvailable = existsSync(liveWatchRoot);
  let liveWatcher = null;
  let weeklyScheduler = null;

  function broadcast(event = 'state', data = { kind: 'state_update' }) {
    const payload = JSON.stringify(data);
    for (const client of sseClients) client.write(`event: ${event}\ndata: ${payload}\n\n`);
  }

  function loadWatcherState() {
    const saved = database.loadLiveWatchState('codex');
    if (!saved) return null;
    return {
      watermarkMs: Number.isFinite(Date.parse(saved.cursorAt ?? ''))
        ? Date.parse(saved.cursorAt)
        : null,
      lastSuccessAt: saved.lastSuccessAt,
      lastChangeAt: saved.lastChangeAt,
      counters: {
        scans: saved.scanCount,
        files: 0,
        insertedEvents: saved.importedEvents,
        savedForecasts: saved.savedForecasts,
        failures: 0,
      },
    };
  }

  function saveWatcherState(state) {
    database.saveLiveWatchState({
      provider: 'codex',
      enabled: true,
      running: true,
      status: state.errorCode ? 'error' : 'watching',
      errorCode: state.errorCode,
      lastScanAt: state.lastScanAt,
      lastSuccessAt: state.lastSuccessAt,
      lastChangeAt: state.lastChangeAt,
      cursorAt: Number.isFinite(state.watermarkMs)
        ? new Date(state.watermarkMs).toISOString()
        : null,
      pollIntervalMs: liveWatchIntervalMs,
      scanCount: state.counters.scans,
      importedEvents: state.counters.insertedEvents,
      savedForecasts: state.counters.savedForecasts,
    });
  }

  function currentLiveWatchStatus(snapshot = null) {
    const status = buildLiveWatchStatus({
      watcher: liveWatcher,
      enabled: liveWatchEnabled,
      rootAvailable: liveWatchRootAvailable,
    });
    if (!status.running || status.errorCode !== null) return status;
    const candidate = snapshot ?? buildLatestLiveSnapshot(database);
    if (candidate.available && !isLiveSnapshotFresh(candidate, wallClock())) {
      return { ...status, status: 'stale' };
    }
    return status;
  }

  function buildProjection(fixture, cursor, state, forecast, display) {
    return {
      runId: state.runId,
      fixtureId: fixture.id,
      fixtureTitle: fixture.title,
      fixtureDescription: fixture.description,
      historyProfile: fixture.historyProfile ?? 'cold',
      cursor,
      eventCount: fixture.events.length,
      state,
      forecast,
      display,
    };
  }

  function persistForecast(fixture, cursor, state, forecast, event) {
    const display = makeDisplay(state, forecast, wallClock());
    database.saveForecast({
      runId: state.runId,
      eventId: event?.event_id ?? null,
      observedAt: event?.observed_at ?? wallClock().toISOString(),
      forecast,
      display,
    });
    if (Number.isFinite(forecast.p50Minutes)) database.setInitialForecast(state.runId, forecast.p50Minutes);
    const historyCount = Number(forecast.raw?.historyCount ?? forecast.raw?.sampleCount ?? 0);
    database.saveCalibration(
      `${state.userId ?? 'local'}/${state.provider ?? event?.provider ?? 'generic'}/${state.modelFamily ?? 'unknown'}/${state.projectId ?? 'default'}`,
      'personal_residual',
      historyCount,
      Number(forecast.personalMultiplier ?? 1),
      {
        eligible: Boolean(forecast.raw?.personalizationEligible ?? historyCount >= 20),
        historyProfile: fixture.historyProfile ?? 'cold',
      },
      'simulated_demo',
    );
    database.saveReplayState(fixture.id, cursor, state.runId);
    return buildProjection(fixture, cursor, state, forecast, display);
  }

  function applyEvent(fixture, cursor, previousState, event) {
    assertValidEvent(event);
    const nextProjection = database.transaction(() => {
      const inserted = database.insertEvent(event);
      const state = inserted ? reduceEvent(previousState, event) : previousState;
      database.saveRun(state, event);
      database.savePlanSteps(state);
      const history = fixture.historyProfile === 'experienced-fast'
        ? database.loadHistory({ before: event.occurred_at, source: 'frozen_demo' })
        : [];
      const forecast = forecastRun({
        state,
        history,
        now: new Date(event.occurred_at),
        seed: `${fixture.seed ?? fixture.id}:${cursor}`,
      });
      return persistForecast(fixture, cursor, state, forecast, event);
    });
    projection = nextProjection;
    return projection;
  }

  function reset(fixtureId = fixtures.keys().next().value) {
    const fixture = fixtures.get(fixtureId);
    if (!fixture) throw new Error(`Unknown fixture: ${fixtureId}`);
    // A reset replaces this frozen run's replay, while keeping outcomes and raw
    // snapshots from the other Demo runs available for audit.
    database.resetReplayRun(fixture.events[0].run_id);
    seedExperiencedFastHistory(database, fixture);
    let state = createRunState(fixture.events[0].run_id);
    projection = applyEvent(fixture, 1, state, fixture.events[0]);
    broadcast();
    return projection;
  }

  function next() {
    if (!projection) return reset();
    const fixture = fixtures.get(projection.fixtureId);
    if (projection.cursor >= fixture.events.length) return projection;
    const event = fixture.events[projection.cursor];
    projection = applyEvent(fixture, projection.cursor + 1, projection.state, event);
    broadcast();
    return projection;
  }

  function restore() {
    const replay = database.loadReplayState();
    if (!replay || !fixtures.has(replay.fixtureId)) return reset();
    const fixture = fixtures.get(replay.fixtureId);
    const run = database.loadRun(replay.runId);
    const forecasts = database.listForecasts(replay.runId);
    const latest = forecasts.at(-1);
    if (!run || !latest) return reset(replay.fixtureId);
    projection = buildProjection(fixture, replay.cursor, run.state, latest.forecast, latest.display);
    return projection;
  }

  function serveStatic(request, response, pathname) {
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = resolve(PUBLIC_DIR, requested);
    if (!file.startsWith(`${PUBLIC_DIR}/`) && file !== join(PUBLIC_DIR, 'index.html')) {
      responseJson(response, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const stats = statSync(file);
      if (!stats.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      createReadStream(file).pipe(response);
    } catch {
      responseJson(response, 404, { error: 'Not found' });
    }
  }

  async function handler(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/tracker/runs') {
        const port = server.address()?.port;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!hosts.includes(request.headers.host)
          || (request.headers.origin && !hosts.map(host => `http://${host}`).includes(request.headers.origin))
          || request.headers['sec-fetch-site'] === 'cross-site') {
          responseJson(response, 403, { error: 'LOCAL_ORIGIN_REQUIRED' });
          return;
        }
        if (request.method !== 'GET') {
          responseJson(response, 405, { error: 'READ_ONLY_ENDPOINT' });
          return;
        }
        response.setHeader('Cache-Control', 'no-store');
        responseJson(response, 200, { enabled: Boolean(tracker), runs: tracker?.list() ?? [] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const schemaVersion = Number(database.db.prepare(`
          SELECT value FROM schema_meta WHERE key = 'schema_version'
        `).get()?.value ?? 0);
        responseJson(response, 200, { ok: true, schemaVersion, fixtures: fixtures.size });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/fixtures') {
        responseJson(response, 200, [...fixtures.values()].map(fixtureSummary));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        responseJson(response, 200, projection ?? restore());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/live/latest') {
        const selectionId = url.searchParams.get('selection');
        const scope = url.searchParams.get('scope') ?? 'run';
        const snapshot = buildLatestLiveSnapshot(database, { selectionId, scope });
        const watchSnapshot = scope === 'run'
          ? snapshot
          : buildLatestLiveSnapshot(database, { selectionId, scope: 'run' });
        const watch = currentLiveWatchStatus(watchSnapshot);
        responseJson(response, 200, {
          ...snapshot,
          isRealtime: scope === 'run'
            && watch.running
            && watch.errorCode === null
            && watch.status !== 'stale',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/live/active') {
        responseJson(response, 200, buildActiveLiveSelections(database, wallClock()));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/live/status') {
        const selectionId = url.searchParams.get('selection');
        const scope = url.searchParams.get('scope') ?? 'run';
        const snapshot = selectionId
          ? buildLatestLiveSnapshot(database, { selectionId, scope })
          : null;
        responseJson(response, 200, currentLiveWatchStatus(snapshot));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/reporter/status') {
        responseJson(response, 200, reporterStatusProjection(database));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/reporter') {
        try {
          assertReporterRequest(request);
          const report = sanitizeReporterReport(await readReporterJson(request));
          const saved = applyReporterObservation(database, report, {
            receivedAt: wallClock().toISOString(),
          });
          if (saved.forecastSaved) {
            broadcast('live_update', { kind: 'live_update' });
          }
          responseJson(response, saved.inserted ? 201 : 200, {
            accepted: true,
            inserted: saved.inserted,
            reforecasted: saved.forecastSaved === true,
            connectionStatus: REPORTER_CONNECTION_STATUS,
            ...database.reporterStatus(),
          });
        } catch (error) {
          throw safeReporterError(error);
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/replay/reset') {
        const body = await readJson(request);
        responseJson(response, 200, reset(body.fixtureId));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/replay/next') {
        responseJson(response, 200, next());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write('event: ready\ndata: connected\n\n');
        sseClients.add(response);
        request.on('close', () => sseClients.delete(response));
        return;
      }
      if (request.method === 'GET') {
        const path = url.pathname === '/' ? '/tracker.html' : url.pathname === '/demo' ? '/index.html' : url.pathname;
        serveStatic(request, response, path);
        return;
      }
      responseJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const safeCode = typeof error?.message === 'string'
        && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
        ? error.message
        : 'REQUEST_FAILED';
      responseJson(response, 400, { error: safeCode });
    }
  }

  restore();
  if (liveWatchEnabled && liveWatchRootAvailable) {
    liveWatcher = createCodexShadowWatcher({
      ...liveWatchOperations,
      root: liveWatchRoot,
      database,
      intervalMs: liveWatchIntervalMs,
      loadState: loadWatcherState,
      saveState: saveWatcherState,
      onUpdate: (report) => broadcast('live', {
        kind: 'live_update',
        observedAt: report.observedAt,
      }),
    });
    void liveWatcher.start().catch(() => {});
  }
  if (weeklyEvaluationEnabled && database.filename !== ':memory:') {
    const reportFile = join(weeklyOutputDirectory, 'weekly-shadow-report.json');
    weeklyScheduler = createWeeklyEvaluationScheduler({
      reportFile,
      run: (generatedAt) => writeWeeklyEvaluation({
        database: database.filename,
        outputDirectory: weeklyOutputDirectory,
        generatedAt,
        completedWeeks: 4,
      }),
    });
    void weeklyScheduler.start().catch(() => {});
  }
  const server = createServer(handler);
  return {
    server,
    database,
    fixtures,
    getLiveWatchStatus: () => currentLiveWatchStatus(),
    getProjection: () => projection,
    reset,
    next,
    async close() {
      weeklyScheduler?.stop();
      liveWatcher?.stop();
      await Promise.all([
        weeklyScheduler?.whenIdle() ?? Promise.resolve(),
        liveWatcher?.whenIdle() ?? Promise.resolve(),
      ]);
      if (liveWatcher) {
        const state = liveWatcher.getStatus();
        const saved = database.loadLiveWatchState('codex');
        database.saveLiveWatchState({
          provider: 'codex',
          enabled: true,
          running: false,
          status: 'stopped',
          errorCode: state.errorCode,
          lastScanAt: state.lastScanAt,
          lastSuccessAt: state.lastSuccessAt,
          lastChangeAt: state.lastChangeAt,
          cursorAt: saved?.cursorAt ?? null,
          pollIntervalMs: state.pollIntervalMs,
          scanCount: state.counters.scans,
          importedEvents: state.counters.insertedEvents,
          savedForecasts: state.counters.savedForecasts,
        });
      }
      for (const client of sseClients) client.end();
      await new Promise((resolveClose) => server.close(() => {
        tracker?.close();
        database.close();
        resolveClose();
      }));
    },
  };
}

async function main() {
  const port = Number(process.env.AGENT_ETA_PORT || 4318);
  const watchEnabled = process.env.AGENT_ETA_WATCH !== '0';
  const weeklyEvaluationEnabled = process.env.AGENT_ETA_WEEKLY_EVAL !== '0';
  const watchInterval = Number(process.env.AGENT_ETA_WATCH_INTERVAL_MS || 2_000);
  const app = createApp({
    trackerDatabasePath: defaultDatabasePath(),
    liveWatchEnabled: watchEnabled,
    liveWatchIntervalMs: watchInterval,
    weeklyEvaluationEnabled,
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Agent ETA → http://127.0.0.1:${port}`);
    console.log(`SQLite → ${app.database.filename}`);
    console.log(`Codex shadow watcher → ${app.getLiveWatchStatus().status}`);
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
