---
name: agent-eta
description: Track the elapsed time and experimental remaining runtime of a bounded agent run using the local Agent ETA CLI. Use when the user asks for runtime visibility or an ETA. Requires terminal access and Node.js; does not validate the quality or completion of the underlying work.
---

Use the repository's `bin/agent-eta.js` with Node.js 22.13+ (or an already installed `agent-eta` command). Locate the checkout first. If this skill was copied separately, do not assume the CLI came with it: ask for the checkout location or install the public repository only within the user's authorized setup scope.

Choose a stable lowercase `--profile` identifier for this agent/workflow and a `--class` from `coding`, `research`, `review`, `writing`, `other`. Use a single absolute `--db` path across calls and working directories. Do not put user identities, task text or secrets into metadata. Read `--help` when needed.

For one synchronous command, use:

```sh
node /path/to/agent-eta/bin/agent-eta.js run --db /path/to/local/runs.sqlite --profile my-agent --class coding -- COMMAND ARGUMENTS
```

The wrapper sends status JSON to stderr, passes child output through, preserves its exit code and records heartbeats while the child exists. It measures that child process only. A launcher that returns before remote work finishes is not a valid task boundary. A successful exit is not proof of correct results.

For work spread across tools:

1. `start --db DATABASE --profile PROFILE --class CLASS`; retain the returned `runId`.
2. Report `ping RUN_ID --db DATABASE` while actively working, ideally every 30 seconds. Do not invent heartbeats while the agent is unavailable; gaps over 60 seconds make the estimate stale and exclude that run from training history. If a tool blocks heartbeat reporting, disclose that limitation or use the synchronous wrapper for that tool.
3. `pause RUN_ID --db DATABASE` before waiting for human input; `resume` only once work resumes.
4. Read `status RUN_ID --db DATABASE` or `watch` to show results. Reading does not constitute progress or a heartbeat.
5. After checking the actual task outcome, `finish RUN_ID --db DATABASE --outcome succeeded|failed|cancelled`. Never let an ETA, zero remaining time, or a finished subprocess substitute for acceptance of the user's task.

Explain `cold_start` as insufficient local history, `stale` as an observation gap, and `paused` as no running countdown. Show no invented number when `remainingMinutes` is null. Numeric P20/P50/P80 values are experimental model quantiles, not calibrated promises. Preserve both `observedAt` and `estimatedAt` when reporting freshness. Completing three runs enables numbers; it does not establish accuracy. Do not manufacture training runs or fake progress to make the UI look ready.

Use `serve --db DATABASE` to show the same runs in the local dashboard. Do not mistake browser refreshes or saved forecast receipts for new agent observations. If `observation_gap` appears after heartbeats resume, numeric forecasts remain unavailable for that run. Historical receipts are local only; do not upload the database.
