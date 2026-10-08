# Phase 7 Codex Goal Shadow Pilot Contract

Status: final local structural pilot GO; numeric automatic task/project ETA NO-GO

Date: 2026-08-30

Runtime schema: SQLite v7

Input boundary: observed local Codex JSONL, not an official provider API

## Purpose

Phase 7 answers one missing identity question from Phase 6: when the same Agent task continues across several bounded Codex turns inside one canonical session, which turns belong to the same task?

The pilot accepts an explicit Codex Goal as that task identity only when the local transcript contains a structurally valid tool call and matching structured result. It then projects the Goal lifecycle into the existing task workset reducer. It does not read transcript prose, infer intent, or create a project.

This phase does **not** promote numeric task ETA. A Goal can add future turns, so its task workset remains open. Every unpromoted provider-shadow state is number-masked: active shows status only, wait shows no resume range, and terminal may show actual duration only. The selected run continues to show the existing run ETA.

## 1. Scope decision

The three product scopes stay distinct:

| Scope | Phase 7 identity source | Current product claim |
|---|---|---|
| run / turn | canonical Codex `task_started` plus terminal lifecycle | numeric run ETA remains the live product |
| task | structurally confirmed Codex Goal within one canonical session, or the existing explicit workset contract | automatic Goal task is provider-shadow identity and status only |
| project | explicit project workset whose children are persisted tasks | no automatic project identity or accuracy claim |

Goal, conversation thread, session, repository, cwd, path and objective are not interchangeable. In particular:

- one Goal creates at most one task;
- one task may accumulate several canonical runs across turns in the same canonical session;
- no Goal event creates, labels or revises a project;
- no directory, branch, timing coincidence or text similarity creates a project;
- task and project evidence are evaluated independently.

## 2. Accepted structural evidence

The parser consumes only already-local Codex JSONL records and recognizes these structural envelopes:

- `session_meta` with native thread and session identity;
- `event_msg.task_started` and the allowlisted run terminal kinds;
- `response_item.function_call` for `create_goal`, `get_goal` or `update_goal`;
- the matching `response_item.function_call_output` with a parseable structured Goal result.

A tool call by itself is not evidence. A bare `create_goal` acknowledgement such as prose saying the Goal was created is not evidence. A valid confirmation requires:

1. call and output share one call ID and occur in that order;
2. exactly one canonical turn was active when the call was made;
3. returned `goal.threadId` matches the scoped native thread;
4. objective, created time, updated time and status are structurally valid;
5. `createdAt <= updatedAt <= output timestamp`;
6. a structured `create_goal` result is `active`;
7. an `update_goal` argument is `blocked` or `complete` and exactly matches the returned status.

`create_goal` or `get_goal` may confirm only `active`. A structured `get_goal` result claiming `blocked` or `complete` is ignored and materializes no lifecycle transition. Only a matching `update_goal` argument/output may confirm `blocked` or `complete`. A structured `get_goal` result with `goal: null` is an absence observation, not completion.

Only the final unterminated partial JSONL record may be ignored while the provider is still appending. A malformed durable/interior record poisons the Goal branch and triggers fail-closed quarantine for any recoverable confirmed Goal alias.

## 3. Identity and branch isolation

Native identifiers remain process-local capabilities. The pilot derives irreversible aliases for Goal, observation, receipt, task and membership identity.

- Goal alias is bound to the exact native thread segment, canonical session alias and Goal creation time.
- The objective contributes only to an in-memory semantic fingerprint used to detect identity conflict; objective text and that semantic fingerprint are not persisted or returned.
- Run alias uses the existing canonical Codex run identity contract.
- Task alias is a deterministic hash of the Goal alias.
- Receipt and workset event aliases are deterministic, making replay idempotent.

A `session_meta` identity change starts a new segment and clears active-turn and pending-call state. State from a parent/root segment cannot bleed into a child segment even when files share a native session component. Copied branches must agree on one canonical session alias; repeated observations must have the same structural fingerprint.

The latest 30-day structural sample contains no verified example of one semantic Goal continuing across distinct native sessions. Goal alias includes the canonical session component, so cross-session identity is unsupported and is not merged by objective, timestamp similarity or thread resemblance. The implemented guarantee is same-session continuity across turn IDs and structurally consistent copied branches only.

