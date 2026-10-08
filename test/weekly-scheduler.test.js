import assert from 'node:assert/strict';
import test from 'node:test';

import { createWeeklyEvaluationScheduler } from '../src/evaluation/scheduler.js';

test('weekly scheduler runs once per UTC week and exposes no local path', async () => {
  let runs = 0;
  let intervalCallback = null;
  const scheduler = createWeeklyEvaluationScheduler({
    reportFile: '/private/report.json',
    now: () => new Date('2026-08-29T04:00:00.000Z'),
    readFile: () => JSON.stringify({ generatedAt: '2026-08-25T01:00:00.000Z' }),
    run: async () => { runs += 1; },
    timers: {
      setInterval(callback) {
        intervalCallback = callback;
        return { unref() {} };
      },
      clearInterval() {},
    },
  });

  assert.deepEqual(await scheduler.start(), {
    ran: false,
    reason: 'current_week_already_reported',
  });
  assert.equal(runs, 0);
  assert.equal(typeof intervalCallback, 'function');
  assert.doesNotMatch(JSON.stringify(scheduler.status()), /private|report\.json/);
  scheduler.stop();
});

test('weekly scheduler writes when the prior report is from an older week', async () => {
  let generatedAt = null;
  const scheduler = createWeeklyEvaluationScheduler({
    reportFile: '/capability-only.json',
    now: () => new Date('2026-08-29T04:00:00.000Z'),
    readFile: () => JSON.stringify({ generatedAt: '2026-08-17T01:00:00.000Z' }),
    run: async (value) => { generatedAt = value; },
  });

  assert.deepEqual(await scheduler.check(), { ran: true, reason: 'report_written' });
  assert.equal(generatedAt, '2026-08-29T04:00:00.000Z');
  assert.equal(scheduler.status().lastErrorCode, null);
});

test('weekly scheduler exposes a shutdown barrier for an in-flight report', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const scheduler = createWeeklyEvaluationScheduler({
    reportFile: '/capability-only.json',
    now: () => new Date('2026-08-29T04:00:00.000Z'),
    readFile: () => { throw new Error('missing'); },
    run: () => pending,
  });
  const check = scheduler.check();
  let idle = false;
  const barrier = scheduler.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  finish();
  await check;
  await barrier;
  assert.equal(idle, true);
});
