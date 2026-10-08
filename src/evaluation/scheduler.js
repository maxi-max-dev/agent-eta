import { readFileSync } from 'node:fs';

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function weekKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function previousWeekKey(reportFile, readFile) {
  try {
    const report = JSON.parse(readFile(reportFile, 'utf8'));
    return weekKey(report.generatedAt);
  } catch {
    return null;
  }
}

/**
 * Run the aggregate evaluator at most once per UTC week. The report path is a
 * local capability and never appears in the public status projection.
 */
export function createWeeklyEvaluationScheduler({
  reportFile,
  run,
  now = () => new Date(),
  timers = globalThis,
  readFile = readFileSync,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
} = {}) {
  if (typeof reportFile !== 'string' || reportFile.length === 0) {
    throw new TypeError('reportFile must be provided');
  }
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  if (!Number.isFinite(checkIntervalMs) || checkIntervalMs <= 0) {
    throw new TypeError('checkIntervalMs must be positive');
  }

  let running = false;
  let checking = false;
  let handle = null;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastErrorCode = null;
  let idleResolvers = [];

  async function check({ force = false } = {}) {
    if (checking) return { ran: false, reason: 'already_running' };
    checking = true;
    const current = now();
    const currentKey = weekKey(current);
    lastAttemptAt = current.toISOString();
    try {
      if (!force && currentKey !== null && previousWeekKey(reportFile, readFile) === currentKey) {
        lastErrorCode = null;
        return { ran: false, reason: 'current_week_already_reported' };
      }
      await run(current.toISOString());
      lastSuccessAt = current.toISOString();
      lastErrorCode = null;
      return { ran: true, reason: 'report_written' };
    } catch {
      lastErrorCode = 'WEEKLY_EVALUATION_FAILED';
      return { ran: false, reason: 'evaluation_failed' };
    } finally {
      checking = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolveIdle of resolvers) resolveIdle();
    }
  }

  async function start({ immediate = true } = {}) {
    if (!running) {
      running = true;
      handle = timers.setInterval(() => void check(), checkIntervalMs);
      handle?.unref?.();
    }
    return immediate ? check() : null;
  }

  function stop() {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
    running = false;
  }

  function whenIdle() {
    if (!checking) return Promise.resolve();
    return new Promise((resolveIdle) => idleResolvers.push(resolveIdle));
  }

  function status() {
    return Object.freeze({
      running,
      checking,
      lastAttemptAt,
      lastSuccessAt,
      lastErrorCode,
      checkIntervalMs,
    });
  }

  return Object.freeze({ start, stop, check, whenIdle, status });
}
