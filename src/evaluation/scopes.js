import { withReadSnapshot } from './database.js';

function number(value) {
  return Number(value ?? 0);
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function scopeRows(database, type) {
  return database.prepare(`
    SELECT
      workset.started_at,
      workset.finished_at,
      forecast.observed_at,
      forecast.p50_minutes,
      forecast.p80_minutes
    FROM worksets workset
    JOIN workset_forecast_snapshots forecast ON forecast.snapshot_id = (
      SELECT candidate.snapshot_id
      FROM workset_forecast_snapshots candidate
      WHERE candidate.workset_id = workset.workset_id
        AND candidate.p50_minutes IS NOT NULL
        AND candidate.observed_at >= workset.started_at
        AND candidate.observed_at < workset.finished_at
      ORDER BY julianday(candidate.observed_at), candidate.snapshot_id
      LIMIT 1
    )
    WHERE workset.workset_type = ?
      AND workset.owner_terminal = 1
      AND workset.status = 'succeeded'
      AND workset.finished_at > workset.started_at
  `).all(type);
}

function scopeSummary(database, type) {
  const counts = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(owner_terminal) AS owner_terminal,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
    FROM worksets WHERE workset_type = ?
  `).get(type);
  const rows = scopeRows(database, type).map((row) => {
    const actual = (Date.parse(row.finished_at) - Date.parse(row.observed_at)) / 60_000;
    return {
      actual,
      p50: Number(row.p50_minutes),
      p80: row.p80_minutes === null ? null : Number(row.p80_minutes),
    };
  }).filter((row) => Number.isFinite(row.actual) && row.actual >= 0 && Number.isFinite(row.p50));
  const absoluteErrors = rows.map((row) => Math.abs(row.p50 - row.actual));
  const p80Rows = rows.filter((row) => Number.isFinite(row.p80));
  return {
    truthStatus: 'contract_only_no_live_source_label',
    numericAccuracyStatus: rows.length ? 'contract_only_not_real_accuracy' : 'unavailable_no_completed_scope_cohort',
    totalWorksets: number(counts.total),
    ownerTerminalWorksets: number(counts.owner_terminal),
    successfulWorksets: number(counts.succeeded),
    evaluatedFirstForecasts: rows.length,
    meanAbsoluteErrorMinutes: absoluteErrors.length
      ? absoluteErrors.reduce((sum, value) => sum + value, 0) / absoluteErrors.length
      : null,
    medianAbsoluteErrorMinutes: quantile(absoluteErrors, 0.5),
    p80Coverage: p80Rows.length
      ? p80Rows.filter((row) => row.actual <= row.p80).length / p80Rows.length
      : null,
    p80Evaluated: p80Rows.length,
    bootstrapUnit: type,
  };
}

function foreignKeyCount(database, table) {
  return database.prepare(`PRAGMA foreign_key_list(${table})`).all().length;
}

export function evaluateScopeDatabase(filename, {
  generatedAt = new Date().toISOString(),
} = {}) {
  return withReadSnapshot(filename, (database) => {
    const gaps = database.prepare(`
      SELECT COUNT(*) AS count
      FROM workset_events event
      LEFT JOIN workset_forecast_snapshots forecast
        ON forecast.workset_id = event.workset_id
        AND forecast.event_id = event.event_id
      WHERE forecast.snapshot_id IS NULL
    `).get();
    const events = database.prepare('SELECT COUNT(*) AS count FROM workset_events').get();
    const forecasts = database.prepare('SELECT COUNT(*) AS count FROM workset_forecast_snapshots').get();
    return {
      generatedAt,
      status: 'contract_ready_live_scope_accuracy_unavailable',
      simulated: false,
      liveScopeCohort: false,
      providerScopeIntegration: 'not_connected',
      scopeSemantics: {
        conversation: 'provider session is grouping only; the numeric product target is the selected active turn unless an explicit task workset exists',
        task: 'explicit hashed closed-or-survival workset with owner terminal; otherwise unknown',
        project: 'explicit project of task worksets; no inferred DAG or critical path; otherwise unknown',
      },
      task: scopeSummary(database, 'task'),
      project: scopeSummary(database, 'project'),
      integrity: {
        worksetEvents: number(events.count),
        worksetForecasts: number(forecasts.count),
        eventForecastGaps: number(gaps.count),
        foreignKeyDefinitions: {
          worksetEvents: foreignKeyCount(database, 'workset_events'),
          worksetMembers: foreignKeyCount(database, 'workset_members'),
          worksetForecasts: foreignKeyCount(database, 'workset_forecast_snapshots'),
        },
      },
      evaluationProtocol: {
        landmark: 'first positive saved scope forecast between explicit scope start and owner terminal',
        temporalRule: 'workset event received_at and forecast observed_at are persisted; live evaluation requires source labels before accuracy claims',
        bootstrapUnits: { task: 'task', project: 'project' },
        waits: 'open human/provider/block/paused snapshots never receive a completion-clock score',
      },
      falsificationGates: {
        thirtyComparableScopes: 'provisional only',
        fiftyComparableScopes: 'candidate must beat the same-landmark historical median with paired interval above zero',
        failureAction: 'stop expanding numeric ETA for that scope; retain state, waiting reason, and completion notification',
      },
      limitations: [
        'The Phase 6 database has no real provider-owned task/project source labels or live task/project cohort.',
        'Any locally inserted workset is contract evidence, not production accuracy evidence.',
        'Project v1 aggregates only explicit sequence and observed-running parallel groups; it does not infer dependencies.',
      ],
      privacy: {
        aggregateOnly: true,
        identifiersEmitted: false,
        contentEmitted: false,
        filesystemPathsEmitted: false,
      },
    };
  });
}

function metric(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : 'unavailable';
}

export function scopeEvaluationMarkdown(report) {
  return [
    '# Agent ETA task/project scope readiness',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Status: **${report.status}**. Provider scope integration: **${report.providerScopeIntegration}**.`,
    '',
    '| Scope | Worksets | Owner terminals | Successful | Evaluated | Median AE | P80 coverage | Evidence |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    `| task | ${report.task.totalWorksets} | ${report.task.ownerTerminalWorksets} | ${report.task.successfulWorksets} | ${report.task.evaluatedFirstForecasts} | ${metric(report.task.medianAbsoluteErrorMinutes)} | ${metric(report.task.p80Coverage === null ? null : report.task.p80Coverage * 100, '%')} | ${report.task.numericAccuracyStatus} |`,
    `| project | ${report.project.totalWorksets} | ${report.project.ownerTerminalWorksets} | ${report.project.successfulWorksets} | ${report.project.evaluatedFirstForecasts} | ${metric(report.project.medianAbsoluteErrorMinutes)} | ${metric(report.project.p80Coverage === null ? null : report.project.p80Coverage * 100, '%')} | ${report.project.numericAccuracyStatus} |`,
    '',
    `Integrity: ${report.integrity.worksetEvents} workset events, ${report.integrity.worksetForecasts} forecast slots, ${report.integrity.eventForecastGaps} gaps.`,
    '',
    '## Honest product boundary',
    '',
    `- Conversation: ${report.scopeSemantics.conversation}`,
    `- Task: ${report.scopeSemantics.task}`,
    `- Project: ${report.scopeSemantics.project}`,
    '',
    '## Limitations',
    '',
    ...report.limitations.map((item) => `- ${item}`),
    '',
  ].join('\n');
}
