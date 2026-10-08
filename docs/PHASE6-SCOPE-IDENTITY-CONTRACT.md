# Phase 6 Scope and Identity Contract

Status: implemented local contract; accuracy promotion remains evidence-gated

Date: 2026-08-29

Schema: SQLite v5, `agenteta.workset-event/1`, `agenteta.reporter/1`

## Purpose

Agent ETA answers one bounded question: **how much active work remains before the selected execution unit reaches an explicit terminal outcome?** The product surface remains one arrival window. While work is active it may show “预计 HH:MM 完成”, “还剩约 N 分钟”, a range, current state, evidence level and change reason. It does not show a completion percentage or infer progress from transcript text.

Phase 6 separates three scopes that share this surface:

| UI scope | Prediction object | Identity truth | Current evidence claim |
|---|---|---|---|
| 本轮 | one canonical turn/run | provider lifecycle events | real local Codex turn/run proxy |
| 任务 | one explicit task workset whose members are runs | versioned workset events | contract implemented; real accuracy unproven |
| 项目 | one explicit project workset whose members are task worksets | versioned workset events | contract implemented; real accuracy unproven |

An open-ended conversation is not a fourth forecast object. “本轮” means the current bounded Agent turn/run. A future user turn is new work and is not included in the current ETA. The system must never claim to know when an indefinitely extensible conversation will be “finished”.

## 1. Canonical turn/run identity

A run is the smallest lifecycle unit with a canonical start and, when observable, one terminal event: `succeeded`, `failed` or `cancelled`. Its estimator uses only canonical structural events, persisted history that was available at the forecast landmark, and explicit Reporter observations.

The local Codex resolver is scoped to an explicitly supplied current thread:

1. Candidate files must match that exact thread before they are opened.
2. Session metadata must hash to the same canonical session alias.
3. Copied branches are deduplicated by canonical run alias.
4. Exactly one started, nonterminal run must remain.
5. Zero or multiple active runs fail closed with an enum error.

There is no “global latest run” fallback. A resolver must not scan unrelated threads and choose the most recent item.

The browser receives an opaque `selectionId`, not a run, session, event or native identifier. `GET /api/live/active` returns bounded, structural selector metadata. `GET /api/live/latest?selection=…&scope=…` preserves the selected chain; another run becoming newer must not steal focus. A missing or invalid selection returns unavailable rather than substituting a different run. The browser rejects an older `projectionRevision` for the same selection and scope.

## 2. Explicit task and project worksets

Task and project identity must come from `agenteta.workset-event/1`. It is never inferred from a prompt, transcript, directory, branch name, flat plan or timing coincidence.

Every workset event has exact, allowlisted fields:

- a hashed workset, event and member alias;
- `workset_type`: `task` or `project`;
- an event timestamp and fixed event kind;
- a monotonically increasing revision for declaration/replan events;
- an explicit `workset_closed` flag;
- an ordered member list with attach/detach timestamps;
- an optional hashed `execution_group` declaration.

A task may contain only run children. A project may contain only persisted task-workset children. Active member IDs and order indexes must be unique. Membership at revision N is immutable; changing membership requires revision N+1. A terminal owner event is immutable.

### Aggregation rules

- An open workset is `unknown` unless it has an explicit parent-level survival forecast. Current children are not silently treated as all future work.
- A closed sequential workset sums the children’s lower and P50 estimates. Its conservative upper adds the child P80 values.
- Parallel treatment is allowed only for an explicitly declared, contiguous execution group whose children are observed as running or succeeded. The lower and P50 use the maximum within that group. For more than one unfinished child, the upper bound remains the conservative sum of child P80 values; Phase 6 does **not** claim that this is a calibrated joint P80.
- A succeeded child contributes zero remaining time. Pending, unknown, failed or cancelled child semantics make the parent `unknown` unless an explicit owner terminal event settles the parent.
- A workset heartbeat ages an unchanged running child forecast by elapsed active time exactly once, so the absolute completion clock does not drift merely because the heartbeat is newer. Waiting children retain their post-resume range; a task heartbeat followed by a project heartbeat must not double-age the same child.
- Even when every child is succeeded, the workset remains `unknown` until the owner emits its terminal event. Child completion does not invent parent completion truth.
- Revision, member, forecast and owner-terminal state are persisted together with foreign-key checks. Restart must reconstruct the same projection from the event ledger.