There is no global-latest resolver and no cross-thread fallback.

## 4. First-ingest provenance

Every `codex_goal_receipts` row has an immutable `first_ingest_mode`:

- `live`: the receipt was first observed by the watcher and its occurrence timestamp was inside that watcher scan's rolling live window;
- `backfill`: the receipt was first discovered by bulk/history import or fell before the watcher's live boundary.

Classification is per receipt, not per file or Goal. A changed JSONL file may contain old and new receipts in one scan: the old receipts are backfill and the in-window receipts are live. The transport rules are:

1. `npm run scan:live:import` always invokes Goal reconciliation in `backfill` mode.
2. The watcher invokes it in `live` mode with the exact lookback/watermark boundary used for that scan.
3. File discovery may catch up from an old durable watermark, but realtime provenance is clamped to `max(discoverySince, scanStarted-initialLookback)`. The older portion is discoverable yet remains backfill; restart cannot enlarge the live window.
4. An existing receipt keeps its original mode on every replay. Updating `last_received_at` never changes `first_ingest_mode`.
5. A backfill receipt replayed inside a later live scan cannot be promoted. A different later receipt for the same Goal may be first observed live.
6. Migration from a schema without this column assigns `backfill`, because historical provenance cannot be reconstructed safely.

Backfill evidence is useful but not realtime truth. Clean backfill receipts may contribute coverage, censoring/quarantine diagnostics and completed outcomes to the offline history library. A backfill-only task is excluded from the realtime picker and every numeric promotion target. Exact selection of such a stored task returns a fixed historical-observation projection with null forecast fields.

A Goal task forecast can enter the numeric target cohort only when a clean applied live receipt was first received no later than that forecast landmark. Absence of the provenance column, absence of a causal live receipt, or backfill-only receipts all fail closed.

## 5. Goal-to-task lifecycle

| Observed structural fact | Durable task effect | Completion-clock effect |
|---|---|---|
| first confirmed `active` | declare revision 1, attach the canonical run, source=`codex_goal_shadow/verified_structural`, status=`running`, open workset | task numeric ETA remains unavailable |
| first confirmed `blocked` | declare the same open task, attach the run, then set `blocked` | no absolute clock |
| later `active` in a new run in the same canonical session | revise membership, append the new run, set/resume `running` | still status-only while open |
| repeated `active` in the same run | idempotent heartbeat | no invented work |
| `blocked` | set or retain `blocked` | stop clock; do not predict unblock time |
| active Goal whose last run terminates with no active run | derived `paused` turn gap | stop clock; run terminal is not task terminal |
| later confirmed `active` | resume the same task and add the new run if needed | resume state, not a new task |
| known Goal followed by `get_goal → null` | persist a censored absence receipt and pause if nonterminal | no success and no absolute clock |
| matching `update_goal(status=complete)` result | explicit task owner `succeeded` terminal | save actual outcome and stop permanently |
| completion first seen without a prior confirmed start | receipt is censored; no task outcome is created | excluded from target accuracy cohort |

`blocked` is recoverable. `run_succeeded`, `run_failed`, `run_cancelled` and scanner silence do not finish the Goal task. Only the structurally matched Goal completion receipt is success truth. A terminal task cannot be reopened.

## 6. Censoring and quarantine

Censoring means the observation is incomplete but not contradictory:

- `get_goal → null` after a known active/blocked Goal;
- terminal Goal found only in backfill without an earlier causal start landmark.

A censored record never becomes success. It may pause an existing task and remains visible in the evaluation funnel.

Quarantine means structural evidence conflicts and prior claims are unsafe. Examples include:

- durable malformed JSON inside a Goal-bearing branch;
- mixed session/thread identity that cannot be reduced to one canonical segment;
- duplicate call/receipt identity with different payload;
- the same Goal identity with a different semantic objective fingerprint;
- completion followed by active/blocked state;
- invalid run lifecycle or causal time reversal;
- workset event/source/revision conflict.

Quarantine is sticky at two levels:

1. `codex_goal_quarantines` stores the hashed Goal alias, fixed `goal_structure_conflict` reason, and immutable first/latest local receipt times even if a task was never materialized.
2. If a workset exists, `workset_sources.source_status` becomes `quarantined` and cannot return to `verified_structural`.

