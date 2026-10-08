# Phase 5 Reporter Sidecar Contract

Status: implemented for the local shadow pilot
Date: 2026-08-29

## Objective

Turn the previously static Reporter schema into a real, local ingestion boundary while preserving the Demo's privacy and evidence rules. This phase does not claim an official Codex or Claude hook. A future provider wrapper remains responsible for mapping its active task to the canonical hashed `run_id` already used by the lifecycle adapter.

## Exact report

The only accepted schema is `agenteta.reporter/1` with these exact fields:

- `schema_version`;
- `provider`;
- `run_id`;
- `reported_at`;
- `task_class`;
- `eligible_large_task`;
- `model_self_eta_minutes`;
- `plan_present`;
- `plan_step_count`;
- `plan_adherence`.

Optional measurements use explicit `null`; missing, extra, free-text, path, native-ID, prompt, message, code or command fields fail closed. `task_class` and `plan_adherence` are fixed enums. The contract never infers task size, plan presence or adherence from transcript text.

## Transport and trust boundary

- `POST /api/reporter` listens only on the existing loopback server.
- The bundled client accepts only `127.0.0.1`, `localhost` or `::1` HTTP targets.
- The server requires `application/json` and rejects every request carrying an `Origin` header, preventing a normal browser page from driving the local write endpoint.
- Local operating-system processes remain inside the same-user trust boundary; Phase 5 does not add a bearer token or multi-user authorization layer.
- Responses expose only aggregate status and fixed error codes. They never echo a submitted run ID, observation ID or rejected body.

## Persistence and idempotence

`reporter_observations` is separate from `runs`. The key is `(run_id, reported_at)`:

- the same key and body is an idempotent success;
- the same key with different content returns `REPORTER_OBSERVATION_CONFLICT`;
- an observation may arrive before the lifecycle run and remains persisted for later exact matching;
- no observation creates, guesses or aliases a lifecycle run.

This permits asynchronous local wrappers without turning “latest task” into an unsafe routing heuristic.

## Evaluation rules

Weekly coverage joins the latest observation at or before the report cutoff to an existing canonical lifecycle `run_id`. Unmatched observations are reported in aggregate but never enter the lifecycle denominator, numerator, forecast cohort or learning history.

For a matched run:

- an explicit Reporter eligibility label supplies the large-task denominator;
- plan presence is true when either Reporter declares it or structural plan events exist;
- adherence is reported only as the explicit enum distribution (`following`, `replanned`, `departed`), never inferred;
- self-ETA is evaluated only if both its declared time and the sidecar's local receipt time are no later than the run start landmark;
- later self-ETA reports remain audit data and are excluded from the baseline to prevent outcome leakage.

Backfilled reports can change historical weekly cohort labels. Production reporting should therefore freeze signed ingestion cutoffs or version cohorts; the local pilot instead records `generatedAt` and evaluates one coherent SQLite read transaction.

## Demonstrated canary

The frozen command below traverses the real CLI, loopback HTTP endpoint, contract validator and SQLite persistence:

```bash
npm run report -- --file fixtures/reporter/valid-planned.json
curl -fsS http://127.0.0.1:4318/api/reporter/status
```

The main pilot database intentionally contains this unmatched frozen observation. Its aggregate status is one observation and zero attached runs. It proves the sidecar path, not real provider coverage, and therefore leaves the four-week promotion gate `unsupported`.

## Next boundary

The smallest credible next step is one provider-owned wrapper that receives the canonical run alias at task start and posts Reporter observations at stable lifecycle checkpoints. Only after matched observations populate four complete weeks may the 30% plan-coverage gate become supported. Official provider APIs, notification delivery, cloud sync and Claude terminal ingestion remain out of scope.
