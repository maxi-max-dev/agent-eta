# Run-level time split protocol v1

Frozen 2026-10-11 before implementation or inspection of a target cohort's results. This increment prepares reproducible cohorts; it does not set promotion gates, prove accuracy, or change the default estimator.

## Declare before collecting

`agent-eta cohort-plan --db DB --holdout-start UTC --holdout-end UTC` reads one existing database snapshot and emits a JSON manifest to stdout. The CLI uses the current clock after the snapshot read. Both bounds must be explicit ISO UTC instants; start must be strictly after declaration, and end strictly after start. No database is created or modified. Redirect stdout to a new local file and preserve it before collection. A plan contains run/receipt IDs and fingerprints: keep private plans local.

The manifest records the declaration, a half-open future start window `[start, end)`, all already-known run IDs, and the exact IDs/fingerprint of completed tuning runs and their currently saved receipts. Tuning runs must pass prospective v1 run validation and finish no later than declaration. Pending or invalid existing runs are excluded from both sets. All forecasts/landmarks of a run stay together. A pre-existing run cannot enter the holdout even if its timestamp claims a future start.

The manifest ID is SHA-256 over its documented fields in fixed order (JSON UTF-8); it checks consistency, not authenticity. Preserve the original plan via a dated independent record when making real prospective claims. Caller-controlled clocks, edited databases and a self-rehashed manifest cannot prove an untouched holdout. Do not upload private plans or databases. No real collection is started by this command.

## Read-only cohort comparison

`agent-eta compare --db DB --plan FILE --cohort tuning|holdout` requires both options. It validates the manifest, requires all known run IDs still to exist, and verifies the frozen tuning runs and receipts against their fingerprint before either comparison. Editing/removing a frozen row fails closed. Receipts appended later to a tuning run are ignored, including attempts to fill a previously missing landmark; the fixed tuning receipt list cannot grow. The original `compare` and `evaluate` commands without a plan retain their existing output contracts.

Holdout membership uses only a new run's start timestamp, never its finish time, outcome, prediction availability or error. A run beginning exactly at start is included; one beginning exactly at end is excluded. A qualifying run may finish after end and still belongs to holdout. Pending runs stay pending; do not claim the window is complete because fast runs finished. The report has no implicit current-time cutoff, so identical database and manifest give identical JSON. New final outcomes can legitimately update the holdout report. Existing receipt validation and 1/5/10-minute selection remain unchanged, with no prediction/history recomputation.

Report full-source counts/fingerprint, manifest ID, cohort membership and exclusions, and the selected-cohort comparison. Explicitly count tuning, holdout, pre-existing excluded, outside-window and invalid-start runs, plus orphan receipts. This exposes exclusions rather than silently dropping old/pending/corrupt data. Scope/profile/model versions remain separate under shadow comparison v1. Completed holdout outcomes may train later online predictions as the tracker already does; this is an online sequential evaluation, not a frozen-history model. Do not tune algorithms on holdout observations; inspected holdouts cannot later be called untouched.

## Duration and workflow diagnostics

Additionally compare each profile/task-class/observed-duration stratum, including availability and sparse-history reasons, not just successful numeric pairs. Fixed active-duration bands are `up_to_5m` (<=5 minutes), `5_to_15m` (>5 and <=15), and `over_15m` (>15). Invalid or unfinished runs have `unknown` duration. These are descriptive engineering bins chosen before results; final duration is unavailable at prediction time and must not become a selection feature or a model input. Preserve pending, failed/cancelled, missing, invalid, gap and `insufficient_tail` counts. No cross-landmark or cross-version score is introduced.

Every cohort report keeps `promotionEligible: false`: no promotion thresholds or independently verified untouched real holdout have been evaluated. A future increment must freeze those gates before opening a new real holdout. No numerical improvement claim can be derived from the synthetic fixtures used to test this feature.

## Required checks

Use labeled synthetic fixtures for future-bound validation, run-level disjointness, exact start/end boundaries, a run crossing the split/end, pending/failed/cancelled outcomes, late added tuning receipts, frozen row mutation/removal, manifest tampering, wrong/missing databases, profile/class/duration strata and sparse history. Verify deterministic reports and unchanged database/WAL bytes, original unplanned comparison compatibility, CLI option scoping and legacy alias, clean-package installation, full tests and Linux/Windows × Node 22/24 CI. Publish only verified code and synthetic checks, not private plans or histories.
