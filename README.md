# Agent ETA

**How long will your agent take?**

Local, experimental runtime estimates for agents. Track a bounded run and see remaining-time quantiles based on your own comparable completed runs. No account, API key, telemetry, or runtime dependencies.

[中文说明](README.zh-CN.md) · [Agent skill](skills/agent-eta/SKILL.md) · [Roadmap](ROADMAP.md)

> **v0.9.0 is experimental.** Runtime visibility and prospective evaluation work; general prediction accuracy is not established. This tool does not validate the quality of an agent's work.

## Run in two minutes

Requires **Node.js 22.13+**. Node 22 may print an experimental SQLite warning. No `npm install` required.

```sh
git clone https://github.com/maxi-max-dev/agent-eta.git
cd agent-eta
node bin/agent-eta.js --help
node bin/agent-eta.js doctor --profile wiring-test --class coding
node bin/agent-eta.js run --profile wiring-test --class coding -- node -e "setTimeout(() => console.log('done'), 1500)"
```

That short command checks wiring, not accuracy. Replace everything after `--` with a real synchronous command; use a separate profile for real work. Status JSON is added to stderr; child output passes through and its exit code is preserved. Heartbeats track the child's lifetime, so a launcher that exits before remote work completes is not suitable.

Or use the pinned GitHub package (Git and npm required; first use downloads it):

```sh
npm exec --yes --package=github:maxi-max-dev/agent-eta#v0.9.0 -- agent-eta --help
```

There is no npm registry release. The package is marked private to prevent accidental registry publication; GitHub distribution is supported.

## Check the connection before starting

`doctor` explains which database is selected and why a workflow has no number, without creating a database, recording forecasts or sending heartbeats:

```sh
node bin/agent-eta.js doctor --db /absolute/path/runs.sqlite --profile my-agent --class coding
```

Retain `database.path` across tool calls. `history` reports matching eligible successes (up to the same 200 used by the predictor) and how many remain before the three-run cold-start threshold. Other profiles, failed/cancelled runs and observation gaps do not warm up this workflow. No test runs are needed to make it look ready.

`not_initialized` is normal for a new path; the first `start`/`run` creates it. `ready` means its schema is readable, not that writes, accuracy or native agent integration are verified. `blocked` exits with code 1 and does not repair the file. The `commands` values are argument arrays for `spawn`/`subprocess`; execute them as arrays, or quote each argument for your shell. They fix both CLI and database paths, including paths with spaces. `dashboard.status` stays `not_checked`; run `commands.serve` before opening its URL. Keep the local report private because it contains filesystem paths. See [onboarding and verified integration boundaries](docs/ONBOARDING.md).

## Give it to an agent

Any agent **with terminal access and Node.js** can use the CLI. This is a portable tool contract, not a claim that every vendor's native hooks have been tested. A chat-only model needs its host to expose the operations.

Copy this prompt after cloning:

> Read `skills/agent-eta/SKILL.md` in this checkout and use Agent ETA to track a bounded task. Use the CLI by its absolute path and one stable absolute database path. Keep actual observation time separate from estimate refresh time. Report cold start, stale observation, or pause honestly. Never invent a number or use the ETA as proof of task completion.

For tasks spanning multiple tool calls:

```sh
node bin/agent-eta.js start --profile my-agent --class research
# Save the runId from JSON; replace RUN_ID below with it.
node bin/agent-eta.js ping RUN_ID
node bin/agent-eta.js status RUN_ID
node bin/agent-eta.js pause RUN_ID
node bin/agent-eta.js resume RUN_ID
node bin/agent-eta.js finish RUN_ID --outcome succeeded
```

Send `ping` approximately every 30 seconds while active. `watch RUN_ID --interval 5` streams fresh estimates without manufacturing observations. `list` shows up to 50 recent runs. Use `--outcome failed` or `cancelled` when appropriate. A terminal run cannot be reopened.

The database defaults to `.agent-eta/runs.sqlite` in the current directory. When changing directories, pass **the same `--db /absolute/path/runs.sqlite` on every call**, or set `AGENT_ETA_TRACKER_DB`. Profiles separate agents/workflows; classes are `coding`, `research`, `review`, `writing`, `other`.

## JavaScript SDK

