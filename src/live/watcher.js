import { discoverCodexSessions } from '../adapters/codex.js';
import { importLiveScans } from '../adapters/importer.js';
import { scanCodexPilotSession } from '../pilot/codex-goal-scan.js';

export const WATCHER_ERROR_CODES = Object.freeze([
  'WATCH_ALREADY_SCANNING',
  'WATCH_DISCOVERY_FAILED',
  'WATCH_SCAN_FAILED',
  'WATCH_IMPORT_FAILED',
  'WATCH_CALLBACK_FAILED',
  'WATCH_STATE_FAILED',
  'WATCH_DISABLED',
]);

const WATCHER_ERROR_CODE_SET = new Set(WATCHER_ERROR_CODES);
const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_OVERLAP_MS = 5_000;
const DEFAULT_INITIAL_LOOKBACK_MS = 15 * 60_000;

function finiteNonNegative(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return selected;
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new TypeError('now must return a valid clock value');
  return milliseconds;
}

function publicReport({
  ok,
  code = null,
  scannedFiles = 0,
  insertedEvents = 0,
  savedForecasts = 0,
  goalPilot = null,
  at,
}) {
  if (code !== null && !WATCHER_ERROR_CODE_SET.has(code)) {
    throw new TypeError('watcher error code is not allowlisted');
  }
  const report = {
    ok,
    errorCode: code,
    scannedFiles,
    insertedEvents,
    savedForecasts,
    observedAt: new Date(at).toISOString(),
  };
  if (goalPilot !== null) report.goalPilot = goalPilot;
  return Object.freeze(report);
}

function safeGoalPilotReport(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = [
    'scannedGoalReceipts',
    'liveGoalReceipts',
    'backfillGoalReceipts',
    'absentGoalReceipts',
    'insertedWorksetEvents',
    'deferredReceipts',
    'terminalWithoutStart',
    'rejectedReceipts',
    'scanErrors',
    'quarantinedTasks',
    'pausedTurnGaps',
    'censoredGoals',
  ];
  const safe = {};
  let observed = false;
  for (const key of keys) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0) return null;
    safe[key] = count;
    if (count > 0) observed = true;
  }
  return observed ? Object.freeze(safe) : null;
}

function candidateSignature(candidate) {
  if (
    candidate === null
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || typeof candidate.file !== 'string'
    || candidate.file.length === 0
    || typeof candidate.modifiedAt !== 'string'
    || !Number.isFinite(Date.parse(candidate.modifiedAt))
    || !Number.isFinite(candidate.sizeBytes)
    || candidate.sizeBytes < 0
  ) {
    throw new TypeError('invalid discovery result');
  }
  return `${new Date(candidate.modifiedAt).toISOString()}|${candidate.sizeBytes}`;
}

/**
 * A privacy-minimized, polling Codex shadow watcher.
 *
 * File paths are ephemeral scan capabilities and never appear in status or
 * callback payloads. The overlap window protects events written at a polling
 * boundary; stable canonical event IDs make the repeated import idempotent.
 */
