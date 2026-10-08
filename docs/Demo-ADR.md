# Agent ETA Demo ADR

Status: final local structural shadow pilot GO; numeric automatic task/project ETA NO-GO

Date: 2026-08-30

Supersedes for Demo scope: `Agent-ETA-Next-architecture-v0.md` v0.4

## Final decision

Agent ETA remains a local, ETA-first product with one reducer, one run forecast engine, append-only evidence and one arrival-window UI.

The production hierarchy is:

1. **Selected turn/run** — the real current product. Without an active plan it uses run-level conditional survival; with a structured plan it uses sequential remaining steps and within-run pace.
2. **Task workset** — explicit Phase 6 declarations remain valid. Phase 7 additionally accepts structurally confirmed Codex Goal receipts as a provider-shadow source for one open, same-session cross-turn task.
3. **Explicit project workset** — implemented contract and conservative projection. It exists only as a project of task worksets.

An open provider conversation is grouping identity, not an outcome. The system answers the current bounded turn unless an explicit task scope exists. It never predicts when an indefinitely extensible chat will be “over”.

Task/project code correctness is not an accuracy claim. Automatic Goal tasks are deliberately open because an active Goal does not declare all future turns. Until an independent provider-shadow cohort passes the 30/50 falsification gates, this source is **status-only / collect-only** and returns no task completion clock. Provider-shadow numbers remain masked in every lifecycle state; terminal may reveal actual duration only. Projects remain explicit only and have a separate evidence gate.

## Phase 7 amendment: automatic task identity, not automatic project ETA

Phase 7 chooses the smallest provider-owned structural signal already present on this machine: Codex Goal tool receipts. The default watcher reads the Goal receipt and canonical run lifecycle from the same durable JSONL boundary, then atomically persists both projections. The observed contract binds identity within one canonical session; the latest 30-day structural sample does not establish cross-session continuity.

This amendment is intentionally narrow:

- a bare `create_goal` call or prose acknowledgement creates nothing;
- a paired, parseable and causally valid structured `create_goal` / `get_goal` result may confirm only `active`; a `get_goal` result claiming `blocked` or `complete` is ignored, and only a matching structured `update_goal` argument/result may confirm `blocked` or `complete`;
- a confirmed Goal maps to one deterministic hashed task workset and each newly observed turn in the same canonical session maps to a canonical run member revision;
- `blocked` is a reversible wait, not terminal; a run terminal while the Goal remains active becomes a paused turn gap; a later active receipt resumes the same task;
- `get_goal → null` after a confirmed Goal is right-censoring: persist the receipt, pause the task and do not record success;
- only a matching `update_goal(status=complete)` receipt establishes the task owner terminal; a completion first discovered without an earlier confirmed start is censored and cannot enter the measured target cohort;
- Goal never creates or labels a project. Thread, session, objective, repository, cwd and path are not project identity.

Durable syntax corruption, mixed-identity ambiguity, semantic identity conflict, illegal lifecycle transition or causal time reversal fail closed. Every known conflicted hashed Goal alias is written to `codex_goal_quarantines`, even if no task has been materialized yet. That ledger survives restart and a later clean branch cannot revive the alias. If a task already exists, its source also becomes sticky `quarantined`; earlier ETA and completion claims are no longer displayed or evaluated. The canonical run import is still handled under its own structural contract and is not rolled back merely because no valid Goal exists.

The detailed machine contract is `docs/PHASE7-SHADOW-PILOT-CONTRACT.md`.

### Live versus backfill provenance

SQLite v7 records the first observation channel of every Goal receipt as `first_ingest_mode=live|backfill`.

