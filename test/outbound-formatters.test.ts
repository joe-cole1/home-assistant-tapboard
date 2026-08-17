import assert from "node:assert/strict";
import test from "node:test";

import { serializeEventEnvelope } from "../src/features/events/envelope.ts";
import type { EventEnvelope } from "../src/features/events/types.ts";
import {
  formatDiscordEvent,
  formatStandardEvent,
} from "../src/features/outbound/transports/formatters.ts";

const IDS = {
  event_id: "33333333-3333-4333-8333-333333333333",
  tap_id: "11111111-1111-4111-8111-111111111111",
  fill_id: "22222222-2222-4222-8222-222222222222",
};

function envelope(
  event_type: EventEnvelope["event_type"],
  data: EventEnvelope["data"],
): EventEnvelope {
  return {
    schema_version: 1,
    event_id: IDS.event_id,
    event_type,
    occurred_at: "2026-08-17T12:00:00.000Z",
    identifiers: { tap_id: IDS.tap_id, fill_id: IDS.fill_id },
    data,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

void test("standard formatter returns the canonical envelope unchanged", () => {
  const event = envelope("pour.completed", { volume_ml: 355 });
  const canonical = serializeEventEnvelope(event);
  assert.equal(formatStandardEvent(canonical), canonical);
  assert.equal(formatStandardEvent(event), canonical);
  assert.equal(parseObject(canonical).event_id, IDS.event_id);
});

void test("Discord formatter uses only the injected public context and Mystery title", () => {
  const event = envelope("fill.assigned", {
    assignment_id: "44444444-4444-4444-8444-444444444444",
  });
  const output = formatDiscordEvent(event, () => ({ tapNumber: 7, title: "Mystery Tap" }));
  const body = parseObject(output);
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content, "Fill assigned: A fill was assigned.");
  assert.deepEqual(body.embeds, [
    { description: "Mystery Tap · Tap 7\nA fill was assigned.", title: "Fill assigned" },
  ]);
  assert.equal(output.includes(IDS.tap_id), false);
  assert.equal(output.includes("assignment_id"), false);
});

void test("all registered event types produce bounded valid Discord JSON", () => {
  const events: readonly EventEnvelope[] = [
    envelope("fill.assigned", { assignment_id: "44444444-4444-4444-8444-444444444444" }),
    envelope("fill.ended", { reason: "manual" }),
    envelope("pour.completed", { volume_ml: 355 }),
    envelope("keg.low", { remaining_percent: 8, threshold_percent: 10 }),
    envelope("health.transitioned", {
      check_id: "low_keg",
      state: "degraded",
      severity: "warning",
    }),
    envelope("integration.status_changed", {
      integration_type: "ha",
      state: "degraded",
      reason_code: "timeout",
    }),
  ];
  for (const event of events) {
    const output = formatDiscordEvent(event);
    const body = parseObject(output);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(typeof body.content, "string");
    assert.ok(Buffer.byteLength(output, "utf8") <= 4_096);
    assert.equal(output.includes(IDS.event_id), false);
    assert.equal(output.includes(IDS.tap_id), false);
    assert.equal(output.includes("Secret"), false);
  }
});

void test("formatter falls back generically when public resolver fails", () => {
  const event = envelope("fill.ended", { reason: "other" });
  const output = formatDiscordEvent(event, () => {
    throw new Error("admin projection must not cross the boundary");
  });
  assert.equal(parseObject(output).content, "Fill ended: Reason: other");
});

void test("Discord retries use current public-safe presentation without changing the envelope", () => {
  const privateAdminTitle = "SENTINEL PRIVATE BEVERAGE";
  const event = envelope("pour.completed", { volume_ml: 473 });
  const canonical = formatStandardEvent(event);
  let publicTitle = "Mystery Tap";
  const resolver = () => ({ tapNumber: 3, title: publicTitle });

  const hiddenAttempt = formatDiscordEvent(event, resolver);
  assert.match(hiddenAttempt, /Mystery Tap · Tap 3/u);
  assert.doesNotMatch(hiddenAttempt, new RegExp(privateAdminTitle, "u"));

  publicTitle = "House IPA";
  const revealedRetry = formatDiscordEvent(event, resolver);
  assert.match(revealedRetry, /House IPA · Tap 3/u);
  assert.doesNotMatch(revealedRetry, new RegExp(privateAdminTitle, "u"));
  assert.equal(formatStandardEvent(event), canonical);
  assert.equal(parseObject(canonical).event_id, IDS.event_id);
});
