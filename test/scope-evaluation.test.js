import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateScopeDatabase, scopeEvaluationMarkdown } from '../src/evaluation/scopes.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

test('scope evaluation stays unavailable without real labelled task/project outcomes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-scope-eval-'));
  const filename = join(directory, 'private.sqlite');
  const database = new AgentEtaDatabase(filename);
  database.close();
  try {
    const report = evaluateScopeDatabase(filename, { generatedAt: '2026-08-29T00:00:00.000Z' });
    assert.equal(report.status, 'contract_ready_live_scope_accuracy_unavailable');
    assert.equal(report.task.numericAccuracyStatus, 'unavailable_no_completed_scope_cohort');
    assert.equal(report.project.numericAccuracyStatus, 'unavailable_no_completed_scope_cohort');
    assert.equal(report.integrity.eventForecastGaps, 0);
    assert.ok(report.integrity.foreignKeyDefinitions.worksetMembers >= 3);
    assert.match(scopeEvaluationMarkdown(report), /Provider scope integration: \*\*not_connected\*\*/);
    assert.doesNotMatch(JSON.stringify(report), /private\.sqlite|agent-eta-scope-eval/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
