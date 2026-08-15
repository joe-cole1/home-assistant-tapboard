import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import type { DatabaseExecutor } from "../src/infrastructure/database/connection.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import {
  computeSemanticPayloadDigest,
  isValidClientSampleId,
  normalizeExternalTelemetrySample,
  parseRfc3339Timestamp,
} from "../src/features/telemetry/normalization.ts";
import { InMemoryTelemetryRateLimiter } from "../src/features/telemetry/rate-limiter.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { listActivity } from "../src/features/activity/repository.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import {
  mapExternalTelemetryPayloadToInternal,
  validateExternalTelemetryPayload,
} from "../src/features/telemetry/telemetry-validation.ts";
import type {
  AcceptedSampleEvent,
  AuthorityChangedEvent,
} from "../src/features/telemetry/types.ts";

function createTestHarness(
  options: {
    readonly clock?: () => Date;
    readonly rateLimiter?: InMemoryTelemetryRateLimiter;
    readonly onAuthorityChanged?: (
      database: DatabaseExecutor,
      event: AuthorityChangedEvent,
    ) => unknown;
    readonly onAcceptedSample?: (database: DatabaseExecutor, event: AcceptedSampleEvent) => unknown;
  } = {},
) {
  const database = openDatabase(":memory:");
  const machineKeyService = createMachineKeyService(database, {
    ...(options.clock ? { now: options.clock } : {}),
  });
  const authService = createAuthService(database);
  const kegService = createKegService(database);
  const beverageService = createBeverageService(database);
  const tapService = createTapService(database, {
    ...(options.clock ? { now: options.clock } : {}),
  });
  const fillService = createFillService(database, {
    beverageService,
    assignmentPort: tapService.asFillAssignmentPort(),
    ...(options.clock ? { now: options.clock } : {}),
  });

  const authorityEvents: AuthorityChangedEvent[] = [];
  const acceptedEvents: AcceptedSampleEvent[] = [];

  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    rateLimiter: options.rateLimiter,
    authorityExtensionPort: {
      onAuthorityChanged: (database, e) => {
        authorityEvents.push(e);
        return options.onAuthorityChanged?.(database, e);
      },
    },
    acceptedExtensionPort: {
      onAcceptedSample: (database, e) => {
        acceptedEvents.push(e);
        return options.onAcceptedSample?.(database, e);
      },
    },
    clock: options.clock,
  });

  return {
    database,
    authService,
    kegService,
    beverageService,
    fillService,
    tapService,
    machineKeyService,
    telemetryService,
    authorityEvents,
    acceptedEvents,
  };
}

type TelemetryCountTable =
  | "telemetry_measurements"
  | "telemetry_ingest_receipts"
  | "telemetry_source_tap_status"
  | "activity_log"
  | "outbound_events";

function countRows(database: DatabaseExecutor, table: TelemetryCountTable): number {
  const row = database
    .prepare<[], { readonly count: number }>(`SELECT count(*) AS count FROM ${table}`)
    .get();
  return row?.count ?? 0;
}

function telemetryCounts(database: DatabaseExecutor): Record<TelemetryCountTable, number> {
  return {
    telemetry_measurements: countRows(database, "telemetry_measurements"),
    telemetry_ingest_receipts: countRows(database, "telemetry_ingest_receipts"),
    telemetry_source_tap_status: countRows(database, "telemetry_source_tap_status"),
    activity_log: countRows(database, "activity_log"),
    outbound_events: countRows(database, "outbound_events"),
  };
}

function createAuthorizedTap(
  harness: ReturnType<typeof createTestHarness>,
  tapNumber: number,
  sourceName: string,
  options: { readonly enabled?: boolean } = {},
) {
  const tap = harness.tapService.createTap({
    tapNumber,
    name: `Tap ${tapNumber}`,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
  const { source, initialToken } = harness.telemetryService.createSource({ name: sourceName });
  harness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });
  return { tap, source, initialToken };
}

// ==========================================
// 1. Normalization & Canonical Unit Conversion Tests
// ==========================================

void test("telemetry normalization converts mass units to grams with 6-decimal rounding", () => {
  // 1 kg = 1000 g
  const sampleKg = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    totalWeight: { value: 5.25, unit: "kg" },
  });
  assert.equal(sampleKg.primaryKind, "total_weight");
  assert.equal(sampleKg.totalMassG, 5250);

  // 1 lb = 453.59237 g
  const sampleLb = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    totalWeight: { value: 10, unit: "lb" },
  });
  assert.equal(sampleLb.totalMassG, 4535.9237);

  // 1 oz = 28.349523125 g -> rounds to 6 decimals: 283.495231
  const sampleOz = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    totalWeight: { value: 10, unit: "oz" },
  });
  assert.equal(sampleOz.totalMassG, 283.495231);
});

void test("telemetry normalization converts volume units to milliliters with 6-decimal rounding", () => {
  // 1 L = 1000 ml
  const sampleL = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    remainingVolume: { value: 18.9270589, unit: "l" },
  });
  assert.equal(sampleL.primaryKind, "remaining_volume");
  assert.equal(sampleL.remainingVolumeMl, 18927.0589);

  // 1 us_gal = 3785.411784 ml
  const sampleGal = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    remainingVolume: { value: 5, unit: "us_gal" },
  });
  assert.equal(sampleGal.remainingVolumeMl, 18927.05892);

  // 1 us_fl_oz = 29.5735295625 ml -> rounds to 6 decimals: 295.735296
  const sampleFlOz = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    remainingVolume: { value: 10, unit: "us_fl_oz" },
  });
  assert.equal(sampleFlOz.remainingVolumeMl, 295.735296);
});

void test("telemetry normalization converts temperature units to Celsius and percentage to percent", () => {
  // 32 F = 0 C
  const sampleF = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    fillPercentage: 75.5,
    temperature: { value: 32, unit: "f" },
  });
  assert.equal(sampleF.primaryKind, "fill_percentage");
  assert.equal(sampleF.fillPercentage, 75.5);
  assert.equal(sampleF.temperatureC, 0);

  // 68 F = 20 C
  const sampleF2 = normalizeExternalTelemetrySample({
    measuredAt: "2026-08-14T12:00:00Z",
    fillPercentage: { value: 50, unit: "%" },
    temperature: { value: 68, unit: "f" },
  });
  assert.equal(sampleF2.temperatureC, 20);
});

void test("RFC3339 timestamp parser requires explicit offset and validates precision", () => {
  // Valid UTC 'Z'
  const parsedZ = parseRfc3339Timestamp("2026-08-14T12:30:45.123Z");
  assert.equal(parsedZ.measuredAtEpochMs, Date.parse("2026-08-14T12:30:45.123Z"));

  // Valid positive offset '+02:00'
  const parsedOffset = parseRfc3339Timestamp("2026-08-14T14:30:45+02:00");
  assert.equal(parsedOffset.measuredAtEpochMs, Date.parse("2026-08-14T12:30:45.000Z"));

  // Rejects timestamp without timezone offset
  assert.throws(() => parseRfc3339Timestamp("2026-08-14T12:30:45"), /timezone offset/);

  // Rejects invalid date
  assert.throws(() => parseRfc3339Timestamp("not-a-date"), /RFC3339|timezone/);
});

void test("client sample ID validator accepts valid characters and rejects invalid chars", () => {
  assert.equal(isValidClientSampleId("scale-01_tap.1:A/B"), true);
  assert.equal(isValidClientSampleId(""), false);
  assert.equal(isValidClientSampleId("scale with spaces"), false);
  assert.equal(isValidClientSampleId("scale#1"), false);
});

