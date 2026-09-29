import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import {
  createInitialTelemetryEpochState,
  insertCompletedPourIdempotently,
  insertTelemetryEpoch,
} from "../src/features/telemetry/repositories/detector.ts";
import {
  openDatabase,
  type DatabaseConnection,
} from "../src/infrastructure/database/connection.ts";
import {
  BUILTIN_SIMULATION_MIGRATION,
  BUILTIN_SIMULATION_MIGRATION_NAME,
  BUILTIN_SIMULATION_SCHEMA_VERSION,
  initializeSchema,
  MIGRATIONS,
  type MigrationDefinition,
} from "../src/infrastructure/database/migrations.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const ids = {
  tap: "00000000-0000-4000-8000-000000000001",
  source: "00000000-0000-4000-8000-000000000002",
  key: "00000000-0000-4000-8000-000000000003",
  keg: "00000000-0000-4000-8000-000000000004",
  beverage: "00000000-0000-4000-8000-000000000005",
  fill: "00000000-0000-4000-8000-000000000006",
  assignment: "00000000-0000-4000-8000-000000000007",
  epoch: "00000000-0000-4000-8000-000000000008",
  pour: "00000000-0000-4000-8000-000000000009",
};

function makeDatabasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-simulation-migration-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite3");
}

function seedSensorOwners(database: DatabaseConnection): void {
  database.execute(`
    INSERT INTO taps (id, tap_number, name, created_at, updated_at)
    VALUES ('${ids.tap}', 1, 'Existing Tap', '${timestamp}', '${timestamp}');
    INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
    VALUES ('${ids.key}', 'simulation-key-1', zeroblob(32), 'Existing source', '${timestamp}');
    INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
    VALUES ('${ids.source}', 'Existing source', '${ids.key}', '${timestamp}', '${timestamp}');
  `);
}

function seedDomainHistory(database: DatabaseConnection): void {
  seedSensorOwners(database);
  database.execute(`
    INSERT INTO kegs (id, keg_number, capacity_ml, current_tare_g, created_at, updated_at)
    VALUES ('${ids.keg}', 1, 19000, 4000, '${timestamp}', '${timestamp}');
    INSERT INTO beverages (id, ownership_type, created_at, updated_at)
    VALUES ('${ids.beverage}', 'custom', '${timestamp}', '${timestamp}');
    INSERT INTO custom_beverage_profiles (beverage_id, name, beverage_type, created_at, updated_at)
    VALUES ('${ids.beverage}', 'Existing beer', 'beer', '${timestamp}', '${timestamp}');
    INSERT INTO fills (id, beverage_id, keg_id, fill_date, created_at, updated_at)
    VALUES ('${ids.fill}', '${ids.beverage}', '${ids.keg}', '2026-01-01', '${timestamp}', '${timestamp}');
    INSERT INTO fill_display_preferences (fill_id, featured, updated_at)
    VALUES ('${ids.fill}', 1, '${timestamp}');
    INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, created_at)
    VALUES ('${ids.assignment}', '${ids.tap}', '${ids.fill}', '${timestamp}', '${timestamp}');
    INSERT INTO activity_log (id, category, action, actor_type, entity_type, entity_id, occurred_at)
    VALUES ('existing-activity', 'domain', 'fill.assigned', 'admin', 'fill', '${ids.fill}', '${timestamp}');
  `);
  insertTelemetryEpoch(database, {
    id: ids.epoch,
    tapId: ids.tap,
    sourceId: ids.source,
    fillId: ids.fill,
    assignmentId: ids.assignment,
    kegId: ids.keg,
    capacityMl: 19000,
    tareG: 4000,
    densityGPerMl: 1.01,
    densitySource: "fallback_fg",
    normalizationVersion: 1,
    detectorConfigVersion: "1:none",
    globalConfigRevision: 1,
    tapOverrideRevision: null,
    arbitrationGroupId: null,
    config: DEFAULT_DETECTOR_CONFIG,
    startedAt: timestamp,
    startedAtEpochMs: Date.parse(timestamp),
  });
  createInitialTelemetryEpochState(database, ids.epoch, timestamp);
  insertCompletedPourIdempotently(database, {
    id: ids.pour,
    effectKey: "existing-pour",
    fillId: ids.fill,
    tapId: ids.tap,
    assignmentId: ids.assignment,
    epochId: ids.epoch,
    detectorSessionId: "existing-session",
    canonicalVolumeMl: 355,
    startedAt: timestamp,
    completedAt: "2026-01-01T00:00:10.000Z",
    createdAt: "2026-01-01T00:00:10.000Z",
  });
}

