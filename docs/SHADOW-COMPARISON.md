# Shadow comparison protocol v1

Frozen 2026-10-11, before implementing this candidate or inspecting a target cohort's results. This increment validates the comparison pipeline using synthetic, controlled-clock replay. It does not promote a new default or establish real-world accuracy.

## Candidate: `empirical-conditional/1`

Use the **same ordered history array** as the current portable predictor: at most 200 successful, eligible, positive-duration runs of the same profile/class, completed by the prediction timestamp, excluding the current run. Use the exact same active elapsed time and prediction timestamp. Do not issue a second history query for the candidate.

When the primary is numeric, retain history durations strictly greater than elapsed active time and subtract that elapsed time. If at least **three** such residuals remain, return nearest-rank P20/P50/P80 (`sorted[ceil(q × N) - 1]`). P50 is the empirical conditional median under that convention. Otherwise abstain with `insufficient_tail`; do not extrapolate a zero or invent a conservative numeric bound. This is the conservative fallback. The threshold is an engineering choice, not statistical validation. The candidate may be less available and may be less accurate than the current model.

When the primary is cold, paused, stale or has an observation gap, the candidate also abstains with that same state. No predictions are generated after a terminal outcome. All candidate quantiles remain uncalibrated. No extra LLM, network call or daemon is introduced.

## Prospective capture

New nonterminal receipts add `comparisonInputs` and `shadow` inside their already content-hashed `payload_json`. Freeze exact active milliseconds, prediction timestamp, the ordered history-duration array in minutes and its SHA-256 (`JSON.stringify(historyMinutes)` UTF-8), together with candidate version, history/support counts, state and quantiles or null. The primary and median baseline continue to use the same history and existing implementation. Displayed primary values and lifecycle behavior are unchanged; the additional payload changes the content-based receipt ID. Identical new receipts still deduplicate.

History inputs are duration metadata only; they contain no prompts, commands or provider logs. Repeating the bounded array increases storage per receipt; `usage` measures payload/file bytes and `export` preserves the added fields. Existing receipts are never rewritten or supplemented after the fact. Receipts from older versions remain `missing_shadow` for this comparison.

The saved inputs make controlled replay inspectable. Hashes establish consistency, not authenticity: caller-controlled clocks and data can still be synthetic. Collection provenance and trustworthy task boundaries require separate evidence.

## Read-only `compare`

Reuse the frozen prospective v1 population, validity checks and 1/5/10-active-minute landmark selection (one earliest receipt per run in the next 30 seconds). Read runs and receipts once, from one SQLite snapshot. **Do not run a predictor or reconstruct history while comparing.** Do not replace an early missing/abstaining candidate with a later number. Validate the existing receipt hash first, then candidate/input schema, version, time, active clock, history hash/count, support count, primary-state agreement and finite ordered quantiles.

At each landmark show primary availability, candidate availability and exclusions. Candidate states are numeric, abstained, missing or invalid, with separate reasons (including `insufficient_tail`, `missing_shadow` and inherited primary failures). Rates use the same at-risk closed-run denominator as prospective v1, including failed/cancelled runs; pending runs remain separate. Never treat an abstention as zero error.

Accuracy uses the intersection where the selected primary, frozen median baseline and candidate are all numeric and the final successful active duration is trustworthy. All three use **exactly the same run/receipt IDs**. Stratify by profile, task class, primary version, baseline version and candidate version. Report each model's mean/median absolute error and severe-underestimate rate, both quantile models' P80 coverage and P20–P80 mean width, and paired candidate-minus-primary / candidate-minus-baseline MAE differences. Use the same deterministic run bootstrap as prospective v1; singleton intervals are null. Include paired values and input fingerprints for audit. No aggregate crosses landmarks or versions.

The original `evaluate` report's sampling and scoring remain unchanged; `compare` has its own schema/protocol. Since candidate abstention narrows the intersection, a favorable paired error is not automatically favorable overall utility. The report always sets `promotionEligible: false` and records why: no predeclared, untouched holdout or promotion gate has yet been evaluated.

## Validation and subsequent work

Before release, use explicitly synthetic fixtures to check hand-calculated quantiles and paired errors, sparse-tail abstention, same-history/timestamp capture, cohort isolation and the 200-run cap, future-outcome exclusion, old-receipt immutability, missing/corrupt shadows, repeated-refresh selection, failed/cancelled/gap outcomes, and deterministic read-only comparison. Controlled chronological replay must save predictions before finishing their test runs. It is pipeline evidence, not real prospective performance evidence.

Run the full suite, clean-package checks and public Linux/Windows × Node 22/24 CI. Keep the displayed default and the existing simple baseline. Later work must define run-level time splits and freeze promotion thresholds before examining an untouched future holdout; already inspected comparison results cannot become that holdout. Collect real future evidence separately, and retain abstention/coverage/width trade-offs even if MAE improves. No default-model promotion occurs in this increment.