void test("SHA-256 semantic payload digest is deterministic and invariant to property order", () => {
  const sampleA = normalizeExternalTelemetrySample({
    clientSampleId: "sample-1",
    measuredAt: "2026-08-14T12:00:00.000Z",
    totalWeight: { value: 15000, unit: "g" },
    temperature: { value: 4, unit: "c" },
  });
  const digest1 = computeSemanticPayloadDigest(sampleA, "11111111-1111-4111-8111-111111111111");

  // Same values with different input unit (e.g. 15 kg = 15000 g) produces identical digest
  const sampleB = normalizeExternalTelemetrySample({
    clientSampleId: "sample-1",
    measuredAt: "2026-08-14T12:00:00.000Z",
    totalWeight: { value: 15, unit: "kg" },
    temperature: { value: 39.2, unit: "f" }, // 39.2 F = 4 C
  });
  const digest2 = computeSemanticPayloadDigest(sampleB, "11111111-1111-4111-8111-111111111111");

  assert.equal(digest1, digest2);
  assert.equal(digest1.length, 64);
});

void test("machine telemetry wire validation is strict snake_case with the exact v1 unit vocabulary", () => {
  const base = {
    measured_at: "2026-08-14T12:00:00Z",
    measurement: { kind: "total_weight", value: 1, unit: "g" },
  } as const;
  const validMassUnits = ["g", "kg", "oz", "lb"] as const;
  for (const unit of validMassUnits) {
    assert.doesNotThrow(() =>
      validateExternalTelemetryPayload({
        ...base,
        measurement: { kind: "total_weight", value: 1, unit },
      }),
    );
  }
  for (const unit of ["ml", "l", "us_fl_oz", "us_gal"] as const) {
    assert.doesNotThrow(() =>
      validateExternalTelemetryPayload({
        measured_at: base.measured_at,
        measurement: { kind: "remaining_volume", value: 1, unit },
      }),
    );
  }
  for (const unit of ["c", "f"] as const) {
    assert.doesNotThrow(() =>
      validateExternalTelemetryPayload({
        ...base,
        temperature: { value: 4, unit },
      }),
    );
  }
  assert.doesNotThrow(() =>
    validateExternalTelemetryPayload({
      measured_at: base.measured_at,
      measurement: { kind: "fill_percentage", value: 50, unit: "percent" },
    }),
  );

  assert.throws(
    () =>
      validateExternalTelemetryPayload({
        measuredAt: base.measured_at,
        measurement: base.measurement,
      }),
    /unknown key|invalid value/i,
  );
  assert.throws(
    () =>
      validateExternalTelemetryPayload({
        ...base,
        measurement: { ...base.measurement, extra: true },
      }),
    /unknown key|invalid value/i,
  );
  assert.throws(
    () =>
      validateExternalTelemetryPayload({
        ...base,
        measurement: { kind: "fill_percentage", value: 50, unit: "%" },
      }),
    /exactly 'percent'|invalid value/i,
  );
  assert.throws(
    () =>
      validateExternalTelemetryPayload({
        ...base,
        temperature: { value: 4, unit: "F" },
      }),
    /one of 'c', 'f'|invalid value/i,
  );

  const canonicalG = validateExternalTelemetryPayload({
    client_sample_id: "wire-equivalent",
    measured_at: "2026-08-14T12:00:00Z",
    measurement: { kind: "total_weight", value: 15_000, unit: "g" },
    temperature: { value: 4, unit: "c" },
  });
  const canonicalKg = validateExternalTelemetryPayload({
    client_sample_id: "wire-equivalent",
    measured_at: "2026-08-14T14:00:00+02:00",
    measurement: { kind: "total_weight", value: 15, unit: "kg" },
    temperature: { value: 39.2, unit: "f" },
  });
  const digestG = computeSemanticPayloadDigest(
    normalizeExternalTelemetrySample(canonicalG),
    "11111111-1111-4111-8111-111111111111",
  );
  const digestKg = computeSemanticPayloadDigest(
    normalizeExternalTelemetrySample(canonicalKg),
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    digestG,
    computeSemanticPayloadDigest(
      normalizeExternalTelemetrySample(mapExternalTelemetryPayloadToInternal(canonicalG)),
      "11111111-1111-4111-8111-111111111111",
    ),
  );
  assert.equal(digestG, digestKg);
});

// ==========================================
// 2. Telemetry Source & Credential Management Tests
// ==========================================

void test("telemetry sources can be created, renamed, listed, and key-rotated", () => {
  const harness = createTestHarness();
  try {
    // 1. Create source
    const created = harness.telemetryService.createSource({
      name: "Kegbot Bar 1",
      label: "Initial key for Kegbot Bar 1",
    });

    assert.equal(created.source.name, "Kegbot Bar 1");
    assert.match(created.initialToken, /^tbk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);

    // Duplicate name conflict
    assert.throws(
      () => harness.telemetryService.createSource({ name: "Kegbot Bar 1" }),
      /already exists/,
    );

    // 2. List sources
    const list = harness.telemetryService.listSources();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, "Kegbot Bar 1");
    assert.equal(list[0]?.currentMachineKey.revokedAt, null);

    // 3. Rename source
    const renamed = harness.telemetryService.renameSource(created.source.id, {
      name: "Kegbot Cellar Taproom",
    });
    assert.equal(renamed.name, "Kegbot Cellar Taproom");

    // 4. Rotate key
    const rotated = harness.telemetryService.rotateSourceKey(created.source.id, {
      label: "Rotated key for Cellar Taproom",
    });
    assert.match(rotated.replacementToken, /^tbk_/);
    assert.notEqual(rotated.replacementToken, created.initialToken);
    assert.notEqual(rotated.source.currentMachineKeyId, created.source.currentMachineKeyId);

    // 5. Verify old token is rejected and replacement token is accepted
    const authOld = harness.telemetryService.authenticateSourceToken(created.initialToken);
    assert.equal(authOld, undefined);

    const authNew = harness.telemetryService.authenticateSourceToken(rotated.replacementToken);
    assert.equal(authNew?.id, created.source.id);
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 3. Tap Authority Management & Extension Port Tests
// ==========================================

void test("tap authority can be assigned and cleared, triggering TelemetryAuthorityExtensionPort", () => {
  const harness = createTestHarness();
  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source } = harness.telemetryService.createSource({ name: "ESP32 Source 1" });

    // Initial state: no authority
    assert.equal(harness.telemetryService.getTapAuthority(tap.id), undefined);

    // Assign authority
    const assignResult = harness.telemetryService.setTapAuthority(tap.id, {
      sourceId: source.id,
    });
    assert.equal(assignResult.requiresFreshBaseline, true);
    assert.equal(assignResult.authority?.sourceId, source.id);

    assert.equal(harness.authorityEvents.length, 1);
    assert.equal(harness.authorityEvents[0]?.tapId, tap.id);
    assert.equal(harness.authorityEvents[0]?.previousSourceId, null);
    assert.equal(harness.authorityEvents[0]?.newSourceId, source.id);

    // Re-assign same authority returns requiresFreshBaseline: false
    const idempotentResult = harness.telemetryService.setTapAuthority(tap.id, {
      sourceId: source.id,
    });
    assert.equal(idempotentResult.requiresFreshBaseline, false);
    assert.equal(harness.authorityEvents.length, 1); // No new event

    // Clear authority
    const clearResult = harness.telemetryService.setTapAuthority(tap.id, {
      sourceId: null,
    });
    assert.equal(clearResult.requiresFreshBaseline, true);
    assert.equal(clearResult.authority, null);

    assert.equal(harness.authorityEvents.length, 2);
    assert.equal(harness.authorityEvents[1]?.previousSourceId, source.id);
    assert.equal(harness.authorityEvents[1]?.newSourceId, null);
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 4. Telemetry Settings & Cross-Field Validation Tests
// ==========================================

void test("telemetry settings enforce default values and cross-field invariants", () => {
  const harness = createTestHarness();
  try {
    const defaultSettings = harness.telemetryService.getSettings();
    assert.equal(defaultSettings.maxBatchSize, 100);
    assert.equal(defaultSettings.maxFutureSkewSeconds, 300);
    assert.equal(defaultSettings.reconnectHorizonSeconds, 21600);
    assert.equal(defaultSettings.rawRetentionSeconds, 21600);
    assert.equal(defaultSettings.receiptRetentionSeconds, 86400);
    assert.equal(defaultSettings.rateLimitSamplesPerMinute, 600);
    assert.equal(defaultSettings.rateLimitBurstSamples, 100);

    // Valid update
    const updated = harness.telemetryService.updateSettings({
      maxBatchSize: 50,
      rateLimitBurstSamples: 50,
      rawRetentionSeconds: 7200,
    });
    assert.equal(updated.maxBatchSize, 50);
    assert.equal(updated.rawRetentionSeconds, 7200);

    // Invalid update: receiptRetentionSeconds < reconnectHorizonSeconds
    assert.throws(
      () =>
        harness.telemetryService.updateSettings({
          receiptRetentionSeconds: 3600,
          reconnectHorizonSeconds: 5000,
        }),
      /receiptRetentionSeconds must be greater than or equal to reconnectHorizonSeconds/,
    );

    // Invalid update: maxBatchSize > rateLimitBurstSamples
    assert.throws(
      () =>
        harness.telemetryService.updateSettings({
          maxBatchSize: 80,
          rateLimitBurstSamples: 20,
        }),
      /maxBatchSize must be less than or equal to rateLimitBurstSamples/,
    );
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 5. Ingestion, Idempotency & Attribution Tests
// ==========================================

void test("single sample ingestion accepts authoritative telemetry, registers first_used_at, and writes receipt", () => {
  const currentTime = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => currentTime });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source } = harness.telemetryService.createSource({ name: "Scale 1" });
    harness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });

    assert.equal(harness.tapService.getTap(tap.id).firstUsedAt, null);

    // 1. Ingest sample on unassigned tap
    const result1 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-001",
      measuredAt: "2026-08-14T12:00:00.000Z",
      totalWeight: { value: 18500, unit: "g" },
      temperature: { value: 3.5, unit: "c" },
    });

    assert.equal(result1.outcome, "accepted");
    assert.equal(result1.code, "telemetry.accepted");
    assert.equal(result1.duplicate, false);
    assert.ok(result1.acceptedMeasurementId);

    // Tap first_used_at is monotonically set
    const updatedTap = harness.tapService.getTap(tap.id);
    assert.equal(updatedTap.firstUsedAt, "2026-08-14T12:00:00.000Z");

    // AcceptedTelemetryExtensionPort was called
    assert.equal(harness.acceptedEvents.length, 1);
    assert.equal(harness.acceptedEvents[0]?.measurementId, result1.acceptedMeasurementId);
    assert.equal(harness.acceptedEvents[0]?.capturedAssignmentId, null);

    // Latest hardware status updated
    const status = harness.telemetryService.getTapLatestHardwareStatus(tap.id);
    assert.equal(status.length, 1);
    assert.equal(status[0]?.latestMeasuredAt, "2026-08-14T12:00:00.000Z");
    assert.equal(status[0]?.totalMassG, 18500);
    assert.equal(status[0]?.temperatureC, 3.5);

    // 2. Duplicate replay with same clientSampleId returns cached receipt (0 new effects)
    const dupResult = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-001",
      measuredAt: "2026-08-14T12:00:00.000Z",
      totalWeight: { value: 18.5, unit: "kg" }, // 18.5 kg = 18500 g (same semantic digest)
      temperature: { value: 3.5, unit: "c" },
    });

    assert.equal(dupResult.outcome, "accepted");
    assert.equal(dupResult.code, "telemetry.accepted");
    assert.equal(dupResult.duplicate, true);
    assert.equal(dupResult.acceptedMeasurementId, result1.acceptedMeasurementId);
    assert.equal(harness.acceptedEvents.length, 1); // No new domain event

    // 3. Conflict replay with same clientSampleId but different measurement returns conflict
    const conflictResult = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-001",
      measuredAt: "2026-08-14T12:00:00.000Z",
      totalWeight: { value: 12000, unit: "g" }, // Different value
    });

    assert.equal(conflictResult.outcome, "rejected");
    assert.equal(conflictResult.code, "telemetry.idempotency_conflict");
    assert.equal(conflictResult.duplicate, false);
  } finally {
    harness.database.close();
  }
});

