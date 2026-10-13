# Portable onboarding

The portable CLI requires Node.js 22.13+ and terminal access. `doctor` does not install Node, launch agents or servers, probe ports, check write permissions, import provider logs, or start a collection service. Read-only SQLite access may participate in WAL shared-memory coordination; it does not change run rows, forecast rows, database bytes or WAL bytes.

## One store across tools and directories

1. Locate the installed CLI. A separately copied Skill does not include the executable.
2. Choose a stable, non-identifying profile and a task class. Run `doctor --db DATABASE --profile PROFILE --class CLASS` using the intended local path.
3. Keep `database.path` and the CLI path in the returned `commands` arrays. Execute arrays directly with an argument-based tool; if using a shell, quote arguments for that shell. Re-run diagnosis when moving or reinstalling the CLI.
4. Use `commands.start` for an explicitly bounded task spanning tool calls, or `run --db DATABASE --profile PROFILE --class CLASS -- COMMAND ARGUMENTS` for a synchronous process. The wrapper measures the child's lifetime, not downstream remote work or correctness.
5. Reuse the database on every `ping`, `pause`, `resume`, `status` and `finish`. For JavaScript, use `new AgentETA({ filename: DATABASE })`. Before waiting for a person, pause; finish with the actual outcome after checking the work.
6. Execute `commands.serve`, then open the reported loopback URL. A URL in a diagnostic report is not evidence of a running server. Browser refreshes never count as heartbeats.

Selection precedence is explicit `--db`, `AGENT_ETA_TRACKER_DB`, legacy `AGENTWHEN_DB`, existing `.agentwhen/runs.sqlite` in the current directory, then `.agent-eta/runs.sqlite` in the current directory. Relative environment or explicit paths still depend on the working directory; `doctor` resolves and flags them. Diagnosis in a second directory does not search the computer for previous data. A missing store is normal on first use, but can also mean the wrong directory was selected.

## Read the result

| Field or status | Meaning and next step |
| --- | --- |
| `not_initialized` | No store exists at this path. Confirm the path; `start`/`run` creates it. Doctor creates no folders or records. |
| `ready` | Existing tracker schema can be read. This does not certify write access or forecast quality. |
| `blocked` | Unreadable, foreign, corrupt or incomplete store. Choose the correct path or a new file; retain the original data. Exit code is 1. |
| `history.state: cold_start` | Fewer than three matching successful, continuously observed, positive-duration runs have finished by readout. No ETA should be invented. |
| `history.state: experimental` | The history threshold is met. Quantiles remain uncalibrated; an existing paused/stale/gapped/terminal run can still have no number. |
| `history.additionalRunsNeeded` | Distance to the engineering threshold, not a request to manufacture warm-up data. |
| `dashboard.status: not_checked` | Server and port availability have not been tested. |

`ready` and `not_initialized` exit zero because the diagnostic completed. Invalid options exit nonzero. Diagnostic output contains local paths and is not a public evidence export.

## Integration evidence boundary

In v0.9.0, an empty dashboard offers a wrapper template using the server's own database and installed CLI, with POSIX-shell/PowerShell quoting and clipboard feedback. Setup metadata uses the existing local-origin, host, cross-site and GET-only guards; paths are never accepted from URL parameters. A missing/disabled/in-memory setup offers no persistent-store command. Disconnection hides the template. Quoting is for the generated executable, paths and identifiers; replace the trailing `COMMAND` with a correctly quoted real command. `cmd.exe` is not a supported template shell. Keep this local-path display and clipboard content private.

On 2026-10-13, the current Codex task invoked the published v0.8.0 wrapper for the actual required `npm test` of this v0.9.0 change, using Node 22.23.1 on macOS. The child completed successfully in 18.305 seconds, the stored outcome matched, and four real-clock cold-start receipts contained no numeric estimate. A local collection contract was saved before invocation; no private DB or raw host/session logs were published. This is one controlled process-boundary integration case using Codex's terminal tool, not a native vendor hook, independent novice study or real numeric accuracy cohort. The desktop host build was not obtained; an unrelated CLI version is not substituted for it.

Release acceptance exercises a clean package through independent CLI invocations across directories, a synchronous process wrapper, and the JavaScript SDK. It checks the same run IDs/store, cold start, explicit pause/resume/outcomes, child output and exit codes, and the local dashboard HTTP API. Synthetic and short wiring runs are kept in isolated directories/profiles and are not accuracy data.

These are portable invocation patterns plus the one specifically bounded host case above, not three independently tested agent products. No new vendor-native hook, chat-only model, independent novice-user study, or unattended collection service is certified by this release. Historical project acceptance remains separate; this onboarding check does not erase it. Independent future holdout collection and general prediction accuracy remain pending.
