import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverClaudeSessions } from '../src/adapters/claude.js';
import { discoverCodexSessions } from '../src/adapters/codex.js';
import { aggregateCoverage } from '../src/adapters/coverage.js';
import { importLiveScans } from '../src/adapters/importer.js';
import { scanCodexPilotSession } from '../src/pilot/codex-goal-scan.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUTPUT_JSON = join(ROOT, 'outputs/live-coverage-report.json');
const OUTPUT_MD = join(ROOT, 'outputs/live-coverage-report.md');
const DEFAULT_DB = join(ROOT, 'data/agent-eta-demo.sqlite');

function parseArguments(argv) {
  const result = { days: 30, importEvents: false };
  for (const argument of argv) {
    if (argument === '--import') result.importEvents = true;
    else if (argument.startsWith('--days=')) result.days = Number(argument.slice('--days='.length));
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(result.days) || result.days <= 0 || result.days > 366) {
    throw new TypeError('--days must be between 0 and 366');
  }
  return result;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function laterTimestamp(startedAt, endedAt) {
  if (!endedAt || Date.parse(endedAt) < Date.parse(startedAt)) return startedAt;
  return endedAt;
}

function codexProjection(candidate, scan) {
  const startedAt = scan.metadata.startedAt ?? candidate.modifiedAt;
  return {
    provider: 'codex',
    sessionId: scan.metadata.nativeSessionId,
    startedAt,
    endedAt: laterTimestamp(startedAt, scan.metadata.lastObservedAt ?? candidate.modifiedAt),
    eventCount: scan.coverage.lineCount,
    planEventCount: scan.coverage.planUpdateCount,
    corruptEventCount: scan.coverage.malformedLines + scan.coverage.invalidSignalRecords,
    hasPlan: scan.coverage.plannedRunCount > 0,
  };
}

function claudeProjection(scan) {
  const startedAt = scan.metadata.firstTimestamp ?? scan.metadata.modifiedAt;
  return {
    provider: 'claude',
    sessionId: scan.metadata.nativeSessionId,
    startedAt,
    endedAt: laterTimestamp(startedAt, scan.metadata.lastTimestamp ?? scan.metadata.modifiedAt),
    eventCount: scan.coverage.totalLines,
    planEventCount: scan.coverage.taskCreateCount + scan.coverage.taskUpdateCount,
    corruptEventCount: scan.coverage.malformedLines,
    hasPlan: scan.coverage.hasNativePlan,
  };
}

function mergeSessionProjections(projections) {
  const bySession = new Map();
  for (const projection of projections) {
    const previous = bySession.get(projection.sessionId);
    if (!previous) {
      bySession.set(projection.sessionId, { ...projection });
      continue;
    }
    previous.startedAt = Date.parse(projection.startedAt) < Date.parse(previous.startedAt)
      ? projection.startedAt
      : previous.startedAt;
    previous.endedAt = Date.parse(projection.endedAt) > Date.parse(previous.endedAt)
      ? projection.endedAt
      : previous.endedAt;
    // Repeated files are often snapshots of one session. Taking the maximum avoids counting
    // the same structural lines twice while preserving a conservative error rate.
    previous.eventCount = Math.max(previous.eventCount, projection.eventCount);
    previous.planEventCount = Math.max(previous.planEventCount, projection.planEventCount);
    previous.corruptEventCount = Math.max(previous.corruptEventCount, projection.corruptEventCount);
    previous.hasPlan ||= projection.hasPlan;
  }
  return [...bySession.values()];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function fixedPercent(value) {
  return value === null ? '不支持' : `${(value * 100).toFixed(2)}%`;
}

function makeMarkdown(report) {
  const codex = report.providers.codex;
  const claude = report.providers.claude;
  const imported = report.import;
  return `# Agent ETA 本机真实覆盖率 canary\n\n` +
    `扫描时间：${report.scannedAt}\n\n` +
    `窗口口径：最近修改过的本机 JSONL，${report.windowDays} 天。所有 session/run/event ID 都只在进程内使用哈希别名；报告不含 prompt、消息正文、代码、命令、工作目录、文件路径或原生 ID。\n\n` +
    `## 结论\n\n` +
    `- Codex 原生计划 session 覆盖率：**${codex.plannedSessionAliases}/${codex.uniqueSessionAliases}（${fixedPercent(codex.sessionPlanCoverage)}）**；文件口径另为 ${codex.planSessionFiles}/${codex.sessionFiles}（${fixedPercent(codex.sessionFilePlanCoverage)}）。\n` +
    `- Codex 唯一 lifecycle-run 覆盖率：**${codex.uniquePlannedRuns}/${codex.uniqueLifecycleRuns}（${fixedPercent(codex.uniqueLifecycleRunPlanCoverage)}）**；未去重事件口径是 ${codex.plannedRunOccurrences}/${codex.lifecycleRunOccurrences}。\n` +
    `- Claude primary session 覆盖率：**${claude.plannedPrimarySessionAliases}/${claude.primarySessionAliases}（${fixedPercent(claude.primarySessionPlanCoverage)}）**；primary-file 口径为 ${claude.plannedPrimaryFiles}/${claude.primaryFiles}。sidechain 不进入主分母。\n` +
    `- Claude 实验 turn 视图：${claude.plannedHumanTurns}/${claude.humanTurns} 个 human-boundary candidates 含计划（${fixedPercent(claude.humanTurnPlanCoverage)}）；其中 ${claude.terminalShapedHumanTurns} 个在完整文件快照中呈 terminal 形态，但不会生成 terminal/outcome。${claude.ambiguousHumanTurns} 个 turn 有结构歧义，其中 ${claude.multipleTerminalHumanTurns} 个包含多条 end_turn signal。\n` +
    `- “大任务覆盖率”：**不支持**。日志没有可安全直接使用的结构化 eligible-large-task 标志，本 canary 不读取正文推断。\n` +
    `- 两端无条件结构计划 presence 当前都很低，只支持让 run-level fallback 继续作为默认主路径。正式的 30% large-task 四周门因 eligible-large-task 分母不可得而保持 unsupported，不能据此宣称已触发。\n\n` +
    `## 结构事件\n\n` +
    `- Codex：${codex.planUpdateEvents} 次 update_plan；${codex.malformedLines} malformed；${codex.planParseErrors} plan parse errors；${codex.orphanPlanUpdates} orphan plans。\n` +
    `- Claude：${claude.taskCreateEvents} 次 TaskCreate，${claude.taskUpdateEvents} 次 TaskUpdate，${claude.dependencyDeclarations} 个 dependency declarations；${claude.malformedLines} malformed。\n` +
    `- Claude 文件：${claude.allFiles} total = ${claude.primaryFiles} primary + ${claude.sidechainFiles} sidechain + ${claude.metadataOnlyFiles} metadata-only；${claude.uniqueSessionAliases} 个唯一哈希 session alias。\n\n` +
    `- Codex Goal shadow：${codex.goalCallFiles} 个文件含 ${codex.goalCalls} 次结构调用；观察到 ${codex.goalObservedStructuralAliases} 个哈希 scope alias，其中 ${codex.goalEligibleConfirmedScopes} 个未被隔离；本轮 ${codex.goalQuarantinedAliases} 个 quarantine alias、SQLite 累计 ${codex.goalDurableQuarantineTombstones} 个 durable tombstone、${codex.goalScanErrors} 个 fail-closed scan errors。receipt 首次摄取口径为 ${codex.goalReceiptIngestModes.live} live / ${codex.goalReceiptIngestModes.backfill} backfill；backfill 只进离线证据，不进入 realtime picker。裸 create 不建任务，goal 只建 task、不建 project。\n\n` +
    `## 导入与学习边界\n\n` +
    (imported
      ? `本次发现 ${imported.uniqueScannedEvents} 条唯一 Codex canonical run events，新写入 ${imported.insertedRunEvents} 条并生成 ${imported.savedRunForecasts} 个 run forecast snapshots；Goal shadow 另写入 ${imported.goalPilot.insertedWorksetEvents} 条 task workset events/forecasts，隔离 ${imported.goalPilot.quarantinedTasks} 个 scope。SQLite 当前累计 ${imported.persistedEvents} 条 live events、${imported.persistedLearningOutcomes} 个成功 run 可进入后续 live residual 学习。源内重复 ${imported.sourceDuplicateEvents} 条，已存在事件 ${imported.alreadyStoredEvents} 条，均被幂等处理。\n\n`
      : `本次是只读扫描，没有写入 canonical events。运行 \`npm run scan:live:import\` 才会把隐私最小化后的 Codex lifecycle/plan 事件写入本地 SQLite。\n\n`) +
    `Claude 当前保持 coverage-only：实验 parser 可按结构切出 human-turn candidates，但同一 assistant 响应可能追加多条 end_turn envelope；在 message 聚合、稳定 checkpoint/quiescence 或 retraction 语义前，turn mode 一律不生成 terminal event。\n\n` +
    `## 合约状态\n\n` +
    `这是对本机当前 Codex/Claude JSONL 形态的实机 adapter canary，不是官方稳定兼容承诺。字段变化会 fail closed、计入解析异常，并且不会回退到读取正文。\n`;
}

function persistenceReport(provider, aggregate, unconditionalCoverage, scannedAt) {
  return {
    provider,
    scannedAt,
    sinceAt: aggregate.timeRange.from,
    untilAt: aggregate.timeRange.to,
    sessionCount: aggregate.totalSessions,
    planSessionCount: aggregate.planSessions,
    planCoverage: unconditionalCoverage ?? 0,
    liveReadOnly: true,
    simulated: false,
    eligibility: aggregate.eligibility,
    events: aggregate.events,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scannedAt = new Date().toISOString();
  const sinceMs = Date.parse(scannedAt) - options.days * 86_400_000;
  const localHome = homedir();
  const codexRoot = join(localHome, '.codex', 'sessions');
  const claudeRoot = join(localHome, '.claude');

  if (!existsSync(codexRoot)) throw new Error('Codex session directory is unavailable');
  if (!existsSync(claudeRoot)) throw new Error('Claude session directory is unavailable');

  process.stderr.write('Scanning Codex structural records…\n');
  const codexCandidates = await discoverCodexSessions({ root: codexRoot, since: sinceMs });
  const codexScans = await mapLimit(codexCandidates, 12, (candidate) =>
    scanCodexPilotSession(candidate.file, { includeEvents: true }),
  );
  const codexProjections = codexScans.map((scan, index) => codexProjection(codexCandidates[index], scan));
  const codexSessionProjections = mergeSessionProjections(codexProjections);
  const codexAggregate = aggregateCoverage(codexSessionProjections);
  const codexRunOccurrences = codexScans.reduce((sum, scan) => sum + scan.coverage.runCount, 0);
  const codexPlannedRunOccurrences = codexScans.reduce((sum, scan) => sum + scan.coverage.plannedRunCount, 0);
  const codexEvents = codexScans.flatMap((scan) => scan.events);
  const uniqueCodexRunIds = new Set(
    codexEvents.filter((event) => event.kind === 'run_started').map((event) => event.run_id),
  );
  const uniqueCodexPlannedRunIds = new Set(
    codexEvents
      .filter((event) => event.kind === 'plan_declared' || event.kind === 'plan_revised')
      .map((event) => event.run_id),
  );
  const observedGoalAliases = new Set(codexScans.flatMap((scan) =>
    scan.goalPilot.projections.flatMap((projection) =>
      projection.goals.map((goal) => goal.goalId))));
  const scanQuarantinedGoalAliases = new Set(codexScans.flatMap((scan) =>
    scan.goalPilot.quarantinedGoalIds));

  process.stderr.write('Scanning Claude structural records…\n');
  const claudeDiscovery = await discoverClaudeSessions({ root: claudeRoot, since: sinceMs });
  const primaryClaude = claudeDiscovery.sessions.filter(
    (scan) => scan.metadata.sessionKind === 'primary',
  );
  const claudeAggregate = aggregateCoverage(
    mergeSessionProjections(primaryClaude.map(claudeProjection)),
  );

  const report = {
    schemaVersion: 'agenteta.live-coverage/1',
    scannedAt,
    windowDays: options.days,
    simulated: false,
    liveReadOnly: true,
    privacy: {
      scope: 'live_adapter_rows_and_this_report',
      liveAdapterPersistedContent: false,
      liveAdapterNativeIdsPersisted: false,
      liveAdapterFilesystemPathsPersisted: false,
      largeTaskEligibilityInferredFromText: false,
    },
    providers: {
      codex: {
        sessionFiles: codexProjections.length,
        planSessionFiles: codexProjections.filter((projection) => projection.hasPlan).length,
        sessionFilePlanCoverage: ratio(
          codexProjections.filter((projection) => projection.hasPlan).length,
          codexProjections.length,
        ),
        uniqueSessionAliases: codexAggregate.totalSessions,
        plannedSessionAliases: codexAggregate.planSessions,
        sessionPlanCoverage: ratio(codexAggregate.planSessions, codexAggregate.totalSessions),
        lifecycleRunOccurrences: codexRunOccurrences,
        plannedRunOccurrences: codexPlannedRunOccurrences,
        lifecycleRunOccurrencePlanCoverage: ratio(codexPlannedRunOccurrences, codexRunOccurrences),
        uniqueLifecycleRuns: uniqueCodexRunIds.size,
        uniquePlannedRuns: uniqueCodexPlannedRunIds.size,
        uniqueLifecycleRunPlanCoverage: ratio(uniqueCodexPlannedRunIds.size, uniqueCodexRunIds.size),
        planUpdateEvents: codexScans.reduce((sum, scan) => sum + scan.coverage.planUpdateCount, 0),
        malformedLines: codexScans.reduce((sum, scan) => sum + scan.coverage.malformedLines, 0),
        planParseErrors: codexScans.reduce((sum, scan) => sum + scan.coverage.planParseErrors, 0),
        orphanPlanUpdates: codexScans.reduce((sum, scan) => sum + scan.coverage.orphanPlanUpdates, 0),
        goalCallFiles: codexScans.filter((scan) => scan.goalPilot.goalCallCount > 0).length,
        goalCalls: codexScans.reduce((sum, scan) => sum + scan.goalPilot.goalCallCount, 0),
        goalObservedStructuralAliases: observedGoalAliases.size,
        goalEligibleConfirmedScopes: [...observedGoalAliases]
          .filter((goalId) => !scanQuarantinedGoalAliases.has(goalId)).length,
        goalConfirmedScopes: [...observedGoalAliases]
          .filter((goalId) => !scanQuarantinedGoalAliases.has(goalId)).length,
        goalScanErrors: codexScans.reduce(
          (sum, scan) => sum + scan.goalPilot.errorCodes.length,
          0,
        ),
        goalQuarantinedAliases: scanQuarantinedGoalAliases.size,
        goalDurableQuarantineTombstones: 0,
        goalReceiptIngestModes: { live: 0, backfill: 0 },
        largeTaskCoverage: codexAggregate.coverage,
        eligibility: codexAggregate.eligibility,
      },
      claude: {
        allFiles: claudeDiscovery.coverage.discoveredFiles,
        primaryFiles: claudeDiscovery.coverage.primarySessionFiles,
        sidechainFiles: claudeDiscovery.coverage.sidechainSessionFiles,
        metadataOnlyFiles: claudeDiscovery.coverage.metadataOnlyFiles,
        uniqueSessionAliases: claudeDiscovery.coverage.uniqueSessionCount,
        primarySessionAliases: claudeAggregate.totalSessions,
        plannedPrimarySessionAliases: claudeAggregate.planSessions,
        primarySessionPlanCoverage: ratio(claudeAggregate.planSessions, claudeAggregate.totalSessions),
        plannedPrimaryFiles: claudeDiscovery.coverage.primaryNativePlanFiles,
        primaryFilePlanCoverage: claudeDiscovery.coverage.primaryPlanCoverage,
        allFilePlanCoverage: claudeDiscovery.coverage.allFilePlanCoverage,
        humanTurns: claudeDiscovery.coverage.humanTurns,
        plannedHumanTurns: claudeDiscovery.coverage.plannedHumanTurns,
        humanTurnPlanCoverage: claudeDiscovery.coverage.humanTurnPlanCoverage,
        terminalShapedHumanTurns: claudeDiscovery.coverage.terminalHumanTurns,
        ambiguousHumanTurns: claudeDiscovery.coverage.ambiguousHumanTurns,
        multipleTerminalHumanTurns: claudeDiscovery.coverage.multipleTerminalHumanTurns,
        mixedTerminalLeafHumanTurns: claudeDiscovery.coverage.mixedTerminalLeafHumanTurns,
        excludedMetaConversationRecords: claudeDiscovery.coverage.metaConversationRecords,
        duplicateRecordUuids: claudeDiscovery.coverage.duplicateRecordUuids,
        orphanConversationRecords: claudeDiscovery.coverage.orphanConversationRecords,
        emittedTerminalEvents: 0,
        terminalImportStable: false,
        taskCreateEvents: claudeDiscovery.coverage.taskCreateEvents,
        taskUpdateEvents: claudeDiscovery.coverage.taskUpdateEvents,
        dependencyDeclarations: claudeDiscovery.coverage.dependencyDeclarations,
        malformedLines: claudeDiscovery.coverage.malformedLines,
        largeTaskCoverage: claudeAggregate.coverage,
        eligibility: claudeAggregate.eligibility,
      },
    },
    importPolicy: {
      codex: 'privacy_minimized_structural_events_and_successful_outcomes',
      claude: 'coverage_only_until_stable_turn_segmentation',
    },
    compatibility: {
      contract: 'observed_local_jsonl_canary',
      officialStableContract: false,
      onSchemaDrift: 'fail_closed_without_reading_content',
    },
    import: null,
  };

  const database = new AgentEtaDatabase(process.env.AGENT_ETA_DB || DEFAULT_DB);
  try {
    database.saveCoverageSnapshot(
      persistenceReport(
        'codex',
        codexAggregate,
        report.providers.codex.sessionPlanCoverage,
        scannedAt,
      ),
    );
    database.saveCoverageSnapshot(
      persistenceReport(
        'claude',
        claudeAggregate,
        report.providers.claude.primaryFilePlanCoverage,
        scannedAt,
      ),
    );
    if (options.importEvents) {
      report.import = importLiveScans({
        database,
        scans: codexScans,
        goalPilotMode: 'backfill',
      });
    }
    const durableGoalAliases = new Set(database.db.prepare(`
      SELECT goal_id FROM codex_goal_quarantines
    `).all().map((row) => row.goal_id));
    report.providers.codex.goalDurableQuarantineTombstones = durableGoalAliases.size;
    report.providers.codex.goalEligibleConfirmedScopes = [...observedGoalAliases]
      .filter((goalId) =>
        !scanQuarantinedGoalAliases.has(goalId) && !durableGoalAliases.has(goalId))
      .length;
    report.providers.codex.goalConfirmedScopes =
      report.providers.codex.goalEligibleConfirmedScopes;
    const receiptModes = database.db.prepare(`
      SELECT first_ingest_mode, COUNT(*) AS count
      FROM codex_goal_receipts
      GROUP BY first_ingest_mode
    `).all();
    report.providers.codex.goalReceiptIngestModes = { live: 0, backfill: 0 };
    for (const row of receiptModes) {
      if (row.first_ingest_mode === 'live' || row.first_ingest_mode === 'backfill') {
        report.providers.codex.goalReceiptIngestModes[row.first_ingest_mode] = row.count;
      }
    }
  } finally {
    database.close();
  }

  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(OUTPUT_MD, makeMarkdown(report), 'utf8');
  process.stdout.write(`${makeMarkdown(report)}\nJSON: ${OUTPUT_JSON}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