void test("telemetry attribution captures active assignment ID only if measuredAt >= assignedAt", () => {
  let currentTime = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => currentTime });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source } = harness.telemetryService.createSource({ name: "Scale 1" });
    harness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });

    const keg = harness.kegService.createKeg({
      kegNumber: 10,
      label: "Sixtel 1",
      capacityMl: 19500,
      currentTareG: 4300,
    });
    const bev = harness.beverageService.createCustomBeverage({
      name: "Pilsner",
      beverageType: "beer",
    });
    const fill = harness.fillService.createFill({
      beverageId: bev.beverage.id,
      kegId: keg.id,
      fillDate: "2026-08-14",
    });

    // Assign Fill to Tap at 12:00:00
    currentTime = new Date("2026-08-14T12:00:00.000Z");
    const assigned = harness.tapService.assignFill(tap.id, { fillId: fill.id });
    assert.ok(assigned.assignment);

    // Telemetry measured at 12:05:00 (after assignment) -> captures assignment ID
    currentTime = new Date("2026-08-14T12:05:00.000Z");
    const resultAfter = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-after",
      measuredAt: "2026-08-14T12:05:00.000Z",
      totalWeight: { value: 19000, unit: "g" },
    });
    assert.equal(resultAfter.outcome, "accepted");
    assert.equal(harness.acceptedEvents[0]?.capturedAssignmentId, assigned.assignment.id);
    assert.equal(harness.acceptedEvents[0]?.capturedFillId, fill.id);
  } finally {
    harness.database.close();
  }
});

void test("permanent Fill deletion removes attributed raw telemetry while preserving receipt identity and latest status", () => {
  const harness = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  try {
    const { tap, source } = createAuthorizedTap(harness, 1, "Deletion Scale");
    const keg = harness.kegService.createKeg({ kegNumber: 1, capacityMl: 19_500 });
    const beverage = harness.beverageService.createCustomBeverage({
      name: "Deletion Lager",
      beverageType: "beer",
    });
    const fill = harness.fillService.createFill({
      beverageId: beverage.beverage.id,
      kegId: keg.id,
      fillDate: "2026-08-14",
    });
    const assignment = harness.tapService.assignFill(tap.id, { fillId: fill.id });
    const accepted = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "fill-delete-attribution",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 15_000, unit: "g" },
    });
    assert.equal(harness.acceptedEvents.at(-1)?.capturedAssignmentId, assignment.assignment.id);

    harness.fillService.deleteFill(fill.id, { reason: "forensic regression" });

    assert.equal(countRows(harness.database, "telemetry_measurements"), 0);
    const receipt = harness.database
      .prepare<[string], { readonly accepted_measurement_id: string | null }>(
        "SELECT accepted_measurement_id FROM telemetry_ingest_receipts WHERE client_sample_id = ?",
      )
      .get("fill-delete-attribution");
    assert.equal(receipt?.accepted_measurement_id, accepted.acceptedMeasurementId);
    const [status] = harness.telemetryService.getTapLatestHardwareStatus(tap.id);
    assert.equal(status?.latestMeasurementId, null);
    assert.equal(status?.capturedAssignmentId, null);
    assert.equal(status?.capturedFillId, null);
    assert.equal(status?.totalMassG, 15_000);
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 6. Timestamp Horizon & Watermark Tests
// ==========================================

