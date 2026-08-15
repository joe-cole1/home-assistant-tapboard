import assert from "node:assert/strict";
import { test } from "node:test";

import { listActivity } from "../src/features/activity/repository.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { listOverflowIncidents } from "../src/features/outbox/repository.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { createTapService } from "../src/features/taps/index.ts";
import { registerTapFirstUse } from "../src/features/taps/repository.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import {
  createInitialTelemetryEpochState,
  insertTelemetryEpoch,
  readTelemetryEpochState,
  updateTelemetryEpochState,
} from "../src/features/telemetry/repositories/detector.ts";
import {
  insertTelemetryMeasurement,
  upsertSourceTapStatus,
  upsertTapTelemetryAuthority,
} from "../src/features/telemetry/repository.ts";
import type { CreateTelemetryEpoch } from "../src/features/telemetry/epoch-types.ts";
import {
  HEALTH_CHECK_IDS,
  createHealthService,
  insertHealthIncident,
  insertHealthLeakSample,
  listHealthIncidentTransitions,
  listHealthLeakSampleRecords,
  replaceHealthLeakSamples,
  readHealthCheckState,
  listHealthCheckStates,
  readHealthGlobalConfig,
  readHealthTapOverride,
  resolveHealthIncident,
  toAdminHealthMaintenanceDetail,
  upsertHealthCheckState,
  type HealthActorOptions,
  type HealthServiceOptions,
} from "../src/features/health/index.ts";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function ids(prefix: number): () => string {
  let value = prefix;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function actor(): HealthActorOptions {
  return { actorType: "admin", actorId: "admin-1", sessionId: "session-1" };
}

function setup(
  options: Omit<HealthServiceOptions, "now" | "idFactory"> = {},
  clock: { value: number } = { value: NOW },
) {
  const database = openDatabase(":memory:");
  const tapService = createTapService(database, {
    now: () => new Date(clock.value),
    idFactory: ids(1),
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "Cellar" });
  const health = createHealthService(database, {
    ...options,
    now: () => new Date(clock.value),
    idFactory: ids(100),
  });
  health.onTapCreated(database, tap.id, clock.value);
  return { database, tap, health, tapService, clock };
}

const DAY_MS = 86_400_000;

function enableLineCleaning(health: ReturnType<typeof createHealthService>): void {
  health.updateGlobalConfig(
    { line_cleaning_due: { enabled: true, intervalDays: 14, criticalGraceDays: 7 } },
    actor(),
  );
}

function healthIncidentActivities(database: ReturnType<typeof openDatabase>, transition?: string) {
  return listActivity(database).filter(
    (record) =>
      record.entityType === "health_incident" &&
      record.action === "transition" &&
      (transition === undefined || record.details?.transition === transition),
  );
}

function outboxSnapshot(database: ReturnType<typeof openDatabase>): string {
  return JSON.stringify(listOverflowIncidents(database));
}

void test("health configuration inherits, clears, and does not churn on no-op", () => {
  const { database, tap, health } = setup();
  const before = readHealthGlobalConfig(database);

  health.updateGlobalConfig({}, actor());
  const noOp = readHealthGlobalConfig(database);
  assert.equal(noOp.revision, before.revision);
  assert.equal(noOp.updatedAt, before.updatedAt);

  health.updateGlobalConfig(
    { scale_availability: { degradedAfterMs: 10_000, activeAfterMs: 20_000 } },
    actor(),
  );
  const changed = readHealthGlobalConfig(database);
  assert.equal(changed.revision, before.revision + 1);

  health.updateTapOverride(tap.id, { low_keg: { thresholdPercent: 25 } }, actor());
  assert.equal(readHealthTapOverride(database, tap.id)?.override.low_keg?.thresholdPercent, 25);
  health.updateTapOverride(tap.id, { low_keg: { thresholdPercent: null } }, actor());
  assert.equal(readHealthTapOverride(database, tap.id), undefined);

  assert.deepEqual(
    listHealthCheckStates(database, tap.id).map((state) => state.checkId),
    [...HEALTH_CHECK_IDS],
  );
  database.close();
});

void test("global configuration rejects candidates invalidated by any persisted Tap override atomically", () => {
  const { database, tap, health } = setup();
  try {
    health.updateTapOverride(tap.id, { low_keg: { criticalPercent: 15 } }, actor());
    const beforeLowKeg = readHealthGlobalConfig(database);
    const beforeLowKegActivities = listActivity(database);
    assert.throws(
      () => health.updateGlobalConfig({ low_keg: { thresholdPercent: 10 } }, actor()),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "validation.invalid_value",
    );
    assert.deepEqual(readHealthGlobalConfig(database), beforeLowKeg);
    assert.deepEqual(listActivity(database), beforeLowKegActivities);
    assert.equal(readHealthTapOverride(database, tap.id)?.override.low_keg?.criticalPercent, 15);

    health.updateGlobalConfig({ low_keg: { thresholdPercent: 16 } }, actor());
    assert.equal(readHealthGlobalConfig(database).config.low_keg.thresholdPercent, 16);

    health.updateTapOverride(tap.id, { scale_availability: { activeAfterMs: 600_000 } }, actor());
    const beforeScale = readHealthGlobalConfig(database);
    const beforeScaleActivities = listActivity(database);
    assert.throws(
      () =>
        health.updateGlobalConfig({ scale_availability: { degradedAfterMs: 700_000 } }, actor()),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "validation.invalid_value",
    );
    assert.deepEqual(readHealthGlobalConfig(database), beforeScale);
    assert.deepEqual(listActivity(database), beforeScaleActivities);

    health.updateGlobalConfig({ scale_availability: { degradedAfterMs: 500_000 } }, actor());
    assert.equal(
      readHealthGlobalConfig(database).config.scale_availability.degradedAfterMs,
      500_000,
    );
  } finally {
    database.close();
  }
});

void test("active incidents open once, escalate in place, recover once, and recur after cooldown", () => {
  const clock = { value: NOW };
  const { database, tap, health, tapService } = setup({}, clock);
  try {
    enableLineCleaning(health);
    const firstCleaningAt = new Date(NOW - 14 * DAY_MS).toISOString();
    const firstMaintenance = health.recordMaintenance(
      tap.id,
      { maintenanceType: "line_cleaned", performedAt: firstCleaningAt },
      actor(),
    );
    assert.equal(firstMaintenance.resultingDueAtMs, NOW);

    const opened = health.listIncidents(tap.id, 200);
    assert.equal(opened.length, 1);
    const firstIncident = opened[0]!;
    assert.equal(firstIncident.checkId, "line_cleaning_due");
    assert.equal(firstIncident.currentSeverity, "warning");
    assert.equal(firstIncident.resolvedAtMs, null);
    assert.equal(tapService.getTap(tap.id).firstUsedAt, new Date(NOW).toISOString());
    assert.equal(healthIncidentActivities(database, "opened").length, 1);
    assert.deepEqual(
      listHealthIncidentTransitions(database, firstIncident.id).map(
        (transition) => transition.transitionKind,
      ),
      ["opened"],
    );

    const activityCountBeforeRepeat = listActivity(database).length;
    const outboxBeforeRepeat = outboxSnapshot(database);
    health.evaluateTap(tap.id, NOW);
    assert.equal(health.listIncidents(tap.id, 200).length, 1);
    assert.equal(listHealthIncidentTransitions(database, firstIncident.id).length, 1);
    assert.equal(listActivity(database).length, activityCountBeforeRepeat);
    assert.equal(outboxSnapshot(database), outboxBeforeRepeat);

    const criticalAt = NOW + 7 * DAY_MS;
    health.evaluateTap(tap.id, criticalAt);
    const escalated = health.getIncident(firstIncident.id);
    assert.equal(escalated.id, firstIncident.id);
    assert.equal(escalated.currentSeverity, "critical");
    assert.equal(escalated.maxSeverity, "critical");
    assert.deepEqual(
      listHealthIncidentTransitions(database, firstIncident.id).map(
        (transition) => transition.transitionKind,
      ),
      ["opened", "severity_changed"],
    );
    assert.equal(healthIncidentActivities(database, "severity_changed").length, 1);

    clock.value = criticalAt;
    health.setIncidentCooldown(firstIncident.id, criticalAt + DAY_MS, actor());
    assert.equal(
      readHealthCheckState(database, tap.id, "line_cleaning_due")?.cooldownUntilMs,
      criticalAt + DAY_MS,
    );

    health.recordMaintenance(
      tap.id,
      { maintenanceType: "line_cleaned", performedAt: new Date(criticalAt).toISOString() },
      actor(),
    );
    const recovered = health.getIncident(firstIncident.id);
    assert.equal(recovered.resolvedAtMs, criticalAt);
    assert.equal(recovered.resolutionReason, "line_cleaning_current");
    assert.deepEqual(
      listHealthIncidentTransitions(database, firstIncident.id).map(
        (transition) => transition.transitionKind,
      ),
      ["opened", "severity_changed", "cooldown_changed", "resolved"],
    );
    assert.equal(healthIncidentActivities(database, "resolved").length, 1);

    health.evaluateTap(tap.id, criticalAt);
    assert.equal(listHealthIncidentTransitions(database, firstIncident.id).length, 4);
    assert.equal(healthIncidentActivities(database, "resolved").length, 1);

    const recurrenceAt = criticalAt + 14 * DAY_MS;
    clock.value = recurrenceAt;
    health.evaluateTap(tap.id, recurrenceAt);
    const incidents = health.listIncidents(tap.id, 200);
    assert.equal(incidents.length, 2);
    const recurrent = incidents.find((incident) => incident.resolvedAtMs === null);
    assert.ok(recurrent);
    assert.notEqual(recurrent.id, firstIncident.id);
    assert.equal(recurrent.currentSeverity, "warning");
    assert.equal(healthIncidentActivities(database, "opened").length, 2);
  } finally {
    database.close();
  }
});

void test("maintenance derives a frozen due date, registers first use, and keeps notes out of admin projections", () => {
  const { database, tap, health } = setup();
  health.updateGlobalConfig(
    { line_cleaning_due: { enabled: true, intervalDays: 14, criticalGraceDays: 7 } },
    actor(),
  );
  const performedAt = "2026-07-31T12:00:00.000Z";
  const record = health.recordMaintenance(
    tap.id,
    { maintenanceType: "line_cleaned", performedAt, notes: "private operator note" },
    actor(),
  );
  assert.equal(record.resultingDueAtMs, Date.parse(performedAt) + 14 * 86_400_000);
  assert.equal(
    database
      .prepare<[string], { first_used_at: string | null }>(
        "SELECT first_used_at FROM taps WHERE id=?",
      )
      .get(tap.id)?.first_used_at,
    "2026-08-01T12:00:00.000Z",
  );
  assert.equal(health.getMaintenanceRecord(tap.id, record.id).notes, "private operator note");
  const projection = health.getAdminMaintenancePage(tap.id);
  assert.equal("notes" in (projection.records[0] ?? {}), false);
  assert.equal("raw" in (projection.records[0] ?? {}), false);
  assert.equal(
    JSON.stringify(health.getAdminOverview(tap.id)).includes("private operator note"),
    false,
  );
  assert.equal(
    JSON.stringify(health.getAdminDetail(tap.id)).includes("private operator note"),
    false,
  );
  assert.equal(
    toAdminHealthMaintenanceDetail(health.getMaintenanceRecord(tap.id, record.id)).notes,
    "private operator note",
  );
  database.close();
});

void test("targeted and page projections omit evidence, source identifiers, and maintenance notes", () => {
  const updates: unknown[] = [];
  const { database, tap, health } = setup({
    onTargetedUpdate: (update) => updates.push(update),
  });
  try {
    enableLineCleaning(health);
    const record = health.recordMaintenance(
      tap.id,
      {
        maintenanceType: "line_cleaned",
        performedAt: new Date(NOW).toISOString(),
        notes: "admin-only note",
      },
      actor(),
    );
    const pageJson = JSON.stringify(health.getAdminMaintenancePage(tap.id));
    const overviewJson = JSON.stringify(health.getAdminOverview(tap.id));
    const detailJson = JSON.stringify(health.getAdminDetail(tap.id));
    assert.equal(pageJson.includes("admin-only note"), false);
    assert.equal(overviewJson.includes("admin-only note"), false);
    assert.equal(detailJson.includes("admin-only note"), false);

    const targeted = updates.at(-1) as
      | {
          readonly checks?: readonly Record<string, unknown>[];
        }
      | undefined;
    assert.ok(targeted);
    const targetedJson = JSON.stringify(targeted);
    assert.equal(targetedJson.includes("admin-only note"), false);
    assert.equal(targetedJson.includes("measurementId"), false);
    assert.equal(targetedJson.includes("sourceId"), false);
    assert.equal(
      targeted.checks?.some((check) => Object.hasOwn(check, "evidence")),
      false,
    );
    assert.equal(
      toAdminHealthMaintenanceDetail(health.getMaintenanceRecord(tap.id, record.id)).notes,
      "admin-only note",
    );
  } finally {
    database.close();
  }
});

void test("acknowledgement is idempotent and cooldown is persisted on the matching check", () => {
  const { database, tap, health } = setup();
  const incidentId = "00000000-0000-4000-8000-000000000200";
  upsertHealthCheckState(database, {
    tapId: tap.id,
    checkId: "low_keg",
    state: "active",
    severity: "warning",
    reason: "below_threshold",
    evidence: { reason: "below_threshold" },
    conditionStartedAtMs: NOW - 30_000,
    lastObservationAtMs: null,
    suppressionUntilMs: null,
    cooldownUntilMs: null,
    evaluatedAtMs: NOW,
    updatedAt: new Date(NOW).toISOString(),
  });
  insertHealthIncident(database, {
    id: incidentId,
    tapId: tap.id,
    checkId: "low_keg",
    openedAtMs: NOW,
    severity: "warning",
    reason: "below_threshold",
    evidence: { reason: "below_threshold" },
    updatedAt: new Date(NOW).toISOString(),
  });

  const acknowledged = health.acknowledgeIncident(incidentId, actor());
  assert.equal(acknowledged.acknowledgedAtMs, NOW);
  const repeated = health.acknowledgeIncident(incidentId, actor());
  assert.equal(repeated.revision, acknowledged.revision);

  health.setIncidentCooldown(incidentId, new Date(NOW + 24 * 60 * 60_000), actor());
  assert.equal(
    listHealthCheckStates(database, tap.id).find((state) => state.checkId === "low_keg")
      ?.cooldownUntilMs,
    NOW + 24 * 60 * 60_000,
  );
  assert.equal(readHealthCheckState(database, tap.id, "low_keg")?.state, "active");
  assert.throws(
    () => health.setIncidentCooldown(incidentId, NOW + 31 * DAY_MS, actor()),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === "validation.invalid_value",
  );
  health.setIncidentCooldown(incidentId, null, actor());
  const cleared = readHealthCheckState(database, tap.id, "low_keg");
  assert.equal(cleared?.cooldownUntilMs, null);
  assert.equal(cleared?.state, "active");
  database.close();
});

void test("failed incident callbacks roll back the incident, health state, and first use atomically", () => {
  const { database, tap, health, tapService } = setup({
    onIncidentOpened: () => {
      throw new Error("incident callback failed");
    },
  });
  try {
    enableLineCleaning(health);
    assert.throws(
      () =>
        health.recordMaintenance(
          tap.id,
          {
            maintenanceType: "line_cleaned",
            performedAt: new Date(NOW - 14 * DAY_MS).toISOString(),
          },
          actor(),
        ),
      /incident callback failed/,
    );
    assert.equal(health.listIncidents(tap.id, 200).length, 0);
    assert.equal(health.getMaintenanceHistory(tap.id).records.length, 0);
    assert.equal(tapService.getTap(tap.id).firstUsedAt, null);
    assert.equal(
      readHealthCheckState(database, tap.id, "line_cleaning_due")?.state,
      "not_configured",
    );
    assert.equal(healthIncidentActivities(database).length, 0);
  } finally {
    database.close();
  }
});

void test("failed maintenance callbacks roll back maintenance, first use, and Activity atomically", () => {
  const { database, tap, health, tapService } = setup({
    onMaintenanceRecorded: () => {
      throw new Error("maintenance callback failed");
    },
  });
  try {
    assert.throws(
      () =>
        health.recordMaintenance(
          tap.id,
          { maintenanceType: "other", performedAt: new Date(NOW).toISOString() },
          actor(),
        ),
      /maintenance callback failed/,
    );
    assert.equal(health.getMaintenanceHistory(tap.id).records.length, 0);
    assert.equal(tapService.getTap(tap.id).firstUsedAt, null);
    assert.equal(
      listActivity(database).some((record) => record.entityType === "tap_line_maintenance"),
      false,
    );
  } finally {
    database.close();
  }
});

void test("retired Taps resolve incidents, clear leak samples, and leave disabled Taps evaluating", () => {
  const { database, tap, health, tapService } = setup();
  try {
    const incidentId = "00000000-0000-4000-8000-000000000300";
    insertHealthIncident(database, {
      id: incidentId,
      tapId: tap.id,
      checkId: "suspected_leak",
      openedAtMs: NOW,
      severity: "warning",
      reason: "leak_threshold",
      evidence: { reason: "leak_threshold", lossMl: 300 },
      updatedAt: new Date(NOW).toISOString(),
    });
    insertHealthLeakSample(database, {
      tapId: tap.id,
      measurementId: "00000000-0000-4000-8000-000000000301",
      epochId: "00000000-0000-4000-8000-000000000302",
      atMs: NOW,
      volumeMl: 500,
      createdAt: new Date(NOW).toISOString(),
    });
    assert.equal(listHealthLeakSampleRecords(database, tap.id).length, 1);

    tapService.retireTap(tap.id, { reason: "decommissioned" });
    const retired = health.evaluateTap(tap.id, NOW + 1_000);
    assert.deepEqual(
      retired.checks.map((check) => [check.state, check.reason]),
      HEALTH_CHECK_IDS.map(() => ["not_configured", "tap_retired"]),
    );
    assert.equal(health.getIncident(incidentId).resolvedAtMs, NOW + 1_000);
    assert.equal(health.getIncident(incidentId).resolutionReason, "tap_retired");
    assert.equal(listHealthLeakSampleRecords(database, tap.id).length, 0);

    const disabled = tapService.createTap({ tapNumber: 2, name: "Disabled", enabled: false });
    health.onTapCreated(database, disabled.id, NOW);
    const disabledEvaluation = health.evaluateTap(disabled.id, NOW);
    assert.equal(tapService.getTap(disabled.id).isRetired, false);
    assert.equal(disabledEvaluation.checks.length, HEALTH_CHECK_IDS.length);
    assert.equal(
      disabledEvaluation.checks.some((check) => check.reason === "tap_retired"),
      false,
    );
    assert.equal(
      disabledEvaluation.checks.find((check) => check.checkId === "scale_availability")?.reason,
      "no_authority",
    );
  } finally {
    database.close();
  }
});

void test("leak sample replacement and legacy reads retain the oldest anchor within the hard bound", () => {
  const { database, tap } = setup();
  const nextId = ids(1_300);
  try {
    const samples = Array.from({ length: 70 }, (_, index) => ({
      tapId: tap.id,
      measurementId: nextId(),
      epochId: "00000000-0000-4000-8000-000000001301",
      atMs: NOW + index,
      volumeMl: 19_000 - index,
      createdAt: new Date(NOW + index).toISOString(),
    }));
    for (const sample of samples) insertHealthLeakSample(database, sample);

    const legacyRead = listHealthLeakSampleRecords(database, tap.id, 64);
    assert.equal(legacyRead.length, 64);
    assert.equal(legacyRead[0]?.measurementId, samples[0]?.measurementId);
    assert.equal(legacyRead.at(-1)?.measurementId, samples.at(-1)?.measurementId);
    assert.equal(
      listHealthLeakSampleRecords(database, tap.id, 1)[0]?.measurementId,
      samples[0]?.measurementId,
    );

    replaceHealthLeakSamples(database, tap.id, samples);
    const replaced = listHealthLeakSampleRecords(database, tap.id);
    assert.equal(replaced.length, 64);
    assert.equal(replaced[0]?.measurementId, samples[0]?.measurementId);
    assert.equal(replaced.at(-1)?.measurementId, samples[63]?.measurementId);
  } finally {
    database.close();
  }
});

void test("epoch state isolates health measurement evidence from a prior source status", () => {
  const { database, tap, health } = setup();
  const nextId = ids(700);
  const sourceId = nextId();
  const keyId = nextId();
  const beverageId = nextId();
  const kegId = nextId();
  const fillId = nextId();
  const assignmentId = nextId();
  const epochId = nextId();
  const priorMeasurementId = nextId();
  const currentMeasurementId = nextId();
  const priorAtMs = NOW - 31 * 60_000;
  const evaluationAtMs = NOW;
  const epochStartedAtMs = NOW - 30_000;
  const priorAt = new Date(priorAtMs).toISOString();
  const evaluationAt = new Date(evaluationAtMs).toISOString();
  const epochStartedAt = new Date(epochStartedAtMs).toISOString();
  try {
    const execute = (sql: string, ...parameters: unknown[]) =>
      database.prepare<unknown[]>(sql).run(...parameters);
    execute(
      "INSERT INTO machine_api_keys (id,public_id,verification_digest,label,created_at) VALUES (?, ?, zeroblob(32), ?, ?)",
      keyId,
      "previous-key-000",
      "Previous source key",
      priorAt,
    );
    execute(
      "INSERT INTO telemetry_sources (id,name,current_machine_key_id,created_at,updated_at) VALUES (?, ?, ?, ?, ?)",
      sourceId,
      "Previous source",
      keyId,
      priorAt,
      priorAt,
    );
    execute(
      "INSERT INTO beverages (id,ownership_type,created_at,updated_at) VALUES (?, ?, ?, ?)",
      beverageId,
      "custom",
      priorAt,
      priorAt,
    );
    execute(
      "INSERT INTO kegs (id,keg_number,capacity_ml,current_tare_g,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      kegId,
      1,
      19_000,
      4_000,
      priorAt,
      priorAt,
    );
    execute(
      "INSERT INTO fills (id,beverage_id,keg_id,fill_date,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      fillId,
      beverageId,
      kegId,
      "2026-08-01",
      priorAt,
      priorAt,
    );
    execute(
      "INSERT INTO tap_assignment_lifecycles (id,tap_id,fill_id,assigned_at,created_at) VALUES (?, ?, ?, ?, ?)",
      assignmentId,
      tap.id,
      fillId,
      epochStartedAt,
      epochStartedAt,
    );
    upsertTapTelemetryAuthority(database, tap.id, sourceId, priorAt);
    insertTelemetryMeasurement(database, {
      id: priorMeasurementId,
      source_id: sourceId,
      tap_id: tap.id,
      measured_at: evaluationAt,
      measured_at_epoch_ms: evaluationAtMs,
      received_at: evaluationAt,
      normalization_version: 1,
      primary_kind: "remaining_volume",
      total_mass_g: null,
      remaining_volume_ml: 15_000,
      fill_percentage: null,
      temperature_c: 4,
      captured_assignment_id: null,
      captured_fill_id: null,
      created_at: priorAt,
    });
    upsertSourceTapStatus(database, {
      source_id: sourceId,
      tap_id: tap.id,
      latest_measurement_id: priorMeasurementId,
      latest_measured_at: evaluationAt,
      latest_measured_at_epoch_ms: evaluationAtMs,
      latest_received_at: evaluationAt,
      normalization_version: 1,
      primary_kind: "remaining_volume",
      total_mass_g: null,
      remaining_volume_ml: 15_000,
      fill_percentage: null,
      temperature_c: 4,
      captured_assignment_id: null,
      captured_fill_id: null,
      updated_at: evaluationAt,
    });
    const epoch: CreateTelemetryEpoch = {
      id: epochId,
      tapId: tap.id,
      sourceId,
      fillId,
      assignmentId,
      kegId,
      capacityMl: 19_000,
      tareG: 4_000,
      densityGPerMl: 1.008,
      densitySource: "fallback_fg",
      normalizationVersion: 1,
      detectorConfigVersion: "health-regression",
      globalConfigRevision: 1,
      tapOverrideRevision: null,
      arbitrationGroupId: null,
      config: DEFAULT_DETECTOR_CONFIG,
      startedAt: epochStartedAt,
      startedAtEpochMs: epochStartedAtMs,
    };
    insertTelemetryEpoch(database, epoch);
    createInitialTelemetryEpochState(database, epoch.id, epochStartedAt);
    const initialState = readTelemetryEpochState(database, epoch.id);
    if (initialState === undefined) throw new Error("detector state fixture was not created");
    updateTelemetryEpochState(database, {
      ...initialState,
      phase: "ready",
      lastStabilizedVolumeMl: 15_000,
      lastPublicVolumeMl: 15_000,
      lastDiagnosticCode: "ok",
      updatedAt: epochStartedAt,
    });
    health.updateGlobalConfig({ serving_temperature: { enabled: true } }, actor());

    const withoutCurrentEpochSample = health.evaluateTap(tap.id, evaluationAtMs);
    const scaleWithoutSample = withoutCurrentEpochSample.checks.find(
      (check) => check.checkId === "scale_availability",
    );
    const temperatureWithoutSample = withoutCurrentEpochSample.checks.find(
      (check) => check.checkId === "serving_temperature",
    );
    assert.equal(scaleWithoutSample?.state, "healthy");
    assert.equal(scaleWithoutSample?.reason, "scale_fresh");
    assert.equal(
      health
        .listIncidents(tap.id, 200)
        .some(
          (incident) => incident.checkId === "scale_availability" && incident.resolvedAtMs === null,
        ),
      false,
    );
    assert.equal(temperatureWithoutSample?.state, "degraded");
    assert.equal(temperatureWithoutSample?.reason, "temperature_invalid");

    database.prepare<[string]>("DELETE FROM telemetry_epoch_state WHERE epoch_id=?").run(epoch.id);
    const withoutEpochState = health.evaluateTap(tap.id, evaluationAtMs);
    assert.equal(
      withoutEpochState.checks.find((check) => check.checkId === "scale_availability")?.reason,
      "scale_fresh",
    );
    assert.equal(
      withoutEpochState.checks.find((check) => check.checkId === "serving_temperature")?.reason,
      "temperature_invalid",
    );
    createInitialTelemetryEpochState(database, epoch.id, epochStartedAt);

    insertTelemetryMeasurement(database, {
      id: currentMeasurementId,
      source_id: sourceId,
      tap_id: tap.id,
      measured_at: evaluationAt,
      measured_at_epoch_ms: evaluationAtMs,
      received_at: evaluationAt,
      normalization_version: 1,
      primary_kind: "remaining_volume",
      total_mass_g: null,
      remaining_volume_ml: 15_000,
      fill_percentage: null,
      temperature_c: 4,
      captured_assignment_id: assignmentId,
      captured_fill_id: fillId,
      created_at: evaluationAt,
    });
    upsertSourceTapStatus(database, {
      source_id: sourceId,
      tap_id: tap.id,
      latest_measurement_id: currentMeasurementId,
      latest_measured_at: evaluationAt,
      latest_measured_at_epoch_ms: evaluationAtMs,
      latest_received_at: evaluationAt,
      normalization_version: 1,
      primary_kind: "remaining_volume",
      total_mass_g: null,
      remaining_volume_ml: 15_000,
      fill_percentage: null,
      temperature_c: 4,
      captured_assignment_id: assignmentId,
      captured_fill_id: fillId,
      updated_at: evaluationAt,
    });
    const currentState = readTelemetryEpochState(database, epoch.id);
    if (currentState === undefined) throw new Error("detector state fixture disappeared");
    updateTelemetryEpochState(database, {
      ...currentState,
      phase: "ready",
      lastMeasurementId: currentMeasurementId,
      lastMeasuredAtMs: evaluationAtMs,
      lastPrimaryKind: "remaining_volume",
      lastPrimaryValue: 15_000,
      lastInterpretedVolumeMl: 15_000,
      lastStabilizedVolumeMl: 15_000,
      lastPublicVolumeMl: 15_000,
      lastTemperatureC: 4,
      lastDiagnosticCode: "ok",
      updatedAt: evaluationAt,
    });
    const withCurrentEpochSample = health.evaluateTap(tap.id, evaluationAtMs);
    assert.equal(
      withCurrentEpochSample.checks.find((check) => check.checkId === "scale_availability")?.reason,
      "scale_fresh",
    );
    assert.equal(
      withCurrentEpochSample.checks.find((check) => check.checkId === "serving_temperature")
        ?.reason,
      "temperature_normal",
    );
  } finally {
    database.close();
  }
});

void test("resolved incident retention prunes at most 100 per pass and preserves open incidents and first use", () => {
  const { database, tap, health, tapService } = setup();
  try {
    registerTapFirstUse(database, tap.id, new Date(NOW - 400 * DAY_MS).toISOString());
    for (let index = 0; index < 101; index += 1) {
      const id = `00000000-0000-4000-8000-${String(1_000 + index).padStart(12, "0")}`;
      const incident = insertHealthIncident(database, {
        id,
        tapId: tap.id,
        checkId: "low_keg",
        openedAtMs: NOW - 400 * DAY_MS - index,
        severity: "warning",
        reason: "below_threshold",
        evidence: { reason: "below_threshold" },
        updatedAt: new Date(NOW - 400 * DAY_MS - index).toISOString(),
      });
      resolveHealthIncident(
        database,
        incident.id,
        NOW - 366 * DAY_MS - index,
        "below_threshold",
        new Date(NOW - 366 * DAY_MS - index).toISOString(),
      );
    }
    insertHealthIncident(database, {
      id: "00000000-0000-4000-8000-000000001200",
      tapId: tap.id,
      checkId: "scale_availability",
      openedAtMs: NOW,
      severity: "warning",
      reason: "scale_unavailable",
      evidence: { reason: "scale_unavailable" },
      updatedAt: new Date(NOW).toISOString(),
    });
    assert.equal(health.listIncidents(tap.id, 200).length, 102);

    assert.equal(health.pruneResolvedIncidents(NOW), 100);
    const afterFirstPass = health.listIncidents(tap.id, 200);
    assert.equal(afterFirstPass.length, 2);
    assert.equal(afterFirstPass.filter((incident) => incident.resolvedAtMs === null).length, 1);
    assert.equal(health.pruneResolvedIncidents(NOW), 1);
    const remaining = health.listIncidents(tap.id, 200);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.resolvedAtMs, null);
    assert.equal(tapService.getTap(tap.id).firstUsedAt, new Date(NOW - 400 * DAY_MS).toISOString());
  } finally {
    database.close();
  }
});
