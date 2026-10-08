# Phase 4 interval calibration contract

Status: implemented for the local Codex shadow pilot
Date: 2026-08-29

## Objective

Correct systematic P80 undercoverage without changing the ETA-first product,
the P50 forecast, or the run-level-first architecture.

## Training observation

Each completed run contributes at most one observation per forecast mode:

```text
ratio = actual remaining minutes at first forecast / original P80 minutes
```

Only successful positive-duration `live_adapter` runs are eligible. The source
run must have `finished_at < target event time`. A run's later snapshots never
become extra samples. The rolling cohort contains at most 500 recent runs.

## Estimator

- Minimum 20 observations.
- Target coverage: 0.80.
- Empirical rank: `ceil((n + 1) * 0.80)`, capped at `n`.
- Log-space shrinkage toward multiplier 1 with prior strength 20.
- Applied multiplier clamped to `[1, 3]`.
- The multiplier can widen P80 but never narrow it.
- P50 and the lower bound are unchanged.
- Terminal and `needs_input` projections are exempt.

Every persisted forecast records the pre-calibration P80, applied multiplier,
sample count, final P80 and whether calibration was applied. Aggregate state
also records raw and calibrated historical coverage. No run ID, path, prompt,
message, command or code is added to the calibration state.

## Evaluation isolation

Live and weekly reports perform all queries inside one SQLite read transaction.
The watcher may keep committing in WAL mode, but a report observes one coherent
database snapshot.

Time-forward evaluation reconstructs the same 20-run gate, 500-run rolling
window and one-sample-per-run rule. The raw method remains in the report beside
the calibrated method.

## Acceptance evidence

At report snapshot `2026-08-29T07:39:50Z`, 3,155 successful positive-duration
Codex runs were eligible:

- run-level fallback P80 coverage: 72.3% raw → 79.3% calibrated;
- plan-conditioned P80 coverage: 75.9% raw → 81.0% calibrated;
- P50 MAE, median AE and severe-underestimate rate are unchanged by design.

The result accepts the calibrator for continued shadow use. It does not prove a
future or distribution-free 80% guarantee. Weekly persisted-snapshot coverage
remains the drift monitor.

## Explicit non-goals

- no critical path, DAG or future-wait prediction;
- no calibration of P50;
- no task-class inference from content;
- no Reporter or Claude outcome integration claim;
- no accuracy claim for plan-conditioned ETA while its paired confidence
  interval crosses zero.
