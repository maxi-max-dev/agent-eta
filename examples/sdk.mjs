import { AgentETA } from '../src/generic/tracker.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A copyable example, not an additional SDK API. Tracking is best effort;
// only the operation determines its return value or thrown error.
export async function runWithTracking(operation, {
  filename, profile = 'sdk-wiring-example', taskClass = 'other', intervalMs = 30_000,
  onStatus = value => console.log(value),
  onTrackingError = stage => console.error(`Agent ETA: ${stage} unavailable; tracking is incomplete.`),
} = {}) {
  if (typeof operation !== 'function') throw new Error('operation must be a function');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 30_000) {
    throw new Error('intervalMs must be positive and at most 30000');
  }
  let tracker, runId, heartbeat;
  const warn = stage => {
    try { Promise.resolve(onTrackingError(stage)).catch(() => {}); } catch {}
  };
  const report = status => {
    try { Promise.resolve(onStatus(status)).catch(() => warn('status output')); }
    catch { warn('status output'); }
  };
  const finish = outcome => {
    if (!runId) return;
    try { report(tracker.finish(runId, outcome)); } catch { warn('final status'); }
  };
  try {
    try {
      tracker = new AgentETA({ filename });
      const run = tracker.start({ profile, taskClass });
      runId = run.runId;
      report(run);
      heartbeat = setInterval(() => {
        try { report(tracker.ping(runId)); }
        catch { clearInterval(heartbeat); warn('heartbeat'); }
      }, intervalMs);
    } catch { warn('start'); }

    let value;
    try { value = await operation(); }
    catch (error) { finish('failed'); throw error; }
    finish('succeeded');
    return value;
  } finally {
    clearInterval(heartbeat);
    try { tracker?.close(); } catch { warn('close'); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Replace this awaited operation with real, bounded work and use a stable
  // real-work profile. This short wiring example is not accuracy data.
  await runWithTracking(() => new Promise(resolve => setTimeout(resolve, 100)));
}
