# Latest-run list performance

v0.9.1 adds one SQLite index on `agentwhen_runs(started_at)`. The existing query still requests `ORDER BY started_at DESC, rowid DESC LIMIT 50`; SQLite scans the index backwards, including its implicit rowid tie breaker. This avoids scanning and sorting every run to choose the latest 50. It does not change history selection, the estimator, refresh frequency, forecast recording or retention.

## Measurement

Measured on 2026-10-14 (Australia/Brisbane), Node 22.23.1, macOS Darwin 24.6.0, arm64, Apple M4. The baseline is the fixed public v0.9.0 package (commit `55b08a16a856e62c748e8d9e6de4fdf39636d9e1`). Each size uses two identically seeded SQLite files, ten profiles and successful terminal runs. Three adjacent inserts share each start timestamp. No provider logs or private records are used.

After five warm-up pairs, the script measures 31 pairs, alternating which implementation runs first. The complete `list()` measurement includes selecting 50 rows and projecting their statuses, including existing history lookups. The selection-only measurement excludes projection. Timings are diagnostic observations, not CI speed thresholds or guarantees across machines.

| Synthetic runs | Complete list median, v0.9.0 → v0.9.1 | Complete list p95, v0.9.0 → v0.9.1 | Selection-only median, v0.9.0 → v0.9.1 |
| ---: | ---: | ---: | ---: |
| 1,000 | 2.75 → 2.45 ms | 3.62 → 2.64 ms | 0.304 → 0.044 ms |
| 10,000 | 6.81 → 4.05 ms | 7.94 → 4.62 ms | 2.671 → 0.048 ms |
| 100,000 | 28.52 → 12.13 ms | 29.35 → 12.75 ms | 25.803 → 0.103 ms |

At 100,000 rows, complete-list median time fell by about 57% in this run. A prior exploratory single-database probe measured different absolute times; the table uses the full paired script, not the best observed result. The query plan changes from a table scan plus temporary sorting tree to a scan using `agentwhen_started`, with no temporary sort.

[Recorded environment, raw samples and query plans](benchmarks/list-v0.9.1.json).

## Cost and compatibility

On an existing 100,000-row synthetic database, opening the tracker and building the index took 18.42 ms once, compared with 0.36 ms for the old constructor opening its baseline file. These are single observations, not distributions. SQLite logical size increased from 16,031,744 to 17,514,496 bytes (1,482,752 extra bytes, about 1.41 MiB). New inserts also maintain an index entry; insert throughput is not measured here. Larger databases and other storage devices may take longer on their first writable open.

The benchmark checks identical displayed statuses and unchanged run/forecast rows across the upgrade and refreshes. Regression tests cover nonchronological insertion, equal timestamps, the 50-run cutoff, repeated opens, original receipt JSON, numeric/cold/paused/stale/gap states, and refreshes that do not send heartbeats. Existing read-only diagnostics and exports do not create the index. No rows are deleted, rewritten or backfilled by this change.

## Reproduce

From a v0.9.1 checkout or unpacked package, with Node 22.13+, install the fixed baseline in a **new local directory** and use a fresh destination for each measurement:

```sh
npm install --prefix ./baseline-v090 --ignore-scripts --no-audit --no-fund github:maxi-max-dev/agent-eta#v0.9.0
node --no-warnings scripts/benchmark-list.js ./baseline-v090/node_modules/agent-eta/src/generic/tracker.js ./list-benchmark-01
```

The script refuses an existing destination, creates only synthetic databases, preserves them, and writes all 31 samples, query plans, environment and compatibility checks to `report.json`. It does not open an existing tracking database or upload anything. Keep the baseline separate from the current package.

This measures terminal-run database/list cost, not active numerical forecast computation, long-running journal growth, HTTP/browser latency, real agent throughput or prediction accuracy. Independent future prediction evidence remains pending.