- `npm run scan:live:import` is a bulk historical operation and labels every newly discovered Goal receipt `backfill`.
- The watcher passes a rolling live-window boundary. Each receipt is classified independently: a new receipt whose occurrence is inside that window is `live`; older receipts found in the same changed file are `backfill`.
- A stale durable watcher watermark may widen file discovery for catch-up, but it cannot widen realtime provenance: the live threshold is clamped to `max(discoverySince, scanStarted-initialLookback)`. Recovered older receipts therefore remain backfill.
- First-ingest mode is immutable. Replaying an existing backfill receipt through a later watcher cycle cannot upgrade it. A distinct later receipt for the same Goal may be first observed live and provide new realtime evidence.
- Pre-v7 receipts have unknown origin and migrate conservatively to `backfill`.
- Clean backfill completion may enter offline coverage and outcome history after causal terminal receipt, but never the realtime picker or numeric target/promotion denominator.
- A task numeric target requires a clean applied live receipt received no later than that forecast landmark. If the provenance column is absent, numeric promotion fails closed.

## Joint Codex × Claude Code review

The two-round desktop Claude Code review and Codex verification agree on the important cuts:

- preserve the working run reducer/estimator instead of rewriting in Go;
- never map “global latest run” to the object Max selected;
- separate provider session identity, turn/run identity and explicit task/project outcome;
- do not infer a project DAG, future work or terminal from transcript text;
- stop the completion clock for human, provider, blocked and paused waits;
- make Reporter provider-owned and exact-thread, with receipt-time causality;
- require representative real scope outcomes before any task/project precision claim.

Codex rejected two tempting expansions: flat native plans do not justify a dependency graph, and locally contract-correct task/project projections do not justify calling them personalized or accurate. The full disagreement/falsification record is in `outputs/phase6-codex-claude-joint-review.md`.

## Evidence retained from v0.4 and machine audits

- The numeric run figures below are the Phase 6 frozen baseline, not evidence that Phase 7 automatic task ETA is accurate. Phase 7 task/project counts and verdicts come only from the generated pilot evaluation report.
- Native plans are structurally useful when present, but not common enough to be the default path.
- The current real live cohort contains 3,230 successful positive-duration Codex turn/run proxies; only 58 have a first-plan landmark.
- In that planned subset, paired mean-MAE gain is +4.44 minutes but the 95% interval `[-2.05, 10.89]` crosses zero and median AE is worse. Plan-conditioned is therefore an opportunistic navigator, not a proven accuracy win.
- All live `task_class` values are currently `other`; task median and global median are the same evidence, not two independent baselines.
- Model self-ETA is absent from the evaluated cohort and remains unavailable.
- Claude exposes TaskCreate/TaskUpdate structure, but appendable multi-envelope `end_turn` records do not provide an irreversible terminal. Claude remains coverage-only.
- Large-task plan coverage is unsupported until Reporter supplies an explicit eligibility denominator; all-run plan presence cannot substitute for it.
- Within-run pace is the highest-value immediate learning signal. Cross-run residuals remain gated at 20 comparable runs and class×provider priors at 100.
- Shared run randomness is required when sampling multiple steps; otherwise P80 becomes falsely narrow.

## Event, identity and privacy rules

Canonical lifecycle events are append-only and idempotent. Occurrence time and local observation time are distinct. A forecast landmark may use only events observed by that landmark and outcomes both finished and terminal-observed before it.

Live persistence is stricter than the forward-compatible public event schema. It accepts only provider-scoped hashed IDs, lifecycle times, generalized step ordinal/class/status and fixed adapter metadata. It rejects prompt/message/code/command fields, paths, native IDs, accessors, arbitrary labels and unknown persistence fields.

Goal parsing uses native thread/session/turn/call values only for in-memory equality checks and irreversible aliases. Goal objective text is used only to detect a semantic collision in memory; it is not emitted by the scan, persisted, returned by APIs or written to evaluation reports. `first_received_at` is the immutable local causal landmark; later repeats may advance only `last_received_at`.

The browser never receives canonical run/session/workset IDs. `/api/live/active` exposes an opaque local `selectionId`; `/api/live/latest?selection=…&scope=…` must preserve that selection even when a newer unrelated run appears. Older `projectionRevision` values cannot overwrite a newer view.

