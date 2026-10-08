# Prospective evaluation protocol v1

Frozen on 2026-10-09 before implementing the evaluator or inspecting a target cohort's results. Changes to sampling or scoring require a new protocol version; do not tune this protocol against reported outcomes.

## Source and limits

`agent-eta evaluate --db /absolute/path/runs.sqlite` reads the portable tracker's existing `agentwhen_runs` and `eta_forecasts` tables in one SQLite read transaction. It never calls the estimator, refreshes a status, trains a model, writes a receipt, or imports provider logs. A missing file is an error, not permission to create a database. An older portable database without the receipt table is reported as `missing_journal`, with missing predictions, rather than backfilled. Incompatible tables are an error.

Receipt hashes detect inconsistency, not authenticity: callers control their clocks and database. A saved timestamp alone cannot prove a forecast really preceded an outcome, or distinguish a synthetic run from real use. Reports are descriptive analyses of supplied receipts. Real-world claims require independently documented prospective collection and trustworthy task boundaries. Synthetic fixtures and historical replay never count as real prospective evidence.

## Population and timing

Report all run outcomes and count unfinished runs separately. The landmark availability population consists of **closed runs** (`succeeded`, `failed`, `cancelled`) with valid timestamps and nonnegative active duration no greater than elapsed wall time. Unfinished runs remain `pending`, not assumed failures or successes. Closed-run selection can favor faster-finishing tasks; publish the pending count and collection horizon when describing results. No cross-landmark aggregate is used.

At each active-time landmark **1, 5, 10 minutes**, a closed run is at risk only when final active duration is strictly greater than the landmark. Shorter/equal runs are `notReached`. Pauses use the recorded active clock; wall-clock waiting is not the prediction target. A run with an observation gap stays in availability counts but its success duration cannot be scored.

## One receipt per run per landmark

Choose the earliest saved row whose exact `active_ms` is in **[landmark, landmark + 30 seconds]** and strictly below final active duration. Sort by `estimated_at`, then SQLite insertion order (`rowid`) for ties. A receipt outside this window is not a nearby substitute. Multiple refreshes cannot give one run extra weight. Choose before checking the receipt's state, validity or error: an early abstention or invalid receipt must not be replaced by a later numeric/better forecast.

Validate the chosen row's SHA-256 ID against its original JSON bytes; column/payload run ID, estimate status, model version and timestamp must agree. Require the v0.2 status envelope, matching profile/class/start time, nonterminal state, `finishedAt: null`, finite nonnegative active duration, and payload active minutes rounded as in the tracker. Require start <= observation <= estimate < finish and active duration <= elapsed wall time at estimate. Experimental forecasts require a running, eligible, fresh observation (at most 60 seconds old), at least three history rows, and finite ordered nonnegative P20/P50/P80 values. Abstentions must carry no numeric forecast or baseline. Invalid chosen rows are counted explicitly, never rescored. Orphan receipt rows are counted separately.

Availability uses all at-risk closed runs, including failed/cancelled outcomes. Report selected `experimental`, `cold_start`, `paused`, `stale`, `observation_gap`, invalid receipts and missing receipts separately. `numericRate`, `abstentionRate`, `missingRate`, `invalidRate` all use this denominator; failed/cancelled counts and gap outcomes are also shown. Thus these four rates sum to one when the denominator is positive. Zero-denominator rates are null.

## Paired accuracy only

Score a chosen numeric receipt only if the outcome is successful, final active duration is trustworthy (`history_eligible = 1`), and its frozen baseline is finite and nonnegative with a nonempty version. Expose exclusion reasons, including failed/cancelled outcomes, missing baseline and observation-gap outcomes. Actual remaining minutes = `(final active_ms - receipt active_ms) / 60000`, with no reconstruction of past history or forecasts. Use the exact same rows for model and baseline. Stratify by profile, task class, model version and baseline version; do not silently pool versions or workflows.

Per stratum and landmark report N, model P50 and baseline mean/median absolute error in minutes, severe-underestimate count/rate (`prediction < actual remaining / 2`, strict), model P80 coverage (`actual <= P80`), mean P20–P80 interval width, and paired mean-absolute-error difference (model minus baseline; negative favors model). Also include the selected IDs and paired values so results can be audited. A baseline point estimate has no invented coverage or interval.

## Uncertainty and insufficient evidence

For N >= 2, provide a descriptive 95% percentile bootstrap interval for the mean paired error difference: 2,000 deterministic resamples of runs with replacement, seed derived from the stratum and landmark, nearest-rank 2.5%/97.5% quantiles. Each stratum/landmark contains one row per run, so runs are the resampling unit. There is no receipt-level pooling or cross-landmark independence assumption. For N = 1, return the descriptive errors and null interval; N = 0 returns no accuracy groups. Never turn a small sample or an interval excluding zero into a release/promotion decision. Representativeness, independent runs, censoring, multiple comparisons and trustworthy collection remain unproven. Status is always no scorable pairs, single-run only, or descriptive only—not “validated” or “improved”.

## Reproducibility and retention

Round report metrics to six decimals after calculation. The report contains protocol ID, source-table fingerprint, journal presence and population counts, but no current wall-clock timestamp or absolute database path: unchanged source rows give identical output. New outcomes may legitimately add scored runs; they cannot recalculate the old frozen forecast or baseline. Default output is JSON to stdout; it includes local run/profile metadata and is not automatically uploaded. No deletion or retention policy is introduced here. Full-journal export and disk-usage controls remain a separate increment.

## Required checks

Use explicitly synthetic test fixtures for hand-calculated paired errors; empty/single-run datasets; fixed-window boundaries; repeated polling and timestamp ties; pause/gap/cold-start/failed/cancelled cases; unfinished runs; corrupt and post-outcome receipts; immutable forecasts after future history arrives; legacy/missing/incompatible databases; deterministic output and unchanged database contents. Exercise receipts produced by the real tracker API as an integration contract, while labeling that controlled clock fixture as synthetic. Run the full project test suite, clean-package CLI checks and the public Linux/Windows × Node 22/24 CI before release.
