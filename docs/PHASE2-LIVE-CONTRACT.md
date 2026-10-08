# Phase 2 live contract

Status: implemented and audited; Claude ingestion held by falsification gate

## Product hierarchy

The primary object remains an arrival window: expected completion clock time, range, current step/state and latest reason. A live-data surface must not add progress percentages or present a scan snapshot as a continuously watched run.

## Live UI

- The browser may switch between frozen Demo routes and imported local snapshots.
- A live projection comes only from persisted `runs` plus its latest persisted `forecast_snapshots` row; the browser never calls the estimator.
- The interface labels the source as a local scan snapshot and shows its observation time.
- Human-facing output must not contain run/session/event IDs, filesystem paths or transcript text.
- An empty state tells the operator to run `npm run scan:live:import`.

## Claude turn truth

A Claude terminal outcome is eligible only if all of the following hold:

1. the run boundary is derived from stable structure, not message text or idle time;
2. appending later records to the same session cannot change an earlier run ID;
3. the terminal event has a stable identity and is not synthesized from the mutable end of a whole file;
4. sidechain events do not masquerade as primary user turns;
5. sanitized fixtures prove append/reopen stability.

If any condition cannot be proved from available structure, Claude remains coverage-only. Failing closed is an accepted result.

### Machine verdict

The ancestry-based experimental parser satisfies stable run identity for sanitized append/reopen fixtures and excludes `isMeta:true` user-role records. It does **not** satisfy stable terminal truth on the real 30-day corpus: the current scan finds 1,107 of 2,288 candidate turns with multiple assistant `end_turn` envelopes, commonly different envelope UUIDs for one assistant message. An append-only scan can therefore emit a terminal before a later envelope arrives. Claude remains coverage-only; no terminal or outcome enters learning until message aggregation plus a stable checkpoint/quiescence rule, or explicit event retraction, is implemented and replay-tested.

## Live evaluation

- Cohort: positive-duration successful runs with `history_source=live_adapter`.
- Start landmark: compare global median, task median, model self-ETA when present, and saved run-level fallback.
- Plan landmark: for runs with a plan, compare the first valid plan-conditioned forecast with a fallback computed at the same observed state/time.
- Every historical feature must come from an outcome whose `finished_at` precedes the landmark.
- Report sample availability, median/mean absolute error, severe underestimation, interval coverage and run-level bootstrap uncertainty.
- Missing model self-ETA is reported as unavailable, never imputed.
- Results from live logs and frozen fixtures remain separate datasets.

Current Codex result: 3,130 eligible outcomes; start-landmark fallback MAE 8.82 minutes versus 8.87 for global/task medians. The 58-run planned subset has paired median MAE gain +4.44 minutes over same-landmark fallback, with 95% interval [-2.05, 10.89]. Because the interval crosses zero and plan median AE is worse, the result is inconclusive.

## Privacy

The live surface and reports may contain only hashed aliases, generalized structural state, timestamps, durations, forecasts and aggregate metrics. Reports omit even hashed per-run IDs. Source paths remain ephemeral process capabilities. No path may fall back to prompt/message/code/command inspection when structure is insufficient.