void test("telemetry rejects non-authoritative sources, future skew, stale reconnect horizon, and out-of-order samples", () => {
  const baseTime = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => baseTime });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source: authSource } = harness.telemetryService.createSource({
      name: "Authorized Source",
    });
    const { source: unauthSource } = harness.telemetryService.createSource({
      name: "Rogue Source",
    });
    harness.telemetryService.setTapAuthority(tap.id, { sourceId: authSource.id });

    // 1. Non-authoritative source
    const nonAuthResult = harness.telemetryService.ingestSingle(unauthSource, 1, {
      clientSampleId: "rogue-1",
      measuredAt: "2026-08-14T12:00:00.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(nonAuthResult.outcome, "rejected");
    assert.equal(nonAuthResult.code, "telemetry.not_authoritative");

    // 2. Future skew (> now + 300s = 12:05:00)
    const futureResult = harness.telemetryService.ingestSingle(authSource, 1, {
      clientSampleId: "future-1",
      measuredAt: "2026-08-14T12:10:00.000Z", // +10 min
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(futureResult.outcome, "rejected");
    assert.equal(futureResult.code, "telemetry.future_timestamp");

    // 3. Stale horizon (< now - 21600s = 06:00:00)
    const staleResult = harness.telemetryService.ingestSingle(authSource, 1, {
      clientSampleId: "stale-1",
      measuredAt: "2026-08-14T05:00:00.000Z", // 7 hours ago
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(staleResult.outcome, "rejected");
    assert.equal(staleResult.code, "telemetry.stale_timestamp");

    // 4. Valid initial sample advances watermark to 12:00:00
    const valid1 = harness.telemetryService.ingestSingle(authSource, 1, {
      clientSampleId: "valid-1",
      measuredAt: "2026-08-14T12:00:00.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(valid1.outcome, "accepted");

    // 5. Out of order sample (<= 12:00:00)
    const oooResult = harness.telemetryService.ingestSingle(authSource, 1, {
      clientSampleId: "ooo-1",
      measuredAt: "2026-08-14T11:59:59.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(oooResult.outcome, "rejected");
    assert.equal(oooResult.code, "telemetry.out_of_order");
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 7. Rate Limiting Tests
// ==========================================

void test("telemetry rate limiter enforces burst and refill rates without durable receipt creation", () => {
  let currentTimeMs = 1000000;
  const rateLimiter = new InMemoryTelemetryRateLimiter();
  const harness = createTestHarness({
    clock: () => new Date(currentTimeMs),
    rateLimiter,
  });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source } = harness.telemetryService.createSource({ name: "Scale 1" });
    harness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });

    // Set tight rate limit: burst 2, 60 samples/minute (1 sample/sec)
    harness.telemetryService.updateSettings({
      rateLimitBurstSamples: 2,
      rateLimitSamplesPerMinute: 60,
      maxBatchSize: 2,
    });

    // Sample 1 (burst token 1 consumed)
    const res1 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "r-1",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(res1.outcome, "accepted");

    // Sample 2 (burst token 2 consumed)
    currentTimeMs += 10;
    const res2 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "r-2",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(res2.outcome, "accepted");

    // Sample 3 immediately after -> rate limited!
    currentTimeMs += 10;
    const res3 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "r-3",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(res3.outcome, "rejected");
    assert.equal(res3.code, "telemetry.rate_limited");

    // Advance clock by 1000ms -> 1 token refilled!
    currentTimeMs += 1000;
    const res4 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "r-3", // retry sample 3
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(res4.outcome, "accepted");
  } finally {
    harness.database.close();
  }
});

void test("telemetry rate limiter does not refill while wall-clock time moves backward", () => {
  const rateLimiter = new InMemoryTelemetryRateLimiter();
  const settings = { rateLimitBurstSamples: 2, rateLimitSamplesPerMinute: 60 };
  assert.equal(rateLimiter.consume("source-1", 2, 1_000, settings), true);
  assert.equal(rateLimiter.consume("source-1", 1, 900, settings), false);
  assert.equal(rateLimiter.consume("source-1", 1, 1_500, settings), false);
  assert.equal(rateLimiter.consume("source-1", 1, 2_000, settings), true);
});

// ==========================================
// 8. Deterministic Batch Processing Tests
// ==========================================

void test("batch ingestion handles preflight resolution, deterministic sorting, intra-batch duplicates and conflicts", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => now });

  try {
    const tap1 = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const tap2 = harness.tapService.createTap({ tapNumber: 2, name: "Tap 2" });
    const { source } = harness.telemetryService.createSource({ name: "Batch Source" });

    harness.telemetryService.setTapAuthority(tap1.id, { sourceId: source.id });
    harness.telemetryService.setTapAuthority(tap2.id, { sourceId: source.id });

    // Batch contains:
    // index 0: Tap 2 measured at 12:00:02
    // index 1: Tap 1 measured at 12:00:01 (clientSampleId: 'b-1')
    // index 2: Tap 1 measured at 12:00:01 (duplicate of 'b-1' with same payload)
    // index 3: Tap 2 measured at 12:00:05 (clientSampleId: 'conflict-id', 10 kg)
    // index 4: Tap 2 measured at 12:00:05 (clientSampleId: 'conflict-id', 12 kg - intra-batch conflict!)
    const batchResult = harness.telemetryService.ingestBatch(source, {
      samples: [
        {
          tapNumber: 2,
          clientSampleId: "tap2-sample1",
          measuredAt: "2026-08-14T12:00:02.000Z",
          totalWeight: { value: 14000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "b-1",
          measuredAt: "2026-08-14T12:00:01.000Z",
          totalWeight: { value: 15000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "b-1",
          measuredAt: "2026-08-14T12:00:01.000Z",
          totalWeight: { value: 15, unit: "kg" }, // same digest
        },
        {
          tapNumber: 2,
          clientSampleId: "conflict-id",
          measuredAt: "2026-08-14T12:00:05.000Z",
          totalWeight: { value: 10000, unit: "g" },
        },
        {
          tapNumber: 2,
          clientSampleId: "conflict-id",
          measuredAt: "2026-08-14T12:00:05.000Z",
          totalWeight: { value: 12000, unit: "g" }, // different digest
        },
      ],
    });

    assert.equal(batchResult.processedCount, 5);
    assert.equal(batchResult.acceptedCount, 3); // index 0, 1, 2
    assert.equal(batchResult.duplicateCount, 1); // index 2
    assert.equal(batchResult.rejectedCount, 2); // index 3, 4 (conflicts)

    // Results preserve exact original input indexes
    assert.equal(batchResult.results[0]?.index, 0);
    assert.equal(batchResult.results[0]?.outcome, "accepted");

    assert.equal(batchResult.results[1]?.index, 1);
    assert.equal(batchResult.results[1]?.outcome, "accepted");
    assert.equal(batchResult.results[1]?.duplicate, false);

    assert.equal(batchResult.results[2]?.index, 2);
    assert.equal(batchResult.results[2]?.outcome, "accepted");
    assert.equal(batchResult.results[2]?.duplicate, true);

    assert.equal(batchResult.results[3]?.index, 3);
    assert.equal(batchResult.results[3]?.outcome, "rejected");
    assert.equal(batchResult.results[3]?.code, "telemetry.idempotency_conflict");

    assert.equal(batchResult.results[4]?.index, 4);
    assert.equal(batchResult.results[4]?.outcome, "rejected");
    assert.equal(batchResult.results[4]?.code, "telemetry.idempotency_conflict");
  } finally {
    harness.database.close();
  }
});

void test("batch tie-breakers use locale-independent ordinal string order", () => {
  const harness = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  try {
    const { source } = createAuthorizedTap(harness, 1, "Ordinal Batch Source");
    const result = harness.telemetryService.ingestBatch(source, {
      samples: [
        {
          tapNumber: 1,
          clientSampleId: "a",
          measuredAt: "2026-08-14T12:00:00Z",
          totalWeight: { value: 2_000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "Z",
          measuredAt: "2026-08-14T12:00:00Z",
          totalWeight: { value: 1_000, unit: "g" },
        },
      ],
    });

    assert.equal(result.results[0]?.code, "telemetry.out_of_order");
    assert.equal(result.results[1]?.code, "telemetry.accepted");
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 9. Retention & Safe Pruning Tests
// ==========================================

void test("retention pruning cleans raw measurements at raw_retention and receipts at receipt_retention without deleting status or first_used_at", () => {
  let currentTime = new Date("2026-08-14T00:00:00.000Z");
  const harness = createTestHarness({ clock: () => currentTime });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const { source } = harness.telemetryService.createSource({ name: "Scale 1" });
    harness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id });

    // Configure: raw retention 6h (21600s), receipt retention 24h (86400s)
    harness.telemetryService.updateSettings({
      rawRetentionSeconds: 21600,
      receiptRetentionSeconds: 86400,
      reconnectHorizonSeconds: 21600,
    });

    // Ingest sample at T0 (00:00:00)
    const ingestT0 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-t0",
      measuredAt: "2026-08-14T00:00:00.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(ingestT0.outcome, "accepted");

    // Advance clock to +8 hours. A normal maximum-size batch crosses the
    // opportunistic-maintenance interval; no Admin prune call is required.
    currentTime = new Date("2026-08-14T08:00:00.000Z");
    const maintenanceBatch = harness.telemetryService.ingestBatch(source, {
      samples: Array.from({ length: 100 }, () => ({
        tapNumber: 1,
        clientSampleId: "sample-t0",
        measuredAt: "2026-08-14T00:00:00.000Z",
        totalWeight: { value: 15_000, unit: "g" },
      })),
    });
    assert.equal(maintenanceBatch.duplicateCount, 100);
    assert.equal(countRows(harness.database, "telemetry_measurements"), 0);
    assert.equal(countRows(harness.database, "telemetry_ingest_receipts"), 1);

    // Measurement deleted, but the durable receipt preserves its accepted measurement ID.
    const receipt = harness.database
      .prepare<[string], { readonly id: string; readonly accepted_measurement_id: string | null }>(
        "SELECT id, accepted_measurement_id FROM telemetry_ingest_receipts WHERE client_sample_id = ?",
      )
      .get("sample-t0");
    assert.ok(receipt);
    assert.equal(receipt.accepted_measurement_id, ingestT0.acceptedMeasurementId);

    // Latest hardware status survives pruning
    const status = harness.telemetryService.getTapLatestHardwareStatus(tap.id);
    assert.equal(status.length, 1);
    assert.equal(status[0]?.latestMeasuredAt, "2026-08-14T00:00:00.000Z");
    assert.equal(status[0]?.totalMassG, 15000);

    // Replay of same sample at +8 hours returns duplicate from receipt (does not re-insert deleted raw measurement)
    const replayT0 = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-t0",
      measuredAt: "2026-08-14T00:00:00.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(replayT0.duplicate, true);

    // Advance clock to +30 hours -> receipt is now older than 24h and is pruned
    currentTime = new Date("2026-08-15T06:00:00.000Z");
    const prune2 = harness.telemetryService.pruneTelemetry();
    assert.equal(prune2.prunedReceiptsCount, 1);

    // Replay of expired sample now rejected as stale (since measuredAt is outside reconnect horizon)
    const staleReplay = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "sample-t0",
      measuredAt: "2026-08-14T00:00:00.000Z",
      totalWeight: { value: 15000, unit: "g" },
    });
    assert.equal(staleReplay.outcome, "rejected");
    assert.equal(staleReplay.code, "telemetry.stale_timestamp");
  } finally {
    harness.database.close();
  }
});

// ==========================================
// 10. Exact #72 transaction, identity, and lifecycle contracts
// ==========================================

void test("source credentials are show-once, source identity survives rotation, and rate limiting is source-scoped", () => {
  let now = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => now });

  try {
    const { tap, source, initialToken } = createAuthorizedTap(harness, 1, "Rotating Scale");
    const genericKey = harness.machineKeyService.create("unbound machine key");
    assert.equal(harness.telemetryService.authenticateSourceToken(genericKey.token), undefined);

    const serializedSource = JSON.stringify(harness.telemetryService.listSources());
    assert.doesNotMatch(serializedSource, new RegExp(initialToken));
    assert.doesNotMatch(serializedSource, /verificationDigest|secret|token/i);

    harness.telemetryService.updateSettings({
      maxBatchSize: 1,
      rateLimitBurstSamples: 1,
      rateLimitSamplesPerMinute: 60,
    });
    const first = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "before-rotation",
      measuredAt: now.toISOString(),
      totalWeight: { value: 10_000, unit: "g" },
    });
    assert.equal(first.outcome, "accepted");

    const rotated = harness.telemetryService.rotateSourceKey(source.id, { label: "new key" });
    assert.equal(rotated.source.id, source.id);
    assert.notEqual(rotated.source.currentMachineKeyId, source.currentMachineKeyId);
    assert.equal(harness.telemetryService.getTapAuthority(tap.id)?.sourceId, source.id);
    assert.equal(harness.telemetryService.authenticateSourceToken(initialToken), undefined);

    const authenticatedAfterRotation = harness.telemetryService.authenticateSourceToken(
      rotated.replacementToken,
    );
    assert.ok(authenticatedAfterRotation);
    assert.equal(authenticatedAfterRotation.id, source.id);

    // The old source namespace remains exhausted after key rotation.
    now = new Date("2026-08-14T12:00:00.100Z");
    const rateLimited = harness.telemetryService.ingestSingle(authenticatedAfterRotation, 1, {
      clientSampleId: "after-rotation",
      measuredAt: now.toISOString(),
      totalWeight: { value: 11_000, unit: "g" },
    });
    assert.equal(rateLimited.outcome, "rejected");
    assert.equal(rateLimited.code, "telemetry.rate_limited");

    // Idempotency is also keyed by source, not by the current machine-key ID.
    const duplicate = harness.telemetryService.ingestSingle(authenticatedAfterRotation, 1, {
      clientSampleId: "before-rotation",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 10, unit: "kg" },
    });
    assert.equal(duplicate.outcome, "accepted");
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.acceptedMeasurementId, first.acceptedMeasurementId);
  } finally {
    harness.database.close();
  }
});

