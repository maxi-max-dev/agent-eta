# A three-minute portable walkthrough

This walkthrough demonstrates the shipped CLI/SDK lifecycle and saved evaluation pipeline. **Every run, duration and outcome is synthetic and uses a scripted clock.** It finishes in seconds; the displayed minutes are scenario time. It is not a benchmark, a real agent integration, a user study or prediction-accuracy evidence.

From the checkout:

```sh
npm run demo:portable
```

From an installed package or extracted release, run its example by absolute path:

```sh
node /path/to/agent-eta/examples/portable-demo.mjs
```

Node.js 22.13+ is required. The example has no arguments, API keys, network calls, model calls or server. It always creates a new `agent-eta-synthetic-demo-*` directory under the operating system's temporary directory. It cannot select an existing database; `--db` is rejected. Database environment variables and working-directory stores are not used. All runs use `synthetic-demo-only`. Never merge these rows into real history or treat the three scripted histories as real warm-up tasks.

## What to show and say

| Step | Observable behavior | Suggested explanation |
| --- | --- | --- |
| Cold start | `cold_start`, no remaining minutes. | “Without comparable history, the tool says it does not know.” |
| One active minute | `experimental`, three synthetic histories, an experimental P50. | “The demo supplies 4/8/12-minute history. That enables a number, but does not establish calibration.” |
| Pause | Ten scripted minutes pass; active time stays at one minute. | “Waiting for a person is excluded from the active-time target. This is not a wall-clock arrival promise.” |
| Five and ten active minutes | Fresh receipts at both landmarks. | “Predictions are recorded while the scenario is running. The eventual outcome does not replace those receipts.” |
| Terminal | Twelve active minutes, twenty-two wall minutes; no further ETA. | “This outcome was scripted for the demo. In real use, success must follow task acceptance.” |
| Missing observations | `stale` after 61 seconds, then `observation_gap` after a new heartbeat. Both hide the number. | “Refreshing the display does not prove progress. A later heartbeat cannot recover missing observations.” |
| Saved export and reports | File verification succeeds; evaluation and shadow comparison can be rerun from the saved database. | “A complete evidence file is inspectable. It still cannot prove authentic collection or model accuracy.” |

Spend about one minute on cold start and the numeric state, one minute on pause/terminal/gaps, and one minute on the saved reports and limits. Exact numeric estimates can differ between new demos because generated run IDs seed the estimator. There is no fixed numerical result to advertise. The saved reports for a given demo are reproducible from that demo's unchanged database.

## Inspect the artifacts

The final stdout line is a JSON locator containing `directory` and `summary`. That fresh directory retains:

- `README.txt`: the synthetic-data warning.
- `synthetic-demo.json`: scenario, labeled steps, status receipts, export verification and absolute command arrays.
- `synthetic-runs.sqlite`: the six scripted runs and their original receipts. No run is left ongoing.
- `synthetic-journal.jsonl`: the unmodified output of the shipped exporter. Rows retain the synthetic profile.
- `synthetic-evaluation.json` and `synthetic-comparison.json`: labeled wrappers with the ordinary report under `report`.

Use the `commands` argument arrays in `synthetic-demo.json` to rerun `evaluate`, `compare` and `verify-export` from another directory. Pass them directly to an argument-based process tool, or quote each argument correctly for your shell. These are read-only commands. Their ordinary report JSON matches the corresponding saved `report` object; the standalone verification matches `verification`.

At the ten-minute landmark, the demo target has only one surviving historical duration. The empirical conditional candidate therefore abstains with `insufficient_tail`, even though the primary model can still show a number. Inspect the selected run identified by `scenario.targetRunId`; the reports also contain the scripted training runs, so their aggregate counts are not solely that one target. This illustrates the candidate's evidence threshold, not that either algorithm is better.

The script retains its new directory for inspection, and never deletes original data. The operating system may eventually clear temporary files. If saving artifacts for a presentation, keep the synthetic labels and source version with them; do not mix them into a real collection or publish unrelated local files. No contest eligibility, registration or submission is performed by this walkthrough.