function snapshotExistingRows(database: DatabaseConnection): Record<string, unknown[]> {
  const tables = database
    .prepare<[], { readonly name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'simulation_settings', 'simulation_sensors', 'simulation_fill_volumes') ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    ]),
  );
}

function readSettings(database: DatabaseConnection): unknown {
  return database.prepare("SELECT * FROM simulation_settings").all();
}

function readSensors(database: DatabaseConnection): unknown {
  return database.prepare("SELECT * FROM simulation_sensors ORDER BY tap_id").all();
}

function readFillVolumes(database: DatabaseConnection): unknown {
  return database.prepare("SELECT * FROM simulation_fill_volumes ORDER BY fill_id").all();
}

void test("v20 upgrades to v21 without changing existing domain, pour history, or settings", (context) => {
  const path = makeDatabasePath(context);
  const previous = openDatabase(path, { migrations: MIGRATIONS.slice(0, 20) });
  let before: Record<string, unknown[]>;
  try {
    seedDomainHistory(previous);
    before = snapshotExistingRows(previous);
    assert.equal(before.pours?.length, 1);
  } finally {
    previous.close();
  }

  const upgraded = openDatabase(path);
  try {
    assert.equal(
      upgraded.pragma<number>("user_version", { simple: true }),
      BUILTIN_SIMULATION_SCHEMA_VERSION,
    );
    assert.deepEqual(snapshotExistingRows(upgraded), before);
    assert.deepEqual(readSettings(upgraded), [
      { singleton: 1, enabled: 0, revision: 0, seeded: 0 },
    ]);
    assert.deepEqual(readSensors(upgraded), []);
    assert.deepEqual(readFillVolumes(upgraded), []);
    assert.deepEqual(
      upgraded.prepare("SELECT version, name FROM schema_migrations WHERE version = 21").get(),
      { version: 21, name: BUILTIN_SIMULATION_MIGRATION_NAME },
    );
    upgraded.execute(`
      UPDATE simulation_settings SET enabled = 1, revision = 7, seeded = 1 WHERE singleton = 1;
      INSERT INTO simulation_sensors
        (tap_id, source_id, remaining_ml, temperature_c, online, noise_enabled, sequence)
      VALUES ('${ids.tap}', '${ids.source}', 12345.5, 6.25, 0, 1, 42);
      INSERT INTO simulation_fill_volumes (fill_id, remaining_ml)
      VALUES ('${ids.fill}', 12345.5);
    `);
  } finally {
    upgraded.close();
  }

  const reopened = openDatabase(path);
  try {
    assert.deepEqual(snapshotExistingRows(reopened), before);
    assert.deepEqual(readSettings(reopened), [
      { singleton: 1, enabled: 1, revision: 7, seeded: 1 },
    ]);
    assert.deepEqual(readSensors(reopened), [
      {
        tap_id: ids.tap,
        source_id: ids.source,
        remaining_ml: 12345.5,
        temperature_c: 6.25,
        online: 0,
        noise_enabled: 1,
        sequence: 42,
      },
    ]);
    assert.deepEqual(readFillVolumes(reopened), [{ fill_id: ids.fill, remaining_ml: 12345.5 }]);
    assert.equal(
      reopened
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM schema_migrations")
        .get()?.count,
      21,
    );
  } finally {
    reopened.close();
  }
});