void test("authority no-ops are inert, hooks receive the executor, and failed authority hooks roll back", () => {
  const hookDatabases: DatabaseExecutor[] = [];
  const events: AuthorityChangedEvent[] = [];
  let failOnSourceId: string | undefined;
  const harness = createTestHarness({
    onAuthorityChanged: (database, event) => {
      hookDatabases.push(database);
      events.push(event);
      if (event.newSourceId === failOnSourceId) {
        throw new Error("authority hook failed");
      }
    },
  });

  try {
    const tap = harness.tapService.createTap({ tapNumber: 1, name: "Tap 1" });
    const first = harness.telemetryService.createSource({ name: "Authority A" });
    const second = harness.telemetryService.createSource({ name: "Authority B" });
    const assigned = harness.telemetryService.setTapAuthority(tap.id, {
      sourceId: first.source.id,
    });
    assert.equal(assigned.requiresFreshBaseline, true);
    assert.strictEqual(hookDatabases[0], harness.database);
    assert.deepEqual(events[0], harness.authorityEvents[0]);

    const activityBeforeNoop = countRows(harness.database, "activity_log");
    const hookCountBeforeNoop = events.length;
    const noOp = harness.telemetryService.setTapAuthority(tap.id, {
      sourceId: first.source.id,
    });
    assert.equal(noOp.requiresFreshBaseline, false);
    assert.equal(events.length, hookCountBeforeNoop);
    assert.equal(countRows(harness.database, "activity_log"), activityBeforeNoop);

    const activityBeforeFailure = countRows(harness.database, "activity_log");
    failOnSourceId = second.source.id;
    assert.throws(
      () => harness.telemetryService.setTapAuthority(tap.id, { sourceId: second.source.id }),
      /authority hook failed/,
    );
    assert.equal(harness.telemetryService.getTapAuthority(tap.id)?.sourceId, first.source.id);
    assert.equal(countRows(harness.database, "activity_log"), activityBeforeFailure);
    assert.equal(events.at(-1)?.newSourceId, second.source.id);
  } finally {
    harness.database.close();
  }
});