export function createCodexShadowWatcher({
  root,
  database,
  enabled = true,
  timers = globalThis,
  now = Date.now,
  intervalMs,
  overlapMs,
  initialLookbackMs,
  onReport = null,
  onUpdate = null,
  loadState = null,
  saveState = null,
  discover = discoverCodexSessions,
  scan = scanCodexPilotSession,
  importScans = importLiveScans,
} = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('root must be a non-empty directory path');
  }
  if (database === null || typeof database !== 'object') {
    throw new TypeError('database must be provided');
  }
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (typeof timers?.setInterval !== 'function' || typeof timers?.clearInterval !== 'function') {
    throw new TypeError('timers must provide setInterval and clearInterval');
  }
  if (typeof now !== 'function' || typeof discover !== 'function' || typeof scan !== 'function') {
    throw new TypeError('watcher operations must be functions');
  }
  if (typeof importScans !== 'function') throw new TypeError('importScans must be a function');
  if (onReport !== null && typeof onReport !== 'function') {
    throw new TypeError('onReport must be a function or null');
  }
  if (onUpdate !== null && typeof onUpdate !== 'function') {
    throw new TypeError('onUpdate must be a function or null');
  }
  if (loadState !== null && typeof loadState !== 'function') {
    throw new TypeError('loadState must be a function or null');
  }
  if (saveState !== null && typeof saveState !== 'function') {
    throw new TypeError('saveState must be a function or null');
  }

  const pollingInterval = finiteNonNegative(intervalMs, DEFAULT_INTERVAL_MS, 'intervalMs');
  if (pollingInterval === 0) throw new TypeError('intervalMs must be greater than zero');
  const overlap = finiteNonNegative(overlapMs, DEFAULT_OVERLAP_MS, 'overlapMs');
  const initialLookback = finiteNonNegative(
    initialLookbackMs,
    DEFAULT_INITIAL_LOOKBACK_MS,
    'initialLookbackMs',
  );

  let running = false;
  let scanning = false;
  let intervalHandle = null;
  let watermarkMs = null;
  let lastSuccessAt = null;
  let lastReport = null;
  let lastNotificationErrorCode = null;
  let lastStateErrorCode = null;
  let lastScanAt = null;
  let lastChangeAt = null;
  let lastGoalPilot = null;
  let idleResolvers = [];
  const counters = {
    scans: 0,
    files: 0,
    insertedEvents: 0,
    savedForecasts: 0,
    failures: 0,
  };
  const knownSignatures = new Map();

  function boundedInteger(value) {
    if (!Number.isSafeInteger(value) || value < 0) return 0;
    return Math.min(value, Number.MAX_SAFE_INTEGER);
  }

  if (loadState !== null) {
    try {
      const loaded = loadState();
      if (loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)) {
        if (Number.isFinite(loaded.watermarkMs)) watermarkMs = loaded.watermarkMs;
        if (typeof loaded.lastSuccessAt === 'string' && !Number.isNaN(Date.parse(loaded.lastSuccessAt))) {
          lastSuccessAt = new Date(loaded.lastSuccessAt).toISOString();
        }
        if (typeof loaded.lastChangeAt === 'string' && !Number.isNaN(Date.parse(loaded.lastChangeAt))) {
          lastChangeAt = new Date(loaded.lastChangeAt).toISOString();
        }
        if (loaded.counters !== null && typeof loaded.counters === 'object') {
          for (const key of Object.keys(counters)) counters[key] = boundedInteger(loaded.counters[key]);
        }
      }
    } catch {
      lastStateErrorCode = 'WATCH_STATE_FAILED';
    }
  }

  function notify(report) {
    let failed = false;
    try {
      onReport?.(report);
    } catch {
      failed = true;
    }
    if (report.insertedEvents > 0) {
      try {
        onUpdate?.(report);
      } catch {
        failed = true;
      }
    }
    lastNotificationErrorCode = failed ? 'WATCH_CALLBACK_FAILED' : null;
  }

  function finish(report) {
    lastReport = report;
    if (report.goalPilot) lastGoalPilot = report.goalPilot;
    lastScanAt = report.observedAt;
    counters.scans = boundedInteger(counters.scans + 1);
    counters.files = boundedInteger(counters.files + report.scannedFiles);
    counters.insertedEvents = boundedInteger(counters.insertedEvents + report.insertedEvents);
    counters.savedForecasts = boundedInteger(counters.savedForecasts + report.savedForecasts);
    if (!report.ok) counters.failures = boundedInteger(counters.failures + 1);
    if (report.insertedEvents > 0) lastChangeAt = report.observedAt;
    notify(report);
    if (saveState !== null) {
      try {
        saveState(Object.freeze({
          schemaVersion: 'agenteta.live-watch/1',
          watermarkMs,
          lastScanAt,
          lastSuccessAt,
          lastChangeAt,
          errorCode: report.errorCode,
          counters: Object.freeze({ ...counters }),
        }));
        lastStateErrorCode = null;
      } catch {
        lastStateErrorCode = 'WATCH_STATE_FAILED';
      }
    }
    return report;
  }

  async function scanOnce() {
    const scanStartedMs = clockMilliseconds(now);
    if (scanning) {
      return publicReport({
        ok: false,
        code: 'WATCH_ALREADY_SCANNING',
        at: scanStartedMs,
      });
    }
    scanning = true;
    try {
      const since = watermarkMs === null
        ? scanStartedMs - initialLookback
        : watermarkMs - overlap;
      // Discovery intentionally catches up from a durable stale watermark,
      // but first-seen provenance must not call that entire recovery window
      // realtime. Only receipts within the normal initial lookback can be live;
      // older recovered records remain immutable backfill evidence.
      const provenanceLiveSince = Math.max(
        since,
        scanStartedMs - initialLookback,
      );
      let discovered;
      try {
        discovered = await discover({ root, since });
        if (!Array.isArray(discovered)) throw new TypeError('invalid discovery result');
      } catch {
        return finish(publicReport({
          ok: false,
          code: 'WATCH_DISCOVERY_FAILED',
          at: scanStartedMs,
        }));
      }

      const changed = [];
      try {
        for (const candidate of discovered) {
          const signature = candidateSignature(candidate);
          if (knownSignatures.get(candidate.file) !== signature) {
            changed.push({ candidate, signature });
          }
        }
      } catch {
        return finish(publicReport({
          ok: false,
          code: 'WATCH_DISCOVERY_FAILED',
          at: scanStartedMs,
        }));
      }

      const scans = [];
      try {
        for (const { candidate } of changed) scans.push(await scan(candidate.file));
      } catch {
        return finish(publicReport({
          ok: false,
          code: 'WATCH_SCAN_FAILED',
          at: scanStartedMs,
        }));
      }

      let imported = { insertedEvents: 0, savedForecasts: 0 };
      if (scans.length > 0) {
        try {
          imported = importScans({
            database,
            scans,
            receivedAt: new Date(scanStartedMs).toISOString(),
            goalPilotMode: 'live',
            goalPilotLiveSinceAt: new Date(provenanceLiveSince).toISOString(),
          });
          if (
            imported === null
            || typeof imported !== 'object'
            || !Number.isInteger(imported.insertedEvents)
            || imported.insertedEvents < 0
            || !Number.isInteger(imported.savedForecasts)
            || imported.savedForecasts < 0
          ) {
            throw new TypeError('invalid import result');
          }
        } catch {
          return finish(publicReport({
            ok: false,
            code: 'WATCH_IMPORT_FAILED',
            scannedFiles: scans.length,
            at: scanStartedMs,
          }));
        }
      }

      for (const { candidate, signature } of changed) {
        knownSignatures.set(candidate.file, signature);
      }
      watermarkMs = scanStartedMs;
      lastSuccessAt = new Date(scanStartedMs).toISOString();
      return finish(publicReport({
        ok: true,
        scannedFiles: scans.length,
        insertedEvents: imported.insertedEvents,
        savedForecasts: imported.savedForecasts,
        goalPilot: safeGoalPilotReport(imported.goalPilot),
        at: scanStartedMs,
      }));
    } finally {
      scanning = false;
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolveIdle of resolvers) resolveIdle();
    }
  }

  async function start({ immediate = true } = {}) {
    if (!enabled) {
      return finish(publicReport({
        ok: false,
        code: 'WATCH_DISABLED',
        at: clockMilliseconds(now),
      }));
    }
    if (!running) {
      running = true;
      intervalHandle = timers.setInterval(() => {
        void scanOnce();
      }, pollingInterval);
      intervalHandle?.unref?.();
    }
    if (immediate) return scanOnce();
    return null;
  }

  function stop() {
    if (intervalHandle !== null) timers.clearInterval(intervalHandle);
    intervalHandle = null;
    running = false;
  }

  function whenIdle() {
    if (!scanning) return Promise.resolve();
    return new Promise((resolveIdle) => idleResolvers.push(resolveIdle));
  }

  function status() {
    const errorCode = lastReport?.errorCode ?? lastStateErrorCode ?? lastNotificationErrorCode;
    const projection = {
      kind: 'codex_shadow_watcher',
      enabled,
      running,
      scanning,
      status: !enabled
        ? 'disabled'
        : scanning
          ? 'scanning'
          : errorCode === null
            ? running ? 'idle' : 'stopped'
            : 'error',
      lastScanAt,
      lastSuccessAt,
      lastChangeAt,
      errorCode,
      pollIntervalMs: pollingInterval,
      overlapMs: overlap,
      initialLookbackMs: initialLookback,
      lastNotificationErrorCode,
      counters: Object.freeze({ ...counters }),
    };
    if (lastGoalPilot !== null) projection.goalPilot = lastGoalPilot;
    return Object.freeze(projection);
  }

  return Object.freeze({
    scanOnce,
    scanNow: scanOnce,
    start,
    stop,
    whenIdle,
    status,
    getStatus: status,
  });
}