No dependency graph, inferred critical path or prediction of undeclared future work is part of this contract.

## 3. Unknown, waiting and terminal semantics

### Unknown

An unavailable forecast must contain no completion clock and no numeric remaining-time claim. At minimum, the following conditions are `unknown`:

- no canonical selected run;
- no unique parent task/project workset for the selected chain;
- an open workset without explicit parent survival;
- incomplete member projections;
- pending or ambiguous child semantics;
- an unavailable child forecast;
- an ambiguous or not-observed-running parallel declaration;
- all children complete but owner terminal absent.

The UI explains the missing truth, for example “没有显式工作集合” or “成员或调度语义不足”. It must not replace `unknown` with a historical median merely to keep a number on screen.

### Waiting

`needs_input`, `waiting_provider`, `blocked` and `paused` stop the completion clock. While any selected scope is in one of these states:

- no absolute “预计 HH:MM 完成” is displayed;
- user reply time, provider recovery time and unblock time are not predicted;
- the UI may show only the post-resume active-work range, such as “回复后约 X–Y 分钟”;
- if that active range is unavailable, the UI says so without inventing one.

Active elapsed time advances only while the scope is running. Upstream producers may debounce brief waits before emitting a wait event, but once a wait is canonical the renderer must fail closed.

### Terminal

Only an explicit run or owner-workset terminal event establishes terminal truth and actual completion time. The same arrival window then stops counting down and shows:

- terminal status;
- actual elapsed time when available;
- the first eligible saved forecast window versus the actual finish time;
- the signed early/late difference from the initial P50.

Raw forecasts remain in SQLite after terminal so evaluation can reproduce what was known at each landmark. A later event may not resurrect a terminal scope.

## 4. Reporter identity and receipt landmark

Reporter transports explicit structural labels; it does not create lifecycle identity. Its `run_id` must exactly match an already canonical hashed run alias.

The Codex wrapper resolves only within the explicit current thread and posts a report only when exactly one active canonical run exists. The wrapper/library is a real local implementation, but it is not an official provider hook and is not automatically invoked by Codex or Claude. Claude terminal ingestion remains outside the learning cohort until its separate canary passes.

Reporter distinguishes two times:

- `reported_at`: when the provider-side observation says it was made;
- `received_at`: the server’s first local receipt time, which is immutable.

The receipt landmark is the causal forecast boundary. A Reporter-triggered forecast may use only lifecycle events whose occurrence and observation times are no later than that receipt, and only prior historical outcomes observable before it. A later plan or terminal already present during backfill must not leak backward.

Persistence is idempotent on `(run_id, reported_at)`:

- identical repetition succeeds without duplicating the observation or forecast;
- conflicting content returns `REPORTER_OBSERVATION_CONFLICT`;
- an unmatched observation is retained as observation-only and creates no run;
- when its canonical run arrives later, reconciliation reuses the immutable first receipt;
- a matched, nonterminal causal run may save one receipt-landmark forecast;
- a terminal or causally incomplete run saves no new receipt forecast.

Observation and forecast persistence are transactional. A saved receipt forecast emits a structural local invalidation; browser responses expose only `reforecasted`, aggregate Reporter status and fixed errors, never internal run or snapshot IDs.

Reporter plan fields label evidence only. They do not synthesize plan steps, task membership or project membership.

## 5. Privacy and trust boundary