After restart or a later clean branch, the durable quarantine ledger is checked before applying any receipt. A first-seen conflict therefore cannot be revived by replaying only the clean prefix. Quarantined tasks are excluded from default selection, numeric projection and evaluation. If the user has a pinned opaque selection, the UI shows a fixed structural-conflict/unavailable state and clears earlier ETA or completion claims.

## 7. Receipt-time causality and persistence

The pilot distinguishes:

- `occurred_at`: the timestamp of the structured function output in the local transcript;
- `first_received_at`: the first local import time, immutable and used as the causal receipt boundary;
- `last_received_at`: the latest idempotent repeat import time.

SQLite v7 contains:

- `workset_sources` for provider, source kind, source status, task class, large-task eligibility and first/latest receipt times;
- `codex_goal_receipts` for hashed receipt/Goal/run aliases, occurrence/receipt times, immutable `first_ingest_mode=live|backfill`, fixed kind, payload fingerprint, optional task alias and applied/censored/quarantined disposition;
- `codex_goal_quarantines` for durable pre/post-materialization structural conflict;
- the existing workset/event/member/forecast tables continue to store reducer truth and every task projection snapshot.

The receipt table contains no FK to a run or workset because a valid receipt may arrive before its canonical run or may be censored before task creation. Workset sources do have a workset FK.

One live import transaction covers:

1. sanitized canonical run events;
2. run reducer state and run forecast snapshots;
3. Goal receipts and quarantine records;
4. task workset events, membership, source and task forecast slot;
5. Reporter reconciliation and calibration touched by that import.

An internal failure rolls back the whole attempt. Retrying the same file must create exactly one semantic result. Same receipt ID plus same payload is idempotent and preserves first-ingest mode; same ID plus different payload quarantines the Goal. Schema migration assigns every pre-provenance receipt `backfill` rather than guessing that it was live.

## 8. UI contract

The UI remains one ETA-first arrival window with an opaque selector and `本轮 | 任务 | 项目` scope controls.

- A verified open Goal task with at least one clean applied live receipt may become the default task selection when it is the unique parent of the selected run.
- A Goal task with only backfill receipts never enters the active candidate list. Exact lookup is allowed for offline inspection but returns “历史结构观察” with no forecast.
- A verified running task without numeric evidence stays visible as “任务进行中 / ETA 证据不足”.
- `blocked` stays visible without an absolute completion time. A `paused` task remains in the active candidate list for a 15-minute grace period, then ages out of that list; an already pinned opaque selector remains queryable and continues to show the paused/no-clock projection.
- A quarantined task cannot replace a healthy run selection; a pinned quarantined task shows only the fixed conflict state.
- If a run has more than one nonquarantined parent task, selection migration fails closed. Freshness filtering cannot turn a genuinely multi-parent identity into a unique one.
- Project remains unavailable unless exactly one explicit, nonquarantined project parent exists.

The browser does not estimate, aggregate, count down or infer identity. It renders saved server projections and rejects stale projection revisions.

Until an explicit future promotion state exists and passes the evidence gates, both `codex_goal_shadow/verified_structural` and `explicit_project_shadow/verified_structural` are fully number-masked even if SQLite contains a numerical workset forecast:

- running: headline/status only; lower/P50/P80/upper are null;
- `needs_input`, `waiting_provider`, `blocked`, `paused`: no absolute clock and no resume lower/upper range;
- succeeded/failed/cancelled: actual duration may be shown, but saved initial prediction, prediction-vs-actual comparison and forecast numbers are hidden;
- API forecast mode/status is unavailable/status-only for these projections.

Controlled contract worksets are not provider shadow and retain their Phase 6 behavior. Current schema has no promoted provider-shadow status, so every provider-shadow row is masked.

## 9. Current numerical policy

Automatic Goal tasks are **status-only / collect-only** for Phase 7:

- `workset_closed=false` while active;
- no parent survival model is available;
- source task class is currently `other`, which is treated as unclassified;
- fewer than the required independent, comparable owner outcomes cannot justify an accuracy claim;
- backfill-only receipts cannot create a realtime selector or numeric target; only a causal clean applied live receipt can qualify a Goal task forecast landmark;
- controlled wrapper outcomes do not promote provider-shadow evidence;
- task samples never promote project evidence.

