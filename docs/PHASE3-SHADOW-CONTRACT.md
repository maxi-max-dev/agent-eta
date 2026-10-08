# Phase 3 shadow-pilot contract

Status: accepted for local construction on 2026-08-29.

## Product surface

The primary object remains one arrival window: expected completion clock time,
range, current step/state, and the latest reason for change. The live surface
must not add completion percentages, a dashboard, or a second prediction model.

The local service may continuously observe privacy-minimized Codex structural
records and persist new canonical events. The browser never parses transcripts
and never estimates an ETA. It only renders the latest persisted forecast.

## Live watcher

- `npm start` starts the local UI and, when the local Codex session directory is
  available, one read-only Codex watcher.
- The watcher polls filesystem metadata, rescans only a bounded overlap window,
  and relies on stable canonical event IDs plus SQLite `INSERT OR IGNORE` for
  idempotence. The overlap is deliberate recovery from append races, not a
  claim that transcript files are immutable.
- Startup and restart must not clear runs, forecasts, outcomes, calibration, or
  the last watcher status. A persisted cursor is an optimization only; overlap
  scanning remains the correctness boundary.
- Successful imports save one raw forecast snapshot per newly inserted event
  and notify the existing local SSE stream. No timer decrements an ETA.
- Raw events, reducer state, forecasts and calibration commit in one SQLite
  transaction. A failed attempt leaves no durable event that could suppress its
  forecast on retry.
- Watcher status exposes only booleans, bounded counters, timestamps, an enum
  status/error code and poll interval. It never exposes source paths, native
  identifiers, prompts, message content, commands, code or working directories.
- `AGENT_ETA_WATCH=0` disables the watcher without disabling the replay Demo.
  Missing directories, parse drift and permission failures are explicit
  degraded states; they never fall back to reading content.
- A healthy watcher does not make an old snapshot realtime. Completed/failed
  snapshots expire after a short grace window; active snapshots expire after
  their saved P80 plus grace; an explicit `needs_input` wait remains current.
- Shutdown stops new polls and waits for any in-flight scan/evaluation before
  persisting `stopped` and closing SQLite.

Claude remains coverage-only. Its experimental turn view emits no terminal
events because append-only files can expose premature or ambiguous `end_turn`
envelopes. Claude outcomes stay outside persistence and learning until a stable
message aggregation plus checkpoint/quiescence or retraction contract exists.

## Reporter contract

The Phase 3 Reporter is a simulated integration contract, not an official Codex
or Claude connection. It accepts only explicit structural observations such as
task class, explicit large-task eligibility, model self-ETA, plan presence and
plan/adherence counters. Every field is allowlisted and bounded; unknown fields,
free text, paths and native identifiers fail closed.

The adapter must not infer `eligible_large_task`, task class or adherence from
prompt/message/code text. Missing explicit fields remain `unavailable`; they are
not imputed from lifecycle length or plan-event frequency.

## Weekly evidence and falsification

Weekly reports are aggregate, read-only views over persisted snapshots and
outcomes. Time ordering is part of the contract: an evaluation landmark may use
only outcomes with `finished_at < landmark_at`.

Each report should state, when supported:

- eligible outcome count and plan-presence count;
- global/task/run-fallback/model-self/plan-conditioned error availability;
- MAE, median absolute error and P80 interval coverage;
- within-run forecast volatility from successive persisted snapshots;
- plan coverage and adherence with their exact denominators.

The four-week promotion gate is fail closed. Only four consecutive, sufficiently
observed weeks with an explicit safe denominator may promote plan-conditioned as
a headline claim. Four consecutive weeks below 30% coverage force it to remain
an opportunistic enhancement. Missing eligibility or adherence yields
`unsupported`/`insufficient_data`, never a synthetic percentage.

Current Codex JSONL does not expose safe large-task eligibility, explicit task
class or model self-ETA. Therefore the live-log gate remains unsupported until
Reporter observations supply those fields. Run-level fallback remains the main
product path regardless of plan availability.

## Privacy and deployment boundary

Everything stays on `127.0.0.1` and local SQLite. The pilot does not upload,
publish, create accounts, send telemetry, or write back to Agent transcripts.
Hashed aliases are allowed inside SQLite for joins, but aggregate reports and
browser responses omit them. Source file paths are ephemeral process
capabilities and must never be persisted or returned by an API.