void test("simulation sensor defaults, references, and state constraints are enforced", () => {
  const database = openDatabase(":memory:");
  try {
    seedSensorOwners(database);
    const insert = database.prepare<[string, string, number]>(
      "INSERT INTO simulation_sensors (tap_id, source_id, remaining_ml) VALUES (?, ?, ?)",
    );
    assert.throws(() => insert.run("missing-tap", ids.source, 100), /FOREIGN KEY constraint/);
    assert.throws(() => insert.run(ids.tap, "missing-source", 100), /FOREIGN KEY constraint/);
    insert.run(ids.tap, ids.source, 100);
    assert.deepEqual(readSensors(database), [
      {
        tap_id: ids.tap,
        source_id: ids.source,
        remaining_ml: 100,
        temperature_c: 4,
        online: 1,
        noise_enabled: 0,
        sequence: 0,
      },
    ]);
    assert.throws(() => insert.run(ids.tap, ids.source, 100), /UNIQUE constraint/);
    for (const assignment of [
      "singleton = 2",
      "enabled = 2",
      "enabled = NULL",
      "seeded = -1",
      "seeded = NULL",
      "revision = -1",
      "revision = 0.5",
      "revision = 'invalid'",
      "revision = NULL",
    ]) {
      assert.throws(
        () => database.execute(`UPDATE simulation_settings SET ${assignment} WHERE singleton = 1`),
        /CHECK constraint|NOT NULL constraint/,
        assignment,
      );
    }
    for (const assignment of [
      "remaining_ml = -1",
      "remaining_ml = 'invalid'",
      "remaining_ml = NULL",
      "temperature_c = -20.01",
      "temperature_c = 80.01",
      "temperature_c = 'invalid'",
      "online = 2",
      "noise_enabled = -1",
      "sequence = -1",
      "sequence = 0.5",
      "sequence = 'invalid'",
    ]) {
      assert.throws(
        () => database.execute(`UPDATE simulation_sensors SET ${assignment}`),
        /CHECK constraint|NOT NULL constraint/,
        assignment,
      );
    }
    database.execute("UPDATE simulation_sensors SET remaining_ml = 0, temperature_c = -20");
    database.execute("UPDATE simulation_sensors SET temperature_c = 80");
    assert.throws(
      () =>
        database.prepare<[string]>("DELETE FROM telemetry_sources WHERE id = ?").run(ids.source),
      /FOREIGN KEY constraint/,
    );
    database.prepare<[string]>("DELETE FROM taps WHERE id = ?").run(ids.tap);
    assert.deepEqual(readSensors(database), []);
  } finally {
    database.close();
  }
});

void test("simulation Fill volumes enforce ownership, finite nonnegative values, and deletion cascades", () => {
  const database = openDatabase(":memory:");
  try {
    seedDomainHistory(database);
    const insert = database.prepare<[string, number]>(
      "INSERT INTO simulation_fill_volumes (fill_id, remaining_ml) VALUES (?, ?)",
    );
    assert.throws(() => insert.run("missing-fill", 100), /FOREIGN KEY constraint/);
    insert.run(ids.fill, 100);
    assert.throws(() => insert.run(ids.fill, 200), /UNIQUE constraint/);
    const update = database.prepare<[number | string | null]>(
      "UPDATE simulation_fill_volumes SET remaining_ml = ?",
    );
    for (const remainingMl of [-1, Infinity, -Infinity, NaN, "invalid", null]) {
      assert.throws(
        () => update.run(remainingMl),
        /CHECK constraint|NOT NULL constraint/,
        String(remainingMl),
      );
    }
    for (const remainingMl of [0, 123.45, Number.MAX_VALUE]) {
      update.run(remainingMl);
      assert.deepEqual(readFillVolumes(database), [
        { fill_id: ids.fill, remaining_ml: remainingMl },
      ]);
    }
    database.prepare<[string]>("DELETE FROM fills WHERE id = ?").run(ids.fill);
    assert.deepEqual(readFillVolumes(database), []);
  } finally {
    database.close();
  }
});