void test("accepted hooks run before receipt finalization and failures roll back every accepted projection", () => {
  let hookDatabase: DatabaseExecutor | undefined;
  let receiptCountAtHook: number | undefined;
  const successful = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
    onAcceptedSample: (database, event) => {
      hookDatabase = database;
      receiptCountAtHook = countRows(database, "telemetry_ingest_receipts");
      assert.equal(event.primaryMeasurement.kind, "total_weight");
      assert.equal(event.primaryMeasurement.value, 15_000);
      assert.equal(successful.telemetryService.getTapLatestHardwareStatus(event.tapId).length, 1);
    },
  });

  try {
    const { tap, source } = createAuthorizedTap(successful, 1, "Hooked Scale");
    const result = successful.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "hook-success",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 15_000, unit: "g" },
    });
    assert.equal(result.outcome, "accepted");
    assert.strictEqual(hookDatabase, successful.database);
    assert.equal(receiptCountAtHook, 0);
    assert.equal(countRows(successful.database, "telemetry_ingest_receipts"), 1);
    assert.equal(successful.tapService.getTap(tap.id).firstUsedAt, "2026-08-14T12:00:00.000Z");
  } finally {
    successful.database.close();
  }

  const failing = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
    onAcceptedSample: () => {
      throw new Error("accepted hook failed");
    },
  });
  try {
    const { tap, source } = createAuthorizedTap(failing, 1, "Failing Scale");
    const before = telemetryCounts(failing.database);
    assert.throws(
      () =>
        failing.telemetryService.ingestSingle(source, 1, {
          clientSampleId: "hook-failure",
          measuredAt: "2026-08-14T12:00:00Z",
          totalWeight: { value: 15_000, unit: "g" },
        }),
      /accepted hook failed/,
    );
    assert.deepEqual(telemetryCounts(failing.database), before);
    assert.equal(failing.tapService.getTap(tap.id).firstUsedAt, null);
    assert.equal(failing.telemetryService.getTapLatestHardwareStatus(tap.id).length, 0);
  } finally {
    failing.database.close();
  }
});

void test("Promise-like telemetry extensions are rejected synchronously and roll back local state", () => {
  const authorityHarness = createTestHarness({
    onAuthorityChanged: () => Promise.resolve(),
  });
  try {
    const tap = authorityHarness.tapService.createTap({ tapNumber: 1 });
    const { source } = authorityHarness.telemetryService.createSource({ name: "Async Authority" });
    assert.throws(
      () => authorityHarness.telemetryService.setTapAuthority(tap.id, { sourceId: source.id }),
      /Telemetry authority extensions must complete synchronously/,
    );
    assert.equal(authorityHarness.telemetryService.getTapAuthority(tap.id), undefined);
  } finally {
    authorityHarness.database.close();
  }

  const acceptedHarness = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
    onAcceptedSample: () => ({ then() {} }),
  });
  try {
    const { tap, source } = createAuthorizedTap(acceptedHarness, 1, "Async Accepted");
    const before = telemetryCounts(acceptedHarness.database);
    assert.throws(
      () =>
        acceptedHarness.telemetryService.ingestSingle(source, 1, {
          clientSampleId: "async-hook",
          measuredAt: "2026-08-14T12:00:00Z",
          totalWeight: { value: 15_000, unit: "g" },
        }),
      /Accepted telemetry extensions must complete synchronously/,
    );
    assert.deepEqual(telemetryCounts(acceptedHarness.database), before);
    assert.equal(acceptedHarness.tapService.getTap(tap.id).firstUsedAt, null);
  } finally {
    acceptedHarness.database.close();
  }
});

void test("disabled taps accept telemetry while retired taps create durable stable rejects", () => {
  const harness = createTestHarness({ clock: () => new Date("2026-08-14T12:00:00.000Z") });
  try {
    const disabled = createAuthorizedTap(harness, 1, "Disabled Scale", { enabled: false });
    const accepted = harness.telemetryService.ingestSingle(disabled.source, 1, {
      clientSampleId: "disabled-accepted",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(accepted.outcome, "accepted");
    assert.equal(harness.tapService.getTap(disabled.tap.id).enabled, false);

    const retired = createAuthorizedTap(harness, 2, "Retired Scale");
    harness.tapService.retireTap(retired.tap.id);
    const rejected = harness.telemetryService.ingestSingle(retired.source, 2, {
      clientSampleId: "retired-rejected",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(rejected.outcome, "rejected");
    assert.equal(rejected.code, "telemetry.tap_retired");
    const receiptCount = countRows(harness.database, "telemetry_ingest_receipts");

    const replay = harness.telemetryService.ingestSingle(retired.source, 2, {
      clientSampleId: "retired-rejected",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(replay.outcome, "rejected");
    assert.equal(replay.code, "telemetry.tap_retired");
    assert.equal(replay.duplicate, true);
    assert.equal(countRows(harness.database, "telemetry_ingest_receipts"), receiptCount);
  } finally {
    harness.database.close();
  }
});

void test("first use is accepted-only and received-time based; attribution excludes delayed and closed assignments", () => {
  let now = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => now });

  try {
    const { tap, source } = createAuthorizedTap(harness, 1, "Attribution Scale");
    const rejectedFuture = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "future-first-use",
      measuredAt: "2026-08-14T12:05:01Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(rejectedFuture.outcome, "rejected");
    assert.equal(harness.tapService.getTap(tap.id).firstUsedAt, null);

    // No assignment is active: the accepted sample still captures no fill.
    const unassigned = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "unassigned-accepted",
      measuredAt: "2026-08-14T11:59:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(unassigned.outcome, "accepted");
    assert.equal(harness.acceptedEvents.at(-1)?.capturedAssignmentId, null);
    assert.equal(harness.acceptedEvents.at(-1)?.capturedFillId, null);
    assert.equal(harness.tapService.getTap(tap.id).firstUsedAt, now.toISOString());

    const keg = harness.kegService.createKeg({
      kegNumber: 1,
      capacityMl: 19_500,
      currentTareG: 4_300,
    });
    const beverage = harness.beverageService.createCustomBeverage({
      name: "Attribution Lager",
      beverageType: "beer",
    });
    const fill = harness.fillService.createFill({
      beverageId: beverage.beverage.id,
      kegId: keg.id,
      fillDate: "2026-08-14",
    });

    now = new Date("2026-08-14T12:01:00.000Z");
    const assignment = harness.tapService.assignFill(tap.id, { fillId: fill.id });
    now = new Date("2026-08-14T12:02:00.000Z");
    const delayed = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "pre-assignment-delayed",
      measuredAt: "2026-08-14T12:00:59Z",
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(delayed.outcome, "accepted");
    assert.equal(harness.acceptedEvents.at(-1)?.capturedAssignmentId, null);
    assert.equal(harness.acceptedEvents.at(-1)?.capturedFillId, null);

    now = new Date("2026-08-14T12:03:00.000Z");
    const fresh = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "fresh-assignment",
      measuredAt: "2026-08-14T12:01:01Z",
      totalWeight: { value: 3_000, unit: "g" },
    });
    assert.equal(fresh.outcome, "accepted");
    assert.equal(harness.acceptedEvents.at(-1)?.capturedAssignmentId, assignment.assignment.id);
    assert.equal(harness.acceptedEvents.at(-1)?.capturedFillId, fill.id);

    harness.tapService.unassign(tap.id);
    now = new Date("2026-08-14T12:04:00.000Z");
    const afterClosed = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "closed-history-not-selected",
      measuredAt: "2026-08-14T12:02:01Z",
      totalWeight: { value: 4_000, unit: "g" },
    });
    assert.equal(afterClosed.outcome, "accepted");
    assert.equal(harness.acceptedEvents.at(-1)?.capturedAssignmentId, null);
    assert.equal(harness.acceptedEvents.at(-1)?.capturedFillId, null);
  } finally {
    harness.database.close();
  }
});