Use a path import from a clone, or `import { AgentETA } from 'agent-eta'` when installed as a GitHub package:

```js
import { AgentETA } from './src/generic/tracker.js';

const tracker = new AgentETA({ filename: './.agent-eta/runs.sqlite' });
const { runId } = tracker.start({ profile: 'my-agent', taskClass: 'coding' });
// While doing real work: tracker.ping(runId).
// Waiting for a human: tracker.pause(runId), then tracker.resume(runId).
console.log(tracker.status(runId));
tracker.finish(runId, 'succeeded'); // Only after the operation actually finishes.
tracker.close();
```

See [the runnable SDK wiring example](examples/sdk.mjs).

## Understand the estimate

| State | Behavior |
| --- | --- |
| `cold_start` | Fewer than 3 valid successful same-profile/class runs: no numeric ETA. |
| `experimental` | P20/P50/P80 remaining **active minutes**, from a conditional duration model and up to 200 recent matching runs. |
| `paused` | No countdown; paused time is excluded from active duration. |
| `stale` | No heartbeat for over 60 seconds: numeric ETA withheld. |
| `observation_gap` | Heartbeat resumed after a gap, but active duration is uncertain: numbers stay withheld for this run. |
| `terminal` | Explicit succeeded/failed/cancelled outcome; no further prediction. |

`observedAt` changes only on lifecycle reports; `estimatedAt` changes when an estimate is read. Reading a status does not prove progress. Observation gaps over 60 seconds exclude that run from training history and further numeric predictions, even if reporting resumes. Failed and cancelled runs also do not train the successful-duration model.

Three runs are an engineering threshold, **not statistical validation**. Quantiles have `calibrated: false`; P80 is not a guaranteed 80% success rate. Predictions may increase as a run outlives shorter examples. Long tasks may be badly underestimated. Changed workflows or poorly chosen cohorts can invalidate comparisons. Active minutes exclude future human waiting and do not guarantee a wall-clock arrival time.

## Visual demo and experimental Codex observer

```sh
npm start
```

Open **http://127.0.0.1:4318**. The homepage shows portable CLI/SDK runs from the same database, refreshing every 5 seconds. It never sends heartbeats on behalf of the agent. Use the “演示 / Codex 观察” link for the synthetic replay and optional Codex observer. Default startup does not read provider logs.

With no runs yet, the page shows the server's actual database path and a copyable wrapper template using absolute executable/CLI/database paths. Select macOS/Linux or PowerShell, copy, and replace the trailing `COMMAND` with real work and its arguments. The template stays local, works from another directory, and disappears when a run is selected or the connection is lost. Copying does not execute anything or create training runs. Windows Command Prompt is not supported by this template; use PowerShell or the CLI argument-array interface.

To select a database from any working directory:

```sh
node bin/agent-eta.js serve --db /absolute/path/runs.sqlite --port 4318
```

Use that same database for `start` / `run`. Empty, cold, paused, stale, interrupted-observation and terminal states are explicit. A lost dashboard connection removes the cached estimate.

To explicitly enable the local Codex observer, stop the demo, run `npm run start:live`, and select the live tab. It reads structured local Codex logs; compatibility depends on their format. Claude log parsing is diagnostic only. The portable homepage and the legacy Codex/plan view share one entry point while retaining separate data contracts. Task/project scopes do not claim reliable numeric accuracy.

## Privacy and scope

The portable CLI/SDK stores generated IDs, profile/class, lifecycle state and times/durations. It does not read prompts, inspect provider logs, persist child commands/output, upload data, or call an LLM. Wrapped commands retain their own behavior and may use the network. Use non-sensitive profiles.

The optional dashboard binds to `127.0.0.1`. Its database defaults to `data/agent-eta-demo.sqlite`; configure `AGENT_ETA_DB` and `AGENT_ETA_PORT` as needed. `AGENT_ETA_WATCH=0` disables log observation; `AGENT_ETA_WEEKLY_EVAL=0` disables weekly evaluation. No background service is installed.

The repository contains synthetic fixtures, not the author's private sessions, databases or screenshots. Keep those out of issues and pull requests. Local data directories and generated reports are git-ignored and excluded from the package.

## Forecast receipts and compatibility