The task view therefore does not borrow a run ETA, global median or historical task median merely to display a number. The selected run continues to use run fallback/plan-conditioned ETA under the existing contract.

## 10. Pilot evaluation protocol

Run:

```bash
npm run evaluate:pilot
```

The generated `outputs/pilot-evaluation-report.{json,md}` is authoritative for sample counts and verdicts. The evaluator reports a separate task and project funnel:

- structurally confirmed Goal receipts and scopes;
- live and backfill first-ingest receipts as separate provenance funnels;
- censored, terminal-without-start and quarantined receipts;
- materialized, active, blocked and completed scopes;
- completed outcome library;
- causal first numeric forecasts;
- wait-contaminated exclusions;
- scoreable owner scopes and paired comparisons.

For each scope, it compares when available:

- historical global conditional-survival median;
- explicitly classified task-class median;
- model self-ETA;
- scope parent-survival fallback;
- workset aggregation;
- selected scope forecast.

Evaluation is strictly time-forward. A historical outcome is usable only when both its finish and terminal receipt are strictly earlier than the target landmark. Clean backfill completions may populate that outcome/history library, but a Goal task target additionally requires a clean applied `first_ingest_mode=live` receipt received by the forecast landmark. Backfill-only, no-causal-receipt and legacy-provenance numeric rows are reported as exclusions, not silently promoted. Each task or project contributes at most one first positive forecast to the target cohort. Bootstrap resamples owner tasks or owner projects, never child turns or snapshots.

Blocking waits after the landmark are excluded before scoring because their duration is deliberately not predicted. Severe underestimation is reported separately from MAE: saved P50 below half of actual remaining time. P80 uses a scope-level Wilson interval. Raw counts of eligible, excluded and missing forecast transitions are diagnostic coverage only. The promotion metric aggregates absolute completion-clock shifts at the owner-scope level, excludes observable structural revisions and waits, and is a hard numeric gate once its threshold and minimum scope cohort are predeclared.

### Decision gates

- `<30` scoreable independent scopes: `insufficient`.
- `30–49`: `provisional`; no accuracy claim.
- `50+`: decision stage, but numeric ETA is promoted only if all declared gates pass.
- At least 30 explicitly classified same-type paired scopes are required for the class-specific decision.
- Paired absolute-error gain over the strongest valid historical reference must have a bootstrap interval entirely above zero.
- Candidate P80 Wilson lower bound must be at least 0.8.
- A completion-clock volatility maximum must be declared before evaluation and have enough scopes; missing volatility evidence cannot produce a full numeric decision.
- Missing task-class, P80 or volatility evidence keeps the scope provisional/status-only.
- A measured gate failure falsifies numeric ETA for that scope and recommends status-only.

Task and project decisions never share samples or evidence status.

## 11. Frozen local evidence

Final local freeze:

- `npm test`: 202/202 pass, including 195 top-level tests;
- main database: schema v7, `integrity_check=ok`, 0 FK violations, 0 event→forecast gaps;
- Goal coverage, generated 2026-08-29T15:46:04.322Z: Codex plan-session coverage 6/148 and lifecycle-run coverage 51/2,913; 2 confirmed hashed Goal aliases, 9 backfill receipts (7 active, 1 blocked, 1 complete), 0 live receipts and 0 quarantine;
- pilot, generated 2026-08-29T15:50:19.792Z: 2 goals / 9 confirmed receipts, overall `shadow_collecting`; task outcome library 1, numeric targets 0, scoreable tasks 0; project evidence 0;
- live run evaluation, generated 2026-08-29T15:47:23.703Z: 3,359 outcomes; global/task median MAE 8.82 minutes, median AE 4.07, severe underestimate 24.9%, P80 81.4%; raw fallback MAE 8.78, median AE 3.20, severe underestimate 30.9%, P80 70.9%; calibrated fallback P80 78.5%; 58 planned runs with the paired bootstrap interval still crossing zero;
- mid-run, generated 2026-08-29T15:48:13.799Z: 3,359 runs / 9,860 eligible landmarks, 217 not-yet-observable exclusions, no production estimator change;
- scope replay: 18 events / 18 forecasts, gap 0;
- weekly rolling window: 1,504 successful outcomes / 1,617 lifecycle runs / 1,497 saved forecasts, P80 68.4%; explicit eligible-large-task four-week plan gate `unsupported`.

