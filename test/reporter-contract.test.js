import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  REPORTER_CONNECTION_STATUS,
  ReporterContractError,
  sanitizeReporterReport,
  validateReporterReport,
} from '../src/reporter/contract.js';

async function fixture(name) {
  const value = await readFile(new URL(`../fixtures/reporter/${name}`, import.meta.url), 'utf8');
  return JSON.parse(value);
}

test('Reporter accepts only the explicit structural planned/unplanned contract', async () => {
  const planned = sanitizeReporterReport(await fixture('valid-planned.json'));
  assert.deepEqual(planned, {
    schema_version: 'agenteta.reporter/1',
    provider: 'codex',
    run_id: 'codex-run-0123456789abcdefabcd',
    reported_at: '2026-08-28T18:05:06.000Z',
    task_class: 'coding',
    eligible_large_task: true,
    model_self_eta_minutes: 18.5,
    plan_present: true,
    plan_step_count: 4,
    plan_adherence: 'following',
  });
  assert.equal(Object.isFrozen(planned), true);
  assert.deepEqual(validateReporterReport(await fixture('valid-unplanned.json')), {
    valid: true,
    code: null,
    value: {
      schema_version: 'agenteta.reporter/1',
      provider: 'generic',
      run_id: 'generic-run-fedcba9876543210abcd',
      reported_at: '2026-08-29T04:05:06.000Z',
      task_class: 'other',
      eligible_large_task: false,
      model_self_eta_minutes: null,
      plan_present: false,
      plan_step_count: 0,
      plan_adherence: 'not_applicable',
    },
  });
  assert.equal(REPORTER_CONNECTION_STATUS, 'local_sidecar');
});

test('Reporter rejects transcript content, unknown fields and native paths without echoing them', async () => {
  const content = await fixture('rejected-content.json');
  const path = await fixture('rejected-native-path.json');
  const contentResult = validateReporterReport(content);
  const pathResult = validateReporterReport(path);
  assert.deepEqual(contentResult, {
    valid: false,
    code: 'REPORTER_MISSING_OR_UNKNOWN_FIELD',
    value: null,
  });
  assert.deepEqual(pathResult, {
    valid: false,
    code: 'REPORTER_INVALID_RUN_ALIAS',
    value: null,
  });
  assert.equal(JSON.stringify(contentResult).includes('private transcript'), false);
  assert.equal(JSON.stringify(pathResult).includes('/Users/'), false);

  assert.throws(
    () => sanitizeReporterReport(content),
    (error) => error instanceof ReporterContractError
      && error.code === 'REPORTER_MISSING_OR_UNKNOWN_FIELD'
      && error.message === 'REPORTER_MISSING_OR_UNKNOWN_FIELD',
  );
});

test('Reporter rejects invalid scalars and inconsistent plan declarations', async () => {
  const base = await fixture('valid-planned.json');
  const cases = [
    [{ ...base, schema_version: 'future' }, 'REPORTER_INVALID_SCHEMA'],
    [{ ...base, provider: 'future' }, 'REPORTER_INVALID_PROVIDER'],
    [{ ...base, provider: 'claude' }, 'REPORTER_INVALID_RUN_ALIAS'],
    [{ ...base, reported_at: 'not-a-date' }, 'REPORTER_INVALID_TIMESTAMP'],
    [{ ...base, task_class: 'private project title' }, 'REPORTER_INVALID_TASK_CLASS'],
    [{ ...base, eligible_large_task: null }, 'REPORTER_INVALID_BOOLEAN'],
    [{ ...base, model_self_eta_minutes: -1 }, 'REPORTER_INVALID_SELF_ETA'],
    [{ ...base, model_self_eta_minutes: 10_081 }, 'REPORTER_INVALID_SELF_ETA'],
    [{ ...base, plan_step_count: 1.5 }, 'REPORTER_INVALID_PLAN_COUNT'],
    [{ ...base, plan_adherence: 'mostly maybe' }, 'REPORTER_INVALID_ADHERENCE'],
    [{ ...base, plan_present: false }, 'REPORTER_INCONSISTENT_PLAN'],
    [{ ...base, plan_step_count: 0 }, 'REPORTER_INCONSISTENT_PLAN'],
  ];
  for (const [input, code] of cases) {
    assert.deepEqual(validateReporterReport(input), { valid: false, code, value: null });
  }
});

test('Reporter rejects accessors and non-plain objects before reading values', async () => {
  const base = await fixture('valid-planned.json');
  Object.defineProperty(base, 'task_class', {
    enumerable: true,
    get() {
      throw new Error('private getter must never execute');
    },
  });
  assert.deepEqual(validateReporterReport(base), {
    valid: false,
    code: 'REPORTER_ACCESSOR_FIELD',
    value: null,
  });
  assert.deepEqual(validateReporterReport(new Date()), {
    valid: false,
    code: 'REPORTER_INVALID_OBJECT',
    value: null,
  });
});
