import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_GOAL_PILOT_ERRORS,
  confirmedCodexGoalIdsFromError,
  projectCodexGoalBranches,
  projectCodexGoalRecords,
  resolveActiveCodexGoal,
} from '../src/pilot/codex-goal-adapter.js';

const THREAD = 'native-thread-private-01';
const SESSION = 'native-session-private-01';
const TURN_A = 'native-turn-private-a';
const TURN_B = 'native-turn-private-b';
const CALL_CREATE = 'native-call-private-create';
const CALL_GET_A = 'native-call-private-get-a';
const CALL_GET_B = 'native-call-private-get-b';
const CALL_UPDATE = 'native-call-private-update';
const CHILD_THREAD = 'native-thread-private-child';
const CHILD_TURN = 'native-turn-private-child';
const SECRET_OBJECTIVE = 'secret objective must never leave the parser';
const SECRET_PATH = '/Users/private/workspace/secret-project';

function record(timestamp, type, payload) {
  return { timestamp, type, payload };
}

function nativeCall(timestamp, { name, callId, argumentsValue }) {
  return record(timestamp, 'response_item', {
    type: 'function_call',
    id: `private-response-${callId}`,
    name,
    arguments: typeof argumentsValue === 'string'
      ? argumentsValue
      : JSON.stringify(argumentsValue),
    call_id: callId,
    internal_chat_message_metadata_passthrough: { private: true },
  });
}

function nativeOutput(timestamp, callId, output) {
  return record(timestamp, 'response_item', {
    type: 'function_call_output',
    id: `private-output-${callId}`,
    call_id: callId,
    output: typeof output === 'string' ? output : JSON.stringify(output),
    internal_chat_message_metadata_passthrough: { private: true },
  });
}

function goalResult({ createdAt = 1_777_680_000_000, updatedAt = createdAt, status = 'active' } = {}) {
  return {
    goal: {
      threadId: THREAD,
      objective: SECRET_OBJECTIVE,
      status,
      tokensUsed: 123,
      timeUsedSeconds: 45,
      createdAt,
      updatedAt,
    },
    remainingTokens: null,
    completionBudgetReport: `private report mentioning ${SECRET_PATH}`,
  };
}

function baseRecords(turnId = TURN_A) {
  return [
    record('2026-08-30T00:00:00.000Z', 'session_meta', {
      id: THREAD,
      session_id: SESSION,
      timestamp: '2026-08-30T00:00:00.000Z',
      cwd: SECRET_PATH,
    }),
    record('2026-08-30T00:00:00.100Z', 'turn_context', {
      cwd: SECRET_PATH,
      prompt: 'private prompt',
    }),
    record('2026-08-30T00:00:01.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: turnId,
      started_at: '2026-08-30T00:00:01.000Z',
    }),
  ];
}