A paused Goal task remains eligible for `/api/live/active` for a 15-minute grace period, then ages out of that active candidate list. This is selector hygiene, not task completion or deletion: an already pinned opaque selection remains queryable through the exact-selection endpoints and continues to render the paused/no-clock projection.

A backfill-only Goal task never enters `/api/live/active`; exact lookup renders a fixed historical-observation state with no forecast. All unpromoted provider-shadow task/project projections are number-masked regardless of saved workset forecasts: running shows status only, waits show neither an absolute clock nor a resume range, and terminal shows actual duration without initial-prediction comparison. Forecast numeric fields returned to the browser are null/status-only. Current schema has no promoted provider-shadow state, so no shadow row bypasses this mask.

Reporter resolution is scoped to the explicit current Codex thread:

1. filename suffix narrows candidates before file reads;
2. root/session metadata must confirm the native thread in memory;
3. the existing canonical session/run alias continues to derive from native `session_id`;
4. copied branches must agree on one canonical session alias;
5. exactly one active run must remain; 0 or >1 fail closed.

There is no global-latest fallback. Filesystem/scan failures collapse to fixed codes without path echo.

## Forecast rules

### Run fallback

Sample total duration from earlier comparable totals or a wide public prior, conditional on total duration exceeding active elapsed; return `total - active_elapsed`.

### Plan-conditioned

Flat plan steps are sequential. Each draw has a shared run multiplier plus smaller step noise. Completed step `actual/prior` pace shrinks toward one; observed retry/replan work changes ETA immediately. Only actual subrun lifecycle events allow bounded run-level parallel credit.

No attention percentage, hidden LLM truth, inferred dependency or guessed future wait is allowed.

### Waits

`needs_input`, `waiting_provider`, `blocked` and `paused` freeze active elapsed and remove the absolute completion clock. The system may show only the post-resume active range; it does not predict user reply, provider recovery or unblock latency.

### Calibration

For each mode, use one first-landmark raw P80 ratio from each of at most 500 prior independent completed runs. Start only after 20 samples, shrink the log multiplier toward one and clamp it to `[1,3]`. The layer can widen but never narrow P80 and never move P50. It is an empirical, conformal-style correction, not a distribution-free guarantee.

## Workset rules

`agenteta.workset-event/1` defines task/project identity and membership.

- task children are runs; project children are persisted task worksets;
- membership at a revision is immutable; replan increments revision;
- open worksets without explicit parent survival are `unknown`;
- closed sequential work sums member lower/P50 and uses a conservative summed upper;
- explicit observed-running parallel groups take the slower branch for lower/P50, while upper remains conservatively summed; Phase 6 does not claim a calibrated joint P80;
- ambiguous, pending, failed/cancelled-child or incomplete scheduling semantics return `unknown` unless an owner terminal settles the parent;
- all children succeeding does not invent parent completion; owner terminal is required.

No inferred DAG or critical path is implemented. The complete contract is `docs/PHASE6-SCOPE-IDENTITY-CONTRACT.md`.

Phase 7 adds provenance without weakening these rules. `workset_sources` separates `controlled_wrapper`, `codex_goal_shadow` and `explicit_project_shadow`. A Goal-derived source is valid only for a task and starts as `verified_structural`; quarantine is one-way. Automatic Goal tasks remain open and therefore have no parent survival/numeric ETA. An automatic project source does not exist.

## Persistence and atomicity

SQLite schema v7 contains the legacy run/event/forecast tables, Reporter and explicit workset tables, plus source provenance, Goal receipt and Goal quarantine ledgers. The following operations are transactional:

- live raw event → reducer state → plan steps → raw/display forecast → calibration;
- Reporter observation → receipt-landmark forecast;
- unmatched Reporter reconciliation at lifecycle import;
- workset event → replay-verified projection/membership → durable forecast slot;
- one changed Codex file → canonical run events/forecasts + Goal receipts + task events/source/forecasts;
- frozen replay event → run/steps → forecast/calibration → replay cursor.

