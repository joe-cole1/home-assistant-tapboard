import assert from "node:assert/strict";
import test from "node:test";

import {
  createEventEnvelope,
  EVENT_REGISTRY,
  serializeEventEnvelope,
} from "../src/features/events/index.ts";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const ID_2 = "123e4567-e89b-12d3-a456-426614174001";

void test("every registered event type validates into a stable envelope", () => {
  const base = {
    occurred_at: "2026-08-13T12:00:00.000Z",
    event_id: ID,
    identifiers: { tap_id: ID_2 },
  };
  const inputs = [
    { event_type: "fill.assigned", data: { assignment_id: ID } },
    { event_type: "fill.ended", data: { reason: "manual" } },
    { event_type: "pour.completed", data: { volume_ml: 12.5 } },
    { event_type: "keg.low", data: { remaining_percent: 10, threshold_percent: 20 } },
    {
      event_type: "health.transitioned",
      data: { check_id: "low_keg", state: "degraded", severity: "warning" },
    },
    {
      event_type: "integration.status_changed",
      data: { integration_type: "home_assistant", state: "healthy", reason_code: null },
      coalescing_key: "home_assistant",
      identifiers: {},
    },
  ] as const;
  for (const input of inputs) {
    const envelope = createEventEnvelope({ ...base, ...input });
    assert.equal(envelope.schema_version, 1);
    assert.equal(serializeEventEnvelope(envelope), serializeEventEnvelope(envelope));
  }
  assert.equal(EVENT_REGISTRY["integration.status_changed"].supersedable, true);
  assert.equal(EVENT_REGISTRY["fill.assigned"].supersedable, false);
});

void test("event validation rejects malformed identities, times, fields, and bounds", () => {
  assert.throws(
    () => createEventEnvelope({ event_type: "unknown", data: {}, identifiers: { tap_id: ID } }),
    /registered/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        event_type: "fill.assigned",
        event_id: ID,
        occurred_at: "2026-08-13T07:00:00-05:00",
        identifiers: { tap_id: ID_2 },
        data: { assignment_id: ID },
      }),
    /canonical UTC/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        event_type: "pour.completed",
        event_id: ID,
        occurred_at: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { volume_ml: Number.NaN },
      }),
    /finite/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        event_type: "fill.ended",
        event_id: ID,
        occurred_at: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { reason: "manual", extra: true },
      }),
    /unknown|missing/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        event_type: "fill.ended",
        event_id: ID,
        occurred_at: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { reason: "manual" },
        coalescing_key: "not_allowed",
      }),
    /not allowed/i,
  );
  // The builder accepts only the snake_case envelope spelling.
  assert.throws(
    () =>
      createEventEnvelope({
        eventType: "fill.ended",
        identifiers: { tap_id: ID_2 },
        data: { reason: "manual" },
      } as never),
    /unknown fields/i,
  );
});