void test("idempotency namespaces, semantic duplicates, conflicts, stable rejects, and rate ordering are exact", () => {
  const harness = createTestHarness({ clock: () => new Date("2026-08-14T12:00:00.000Z") });
  try {
    const tap1 = createAuthorizedTap(harness, 1, "Identity Source A");
    const tap2 = harness.tapService.createTap({ tapNumber: 2, name: "Tap 2" });
    harness.telemetryService.setTapAuthority(tap2.id, { sourceId: tap1.source.id });
    const tap3 = createAuthorizedTap(harness, 3, "Identity Source B");

    const first = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "source-scoped-id",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 10_000, unit: "g" },
    });
    assert.equal(first.outcome, "accepted");

    const crossTapConflict = harness.telemetryService.ingestSingle(tap1.source, 2, {
      clientSampleId: "source-scoped-id",
      measuredAt: "2026-08-14T12:00:01Z",
      totalWeight: { value: 10_000, unit: "g" },
    });
    assert.equal(crossTapConflict.code, "telemetry.idempotency_conflict");

    // A different source has an independent client identity namespace.
    const otherSource = harness.telemetryService.ingestSingle(tap3.source, 3, {
      clientSampleId: "source-scoped-id",
      measuredAt: "2026-08-14T12:00:01Z",
      totalWeight: { value: 10_000, unit: "g" },
    });
    assert.equal(otherSource.outcome, "accepted");

    const fallbackTap1 = harness.telemetryService.ingestSingle(tap1.source, 1, {
      measuredAt: "2026-08-14T12:00:02Z",
      totalWeight: { value: 11_000, unit: "g" },
    });
    const fallbackTap2 = harness.telemetryService.ingestSingle(tap1.source, 2, {
      measuredAt: "2026-08-14T12:00:02Z",
      totalWeight: { value: 11_000, unit: "g" },
    });
    const fallbackOtherSource = harness.telemetryService.ingestSingle(tap3.source, 3, {
      measuredAt: "2026-08-14T12:00:02Z",
      totalWeight: { value: 11_000, unit: "g" },
    });
    assert.equal(fallbackTap1.outcome, "accepted");
    assert.equal(fallbackTap2.outcome, "accepted");
    assert.equal(fallbackOtherSource.outcome, "accepted");
    const fallbackDuplicate = harness.telemetryService.ingestSingle(tap1.source, 1, {
      measuredAt: "2026-08-14T12:00:02Z",
      totalWeight: { value: 11, unit: "kg" },
    });
    assert.equal(fallbackDuplicate.duplicate, true);
    assert.equal(fallbackDuplicate.acceptedMeasurementId, fallbackTap1.acceptedMeasurementId);

    const semantic = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "semantic-equivalent",
      measuredAt: "2026-08-14T12:00:03Z",
      totalWeight: { value: 12_000, unit: "g" },
    });
    assert.equal(semantic.outcome, "accepted");
    const semanticDuplicate = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "semantic-equivalent",
      measuredAt: "2026-08-14T12:00:03+00:00",
      totalWeight: { value: 12, unit: "kg" },
    });
    assert.equal(semanticDuplicate.duplicate, true);
    const semanticConflict = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "semantic-equivalent",
      measuredAt: "2026-08-14T12:00:03Z",
      totalWeight: { value: 12_001, unit: "g" },
    });
    assert.equal(semanticConflict.code, "telemetry.idempotency_conflict");

    const rejected = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "stable-rejection",
      measuredAt: "2026-08-14T12:00:01Z",
      totalWeight: { value: 1, unit: "kg" },
    });
    assert.equal(rejected.code, "telemetry.out_of_order");
    const receiptsBeforeReplay = countRows(harness.database, "telemetry_ingest_receipts");
    const rejectedReplay = harness.telemetryService.ingestSingle(tap1.source, 1, {
      clientSampleId: "stable-rejection",
      measuredAt: "2026-08-14T12:00:01Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(rejectedReplay.code, "telemetry.out_of_order");
    assert.equal(rejectedReplay.duplicate, true);
    assert.equal(countRows(harness.database, "telemetry_ingest_receipts"), receiptsBeforeReplay);
  } finally {
    harness.database.close();
  }

  let currentTimeMs = Date.parse("2026-08-14T12:00:00.000Z");
  const rateHarness = createTestHarness({
    clock: () => new Date(currentTimeMs),
    rateLimiter: new InMemoryTelemetryRateLimiter(),
  });
  try {
    const { source } = createAuthorizedTap(rateHarness, 1, "Rate Ordering Source");
    rateHarness.telemetryService.updateSettings({
      maxBatchSize: 1,
      rateLimitBurstSamples: 1,
      rateLimitSamplesPerMinute: 60,
    });
    const accepted = rateHarness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "rate-first",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(accepted.outcome, "accepted");
    const duplicate = rateHarness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "rate-first",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 1, unit: "kg" },
    });
    assert.equal(duplicate.outcome, "accepted");
    assert.equal(duplicate.duplicate, true);
    currentTimeMs += 100;
    const limited = rateHarness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "rate-new",
      measuredAt: new Date(currentTimeMs).toISOString(),
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(limited.code, "telemetry.rate_limited");
    assert.equal(countRows(rateHarness.database, "telemetry_ingest_receipts"), 1);
  } finally {
    rateHarness.database.close();
  }
});