function jsonl(records) {
  return `${records.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function activeNativeShape({ turnId = TURN_A, getCallId = CALL_GET_A } = {}) {
  return [
    ...baseRecords(turnId),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'create_goal',
      callId: CALL_CREATE,
      argumentsValue: { objective: SECRET_OBJECTIVE },
    }),
    // The sole local create_goal sample has an unstructured output. It is not
    // accepted as evidence; the following native get_goal receipt is.
    nativeOutput(
      '2026-08-30T00:00:02.100Z',
      CALL_CREATE,
      'unstructured provider response containing no machine-readable state',
    ),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: getCallId,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.100Z', getCallId, goalResult()),
  ];
}

test('native goal shape needs a structured state receipt and copied branches are idempotent', () => {
  const body = jsonl(activeNativeShape());
  const projection = projectCodexGoalBranches({
    branches: [body, body],
    threadId: THREAD,
  });
  const resolved = resolveActiveCodexGoal({ branches: [body, body], threadId: THREAD });

  assert.equal(projection.activeGoalCount, 1);
  assert.equal(projection.activeRunCount, 1);
  assert.equal(projection.events.length, 1);
  assert.equal(projection.events[0].kind, 'goal_active');
  assert.equal(projection.coverage.invalidGoalReceipts, 2);
  assert.equal(projection.coverage.uniqueGoalObservations, 1);
  assert.equal(projection.coverage.duplicateGoalObservations, 1);
  assert.equal(resolved.status, 'active');
  assert.equal(resolved.continuedAcrossTurns, false);
  assert.deepEqual(
    projectCodexGoalRecords({ records: activeNativeShape(), threadId: THREAD }),
    projectCodexGoalBranches({ branches: [body], threadId: THREAD }),
  );
});

test('zero or multiple active goals and runs fail closed with fixed codes', () => {
  const absent = jsonl([
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:02.100Z', CALL_GET_A, {
      goal: null,
      remainingTokens: null,
      completionBudgetReport: null,
    }),
  ]);
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [absent], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.noActiveGoal,
  );

  const twoGoals = jsonl([
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:02.100Z', CALL_GET_A, goalResult()),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: CALL_GET_B,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.100Z', CALL_GET_B, goalResult({
      createdAt: 1_777_680_001_000,
      updatedAt: 1_777_680_001_000,
    })),
  ]);
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [twoGoals], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.multipleActiveGoals,
  );

  const twoRuns = jsonl([
    ...activeNativeShape(),
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
      started_at: '2026-08-30T00:00:04.000Z',
    }),
  ]);
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [twoRuns], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.multipleActiveRuns,
  );

  const noCurrentRun = jsonl([
    ...activeNativeShape(),
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:04.000Z',
    }),
  ]);
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [noCurrentRun], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.noActiveRun,
  );
});

test('projection contains no objective, prose, path, or native identifiers', () => {
  const body = jsonl([
    ...activeNativeShape(),
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'agent_message',
      message: 'private message body',
      command: 'private command body',
    }),
  ]);
  const publicJson = JSON.stringify(projectCodexGoalBranches({
    branches: [body],
    threadId: THREAD,
  }));
  for (const forbidden of [
    THREAD,
    SESSION,
    TURN_A,
    CALL_CREATE,
    CALL_GET_A,
    SECRET_OBJECTIVE,
    SECRET_PATH,
    'private prompt',
    'private message body',
    'private command body',
  ]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
});

test('active goal continues across turns and terminal update is explicit', () => {
  const createdAt = 1_777_680_000_000;
  const firstTurn = [
    ...activeNativeShape(),
    record('2026-08-30T00:01:00.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:01:00.000Z',
    }),
    record('2026-08-30T00:02:00.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
      started_at: '2026-08-30T00:02:00.000Z',
    }),
    nativeCall('2026-08-30T00:02:01.000Z', {
      name: 'get_goal',
      callId: CALL_GET_B,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:02:01.100Z', CALL_GET_B, goalResult({
      createdAt,
      updatedAt: createdAt + 1_000,
    })),
  ];
  const active = resolveActiveCodexGoal({ branches: [jsonl(firstTurn)], threadId: THREAD });
  assert.equal(active.observedRunCount, 2);
  assert.equal(active.continuedAcrossTurns, true);

  const readbackOnly = projectCodexGoalBranches({
    branches: [jsonl([
      ...firstTurn,
      nativeCall('2026-08-30T00:02:01.500Z', {
        name: 'get_goal',
        callId: 'call-get-complete-without-update',
        argumentsValue: {},
      }),
      nativeOutput('2026-08-30T00:02:01.600Z', 'call-get-complete-without-update', goalResult({
        createdAt,
        updatedAt: createdAt + 1_500,
        status: 'complete',
      })),
    ])],
    threadId: THREAD,
  });
  assert.equal(readbackOnly.goals[0].status, 'active');
  assert.equal(readbackOnly.events.at(-1).kind, 'goal_active');
  assert.equal(readbackOnly.coverage.invalidGoalReceipts, 2);

  const blockedReadbackOnly = projectCodexGoalBranches({
    branches: [jsonl([
      ...firstTurn,
      nativeCall('2026-08-30T00:02:01.700Z', {
        name: 'get_goal',
        callId: 'call-get-blocked-without-update',
        argumentsValue: {},
      }),
      nativeOutput('2026-08-30T00:02:01.800Z', 'call-get-blocked-without-update', goalResult({
        createdAt,
        updatedAt: createdAt + 1_700,
        status: 'blocked',
      })),
    ])],
    threadId: THREAD,
  });
  assert.equal(blockedReadbackOnly.goals[0].status, 'active');
  assert.equal(blockedReadbackOnly.events.at(-1).kind, 'goal_active');
  assert.equal(blockedReadbackOnly.coverage.invalidGoalReceipts, 2);

  const withTerminal = [
    ...firstTurn,
    nativeCall('2026-08-30T00:02:02.000Z', {
      name: 'update_goal',
      callId: CALL_UPDATE,
      argumentsValue: { status: 'complete' },
    }),
    nativeOutput('2026-08-30T00:02:02.100Z', CALL_UPDATE, goalResult({
      createdAt,
      updatedAt: createdAt + 2_000,
      status: 'complete',
    })),
  ];
  const terminal = projectCodexGoalBranches({ branches: [jsonl(withTerminal)], threadId: THREAD });
  assert.equal(terminal.activeGoalCount, 0);
  assert.equal(terminal.goals[0].status, 'complete');
  assert.equal(terminal.events.at(-1).kind, 'goal_completed');
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [jsonl(withTerminal)], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.noActiveGoal,
  );
});

test('append and restart projections are deterministic and monotonic', () => {
  const prefixRecords = activeNativeShape();
  const prefixBody = jsonl(prefixRecords);
  const first = projectCodexGoalBranches({ branches: [prefixBody], threadId: THREAD });
  const restarted = projectCodexGoalBranches({ branches: [prefixBody], threadId: THREAD });
  assert.deepEqual(restarted, first);

  const appended = projectCodexGoalBranches({
    branches: [jsonl([
      ...prefixRecords,
      nativeCall('2026-08-30T00:00:04.000Z', {
        name: 'update_goal',
        callId: CALL_UPDATE,
        argumentsValue: { status: 'blocked' },
      }),
      nativeOutput('2026-08-30T00:00:04.100Z', CALL_UPDATE, goalResult({
        updatedAt: 1_777_680_002_000,
        status: 'blocked',
      })),
    ])],
    threadId: THREAD,
  });
  assert.deepEqual(
    appended.events.slice(0, first.events.length),
    first.events,
  );
  assert.equal(appended.events.at(-1).kind, 'goal_blocked');
  assert.equal(appended.goals[0].status, 'blocked');
  assert.equal(appended.blockedGoalCount, 1);
  assert.throws(
    () => resolveActiveCodexGoal({
      branches: [jsonl([
        ...prefixRecords,
        nativeCall('2026-08-30T00:00:04.000Z', {
          name: 'update_goal',
          callId: CALL_UPDATE,
          argumentsValue: { status: 'blocked' },
        }),
        nativeOutput('2026-08-30T00:00:04.100Z', CALL_UPDATE, goalResult({
          updatedAt: 1_777_680_002_000,
          status: 'blocked',
        })),
      ])],
      threadId: THREAD,
    }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.goalBlocked,
  );
});

test('blocked is recoverable under the same goal identity and only complete is terminal', () => {
  const createdAt = 1_777_680_000_000;
  const blockedRecords = [
    ...activeNativeShape(),
    nativeCall('2026-08-30T00:00:04.000Z', {
      name: 'update_goal',
      callId: 'native-call-private-block',
      argumentsValue: { status: 'blocked' },
    }),
    nativeOutput('2026-08-30T00:00:04.100Z', 'native-call-private-block', goalResult({
      createdAt,
      updatedAt: createdAt + 1_000,
      status: 'blocked',
    })),
  ];
  const blocked = projectCodexGoalRecords({ records: blockedRecords, threadId: THREAD });
  assert.equal(blocked.activeGoalCount, 0);
  assert.equal(blocked.blockedGoalCount, 1);
  assert.equal(blocked.events.at(-1).kind, 'goal_blocked');
  assert.equal(blocked.goals[0].status, 'blocked');
  assert.throws(
    () => resolveActiveCodexGoal({ branches: [blockedRecords], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.goalBlocked,
  );

  const recoveredRecords = [
    ...blockedRecords,
    nativeCall('2026-08-30T00:00:05.000Z', {
      name: 'get_goal',
      callId: 'native-call-private-resume',
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:05.100Z', 'native-call-private-resume', goalResult({
      createdAt,
      updatedAt: createdAt + 2_000,
      status: 'active',
    })),
  ];
  const recovered = resolveActiveCodexGoal({ branches: [recoveredRecords], threadId: THREAD });
  assert.equal(recovered.goalId, blocked.goals[0].goalId);
  assert.equal(recovered.status, 'active');

  const completed = projectCodexGoalRecords({
    records: [
      ...recoveredRecords,
      nativeCall('2026-08-30T00:00:06.000Z', {
        name: 'update_goal',
        callId: 'native-call-private-complete-after-resume',
        argumentsValue: { status: 'complete' },
      }),
      nativeOutput(
        '2026-08-30T00:00:06.100Z',
        'native-call-private-complete-after-resume',
        goalResult({
          createdAt,
          updatedAt: createdAt + 3_000,
          status: 'complete',
        }),
      ),
    ],
    threadId: THREAD,
  });
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ['goal_active', 'goal_blocked', 'goal_active', 'goal_completed'],
  );
  assert.equal(new Set(completed.events.map((event) => event.goalId)).size, 1);
  assert.equal(completed.goals[0].status, 'complete');

  const publicJson = JSON.stringify(completed);
  for (const forbidden of [SECRET_OBJECTIVE, SECRET_PATH, THREAD, SESSION, TURN_A]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
});

test('run completion, cancellation, and silence never infer goal completion', () => {
  for (const runTerminal of ['task_complete', 'turn_aborted']) {
    const records = [
      ...activeNativeShape(),
      record('2026-08-30T00:00:04.000Z', 'event_msg', {
        type: runTerminal,
        turn_id: TURN_A,
        completed_at: '2026-08-30T00:00:04.000Z',
      }),
    ];
    const projection = projectCodexGoalRecords({ records, threadId: THREAD });
    assert.equal(projection.goals[0].status, 'active');
    assert.deepEqual(projection.events.map((event) => event.kind), ['goal_active']);
    assert.throws(
      () => resolveActiveCodexGoal({ branches: [records], threadId: THREAD }),
      (error) => error.message === CODEX_GOAL_PILOT_ERRORS.noActiveRun,
    );
  }
});

test('root and child session_meta segments never mix lifecycle or goal evidence', () => {
  const childResult = goalResult({ createdAt: 1_777_680_010_000 });
  childResult.goal.threadId = CHILD_THREAD;
  childResult.goal.objective = 'private child objective';
  const pendingAcrossSwitch = 'native-call-private-pending-across-switch';
  const childCall = 'native-call-private-child-goal';
  const records = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    // Repeated metadata for the same identity is not a switch and preserves
    // the pending call/output pair.
    record('2026-08-30T00:00:02.050Z', 'session_meta', {
      id: THREAD,
      session_id: SESSION,
    }),
    nativeOutput('2026-08-30T00:00:02.100Z', CALL_GET_A, goalResult()),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: pendingAcrossSwitch,
      argumentsValue: {},
    }),
    // Child deliberately reuses the native session component. Its different
    // thread identity still starts an isolated, out-of-scope segment.
    record('2026-08-30T00:00:03.100Z', 'session_meta', {
      id: CHILD_THREAD,
      session_id: SESSION,
    }),
    record('2026-08-30T00:00:03.200Z', 'event_msg', {
      type: 'task_started',
      turn_id: CHILD_TURN,
    }),
    nativeOutput('2026-08-30T00:00:03.300Z', pendingAcrossSwitch, goalResult()),
    nativeCall('2026-08-30T00:00:03.400Z', {
      name: 'get_goal',
      callId: childCall,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.500Z', childCall, childResult),
    record('2026-08-30T00:00:04.000Z', 'session_meta', {
      id: THREAD,
      session_id: SESSION,
    }),
    // The pre-switch pending call remains cleared after returning to root.
    nativeOutput('2026-08-30T00:00:04.050Z', pendingAcrossSwitch, goalResult()),
    record('2026-08-30T00:00:04.100Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_B,
    }),
    nativeCall('2026-08-30T00:00:04.200Z', {
      name: 'get_goal',
      callId: CALL_GET_B,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:04.300Z', CALL_GET_B, goalResult({
      updatedAt: 1_777_680_001_000,
    })),
  ];
  const interleavedJsonl = jsonl(records);
  const projection = projectCodexGoalBranches({
    branches: [interleavedJsonl],
    threadId: THREAD,
  });
  const resolved = resolveActiveCodexGoal({
    branches: [interleavedJsonl],
    threadId: THREAD,
  });

  assert.deepEqual(projection.events.map((event) => event.kind), [
    'goal_active',
    'goal_active',
  ]);
  assert.equal(projection.coverage.goalCalls, 3);
  assert.equal(projection.coverage.pairedGoalOutputs, 2);
  assert.equal(projection.activeRunCount, 1);
  assert.equal(resolved.observedRunCount, 2);
  assert.equal(resolved.continuedAcrossTurns, true);
  const publicJson = JSON.stringify(projection);
  for (const forbidden of [
    CHILD_THREAD,
    CHILD_TURN,
    childCall,
    'private child objective',
    pendingAcrossSwitch,
  ]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
});

test('only one unterminated partial tail is recoverable; other malformed lines poison the branch', () => {
  const records = activeNativeShape();
  const body = jsonl(records);
  const baseline = projectCodexGoalBranches({ branches: [body], threadId: THREAD });
  const partialTail = projectCodexGoalBranches({
    branches: [`${body}{"timestamp":`],
    threadId: THREAD,
  });
  assert.deepEqual(partialTail.events, baseline.events);
  assert.equal(partialTail.coverage.ignoredTailPartialRecords, 1);

  const validLines = records.map((value) => JSON.stringify(value));
  const malformedBranches = [
    `${[validLines[0], '{"broken":', ...validLines.slice(1)].join('\n')}\n`,
    `${body}{"timestamp":\n`,
    `${body}42`,
  ];
  for (const malformed of malformedBranches) {
    assert.throws(
      () => projectCodexGoalBranches({ branches: [malformed], threadId: THREAD }),
      (error) => error.message === CODEX_GOAL_PILOT_ERRORS.malformedBranch
        && !error.message.includes('broken'),
    );
  }
  assert.throws(
    () => projectCodexGoalRecords({ records: [...records, null], threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.invalidBranches,
  );
});

test('call and goal timestamps obey strict causal order with zero skew', () => {
  const outputBeforeCall = [
    ...baseRecords(),
    nativeOutput('2026-08-30T00:00:02.000Z', CALL_GET_A, goalResult()),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
  ];
  const reversedEnvelopeTime = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:02.000Z', CALL_GET_A, goalResult()),
  ];
  const futureGoalTime = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.000Z', CALL_GET_A, goalResult({
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_001_000,
    })),
  ];
  const reversedGoalTime = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.000Z', CALL_GET_A, goalResult({
      createdAt: 1_777_680_002_000,
      updatedAt: 1_777_680_001_000,
    })),
  ];

  for (const records of [
    outputBeforeCall,
    reversedEnvelopeTime,
    futureGoalTime,
    reversedGoalTime,
  ]) {
    assert.throws(
      () => projectCodexGoalRecords({ records, threadId: THREAD }),
      (error) => error.message === CODEX_GOAL_PILOT_ERRORS.causalityViolation,
    );
  }
});

test('seconds and milliseconds normalize to one goal while duplicate receipts stay idempotent', () => {
  const createdAtMilliseconds = 1_777_680_000_000;
  const createdAtSeconds = createdAtMilliseconds / 1_000;
  const firstOutput = goalResult({
    createdAt: createdAtSeconds,
    updatedAt: createdAtSeconds,
  });
  const secondOutput = goalResult({
    createdAt: createdAtMilliseconds,
    updatedAt: createdAtMilliseconds + 1_000,
  });
  const records = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput(Date.parse('2026-08-30T00:00:02.100Z') / 1_000, CALL_GET_A, firstOutput),
    nativeOutput('2026-08-30T00:00:02.200Z', CALL_GET_A, firstOutput),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: CALL_GET_B,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.100Z', CALL_GET_B, secondOutput),
  ];
  const projection = projectCodexGoalRecords({ records, threadId: THREAD });
  assert.equal(projection.goals.length, 1);
  assert.equal(projection.events.length, 2);
  assert.equal(projection.coverage.duplicateGoalReceipts, 1);
  assert.equal(new Set(projection.events.map((event) => event.goalId)).size, 1);

  const conflictingDuplicate = [
    ...records,
    nativeOutput('2026-08-30T00:00:03.200Z', CALL_GET_B, goalResult({
      createdAt: createdAtMilliseconds,
      updatedAt: createdAtMilliseconds + 2_000,
      status: 'blocked',
    })),
  ];
  assert.throws(
    () => projectCodexGoalRecords({ records: conflictingDuplicate, threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.branchConflict,
  );
});

test('goal and observation aliases include raw thread identity without exposing it', () => {
  function recordsForThread(threadId, turnId, objective) {
    const result = goalResult();
    result.goal.threadId = threadId;
    result.goal.objective = objective;
    return [
      record('2026-08-30T00:00:00.000Z', 'session_meta', {
        id: threadId,
        session_id: SESSION,
      }),
      record('2026-08-30T00:00:01.000Z', 'event_msg', {
        type: 'task_started',
        turn_id: turnId,
        started_at: '2026-08-30T00:00:01.000Z',
      }),
      nativeCall('2026-08-30T00:00:02.000Z', {
        name: 'get_goal',
        callId: CALL_GET_A,
        argumentsValue: {},
      }),
      nativeOutput('2026-08-30T00:00:02.100Z', CALL_GET_A, result),
    ];
  }

  const first = projectCodexGoalRecords({
    records: recordsForThread(THREAD, TURN_A, 'first private objective'),
    threadId: THREAD,
  });
  const second = projectCodexGoalRecords({
    records: recordsForThread(CHILD_THREAD, CHILD_TURN, 'second private objective'),
    threadId: CHILD_THREAD,
  });
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.goals[0].goalId, second.goals[0].goalId);
  assert.notEqual(first.events[0].eventId, second.events[0].eventId);
  for (const publicJson of [JSON.stringify(first), JSON.stringify(second)]) {
    assert.equal(publicJson.includes(THREAD), false);
    assert.equal(publicJson.includes(CHILD_THREAD), false);
    assert.equal(publicJson.includes('private objective'), false);
  }
});

test('same thread and createdAt cannot represent two semantic goals', () => {
  const firstResult = goalResult();
  const secondResult = goalResult({ updatedAt: 1_777_680_001_000 });
  firstResult.goal.objective = 'first semantic objective';
  secondResult.goal.objective = 'different semantic objective';
  const records = [
    ...baseRecords(),
    nativeCall('2026-08-30T00:00:02.000Z', {
      name: 'get_goal',
      callId: CALL_GET_A,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:02.100Z', CALL_GET_A, firstResult),
    nativeCall('2026-08-30T00:00:03.000Z', {
      name: 'get_goal',
      callId: CALL_GET_B,
      argumentsValue: {},
    }),
    nativeOutput('2026-08-30T00:00:03.100Z', CALL_GET_B, secondResult),
  ];
  assert.throws(
    () => projectCodexGoalRecords({ records, threadId: THREAD }),
    (error) => error.message === CODEX_GOAL_PILOT_ERRORS.goalIdentityConflict
      && !error.message.includes('semantic objective'),
  );
});

test('lifecycle conflicts quarantine duplicate, orphan, reopened, and time-invalid runs', () => {
  const sessionMeta = baseRecords()[0];
  const duplicateStart = [
    ...baseRecords(),
    record('2026-08-30T00:00:01.100Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:01.100Z',
    }),
  ];
  const orphanTerminal = [
    sessionMeta,
    record('2026-08-30T00:00:02.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:02.000Z',
    }),
  ];
  const terminalThenReopen = [
    ...baseRecords(),
    record('2026-08-30T00:00:02.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:02.000Z',
    }),
    record('2026-08-30T00:00:03.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:03.000Z',
    }),
  ];
  const duplicateTerminal = [
    ...baseRecords(),
    record('2026-08-30T00:00:02.000Z', 'event_msg', {
      type: 'turn_aborted',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:02.000Z',
    }),
    record('2026-08-30T00:00:02.100Z', 'event_msg', {
      type: 'turn_aborted',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:02.100Z',
    }),
  ];
  const futureStart = [
    sessionMeta,
    record('2026-08-30T00:00:01.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:02.000Z',
    }),
  ];
  const terminalBeforeStart = [
    ...baseRecords(),
    record('2026-08-30T00:00:02.000Z', 'event_msg', {
      type: 'task_complete',
      turn_id: TURN_A,
      completed_at: '2026-08-30T00:00:00.500Z',
    }),
  ];
  const invalidEnvelopeTimestamp = [
    sessionMeta,
    record('not-a-time', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
    }),
  ];

  for (const records of [
    duplicateStart,
    orphanTerminal,
    terminalThenReopen,
    duplicateTerminal,
    futureStart,
    terminalBeforeStart,
    invalidEnvelopeTimestamp,
  ]) {
    assert.throws(
      () => projectCodexGoalRecords({ records, threadId: THREAD }),
      (error) => error.message === CODEX_GOAL_PILOT_ERRORS.lifecycleConflict
        && !error.message.includes(TURN_A),
    );
  }
});

test('post-verification parser failures retain only trusted goal aliases for sticky quarantine', () => {
  const verifiedRecords = activeNativeShape();
  const verified = projectCodexGoalRecords({ records: verifiedRecords, threadId: THREAD });
  const [verifiedGoalId] = verified.goals.map((goal) => goal.goalId);

  const lifecycleConflict = [
    ...verifiedRecords,
    record('2026-08-30T00:00:04.000Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:04.000Z',
    }),
  ];
  const stateConflict = [
    ...verifiedRecords,
    nativeCall('2026-08-30T00:00:04.000Z', {
      name: 'update_goal',
      callId: 'native-call-private-terminal-before-reopen',
      argumentsValue: { status: 'complete' },
    }),
    nativeOutput(
      '2026-08-30T00:00:04.100Z',
      'native-call-private-terminal-before-reopen',
      goalResult({ updatedAt: 1_777_680_001_000, status: 'complete' }),
    ),
    nativeCall('2026-08-30T00:00:05.000Z', {
      name: 'get_goal',
      callId: 'native-call-private-invalid-reopen',
      argumentsValue: {},
    }),
    nativeOutput(
      '2026-08-30T00:00:05.100Z',
      'native-call-private-invalid-reopen',
      goalResult({ updatedAt: 1_777_680_002_000, status: 'active' }),
    ),
  ];
  const causalityConflict = [
    ...verifiedRecords,
    nativeCall('2026-08-30T00:00:05.000Z', {
      name: 'get_goal',
      callId: 'native-call-private-reversed-after-verified',
      argumentsValue: {},
    }),
    nativeOutput(
      '2026-08-30T00:00:04.000Z',
      'native-call-private-reversed-after-verified',
      goalResult({ updatedAt: 1_777_680_001_000 }),
    ),
  ];

  for (const [records, expectedCode] of [
    [lifecycleConflict, CODEX_GOAL_PILOT_ERRORS.lifecycleConflict],
    [stateConflict, CODEX_GOAL_PILOT_ERRORS.stateConflict],
    [causalityConflict, CODEX_GOAL_PILOT_ERRORS.causalityViolation],
  ]) {
    let thrown;
    try {
      projectCodexGoalRecords({ records, threadId: THREAD });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.message, expectedCode);
    const confirmedGoalIds = confirmedCodexGoalIdsFromError(thrown);
    assert.deepEqual(confirmedGoalIds, [verifiedGoalId]);
    assert.equal(Object.isFrozen(confirmedGoalIds), true);
    const publicError = JSON.stringify(thrown);
    for (const forbidden of [
      THREAD,
      SESSION,
      TURN_A,
      SECRET_OBJECTIVE,
      SECRET_PATH,
      'native-call-private',
    ]) {
      assert.equal(publicError.includes(forbidden), false);
    }
  }

  const forged = new Error(CODEX_GOAL_PILOT_ERRORS.stateConflict);
  forged.confirmedGoalIds = [verifiedGoalId];
  assert.deepEqual(confirmedCodexGoalIdsFromError(forged), []);
});

test('late target segments quarantine only their goal while an interleaved child stays valid', () => {
  const childGoal = goalResult({ createdAt: 1_777_680_010_000 });
  childGoal.goal.threadId = CHILD_THREAD;
  childGoal.goal.objective = 'private child objective excluded from target quarantine';
  const records = [
    record('2026-08-30T00:00:00.000Z', 'session_meta', {
      id: CHILD_THREAD,
      session_id: SESSION,
    }),
    record('2026-08-30T00:00:00.100Z', 'event_msg', {
      type: 'task_started',
      turn_id: CHILD_TURN,
      started_at: '2026-08-30T00:00:00.100Z',
    }),
    nativeCall('2026-08-30T00:00:00.200Z', {
      name: 'get_goal',
      callId: 'native-call-private-child-before-target',
      argumentsValue: {},
    }),
    nativeOutput(
      '2026-08-30T00:00:00.300Z',
      'native-call-private-child-before-target',
      childGoal,
    ),
    ...activeNativeShape(),
    record('2026-08-30T00:00:04.000Z', 'session_meta', {
      id: CHILD_THREAD,
      session_id: SESSION,
    }),
    record('2026-08-30T00:00:05.000Z', 'session_meta', {
      id: THREAD,
      session_id: SESSION,
    }),
    record('2026-08-30T00:00:05.100Z', 'event_msg', {
      type: 'task_started',
      turn_id: TURN_A,
      started_at: '2026-08-30T00:00:05.100Z',
    }),
  ];
  const childProjection = projectCodexGoalRecords({ records, threadId: CHILD_THREAD });
  assert.equal(childProjection.goals.length, 1);

  let targetError;
  try {
    projectCodexGoalRecords({ records, threadId: THREAD });
  } catch (error) {
    targetError = error;
  }
  assert.equal(targetError?.message, CODEX_GOAL_PILOT_ERRORS.lifecycleConflict);
  const targetGoalIds = confirmedCodexGoalIdsFromError(targetError);
  assert.equal(targetGoalIds.length, 1);
  assert.notEqual(targetGoalIds[0], childProjection.goals[0].goalId);
  assert.equal(JSON.stringify(targetError).includes('private child objective'), false);
});
