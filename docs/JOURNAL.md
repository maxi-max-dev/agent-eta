# Portable journal export and storage

These commands read an existing portable CLI/SDK database. They do not read provider logs, generate predictions, modify records, checkpoint SQLite, compact files or upload anything.

```sh
node bin/agent-eta.js usage --db /absolute/path/runs.sqlite
node bin/agent-eta.js export --db /absolute/path/runs.sqlite
```

`usage` returns one JSON object. `export` streams JSON Lines to stdout; to save it, redirect to a **new local file**, for example `... export --db /absolute/path/runs.sqlite > journal-2026-10-10.jsonl`. Shell redirection controls the destination and can overwrite an existing file. Never use the database or a SQLite sidecar as that destination. Both commands use the same default database/environment variables as the other CLI commands. The `agentwhen` alias remains supported.

## Export contract: `agent-eta.journal/1`

One read transaction fixes the view before any output is emitted. Writes that arrive later are not mixed into that export. Rows stream with backpressure rather than loading the whole journal in memory. A long-running reader can delay SQLite's normal WAL recycling, so finish or cancel exports rather than leaving a consumer paused indefinitely. Cancellation closes the read transaction.

The stream has these record types, in order:

1. `manifest`: schema, journal presence (`present` or `missing_journal`), snapshot counts and provenance limit.
2. `run`: every portable run, including ongoing, failed, cancelled and ineligible runs. `row` contains `insertion_order` (original SQLite rowid), ID, profile, task class, lifecycle state, start/finish/last-observation times, active duration/start and history eligibility.
3. `forecast`: every receipt in insertion order, including abstentions, orphan rows and damaged receipt contents. `row` contains original rowid, ID, run ID, prediction time, active duration, estimate status, model version and **the unchanged `payload_json` string**. It is not reparsed or re-signed. The frozen baseline remains inside that original string.
4. `end`: the same run/forecast counts and SHA-256 digest of **all preceding UTF-8 lines, including each LF newline**, excluding the `end` line itself.

To accept a saved export as complete, require a successful command exit, one final `end` record, matching manifest/end/actual row counts, and the matching digest over the saved bytes. A truncated stream or failed pipe is not a complete export. Modified line endings also change the digest. Do not parse and reserialize lines before checking it.

This is a logical export of the portable schema, not a byte-for-byte SQLite backup: indexes, other tables and extension columns are not exported. Original insertion order is included so the existing evaluator's timestamp tie-breaking can be reproduced. Automated tests reconstruct a fresh test database and require an identical evaluation report, including its source fingerprint. There is no import or deletion command in this release. Keep the original database.

An older portable database without `eta_forecasts` is labeled `missing_journal` with zero forecasts; it is not migrated or backfilled. Missing files and incompatible schemas fail without creating a database. Exporting a damaged receipt preserves evidence of the damage; an export digest does not validate forecast integrity, data authenticity or model accuracy.

If externally modified columns contain BLOBs or nonfinite numbers that JSON cannot faithfully represent, export fails with `EXPORT_UNSUPPORTED_VALUE` and emits no completion marker. It leaves the source unchanged instead of silently coercing those values.

Exports contain local run/profile metadata. They are not anonymized or automatically safe to publish. The exporter itself stores no new prompts or commands and does not send a file anywhere.

## Storage contract: `agent-eta.usage/1`

| Field | Meaning |
| --- | --- |
| `counts.runs`, `counts.forecasts` | All portable rows in one read snapshot, not only the dashboard's latest 50 or scored forecasts. |
| `receipts.payloadBytes` | Sum of stored receipt JSON UTF-8 byte lengths; excludes indexes, row metadata and SQLite page overhead. |
| `receipts.earliestEstimatedAtMs`, `latestEstimatedAtMs` | Stored receipt timestamp range, or null for no receipts. Not evidence that collection is currently running. |
| `sqlite.logicalBytes` | `page_size × page_count`, SQLite's logical database size in this read snapshot. |
| `sqlite.freeListBytes` | `page_size × freelist_count`, wholly free pages already inside the database. Not filesystem free space, and not a promise that files will shrink. |
| `files` | Separately measured file lengths for database, WAL, SHM and rollback journal. Missing sidecars are zero bytes; inaccessible measurements are null. |
| `totalFileBytes` | Sum of measured file lengths, null if any length is unknown. Not filesystem allocation or additional bytes to add to `logicalBytes`. |
| `retention` | `keep_all`, with automatic deletion disabled. |

Filesystem lengths are sampled **before opening the read transaction**, not atomically with concurrent writers. An active WAL can make file lengths differ greatly from SQLite logical size; do not add both together. Sparse files, compression and filesystem allocation can also differ from file length. SQLite readers may participate in shared-memory coordination; read-only means no logical data mutation, not a promise that transient SHM files never change.

## Retention choices

| Choice | Availability | Trade-off |
| --- | --- | --- |
| Keep all original records | Current default | Preserves future reproducibility; storage grows. Use `usage` to measure it. |
| Begin a new database for a new collection period | Already possible by explicitly choosing a new `--db` path for future tracking | Keep the old database and a verified export. The new database starts cold with no prior history; all callers must deliberately use the new path. Nothing is moved or deleted automatically. |
| Delete receipts older than an explicit cutoff, e.g. 30 or 90 days | Design option only, **not implemented or enabled** | Would require an agreed cutoff, protection for ongoing runs, verified recoverable archives and preserved sampling denominators before implementation. It can remove evidence and change evaluation populations. |

This release implements measurement and export only. It sets no automatic expiry, pruning or compaction schedule. Selecting a future retention policy is separate from showing how much space is used. The [prospective protocol](PROSPECTIVE-EVALUATION.md) and prediction algorithm are unchanged.