void test("v21 rejects altered simulation DDL and missing singleton state on reopen", async (context) => {
  const cases = [
    {
      name: "missing settings singleton",
      sql: "DELETE FROM simulation_settings WHERE singleton = 1",
      error: /required simulation_settings state is missing/,
    },
    {
      name: "weakened sensor table",
      sql: "DROP TABLE simulation_sensors; CREATE TABLE simulation_sensors (tap_id TEXT PRIMARY KEY, source_id TEXT, remaining_ml REAL)",
      error: /simulation_sensors has invalid DDL/,
    },
    {
      name: "weakened settings table",
      sql: "DROP TABLE simulation_settings; CREATE TABLE simulation_settings (singleton INTEGER PRIMARY KEY, enabled INTEGER, revision INTEGER, seeded INTEGER); INSERT INTO simulation_settings VALUES (1, 0, 0, 0)",
      error: /simulation_settings has invalid DDL/,
    },
    {
      name: "missing Fill volume table",
      sql: "DROP TABLE simulation_fill_volumes",
      error: /schema objects do not match/,
    },
    {
      name: "weakened Fill volume table",
      sql: "DROP TABLE simulation_fill_volumes; CREATE TABLE simulation_fill_volumes (fill_id TEXT PRIMARY KEY REFERENCES fills(id) ON DELETE CASCADE, remaining_ml REAL NOT NULL)",
      error: /simulation_fill_volumes has invalid DDL/,
    },
  ] as const;
  for (const entry of cases) {
    await context.test(entry.name, (subcontext) => {
      const path = makeDatabasePath(subcontext);
      const database = openDatabase(path);
      try {
        database.execute(entry.sql);
      } finally {
        database.close();
      }
      assert.throws(() => openDatabase(path), entry.error);
    });
  }
});

void test("an incompatible v20 schema fails before any v21 state is created", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 20) });
  try {
    database.execute("DROP TABLE fill_display_preferences");
    assert.throws(() => initializeSchema(database, MIGRATIONS), /schema objects do not match/);
    assert.equal(database.pragma<number>("user_version", { simple: true }), 20);
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('simulation_settings', 'simulation_sensors', 'simulation_fill_volumes')",
        )
        .all(),
      [],
    );
    assert.equal(
      database.prepare("SELECT version FROM schema_migrations WHERE version = 21").get(),
      undefined,
    );
  } finally {
    database.close();
  }
});

void test("a failed v21 migration rolls back tables, seeded state, and the migration ledger", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 20) });
  try {
    seedDomainHistory(database);
    const before = snapshotExistingRows(database);
    const failingMigration: MigrationDefinition = {
      version: 21,
      name: "test-failing-simulation",
      apply(transaction) {
        BUILTIN_SIMULATION_MIGRATION.apply(transaction);
        throw new Error("injected simulation migration failure");
      },
    };
    assert.throws(
      () => initializeSchema(database, [...MIGRATIONS.slice(0, 20), failingMigration]),
      /injected simulation migration failure/,
    );
    assert.equal(database.pragma<number>("user_version", { simple: true }), 20);
    assert.deepEqual(snapshotExistingRows(database), before);
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('simulation_settings', 'simulation_sensors', 'simulation_fill_volumes')",
        )
        .all(),
      [],
    );
    assert.equal(
      database.prepare("SELECT version FROM schema_migrations WHERE version = 21").get(),
      undefined,
    );
    initializeSchema(database, MIGRATIONS);
    assert.deepEqual(readSettings(database), [
      { singleton: 1, enabled: 0, revision: 0, seeded: 0 },
    ]);
  } finally {
    database.close();
  }
});