Visual acceptance artifacts:

- [desktop shadow](../outputs/phase7-shadow-pilot-desktop.png)
- [390 px mobile shadow](../outputs/phase7-shadow-pilot-mobile.png)

This evidence passes the local structural contract. It does not pass numeric automatic task/project promotion: task has no causal numeric target, project has no evidence, and both remain NO-GO.

## 12. Local acceptance commands

```bash
cd agent-eta
npm test
npm run scan:live:import
npm run evaluate:pilot
npm start
```

`npm start` is still the single runtime command; the default watcher classifies each newly observed durable Goal receipt against its rolling live window. `scan:live:import` is the explicit 30-day bulk backfill command and never manufactures live provenance. A current in-memory Goal may not appear until Codex flushes its structural call/output records to JSONL; that delay is honest observation latency, not a reason to synthesize state.

Acceptance requires:

- schema version 7, `integrity_check=ok`, empty FK check and no event/forecast gaps;
- bulk import writes backfill, watcher classifies per receipt/window, stale-watermark discovery cannot widen the clamped live provenance boundary, and replay cannot upgrade first-ingest mode;
- restart preserves active/blocked/paused/censored/quarantined/terminal task truth;
- bare create, null Goal, terminal-without-start and structural conflicts fail closed;
- first-seen quarantine survives restart and a clean replay branch;
- a Goal creates no project row;
- backfill-only Goal task never enters the realtime picker or numeric target cohort;
- task waits show no absolute completion clock;
- every unpromoted provider-shadow state has null forecast numbers; wait has no resume range and terminal may show actual only;
- paused task leaves the active candidate list after the 15-minute grace while an exact pinned selection remains queryable;
- default and pinned selection behavior remains identity-stable;
- distinct canonical sessions are never merged into one Goal task without a future explicit identity contract;
- persisted rows, API responses, errors and reports contain no prompt, objective, message, code, command, path or native ID;
- evaluation reports task and project separately, treats raw transition counts as diagnostic, and enforces owner-scope volatility as a hard numeric gate.

## 13. Falsification failures

Any of the following invalidates this Phase 7 contract:

- a bare/unstructured Goal call materializes a task;
- a run terminal, scanner silence or `get_goal → null` marks a task successful;
- a Goal receipt creates or labels a project;
- a backfill receipt enters the realtime picker, qualifies a numeric target, or changes to live on replay;
- a stale watcher watermark causes an occurrence older than the normal initial lookback to be labelled live;
- a quarantined alias becomes verified after restart or clean replay;
- one failed import leaves a run event without its run forecast or a task event without its task forecast;
- waiting/blocked/paused displays an absolute completion clock;
- an unpromoted provider shadow exposes saved ETA numbers, a wait resume range, or a terminal prediction comparison;
- a stale paused task remains in the default active list after its 15-minute grace, or an exact pinned selection becomes unqueryable solely because it aged out;
- an ambiguous parent mapping silently selects a task or project;
- separate canonical sessions are merged by objective or resemblance;
- native identity, objective, transcript content or filesystem path enters persistence/API/report output;
- controlled or task samples are counted as independent provider-shadow project evidence;
- fewer than the required owner scopes are advertised as accurate or personalized ETA.

## 14. Known limitations

- Codex JSONL is an observed local contract and may change without notice; there is no official hook in this phase.
- Tool receipt visibility can lag the active turn until the provider flushes durable JSONL.
- Cross-session continuity for the same semantic Goal was not observed in the latest 30-day structural sample and is unsupported; only same-session turns/consistent branches are joined.
- Goal receipt provenance is explicit in v7, but canonical run `needs_input` / `waiting_provider` events still lack an equivalent first-ingest live/backfill field. Offline scoring conservatively excludes observed waits; distinguishing a run wait first seen live from one first seen in bulk history remains P1.
- Goal task class is currently unclassified and large-task eligibility is unknown.
- Automatic Goal task is open, so its numeric remaining work is intentionally unknown.
- No automatic project identity, project membership, DAG or critical path is inferred.
- No user-response, provider-recovery or external-wait duration is predicted.
- Historical terminal-only Goal backfill can populate coverage/censoring evidence but cannot manufacture a causal forecast target.
- Representative task and project accuracy cohorts have not yet passed the 30/50 decision gates.
