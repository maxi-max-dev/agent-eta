import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  EVENT_SCHEMA_VERSION,
  assertValidEvent,
  isKnownEventKind,
  validateEvent,
} from "../src/core/contract.js";

const fixtureDirectory = new URL("../fixtures/replays/", import.meta.url);

function canonical(overrides = {}) {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: "evt-1",
    run_id: "run-1",
    provider: "generic",
    native_session_id: "native-1",
    occurred_at: "2026-08-29T00:00:00.000Z",
    observed_at: "2026-08-29T00:00:00.100Z",
    kind: "heartbeat",
    source: { adapter: "test", mode: "simulated_contract", confidence: 1 },
    data: {},
    ...overrides,
  };
}

test("all frozen replay events satisfy the canonical contract", async () => {
  const filenames = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".json"));
  assert.ok(filenames.length >= 6);

  for (const filename of filenames) {
    const fixture = JSON.parse(await readFile(new URL(filename, fixtureDirectory), "utf8"));
    assert.equal(path.basename(filename, ".json"), fixture.id);
    assert.ok(["cold", "experienced-fast"].includes(fixture.historyProfile));
    assert.ok(fixture.events.length > 0);
    for (const event of fixture.events) {
      assert.deepEqual(validateEvent(event), { valid: true, errors: [] }, filename);
    }
    assert.equal(fixture.events[0].kind, "run_started");
    assert.equal(typeof fixture.events[0].data.model_self_eta_minutes, "number");
  }
});

test("required top-level, source and kind-specific fields are reported", () => {
  const missing = canonical({
    event_id: "",
    occurred_at: "not-a-date",
    source: { adapter: "test" },
    kind: "step_started",
  });
  const result = validateEvent(missing);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /event_id/);
  assert.match(result.errors.join("\n"), /occurred_at/);
  assert.match(result.errors.join("\n"), /source\.mode/);
  assert.match(result.errors.join("\n"), /source\.confidence/);
  assert.match(result.errors.join("\n"), /data\.step_id/);
  assert.throws(() => assertValidEvent(missing), /Invalid canonical event/);
});

test("unknown event kinds and fields remain forward compatible", () => {
  const event = canonical({
    kind: "provider_announced_quantum_progress",
    future_top_level_field: { preserved: true },
    data: { future_payload: [1, 2, 3] },
  });
  assert.equal(isKnownEventKind(event.kind), false);
  assert.deepEqual(validateEvent(event), { valid: true, errors: [] });
  assert.equal(assertValidEvent(event), event);
});

test("plan steps have stable class, status and duration validation", () => {
  const event = canonical({
    kind: "plan_declared",
    data: {
      steps: [
        {
          id: "bad",
          label: "Bad step",
          class: "magic",
          status: "almost_done",
          prior_minutes: -1,
        },
      ],
    },
  });
  const result = validateEvent(event);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
});