void test("timestamp horizons accept exact boundaries and reject newer-than-bound, older, and equal-time identities", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => now });
  try {
    const first = createAuthorizedTap(harness, 1, "Boundary Source");
    const exactFuture = harness.telemetryService.ingestSingle(first.source, 1, {
      clientSampleId: "exact-future",
      measuredAt: "2026-08-14T12:05:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(exactFuture.outcome, "accepted");
    const tooFuture = harness.telemetryService.ingestSingle(first.source, 1, {
      clientSampleId: "too-future",
      measuredAt: "2026-08-14T12:05:00.001Z",
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(tooFuture.code, "telemetry.future_timestamp");
    const older = harness.telemetryService.ingestSingle(first.source, 1, {
      clientSampleId: "older-than-latest",
      measuredAt: "2026-08-14T12:04:59Z",
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(older.code, "telemetry.out_of_order");
    const equalNewIdentity = harness.telemetryService.ingestSingle(first.source, 1, {
      clientSampleId: "equal-time-new-identity",
      measuredAt: "2026-08-14T12:05:00Z",
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(equalNewIdentity.code, "telemetry.out_of_order");

    const exactPast = createAuthorizedTap(harness, 2, "Boundary Past Source");
    const exactReconnectBoundary = harness.telemetryService.ingestSingle(exactPast.source, 2, {
      clientSampleId: "exact-past",
      measuredAt: "2026-08-14T06:00:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(exactReconnectBoundary.outcome, "accepted");
    const stale = harness.telemetryService.ingestSingle(exactPast.source, 2, {
      clientSampleId: "stale-past",
      measuredAt: "2026-08-14T05:59:59.999Z",
      totalWeight: { value: 2_000, unit: "g" },
    });
    assert.equal(stale.code, "telemetry.stale_timestamp");
  } finally {
    harness.database.close();
  }
});

void test("batch validation is all-or-nothing, ordered by canonical time, and retry-safe", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");
  const harness = createTestHarness({ clock: () => now });
  try {
    const tap1 = createAuthorizedTap(harness, 1, "Batch Source");
    const tap2 = harness.tapService.createTap({ tapNumber: 2, name: "Tap 2" });
    harness.telemetryService.setTapAuthority(tap2.id, { sourceId: tap1.source.id });
    const before = telemetryCounts(harness.database);
    assert.throws(
      () =>
        harness.telemetryService.ingestBatch(tap1.source, {
          samples: [
            {
              tapNumber: 1,
              clientSampleId: "valid-but-not-committed",
              measuredAt: "2026-08-14T12:00:00Z",
              totalWeight: { value: 1_000, unit: "g" },
            },
            {
              tapNumber: 2,
              clientSampleId: "invalid-unknown-field",
              measuredAt: "2026-08-14T12:00:01Z",
              totalWeight: { value: 1_000, unit: "g" },
              unexpected: true,
            } as never,
          ],
        }),
      /unknown key|invalid value/i,
    );
    assert.deepEqual(telemetryCounts(harness.database), before);

    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      tapNumber: 1,
      clientSampleId: `too-many-${index}`,
      measuredAt: `2026-08-14T12:00:${String(index % 60).padStart(2, "0")}Z`,
      totalWeight: { value: 1_000, unit: "g" as const },
    }));
    assert.throws(
      () => harness.telemetryService.ingestBatch(tap1.source, { samples: tooMany }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        String(error.details?.reason).includes("more than 100 samples"),
    );
    assert.deepEqual(telemetryCounts(harness.database), before);

    const batch = harness.telemetryService.ingestBatch(tap1.source, {
      samples: [
        {
          tapNumber: 2,
          clientSampleId: "batch-later",
          measuredAt: "2026-08-14T12:00:02Z",
          totalWeight: { value: 14_000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "batch-duplicate",
          measuredAt: "2026-08-14T12:00:01Z",
          totalWeight: { value: 15_000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "batch-duplicate",
          measuredAt: "2026-08-14T12:00:01Z",
          totalWeight: { value: 15, unit: "kg" },
        },
        {
          tapNumber: 2,
          clientSampleId: "batch-conflict",
          measuredAt: "2026-08-14T12:00:03Z",
          totalWeight: { value: 10_000, unit: "g" },
        },
        {
          tapNumber: 2,
          clientSampleId: "batch-conflict",
          measuredAt: "2026-08-14T12:00:03Z",
          totalWeight: { value: 12_000, unit: "g" },
        },
      ],
    });
    assert.deepEqual(
      batch.results.map((item) => [item.index, item.outcome, item.duplicate]),
      [
        [0, "accepted", false],
        [1, "accepted", false],
        [2, "accepted", true],
        [3, "rejected", false],
        [4, "rejected", false],
      ],
    );
    assert.equal(batch.acceptedCount, 3);
    assert.equal(batch.rejectedCount, 2);
    assert.equal(batch.duplicateCount, 1);
    const afterFirstBatch = telemetryCounts(harness.database);

    const retry = harness.telemetryService.ingestBatch(tap1.source, {
      samples: [
        {
          tapNumber: 2,
          clientSampleId: "batch-later",
          measuredAt: "2026-08-14T12:00:02Z",
          totalWeight: { value: 14_000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "batch-duplicate",
          measuredAt: "2026-08-14T12:00:01Z",
          totalWeight: { value: 15_000, unit: "g" },
        },
        {
          tapNumber: 1,
          clientSampleId: "batch-duplicate",
          measuredAt: "2026-08-14T12:00:01Z",
          totalWeight: { value: 15, unit: "kg" },
        },
        {
          tapNumber: 2,
          clientSampleId: "batch-conflict",
          measuredAt: "2026-08-14T12:00:03Z",
          totalWeight: { value: 10_000, unit: "g" },
        },
        {
          tapNumber: 2,
          clientSampleId: "batch-conflict",
          measuredAt: "2026-08-14T12:00:03Z",
          totalWeight: { value: 12_000, unit: "g" },
        },
      ],
    });
    assert.equal(retry.acceptedCount, 3);
    assert.equal(retry.duplicateCount, 3);
    assert.deepEqual(telemetryCounts(harness.database), afterFirstBatch);
  } finally {
    harness.database.close();
  }
});

void test("batch accepted-hook failure rolls back all items rather than committing a prefix", () => {
  const harness = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
    onAcceptedSample: (_database, event) => {
      if (event.primaryMeasurement.value === 20_000) throw new Error("batch hook failed");
    },
  });
  try {
    const { tap, source } = createAuthorizedTap(harness, 1, "Batch Hook Source");
    const before = telemetryCounts(harness.database);
    assert.throws(
      () =>
        harness.telemetryService.ingestBatch(source, {
          samples: [
            {
              tapNumber: 1,
              clientSampleId: "batch-hook-first",
              measuredAt: "2026-08-14T12:00:00Z",
              totalWeight: { value: 10_000, unit: "g" },
            },
            {
              tapNumber: 1,
              clientSampleId: "batch-hook-second",
              measuredAt: "2026-08-14T12:00:01Z",
              totalWeight: { value: 20_000, unit: "g" },
            },
          ],
        }),
      /batch hook failed/,
    );
    assert.deepEqual(telemetryCounts(harness.database), before);
    assert.equal(harness.tapService.getTap(tap.id).firstUsedAt, null);
  } finally {
    harness.database.close();
  }
});

void test("ordinary telemetry acceptance adds no Activity or outbox rows", () => {
  const harness = createTestHarness({
    clock: () => new Date("2026-08-14T12:00:00.000Z"),
  });
  try {
    const { source } = createAuthorizedTap(harness, 1, "Quiet Scale");
    const activityBefore = listActivity(harness.database).length;
    const outboxBefore = countRows(harness.database, "outbound_events");
    const result = harness.telemetryService.ingestSingle(source, 1, {
      clientSampleId: "quiet-sample",
      measuredAt: "2026-08-14T12:00:00Z",
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(result.outcome, "accepted");
    assert.equal(listActivity(harness.database).length, activityBefore);
    assert.equal(countRows(harness.database, "outbound_events"), outboxBefore);
  } finally {
    harness.database.close();
  }
});

void test("telemetry pruning is deterministic and bounded while durable receipts and projections survive", () => {
  let currentTime = new Date("2026-08-14T00:00:01.000Z");
  const harness = createTestHarness({ clock: () => currentTime });
  try {
    const { tap, source } = createAuthorizedTap(harness, 1, "Pruning Scale");
    harness.telemetryService.updateSettings({
      rawRetentionSeconds: 300,
      reconnectHorizonSeconds: 3_600,
      receiptRetentionSeconds: 3_600,
      rateLimitSamplesPerMinute: 6_000,
      rateLimitBurstSamples: 1_000,
    });

    const firstMeasuredAt = "2026-08-14T00:00:00.000Z";
    let firstMeasurementId: string | undefined;
    for (let index = 0; index < 501; index += 1) {
      const measuredAt = new Date(Date.parse(firstMeasuredAt) + index).toISOString();
      currentTime = new Date(Date.parse(measuredAt) + 1_000);
      const result = harness.telemetryService.ingestSingle(source, 1, {
        measuredAt,
        totalWeight: { value: 1_000 + index, unit: "g" },
      });
      assert.equal(result.outcome, "accepted");
      if (index === 0) firstMeasurementId = result.acceptedMeasurementId;
    }
    assert.ok(firstMeasurementId);
    const firstUsedAt = harness.tapService.getTap(tap.id).firstUsedAt;
    assert.equal(firstUsedAt, "2026-08-14T00:00:01.000Z");

    currentTime = new Date("2026-08-14T00:20:00.000Z");
    const firstPrune = harness.telemetryService.pruneTelemetry();
    assert.equal(firstPrune.prunedMeasurementsCount, 500);
    assert.equal(firstPrune.prunedReceiptsCount, 0);
    const secondPrune = harness.telemetryService.pruneTelemetry();
    assert.equal(secondPrune.prunedMeasurementsCount, 1);
    assert.equal(secondPrune.prunedReceiptsCount, 0);

    const receipt = harness.database
      .prepare<[string], { readonly accepted_measurement_id: string | null }>(
        "SELECT accepted_measurement_id FROM telemetry_ingest_receipts WHERE measured_at = ?",
      )
      .get(firstMeasuredAt);
    assert.equal(receipt?.accepted_measurement_id, firstMeasurementId);
    const status = harness.telemetryService.getTapLatestHardwareStatus(tap.id);
    assert.equal(status.length, 1);
    assert.equal(status[0]?.latestMeasuredAt, "2026-08-14T00:00:00.500Z");
    assert.equal(status[0]?.totalMassG, 1_500);
    assert.equal(harness.tapService.getTap(tap.id).firstUsedAt, firstUsedAt);

    const duplicateAfterRawPrune = harness.telemetryService.ingestSingle(source, 1, {
      measuredAt: firstMeasuredAt,
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(duplicateAfterRawPrune.duplicate, true);
    assert.equal(duplicateAfterRawPrune.acceptedMeasurementId, firstMeasurementId);

    currentTime = new Date("2026-08-14T02:00:00.000Z");
    const receiptPrune = harness.telemetryService.pruneTelemetry();
    assert.equal(receiptPrune.prunedReceiptsCount, 500);
    const finalReceiptPrune = harness.telemetryService.pruneTelemetry();
    assert.equal(finalReceiptPrune.prunedReceiptsCount, 1);
    const expiredReplay = harness.telemetryService.ingestSingle(source, 1, {
      measuredAt: firstMeasuredAt,
      totalWeight: { value: 1_000, unit: "g" },
    });
    assert.equal(expiredReplay.outcome, "rejected");
    assert.equal(expiredReplay.code, "telemetry.stale_timestamp");
  } finally {
    harness.database.close();
  }
});