`workset_sources` has a workset FK; workset ledgers retain their existing FK and uniqueness constraints. `codex_goal_receipts` records a structural receipt fingerprint, immutable first receipt, immutable `first_ingest_mode`, latest repeat receipt, optional task alias and applied/censored/quarantined disposition. Repeated same payload is idempotent and cannot change ingest mode; same receipt ID with different payload quarantines the affected source. `codex_goal_quarantines` stores only the hashed Goal alias, fixed `goal_structure_conflict` reason and first/last receipt time; it is authoritative even before a workset exists and makes quarantine durable across restart and clean replay.

Schema v7 is an additive, restart-safe migration for this pilot. Existing receipts receive the conservative default `backfill`; no legacy row is inferred live. It does not claim that the older run/event/plan/forecast soft references have been physically rebuilt. Those remain protected by transaction ordering and explicit orphan audits. Reporter remains a soft reference because an observation is allowed to arrive before its run.

## Runtime decision

Use Node.js 22 standard-library modules: `node:http`, `node:sqlite`, browser-native HTML/CSS/JS and `node:test`. This machine already supports them and the Demo has no third-party dependency.

Go remains a production migration option, not a prerequisite. A rewrite must preserve canonical event/workset JSON, SQLite migrations, reducer projection, forecast projection and frozen black-box fixtures. The browser contains no forecast logic.

## Evaluation and falsification

All evaluators read one SQLite snapshot. Run history is time-forward; mid-run evaluation also requires source event observation and terminal observation before the landmark. Bootstrap units are runs; future task/project reports must resample owner scopes rather than child snapshots.

At the frozen Phase 6 checkpoint of 2026-08-29T12:12Z:

- start fallback: 3,230 runs, MAE 8.77, median AE 3.19, raw/calibrated P80 coverage 72.0%/79.1%;
- global/task median: MAE 8.82, median AE 4.07, P80 81.9%;
- first-plan: 58 runs, accuracy improvement inconclusive;
- mid-run: 9,473 eligible landmarks; no experimental arm passes every in-sample promotion gate, so the production estimator is unchanged;
- task/project: zero real worksets/outcomes; numeric accuracy unavailable;
- weekly eligibility denominator: unsupported.

Phase 7 adds a separate `evaluate:pilot` protocol rather than reusing child run snapshots as independent task samples:

- task and project evidence status, outcome libraries and decisions are separate;
- only `codex_goal_shadow/verified_structural` is provider-shadow task evidence; only `explicit_project_shadow/verified_structural` is provider-shadow project evidence; controlled wrapper rows remain contract-only;
- clean backfill scopes may contribute completed outcomes to later offline historical baselines, but backfill-only numeric forecasts are excluded from targets; a Goal task target additionally requires a causal clean applied `first_ingest_mode=live` receipt by its landmark;
- live and backfill receipt funnels are reported separately; a legacy database without `first_ingest_mode` cannot qualify provider task targets;
- each owner scope contributes at most its first positive causal numeric forecast; turns and snapshots inside one scope are never independent samples;
- completed owner outcomes without a numeric forecast may enter a later historical baseline only after both finish time and terminal receipt precede the target landmark;
- `other` and `unknown` are unclassified, so they cannot populate a task-class median or a “same type” promotion claim;
- blocking waits between landmark and terminal are excluded from scoreable ETA targets, not counted as model error;
- paired bootstrap resamples tasks for task claims and projects for project claims;
- the report compares historical global median, historical task-class median when available, model self-ETA, parent-survival fallback, workset aggregation and the selected scope forecast;
- P80 coverage includes a scope-level Wilson interval; severe underestimation is reported separately. Raw eligible/excluded forecast-transition counts are diagnostic only. The completion-clock volatility statistic is aggregated at owner-scope level, excludes observable structural revisions and waits, and is a hard promotion gate once its threshold and minimum cohort are predeclared.

At the final Phase 7 local freeze:

- `npm test` passes 202/202, with 195 top-level tests;
- the main SQLite database is schema v7 with `integrity_check=ok`, zero FK violations and zero event→forecast gaps;
- coverage generated at 2026-08-29T15:46:04.322Z has Codex plan-session coverage 6/148 and lifecycle-run coverage 51/2,913. It contains 2 confirmed Goal aliases and 9 backfill receipts (7 active, 1 blocked, 1 complete), with 0 live receipts and 0 quarantines;
- pilot evaluation generated at 2026-08-29T15:50:19.792Z is `shadow_collecting`: 2 goals / 9 confirmed receipts, task outcome library 1, numeric targets 0, scoreable tasks 0; project evidence 0;
- live evaluation generated at 2026-08-29T15:47:23.703Z has 3,359 outcomes. Global/task median MAE/median AE/severe-underestimate/P80 are 8.82/4.07 minutes/24.9%/81.4%; raw fallback is 8.78/3.20 minutes/30.9%/70.9%; calibrated fallback P80 is 78.5%; the 58-run plan comparison remains inconclusive because its paired bootstrap interval crosses zero;
- mid-run generated at 2026-08-29T15:48:13.799Z has 3,359 runs, 9,860 eligible landmarks and 217 not-yet-observable exclusions, with no production estimator change;
- scope replay has 18 events and 18 forecasts with zero gaps;
- the weekly rolling window has 1,504 successful outcomes, 1,617 lifecycle runs, 1,497 saved forecasts and P80 coverage 68.4%; the four-week plan-coverage gate remains unsupported.

These are local structural and run-level facts, not a task/project accuracy claim. The frozen product decision is structural shadow GO and numeric automatic task/project ETA NO-GO.

Promotion gates:

- fewer than 30 comparable owner scopes are insufficient; 30–49 are provisional; 50+ reaches a decision but does not guarantee promotion;
- a numeric decision requires at least 30 explicitly classified same-type paired scopes, a paired same-landmark absolute-error gain interval entirely above zero, P80 Wilson lower bound at least 0.8, and a predeclared completion-clock volatility threshold with enough scopes;
- missing class-specific, P80 or volatility evidence remains provisional/status-only; a measured gate failure falsifies that numeric layer and also returns status-only;
- severe-underestimate rate must be reported beside MAE and P80 and must not be hidden by a passing average metric;
- four supported weeks below 30% explicit eligible-task plan coverage demote plan-conditioned to an opportunity-only feature;
- 20 attached Reporter observations with zero identity mismatch are required before Reporter promotion;
- ≥100 representative runs without at least 10% supported MAE improvement over the strongest simple baseline trigger deletion of non-contributing complexity.

The generated `outputs/pilot-evaluation-report.{json,md}` remains the authority for current Phase 7 counts and verdicts; the figures above identify this ADR's final frozen snapshot. Until a later report reaches and passes the decision gates independently for a scope, the UI must not promote numeric ETA for that scope.

One provenance gap remains P1: canonical run wait events do not yet store their own first-ingest live/backfill mode. The evaluator can detect and conservatively exclude observed wait contamination, but cannot yet prove whether a run-level wait was first seen realtime or during bulk history import. Schema v7 solves Goal receipt provenance, not this run-wait distinction.

## Final verdict

**Final local structural shadow pilot GO; numeric automatic task/project ETA NO-GO.** The honest product remains a real Codex turn/run ETA. Phase 7 now identifies a same-session cross-turn task from real, durable structured Goal receipts, preserves live/backfill first-ingest provenance, and can recover active/blocked/paused/censored/complete truth across restart. Bulk history—including history recovered from a stale watcher watermark—cannot masquerade as realtime activity; provider-shadow numbers stay masked. Cross-session Goal identity is unsupported and automatic task mode is status-only while it collects independent outcomes. Project identity remains explicit, separate and unavailable when absent. This is the architecture to keep unless later 30/50 evidence independently passes every numeric gate or Codex changes the observed JSONL contract.
