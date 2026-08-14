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
    occurredAt: "2026-08-13T12:00:00.000Z",
    eventId: ID,
    identifiers: { tap_id: ID_2 },
  };
  const inputs = [
    { eventType: "fill.assigned", data: { assignment_id: ID } },
    { eventType: "fill.ended", data: { reason: "manual" } },
    { eventType: "pour.completed", data: { volume_ml: 12.5 } },
    { eventType: "keg.low", data: { remaining_percent: 10, threshold_percent: 20 } },
    {
      eventType: "health.transitioned",
      data: { check_id: "low_keg", state: "degraded", severity: "warning" },
    },
    {
      eventType: "integration.status_changed",
      data: { integration_type: "home_assistant", state: "healthy", reason_code: null },
      coalescingKey: "home_assistant",
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
    () => createEventEnvelope({ eventType: "unknown", data: {}, identifiers: { tap_id: ID } }),
    /registered/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        eventType: "fill.assigned",
        eventId: ID,
        occurredAt: "2026-08-13T07:00:00-05:00",
        identifiers: { tap_id: ID_2 },
        data: { assignment_id: ID },
      }),
    /canonical UTC/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        eventType: "pour.completed",
        eventId: ID,
        occurredAt: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { volume_ml: Number.NaN },
      }),
    /finite/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        eventType: "fill.ended",
        eventId: ID,
        occurredAt: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { reason: "manual", extra: true },
      }),
    /unknown|missing/i,
  );
  assert.throws(
    () =>
      createEventEnvelope({
        eventType: "fill.ended",
        eventId: ID,
        occurredAt: "2026-08-13T12:00:00.000Z",
        identifiers: { tap_id: ID_2 },
        data: { reason: "manual" },
        coalescingKey: "not_allowed",
      }),
    /not allowed/i,
  );
});
