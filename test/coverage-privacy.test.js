import assert from "node:assert/strict";
import test from "node:test";

import { aggregateCoverage } from "../src/adapters/coverage.js";
import { assertPrivacySafe } from "../src/adapters/privacy.js";

const sessions = [
  {
    provider: "codex",
    sessionId: "session-001",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: "2026-08-01T10:20:00.000Z",
    status: "succeeded",
    eventCount: 12,
    planEventCount: 2,
    corruptEventCount: 1,
    eligibleLargeTask: true,
    taskClass: "large",
    label: "planned",
  },
  {
    provider: "codex",
    sessionId: "session-002",
    startedAt: "2026-08-02T11:00:00.000Z",
    endedAt: "2026-08-02T11:05:00.000Z",
    status: "succeeded",
    eventCount: 8,
    planEventCount: 0,
    corruptEventCount: 0,
    eligibleLargeTask: true,
    taskClass: "large",
    label: "unplanned",
  },
  {
    provider: "codex",
    sessionId: "session-003",
    startedAt: "2026-08-03T12:00:00.000Z",
    endedAt: "2026-08-03T12:01:00.000Z",
    status: "cancelled",
    eventCount: 5,
    hasPlan: true,
    corruptEventCount: 1,
    eligibleLargeTask: false,
    taskClass: "small",
    label: "planned",
  },
];

test("aggregateCoverage reports eligible large-task coverage and corruption", () => {
  const result = aggregateCoverage(sessions);

  assert.deepEqual(result, {
    provider: "codex",
    simulated: false,
    liveReadOnly: true,
    totalSessions: 3,
    eligibility: {
      definition: "eligibleLargeTask_boolean",
      supported: true,
      eligibleSessions: 2,
    },
    planSessions: 2,
    eligiblePlanSessions: 1,
    coverage: 0.5,
    events: { total: 25, corrupt: 2, rate: 0.08 },
    timeRange: {
      from: "2026-08-01T10:00:00.000Z",
      to: "2026-08-03T12:01:00.000Z",
    },
  });
});

test("aggregateCoverage marks eligibility unsupported instead of reading content", () => {
  const result = aggregateCoverage([
    {
      provider: "future-provider",
      sessionId: "opaque-1",
      startedAt: "2026-08-10T00:00:00.000Z",
      eventCount: 4,
      planEventCount: 1,
      corruptEventCount: 0,
    },
  ]);

  assert.equal(result.provider, "future-provider");
  assert.equal(result.eligibility.supported, false);
  assert.equal(result.eligibility.eligibleSessions, null);
  assert.equal(result.eligiblePlanSessions, null);
  assert.equal(result.coverage, null);
  assert.equal(result.planSessions, 1);
});

test("aggregateCoverage remains provider-neutral and handles an empty scan", () => {
  assert.equal(aggregateCoverage([
    {
      provider: "claude",
      sessionId: "c-1",
      startedAt: "2026-08-01T00:00:00.000Z",
      eventCount: 0,
      eligibleLargeTask: false,
    },
    {
      provider: "codex",
      sessionId: "x-1",
      startedAt: "2026-08-02T00:00:00.000Z",
      eventCount: 0,
      eligibleLargeTask: false,
    },
  ]).provider, "mixed");

  const empty = aggregateCoverage([]);
  assert.equal(empty.provider, "unknown");
  assert.equal(empty.totalSessions, 0);
  assert.equal(empty.eligibility.supported, false);
  assert.equal(empty.coverage, null);
  assert.equal(empty.events.rate, null);
  assert.deepEqual(empty.timeRange, { from: null, to: null });
});

test("assertPrivacySafe accepts only generalized structural metadata", () => {
  const safe = {
    provider: "generic",
    sessionId: "opaque:123",
    startedAt: "2026-08-29T00:00:00.000Z",
    status: "in_progress",
    eventCount: 3,
    eligibleLargeTask: true,
    class: "test",
    label: "large-task",
  };

  assert.equal(assertPrivacySafe(safe), safe);
});

test("assertPrivacySafe rejects正文, commands, code, absolute paths and free text", () => {
  const unsafe = [
    { provider: "codex", prompt: "summarize this" },
    { provider: "codex", command: "npm test" },
    { provider: "codex", code: "console.log(1)" },
    { provider: "codex", sessionId: "/Users/example/private/session" },
    { provider: "codex", label: "x".repeat(65) },
    { provider: "codex", label: "npm" },
    { provider: "codex", label: "two words" },
    { provider: "codex", unknownMetadata: 1 },
    { provider: "codex", eligibility: { content: "nested正文" } },
  ];

  for (const value of unsafe) {
    assert.throws(() => assertPrivacySafe(value), /Privacy-unsafe value/);
  }
});

test("aggregateCoverage rejects accidental content before calculating metrics", () => {
  assert.throws(
    () => aggregateCoverage([
      {
        provider: "codex",
        sessionId: "session-unsafe",
        startedAt: "2026-08-01T00:00:00.000Z",
        eventCount: 1,
        eligibleLargeTask: true,
        message: "private transcript material",
      },
    ]),
    /may contain message data/,
  );
});

test("privacy validation rejects accessors without invoking them", () => {
  let invoked = false;
  const value = { provider: "codex" };
  Object.defineProperty(value, "status", {
    enumerable: true,
    get() {
      invoked = true;
      return "succeeded";
    },
  });

  assert.throws(() => assertPrivacySafe(value), /accessor properties are forbidden/);
  assert.equal(invoked, false);

  const values = [];
  Object.defineProperty(values, "0", {
    enumerable: true,
    get() {
      invoked = true;
      return "private";
    },
  });
  assert.throws(() => assertPrivacySafe(values), /accessor properties are forbidden/);
  assert.equal(invoked, false);
});

test("privacy validation rejects cyclic values and hidden array properties", () => {
  const cyclic = [];
  cyclic.push(cyclic);
  assert.throws(() => assertPrivacySafe(cyclic), /cyclic objects are forbidden/);

  const decorated = [];
  decorated.message = "hidden正文";
  assert.throws(() => assertPrivacySafe(decorated), /array properties are forbidden/);
});