The system is local-only on loopback plus local SQLite. It does not publish, upload, create accounts, send telemetry or write back into Agent transcripts.

Persisted contracts and browser APIs are structural and allowlisted. They must reject or omit:

- prompt and message text;
- code and command contents;
- absolute paths and working directories;
- native session/thread identifiers;
- user-provided workset names or arbitrary labels;
- unbounded free text.

Hashed aliases may exist inside SQLite for exact joins. The live browser surface gets a second opaque selection alias and safe enums; `/api/live/active` must not expose canonical run/workset aliases. API error bodies are fixed codes and must not echo rejected input or internal exception messages.

The Reporter write endpoint requires loopback HTTP, JSON content type and no browser `Origin`. This is a same-user local trust boundary, not multi-user authentication.

## 6. Acceptance scenarios

Phase 6 is acceptable only when all of these are reproducible from canonical events, Reporter receipt or frozen replay:

1. A selected active run shows completion clock, remaining minutes, range, status/evidence, current step and reason.
2. A newer unrelated run does not replace the selected run.
3. An older projection revision cannot overwrite a newer one.
4. Missing or ambiguous task/project identity renders `unknown` with no numeric ETA.
5. A valid closed task workset produces the contract-defined aggregate; a valid project chains only through explicit task worksets.
6. Open, incomplete, pending and ambiguous-parallel worksets fail closed.
7. All four waiting states remove the absolute clock and retain only a post-resume active range when available.
8. Terminal state shows initial predicted window versus actual outcome in the same arrival window.
9. Reporter zero/multiple-active resolution fails closed; matched receipt forecasting is causal, idempotent and restart-safe.
10. Browser/API privacy tests find no prompt, message, code, command, path, native ID or canonical run/workset ID.
11. SQLite integrity, foreign-key/orphan checks, event/forecast atomicity and restart replay pass.
12. Desktop and 390px mobile verification show one arrival window, not a dashboard or percentage view.
13. A fresh explicit task/project remains discoverable in the bounded active selector even when unrelated run snapshots arrive later; ranking still exposes only opaque selections and never guesses an ambiguous parent.

## 7. Evidence and falsification gates

Implementation correctness is not an accuracy claim. Phase 6 has real run-level proxy outcomes, but no representative task/project outcome cohort. Task/project forecasts must therefore be described as explicit-workset contract projections, not as proven personalized estimates.

Promotion requires all applicable gates:

- Evaluation is strict time-forward and compares global median, task median, model self-ETA when available, run-level fallback and plan-conditioned at equivalent landmarks.
- Bootstrap resamples independent runs; task/project evaluation must resample the owner workset, not correlated child snapshots.
- At 30 comparable new outcomes, any gain is provisional. At 50, if 50%-elapsed paired bootstrap cannot support positive absolute-error gain over historical medians, numeric ETA expansion stops; status, wait reason and completion notification remain.
- Calibrated P80 coverage must be reported with uncertainty and remain near 0.8 without increasing severe underestimation. Otherwise widen the range or return low evidence/unknown.
- If eligible-large-task plan coverage stays below 30% for four consecutive supported weeks, plan-conditioned remains an opportunistic enhancement rather than the headline path.
- Reporter promotion requires at least 20 attached real observations with zero identity mismatches. Zero or multiple active runs must continue to fail closed.
- Any numeric task/project ETA emitted for an open workset without parent survival, incomplete membership, ambiguous scheduling or missing owner truth is a contract failure.
- Task/project accuracy may be claimed only after representative real owner outcomes are collected and evaluated by scope. Contract fixtures and replay tests prove semantics, not precision.

## Non-goals

Phase 6 does not estimate the end of an open conversation, future user turns, user reply latency, provider recovery latency, undeclared future tasks, inferred dependencies or a critical path. It does not treat model self-ETA as ground truth and does not claim that plan-conditioned, task-level or project-level ETA is more accurate without passing the gates above.
