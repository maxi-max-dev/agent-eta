# Demo implementation contract

This file freezes cross-module boundaries while parallel work is in progress.

## Canonical event

```js
{
  schema_version: "agenteta.event/1",
  event_id: "evt_unique",
  run_id: "run_demo",
  provider: "codex" | "claude" | "generic",
  native_session_id: "fixture-session",
  occurred_at: "2026-08-29T00:00:00.000Z",
  observed_at: "2026-08-29T00:00:00.000Z",
  kind: "run_started" | "plan_declared" | "plan_revised" |
        "step_started" | "step_completed" | "retry_started" |
        "scope_expanded" | "waiting_provider" | "needs_input" |
        "resumed" | "subrun_started" | "subrun_finished" |
        "run_succeeded" | "run_failed" | "run_cancelled" |
        "heartbeat",
  source: { adapter: "fixture-replay", mode: "simulated_contract", confidence: 1 },
  data: {}
}
```

Plan steps use `{ id, label, class, status, prior_minutes? }`. Stable classes are `inspect`, `edit`, `test`, `review`, `external_wait`, and `other`.

## Reducer export

`src/core/reducer.js` exports:

```js
createRunState(runId)
reduceEvent(previousState, event) -> nextState
```

The returned state must be JSON-serializable and include `runId`, `status`, `startedAt`, `finishedAt`, `activeElapsedMs`, `currentStep`, `steps`, `planRevision`, `retryCount`, `reason`, `needsInput`, and `subruns`.

## Estimator export

`src/core/estimator.js` exports:

```js
forecastRun({ state, history, now, seed }) -> {
  mode: "run_fallback" | "plan_conditioned",
  status: "forecast" | "needs_input" | "terminal" | "warming_up",
  p50Minutes,
  p80Minutes,
  lowerMinutes,
  paceMultiplier,
  personalMultiplier,
  reason,
  raw
}
```

`history` is an array of completed comparable run summaries. Random sampling must be deterministic for a given seed.

## UI projection

`GET /api/state` returns:

```js
{
  runId,
  fixtureId,
  fixtureTitle,
  cursor,
  eventCount,
  state,
  forecast,
  display: {
    headline,
    range,
    currentStep,
    reason,
    tone: "working" | "waiting" | "done" | "failed"
  }
}
```

Controls call `GET /api/fixtures`, `POST /api/replay/reset` with `{fixtureId}`, and `POST /api/replay/next`. `GET /api/stream` is an SSE invalidation channel.

## Live adapter persistence boundary

`scanCodexSession` and `scanClaudeSession` return structural metadata plus optional canonical events. `scanClaudeTurns` is an experimental ancestry projection for coverage and plan-shape analysis; it excludes `isMeta` records and never emits terminal events because mutable transcripts lack a stable append checkpoint. Discovery file paths are ephemeral process capabilities and must be removed before aggregation, reporting or persistence.

`sanitizeLiveEvent` is stricter than `validateEvent`: only provider-scoped hashed IDs, timestamps, approved local adapter source fields, ordinal step labels (`步骤 N`), generalized classes/statuses and kind-specific structural data may enter SQLite. Unknown fields and all free text fail closed.

`importLiveScans({ database, scans })` is idempotent and saves one raw forecast snapshot for every newly inserted canonical event. Training history is queried with `history_source=live_adapter` and `finished_at < event.occurred_at`. Only positive-duration successful Codex runs are eligible. Claude is coverage-only until stable turn segmentation/retraction exists.

Coverage must distinguish:

- file observations;
- unique hashed session aliases;
- unique lifecycle run IDs;
- eligible-large-task coverage, which is `null/unsupported` unless every input has a safe explicit boolean eligibility flag.
