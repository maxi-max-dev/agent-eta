# Candidate review gate v1

Frozen 2026-10-11 before implementation or inspection of a target real holdout. These are conservative **engineering acceptance targets**, not empirically fitted thresholds, a statistical power calculation, or a promise of generalization. Synthetic examples only test the checker. This gate never switches models automatically.

## Freeze a new, scoped plan

`agent-eta gate-plan --db DB --profile NAME --class CLASS --holdout-start UTC --holdout-end UTC` creates a fresh time-split v1 plan and wraps it with the exact scope, policy and model versions: primary `conditional-lognormal/1`, median baseline `cohort-median-minus-elapsed/1`, candidate `empirical-conditional/1`. Both times must still be in the future as required by time-split v1. Existing cohort plans cannot be retrofitted after their outcomes have been inspected. Save the new manifest locally before collecting. A SHA-256 ID checks consistency of the scope, nested plan, versions and fixed thresholds; it does not authenticate them. Keep an independent dated record of the original manifest and the actual collection software/version when making prospective claims.

`agent-eta gate --db DB --plan FILE` reads one snapshot, verifies the frozen tuning data, and selects only new holdout runs of the declared profile/class. Other workflows are counted as out of scope. No forecasts are generated, no database is changed, and no external service is called. Model labels are checked; the tool cannot independently prove that a collector used the declared implementation or that runs were real/independent.

## Do not open an incomplete holdout

Use the actual current clock at readout. Before the end of the declared start window, return `awaiting_window` without accuracy metrics. After the window ends, any unfinished in-scope run returns `awaiting_outcomes`, also without metrics. A run that starts within the window and finishes later remains included. Invalid runs or in-scope outcome/receipt timestamps later than readout return `invalid_evidence`. Never quietly drop those rows. These guards prevent the command from favoring early-finishing runs; callers can still inspect data elsewhere, which requires disclosure and a new future holdout after tuning.

## Numeric targets, all required

Use shadow comparison v1's exact paired samples and its fixed 1/5/10 active-minute landmarks. Do not pool landmarks or model versions. At **each** landmark, require at least 30 three-way paired successful runs. Also require at least 10 paired runs whose final active duration is strictly over 15 minutes, at each landmark, for long-run regression checks. Thirty and ten are minimum engineering screening counts, not evidence of adequate statistical power; independent collection, workflow diversity and uncertainty still need review.

| Check | Overall scope, at each landmark | Long-run subset (>15 active minutes), at each landmark | Why |
|---|---|---|---|
| Mean absolute error | Candidate <=90% of both primary and median baseline | Candidate no worse than either | Demand a material benefit, with no long-run regression |
| Median absolute error | No worse than either comparator | No worse than either | Do not improve the mean by sacrificing the typical run |
| Severe underestimate count | Candidate <=80% of primary count and no worse than baseline; if primary count is zero candidate must also be zero | No worse than either | Target substantial underestimation; zero has no invented relative gain |
| Paired MAE bootstrap upper bound | Strictly below zero versus each comparator | Diagnostic only | Require directional support; this remains descriptive, not a multiplicity-adjusted significance claim |
| Candidate P80 coverage | >=0.80, and at most 0.02 below primary | Same | Guard against narrower but unreliable intervals |
| Mean P20–P80 width | <=1.25 times primary width | Same | Prevent a wider interval from buying apparent coverage without limit |
| Candidate numeric rate | >=0.80 and no more than 0.05 below primary | Same | Prevent abstention from concealing hard runs |
| Missing/invalid receipt rates | Zero, for primary and candidate | Same | Incomplete or corrupt capture cannot support a favorable decision |

Availability retains failed/cancelled closed runs in its denominator, as in prospective v1; accuracy retains only valid successful pairs. All selected primary/candidate labels and all scored baseline labels must match the frozen versions. No valid paired group from another version is silently discarded. Duration grouping is retrospective diagnosis, never a prediction input. Ratios and errors use the comparison report's six-decimal values; boundary comparisons use those published values consistently.

## Meaning of the result

Return a check-by-check report with observed values and limits. A missing denominator or metric is `not_evaluable`, never a zero or a pass. Insufficient paired counts yield `insufficient_evidence`; sufficient data with any missed target yields `targets_not_met`; only all numeric targets met yields `numeric_targets_met_pending_review`. Version mismatch is `invalid_evidence`.

Every result has `promotionEligible: false`, `defaultModelChanged: false`, and requires independent provenance/untouched-holdout review. Even the favorable numeric status does not establish real accuracy, justify generalizing to other workflows, or authorize automatic promotion. CLI exit zero means a diagnostic report was produced, not that its targets passed. Invalid inputs, altered manifests and frozen-source mismatch exit nonzero. Readout includes its actual assessment time; fixed-clock assessments of unchanged inputs are deterministic.

## Required checks

Use synthetic controlled clocks to test future-only plan creation, scope/version/threshold tampering, window/pending guards without numeric leakage, long runs crossing the end, all numeric boundaries including zero primary error/width/severe count, sparse history and missing/corrupt capture, insufficient long-run pairs, version mismatch, wrong scope, future/invalid records, deterministic fixed-clock output, read-only database/WAL, missing-file behavior and legacy CLI compatibility. Reuse time-split invariants. Run the full suite, clean/public package checks and Linux/Windows × Node 22/24 CI. Do not start a real holdout or claim improvement from these fixtures.
