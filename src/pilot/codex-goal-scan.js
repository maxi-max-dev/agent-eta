import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { scanCodexSession } from '../adapters/codex.js';
import {
  CODEX_GOAL_PILOT_ERRORS,
  confirmedCodexGoalIdsFromError,
  projectCodexGoalBranches,
  projectCodexGoalRecords,
} from './codex-goal-adapter.js';

export const CODEX_GOAL_SHADOW_SCAN_SCHEMA = 'agenteta.codex-goal-shadow-scan/1';

const SAFE_ERROR_CODES = new Set(Object.values(CODEX_GOAL_PILOT_ERRORS));
const GOAL_TOOLS = new Set(['create_goal', 'get_goal', 'update_goal']);
const GOAL_MARKERS = [...GOAL_TOOLS].map((tool) => `"${tool}"`);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function structuralIndex(body) {
  const validRecords = [];
  const threadIds = new Set();
  let goalCallCount = 0;
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    validRecords.push(record);
    const payload = isRecord(record.payload) ? record.payload : null;
    if (record.type === 'session_meta' && typeof payload?.id === 'string' && payload.id !== '') {
      threadIds.add(payload.id);
    }
    if (
      record.type === 'response_item'
      && payload?.type === 'function_call'
      && GOAL_TOOLS.has(payload.name)
    ) {
      goalCallCount += 1;
    }
  }
  return { validRecords, threadIds: [...threadIds], goalCallCount };
}

function malformedBranchGoalIds(records, threadId) {
  try {
    return projectCodexGoalRecords({ records, threadId }).goals.map((goal) => goal.goalId);
  } catch (error) {
    return confirmedCodexGoalIdsFromError(error);
  }
}

function fixedErrorCode(error) {
  return SAFE_ERROR_CODES.has(error?.message)
    ? error.message
    : CODEX_GOAL_PILOT_ERRORS.invalidBranches;
}

async function containsGoalMarker(file) {
  let carry = '';
  for await (const chunk of createReadStream(file, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  })) {
    const text = carry + chunk;
    if (GOAL_MARKERS.some((marker) => text.includes(marker))) return true;
    carry = text.slice(-32);
  }
  return false;
}

/**
 * Scan one changed Codex transcript for both canonical run events and the
 * experimental Goal shadow contract. Raw thread IDs, file paths and goal
 * objective text remain process-local; only irreversible aliases and enums
 * leave this function.
 */
export async function scanCodexPilotSession(file, options = {}) {
  // Almost every transcript has no Goal tool call. Stream a literal marker
  // gate first so a 30-day scan does not retain and parse every large JSONL a
  // second time. A false positive only triggers stricter structural parsing;
  // a file appended after this pass is picked up by the watcher's overlap.
  const hasGoalMarker = await containsGoalMarker(file);
  const body = hasGoalMarker ? await readFile(file, 'utf8') : null;
  const index = body === null
    ? { validRecords: [], threadIds: [], goalCallCount: 0 }
    : structuralIndex(body);
  const projections = [];
  const quarantinedGoalIds = new Set();
  const errorCodes = new Set();

  if (index.goalCallCount > 0) {
    for (const threadId of index.threadIds) {
      try {
        const projection = projectCodexGoalBranches({ branches: [body], threadId });
        if (projection.coverage.goalCalls > 0) projections.push(projection);
      } catch (error) {
        const code = fixedErrorCode(error);
        errorCodes.add(code);
        const confirmed = confirmedCodexGoalIdsFromError(error);
        const goalIds = confirmed.length > 0 || code !== CODEX_GOAL_PILOT_ERRORS.malformedBranch
          ? confirmed
          : malformedBranchGoalIds(index.validRecords, threadId);
        for (const goalId of goalIds) {
          quarantinedGoalIds.add(goalId);
        }
      }
    }
  }

  const canonical = await scanCodexSession(file, options);
  return {
    ...canonical,
    goalPilot: Object.freeze({
      schemaVersion: CODEX_GOAL_SHADOW_SCAN_SCHEMA,
      projections: Object.freeze(projections),
      quarantinedGoalIds: Object.freeze([...quarantinedGoalIds].toSorted()),
      errorCodes: Object.freeze([...errorCodes].toSorted()),
      scannedThreadCount: index.threadIds.length,
      goalCallCount: index.goalCallCount,
    }),
  };
}