Each displayed nonterminal estimate (including an abstention) is saved to the local `eta_forecasts` table with a content-based ID, the exact prediction time, active duration, model version, and a frozen median-duration baseline computed from the history available then. Identical receipts deduplicate; later outcomes do not rewrite them. Polling records estimates but never changes `observedAt`. `forecastId` identifies the receipt. These records enable prospective evaluation; they do not yet establish accuracy. Journaling grows with usage; use the read-only `usage` and `export` commands below. Automatic retention is not enabled.

The public name and command are now **Agent ETA** / `agent-eta`. The v0.1.0 `agentwhen` command, `AgentWhen` SDK export, `AGENTWHEN_DB` variable, database tables, run IDs and `agentwhen.status/1` envelope remain compatible. If `.agentwhen/runs.sqlite` already exists in the current directory, it is reused unless an explicit database is selected. No user data is renamed or deleted. The old GitHub URL redirects; historical v0.1.0 assets keep their original names.

## Evaluate saved predictions

After collecting runs through the CLI or SDK, evaluate their existing receipts locally:

```sh
node bin/agent-eta.js evaluate --db /absolute/path/runs.sqlite
# Optionally redirect stdout to a local JSON file for comparison.
```

This command opens an existing database read-only and outputs deterministic JSON. It does not generate new predictions. At 1, 5 and 10 active minutes, it selects the first receipt in the next 30 seconds, at most one per run per landmark. Early abstentions cannot be replaced by later numeric forecasts. It compares the model with its frozen baseline on exactly the same successful, continuously observed runs, separately by profile, class and model/baseline version. Reports include paired errors, severe underestimates, P80 coverage, interval width and a descriptive run bootstrap interval (null for a singleton).

Availability counts include failed/cancelled closed runs, missing receipts, pauses, cold starts and observation gaps. Unfinished runs are shown separately as pending; results on closed runs can favor shorter tasks. Zero scorable pairs produce an explicit `no_scorable_pairs`, not a performance claim. Older databases without receipts report `missing_journal`; no predictions are backfilled.

Read the frozen [prospective evaluation protocol](docs/PROSPECTIVE-EVALUATION.md) for denominators, integrity checks and limits. The report includes local run/profile metadata. Receipt hashes check consistency, not whether a run was real or synthetic; independent collection evidence is still required. This release adds evaluation tooling, **not evidence of improved accuracy**. Full-journal export and disk-usage reporting are available below; automatic deletion remains disabled.

## Compare a shadow candidate

Starting with v0.5.0, new portable receipts also freeze an empirical conditional candidate and the ordered history-duration array used by both models. The displayed ETA still uses the existing model. No extra model service or network request is needed.

```sh
node bin/agent-eta.js compare --db /absolute/path/runs.sqlite
```

This read-only report uses the same fixed landmarks as `evaluate`, and compares the current model, frozen median baseline and candidate on exactly the same successful runs. It includes errors, severe underestimates, coverage, interval width, missing records and abstentions. With fewer than three comparable durations still longer than elapsed time, the candidate returns `insufficient_tail` and no number; a smaller scored subset must not hide that loss of availability.

Old receipts without shadow fields remain `missing_shadow`; the command never regenerates old predictions or consults future history. The report always has `promotionEligible: false`: synthetic replay verifies the pipeline, while a predeclared future holdout and real accuracy evidence remain pending. See the frozen [shadow comparison protocol](docs/SHADOW-COMPARISON.md).

New receipts store up to 200 history durations per estimate, adding bounded per-receipt storage. These are local duration metadata, not prompts or commands; `usage` measures the bytes and `export` preserves them. Receipt IDs change with the additional content, while historical receipts remain untouched.

## Freeze tuning runs before a future comparison

Use an existing local database. Replace the two UTC placeholders with a future collection window (start inclusive, end exclusive), and save the plan to a **new** file before collecting:

```sh
node bin/agent-eta.js cohort-plan --db .agent-eta/runs.sqlite --holdout-start "FUTURE_START_UTC" --holdout-end "FUTURE_END_UTC" > .agent-eta/cohort-plan.json
node bin/agent-eta.js compare --db .agent-eta/runs.sqlite --plan .agent-eta/cohort-plan.json --cohort tuning
# After collecting new runs in that window:
node bin/agent-eta.js compare --db .agent-eta/runs.sqlite --plan .agent-eta/cohort-plan.json --cohort holdout
```

Use ISO UTC values such as `2026-10-12T00:00:00Z`, choosing dates still in the future when you run the command. Check the command succeeds before using the plan. The manifest freezes completed tuning runs and their saved receipt IDs. Later-added tuning predictions are ignored, edited/deleted frozen rows cause an error, and pre-existing runs cannot enter holdout. New run **start times**, not finish times or prediction quality, determine holdout membership; unfinished runs remain visible even after the collection window ends.

Reports include errors and availability by profile/class and fixed final-active-duration bands (<=5, >5–15, >15 minutes; unfinished/invalid duration is unknown). Duration bands are retrospective diagnostics, never prediction inputs. The original unplanned `compare` output is unchanged. No promotion gate is applied and the default model stays the same. A manifest is not proof of real use or an untouched holdout; do not tune on holdout reports, and keep plans/reports private. See the frozen [time-split protocol](docs/TIME-SPLIT.md).

## Declare review targets before looking at new results

To review the current empirical candidate, create a **fresh** gate plan before collection. Choose the exact workflow and future UTC bounds; replace the placeholders and save to a new local file:

```sh
node bin/agent-eta.js gate-plan --db .agent-eta/runs.sqlite --profile my-agent --class coding --holdout-start "FUTURE_START_UTC" --holdout-end "FUTURE_END_UTC" > .agent-eta/gate-plan.json
node bin/agent-eta.js gate --db .agent-eta/runs.sqlite --plan .agent-eta/gate-plan.json
```

The plan freezes scope, model versions and the [review targets](docs/PROMOTION-GATE.md). Before the window closes, or while an in-scope task is unfinished, `gate` withholds accuracy metrics. It then checks every 1/5/10-minute landmark against the paired primary and median baseline: at least 30 pairs, at least 10 long-run pairs, 10% lower mean error, fewer severe underestimates, coverage/width limits and availability limits. These are engineering screening targets, not a power calculation. See the protocol for exact thresholds and boundaries.

Outputs distinguish `awaiting_window`, `awaiting_outcomes`, `invalid_evidence`, `insufficient_evidence`, `targets_not_met` and `numeric_targets_met_pending_review`. Even the last status retains `promotionEligible: false`: independent real/untouched collection review is still required. Exit zero means a report was produced, not a pass. There is no model switch. Do not tune on an inspected holdout or reuse it as untouched; start a new future plan. Commands are local and read-only; save manifests/reports privately and record actual collector versions separately.

## Export records and check storage

```sh
node bin/agent-eta.js usage --db /absolute/path/runs.sqlite
node bin/agent-eta.js export --db /absolute/path/runs.sqlite
```

`usage` reports record counts, UTF-8 receipt payload bytes, SQLite logical/free pages, and database/WAL/SHM file lengths separately. File lengths are sampled separately from the SQL snapshot and may change while a writer is active; internal free pages do not mean the file has shrunk.

`export` streams a single snapshot as JSONL, preserving every portable run and receipt, original prediction JSON, frozen baseline and insertion order. It ends with counts and a SHA-256 completion marker. Redirect stdout to a new local file if needed; an interrupted stream without a matching completion marker is incomplete. Both commands are read-only, create no missing database, and upload nothing. Exports contain local metadata and are not anonymized. The original records remain in place.

See [the journal contract and retention choices](docs/JOURNAL.md). Default retention keeps everything. No automatic expiry or pruning is enabled, and the prediction algorithm is unchanged.

## Development and evidence

```sh
npm test
npm run evaluate
```

Tests cover lifecycle, privacy, stale observation, cohorts, process behavior, prospective evaluation, and the existing estimator/dashboard. `npm run evaluate` is the older synthetic replay; `agent-eta evaluate --db ...` reads portable saved receipts under the prospective protocol. Synthetic tests prove neither real-world accuracy nor adoption. This project originated in the Agent ETA prototype; internal contract `agenteta.event/1` is retained for compatibility. Technical contracts are in [docs/](docs/).

Next: collect predictions prospectively, compare simple baselines on the same held-out cases, and measure severe underestimation and abstention alongside average error. See [Contributing](CONTRIBUTING.md) and the [roadmap](ROADMAP.md).

## License

[MIT](LICENSE).
