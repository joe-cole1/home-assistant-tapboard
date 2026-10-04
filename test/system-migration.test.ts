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
  initializeSchema,
  MIGRATIONS,
  SYSTEM_ADMINISTRATION_MIGRATION,
  SYSTEM_ADMINISTRATION_MIGRATION_NAME,
  SYSTEM_ADMINISTRATION_SCHEMA_VERSION,
  type MigrationDefinition,
} from "../src/infrastructure/database/migrations.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const epochTimestamp = "1970-01-01T00:00:00.000Z";
const updatedTimestamp = "2026-09-30T00:00:00.000Z";
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
const newTableNames = ["auth_session_settings", "outbox_retention"] as const;

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
}

interface SessionSettingsRow {
  readonly id: number;
  readonly inactivity_ms: number | null;
  readonly absolute_ms: number | null;
  readonly revision: number;
  readonly updated_at: string;
}

interface OutboxRetentionRow {
  readonly id: number;
  readonly retention_days: number;
  readonly revision: number;
  readonly updated_at: string;
}

type SqlValue = number | string | null | Buffer;

function makeDatabasePath(context: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "tapboard-system-migration-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite3");
}

function readSchema(database: DatabaseConnection): SchemaObjectRow[] {
  return database
    .prepare<[], SchemaObjectRow>(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function readLedger(database: DatabaseConnection): LedgerRow[] {
  return database
    .prepare<[], LedgerRow>(
      "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    )
    .all();
}

function snapshotRows(
  database: DatabaseConnection,
  excludedTables: readonly string[] = [],
): Record<string, unknown[]> {
  const tables = readSchema(database).filter(
    ({ type, name }) => type === "table" && !excludedTables.includes(name),
  );
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    ]),
  );
}

function readSessionSettings(database: DatabaseConnection): SessionSettingsRow[] {
  return database.prepare<[], SessionSettingsRow>("SELECT * FROM auth_session_settings").all();
}

function readOutboxRetention(database: DatabaseConnection): OutboxRetentionRow[] {
  return database.prepare<[], OutboxRetentionRow>("SELECT * FROM outbox_retention").all();
}

function assertDefaultSettings(database: DatabaseConnection): void {
  assert.deepEqual(readSessionSettings(database), [
    { id: 1, inactivity_ms: null, absolute_ms: null, revision: 0, updated_at: epochTimestamp },
  ]);
  assert.deepEqual(readOutboxRetention(database), [
    { id: 1, retention_days: 30, revision: 0, updated_at: epochTimestamp },
  ]);
}

function assertNoSystemMigration(database: DatabaseConnection): void {
  assert.equal(database.pragma<number>("user_version", { simple: true }), 21);
  assert.deepEqual(
    readSchema(database).filter(({ name }) => newTableNames.some((table) => table === name)),
    [],
  );
  assert.equal(readLedger(database).length, 21);
  assert.equal(
    database.prepare("SELECT version FROM schema_migrations WHERE version = 22").get(),
    undefined,
  );
}

function seedExistingState(database: DatabaseConnection): void {
  database.execute(`
    INSERT INTO admin_credentials
      (id, verifier_version, scrypt_n, scrypt_r, scrypt_p, scrypt_key_length,
       salt, verifier, revision, created_at, updated_at)
    VALUES (1, 1, 16384, 8, 1, 32, zeroblob(16), zeroblob(32), 4, '${timestamp}', '${timestamp}');
    INSERT INTO admin_sessions
      (id, session_digest, csrf_digest, credential_revision, created_at, last_used_at,
       expires_at, absolute_expires_at)
    VALUES ('existing-session', zeroblob(32), zeroblob(32), 4, '${timestamp}', '${timestamp}',
      '2026-01-02T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    UPDATE login_throttle SET generation = 5, attempt_sequence = 9,
      window_started_at = '${timestamp}', attempt_count = 3 WHERE id = 1;
    UPDATE activity_retention SET retention_days = 17, updated_at = '${timestamp}' WHERE id = 1;
    UPDATE beverage_settings SET fallback_fg = 1.011, updated_at = '${timestamp}' WHERE id = 1;
    UPDATE forecast_settings SET serving_size_ml = 500, updated_at = '${timestamp}' WHERE id = 1;
    INSERT INTO encrypted_secrets
      (id, integration_type, record_id, field_name, envelope_version, nonce,
       ciphertext, auth_tag, revision, created_at, updated_at)
    VALUES ('existing-secret', 'webhook', 'existing-destination', 'authorization', 1,
      zeroblob(12), zeroblob(8), zeroblob(16), 3, '${timestamp}', '${timestamp}');
    INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at)
    VALUES ('${ids.key}', 'system-fixture-1', zeroblob(32), 'Existing source', '${timestamp}');
    INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at)
    VALUES ('${ids.source}', 'Existing source', '${ids.key}', '${timestamp}', '${timestamp}');
    INSERT INTO taps (id, tap_number, name, first_used_at, created_at, updated_at)
    VALUES ('${ids.tap}', 1, 'Existing Tap', '${timestamp}', '${timestamp}', '${timestamp}');
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
    INSERT INTO activity_log
      (id, category, action, actor_type, entity_type, entity_id, occurred_at)
    VALUES ('existing-activity', 'domain', 'fill.assigned', 'admin', 'fill', '${ids.fill}', '${timestamp}');
    INSERT INTO deletion_audit
      (id, schema_version, entity_type, entity_id, actor_type, impacts_json, deleted_at)
    VALUES ('existing-audit', 1, 'fill', 'deleted-fill', 'admin', '{}', '${timestamp}');
    UPDATE simulation_settings SET enabled = 1, seeded = 1, revision = 9 WHERE singleton = 1;
    INSERT INTO simulation_sensors
      (tap_id, source_id, remaining_ml, temperature_c, online, noise_enabled, sequence)
    VALUES ('${ids.tap}', '${ids.source}', 12345.5, 6.25, 0, 1, 42);
    INSERT INTO simulation_fill_volumes (fill_id, remaining_ml)
    VALUES ('${ids.fill}', 12345.5);
    INSERT INTO outbound_destinations (id, label, enabled, created_at, updated_at)
    VALUES ('existing-destination', 'Existing destination', 1, '${timestamp}', '${timestamp}');
    INSERT INTO outbound_destination_versions (id, destination_id, version_number, created_at)
    VALUES ('existing-version', 'existing-destination', 1, '${timestamp}');
    INSERT INTO outbound_destination_configs
      (version_id, destination_id, transport_kind, safe_summary, config_json, created_at)
    VALUES ('existing-version', 'existing-destination', 'webhook', 'safe',
      '{"endpoint":"https://example.test"}', '${timestamp}');
    INSERT INTO outbound_destination_profiles
      (destination_id, transport_kind, required, current_version_id, created_at, updated_at)
    VALUES ('existing-destination', 'webhook', 1, 'existing-version', '${timestamp}', '${timestamp}');
    INSERT INTO outbound_destination_subscriptions
      (version_id, destination_id, event_type, created_at)
    VALUES ('existing-version', 'existing-destination', 'fill.assigned', '${timestamp}');
    INSERT INTO outbound_events
      (id, event_type, schema_version, occurred_at, envelope_json, envelope_bytes, created_at)
    VALUES
      ('pending-event', 'fill.assigned', 1, '${timestamp}', '{}', 2, '${timestamp}'),
      ('completed-event', 'fill.assigned', 1, '${timestamp}', '{}', 2, '${timestamp}');
    INSERT INTO outbound_deliveries
      (id, event_id, destination_id, destination_version_id, state, attempt_count,
       next_attempt_at, revision, envelope_bytes, created_at, updated_at, terminal_at)
    VALUES
      ('pending-delivery', 'pending-event', 'existing-destination', 'existing-version',
       'pending', 0, '${timestamp}', 0, 2, '${timestamp}', '${timestamp}', NULL),
      ('completed-delivery', 'completed-event', 'existing-destination', 'existing-version',
       'succeeded', 1, '${timestamp}', 2, 2, '${timestamp}', '${timestamp}', '${timestamp}');
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
    detectorSessionId: "existing-detector-session",
    canonicalVolumeMl: 355,
    startedAt: timestamp,
    completedAt: "2026-01-01T00:00:10.000Z",
    createdAt: "2026-01-01T00:00:10.000Z",
  });
}

void test("v21 upgrades additively to v22 and preserves existing security, domain, and outbox state", (context) => {
  const path = makeDatabasePath(context);
  const previous = openDatabase(path, { migrations: MIGRATIONS.slice(0, 21) });
  let beforeRows: Record<string, unknown[]>;
  let beforeSchema: SchemaObjectRow[];
  let beforeLedger: LedgerRow[];
  try {
    seedExistingState(previous);
    beforeRows = snapshotRows(previous, ["schema_migrations"]);
    beforeSchema = readSchema(previous);
    beforeLedger = readLedger(previous);
  } finally {
    previous.close();
  }

  const upgraded = openDatabase(path, { migrations: MIGRATIONS.slice(0, 22) });
  try {
    assert.equal(upgraded.pragma<number>("user_version", { simple: true }), 22);
    assert.equal(SYSTEM_ADMINISTRATION_SCHEMA_VERSION, 22);
    assert.deepEqual(snapshotRows(upgraded, ["schema_migrations", ...newTableNames]), beforeRows);
    assert.deepEqual(
      readSchema(upgraded).filter(({ name }) => !newTableNames.some((table) => table === name)),
      beforeSchema,
    );
    assert.deepEqual(
      readSchema(upgraded)
        .filter(({ name }) => newTableNames.some((table) => table === name))
        .map(({ type, name }) => ({ type, name })),
      newTableNames.map((name) => ({ type: "table", name })),
    );
    assert.deepEqual(readLedger(upgraded).slice(0, 21), beforeLedger);
    assert.equal(readLedger(upgraded).length, 22);
    assert.deepEqual(
      upgraded.prepare("SELECT version, name FROM schema_migrations WHERE version = 22").get(),
      { version: 22, name: SYSTEM_ADMINISTRATION_MIGRATION_NAME },
    );
    assertDefaultSettings(upgraded);
    upgraded.execute(`
      UPDATE auth_session_settings SET inactivity_ms = 60000, absolute_ms = 31536000000,
        revision = 5, updated_at = '${updatedTimestamp}' WHERE id = 1;
      UPDATE outbox_retention SET retention_days = 3650,
        revision = 6, updated_at = '${updatedTimestamp}' WHERE id = 1;
    `);
  } finally {
    upgraded.close();
  }

  const reopened = openDatabase(path, { migrations: MIGRATIONS.slice(0, 22) });
  try {
    assert.deepEqual(snapshotRows(reopened, ["schema_migrations", ...newTableNames]), beforeRows);
    assert.deepEqual(readLedger(reopened).slice(0, 21), beforeLedger);
    assert.equal(readLedger(reopened).length, 22);
    assert.deepEqual(readSessionSettings(reopened), [
      {
        id: 1,
        inactivity_ms: 60000,
        absolute_ms: 31536000000,
        revision: 5,
        updated_at: updatedTimestamp,
      },
    ]);
    assert.deepEqual(readOutboxRetention(reopened), [
      { id: 1, retention_days: 3650, revision: 6, updated_at: updatedTimestamp },
    ]);
  } finally {
    reopened.close();
  }
});

void test("v22 session settings require paired integer durations within one year and ordered limits", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 22) });
  try {
    assertDefaultSettings(database);
    const update = database.prepare<[SqlValue, SqlValue]>(
      "UPDATE auth_session_settings SET inactivity_ms = ?, absolute_ms = ? WHERE id = 1",
    );
    const invalidPairs: readonly (readonly [SqlValue, SqlValue])[] = [
      [null, 60000],
      [60000, null],
      [59999, 60000],
      [60000, 59999],
      [60000, 31536000001],
      [31536000001, 31536000001],
      [120000, 60000],
      [60000.5, 120000],
      [60000, 120000.5],
      ["invalid", 60000],
      [60000, "invalid"],
      [Buffer.from("60000"), 60000],
      [60000, Buffer.from("60000")],
      [Infinity, Infinity],
      [-Infinity, 60000],
      [NaN, 60000],
    ];
    for (const [inactivity, absolute] of invalidPairs) {
      assert.throws(
        () => update.run(inactivity, absolute),
        /CHECK constraint/,
        `${String(inactivity)}, ${String(absolute)}`,
      );
      assertDefaultSettings(database);
    }
    for (const [inactivity, absolute] of [
      [60000, 60000],
      [60000, 31536000000],
      [31536000000, 31536000000],
      [null, null],
    ] as const) {
      update.run(inactivity, absolute);
      assert.deepEqual(readSessionSettings(database), [
        {
          id: 1,
          inactivity_ms: inactivity,
          absolute_ms: absolute,
          revision: 0,
          updated_at: epochTimestamp,
        },
      ]);
    }
  } finally {
    database.close();
  }
});

void test("v22 outbox retention enforces integer days from 1 to 3650", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 22) });
  try {
    const update = database.prepare<[SqlValue]>(
      "UPDATE outbox_retention SET retention_days = ? WHERE id = 1",
    );
    for (const days of [
      0,
      -1,
      3651,
      1.5,
      "invalid",
      Buffer.from("30"),
      Infinity,
      -Infinity,
      NaN,
      null,
    ]) {
      assert.throws(() => update.run(days), /CHECK constraint|NOT NULL constraint/, String(days));
      assertDefaultSettings(database);
    }
    for (const days of [1, 3650]) {
      update.run(days);
      assert.deepEqual(readOutboxRetention(database), [
        { id: 1, retention_days: days, revision: 0, updated_at: epochTimestamp },
      ]);
    }
  } finally {
    database.close();
  }
});

void test("v22 settings retain singleton identities, integer revisions, and required timestamps", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 22) });
  try {
    for (const table of newTableNames) {
      assert.throws(
        () => database.execute(`INSERT INTO ${table} (id) VALUES (1)`),
        /UNIQUE constraint/,
      );
      assert.throws(
        () => database.execute(`INSERT INTO ${table} (id) VALUES (2)`),
        /CHECK constraint/,
      );
      for (const assignment of [
        "id = 0",
        "id = 2",
        "revision = -1",
        "revision = 0.5",
        "revision = 'invalid'",
        "revision = NULL",
        "updated_at = NULL",
      ]) {
        assert.throws(
          () => database.execute(`UPDATE ${table} SET ${assignment} WHERE id = 1`),
          /CHECK constraint|NOT NULL constraint/,
          `${table}: ${assignment}`,
        );
        assertDefaultSettings(database);
      }
      database.execute(
        `UPDATE ${table} SET revision = 7, updated_at = '${updatedTimestamp}' WHERE id = 1`,
      );
      assert.deepEqual(
        database.prepare(`SELECT revision, updated_at FROM ${table} WHERE id = 1`).get(),
        { revision: 7, updated_at: updatedTimestamp },
      );
      database.execute(
        `UPDATE ${table} SET revision = 0, updated_at = '${epochTimestamp}' WHERE id = 1`,
      );
    }
  } finally {
    database.close();
  }
});

void test("v22 fails closed on altered settings DDL, missing singletons, or schema objects", async (context) => {
  const cases = [
    {
      name: "missing session settings singleton",
      sql: "DELETE FROM auth_session_settings WHERE id = 1",
      error: /required auth_session_settings state is missing/,
    },
    {
      name: "missing outbox retention singleton",
      sql: "DELETE FROM outbox_retention WHERE id = 1",
      error: /required outbox_retention state is missing/,
    },
    {
      name: "missing session settings table",
      sql: "DROP TABLE auth_session_settings",
      error: /schema objects do not match/,
    },
    {
      name: "missing outbox retention table",
      sql: "DROP TABLE outbox_retention",
      error: /schema objects do not match/,
    },
    {
      name: "weakened session settings constraints with canonical columns",
      sql: `DROP TABLE auth_session_settings;
        CREATE TABLE auth_session_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          inactivity_ms INTEGER,
          absolute_ms INTEGER,
          revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
          updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
          CHECK ((inactivity_ms IS NULL AND absolute_ms IS NULL) OR
            (inactivity_ms BETWEEN 60000 AND 31536000000
              AND absolute_ms BETWEEN 60000 AND 31536000000 AND inactivity_ms <= absolute_ms))
        );
        INSERT INTO auth_session_settings (id) VALUES (1);`,
      error: /auth_session_settings has invalid DDL/,
    },
    {
      name: "weakened outbox retention constraints with canonical columns",
      sql: `DROP TABLE outbox_retention;
        CREATE TABLE outbox_retention (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
          revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0),
          updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
        );
        INSERT INTO outbox_retention (id) VALUES (1);`,
      error: /outbox_retention has invalid DDL/,
    },
    {
      name: "unexpected user object",
      sql: "CREATE TABLE unexpected_system_state (id INTEGER)",
      error: /schema objects do not match/,
    },
  ] as const;
  for (const entry of cases) {
    await context.test(entry.name, (subcontext) => {
      const path = makeDatabasePath(subcontext);
      const database = openDatabase(path, { migrations: MIGRATIONS.slice(0, 22) });
      try {
        database.execute(entry.sql);
        const beforeRows = snapshotRows(database);
        const beforeSchema = readSchema(database);
        assert.throws(
          () => openDatabase(path, { migrations: MIGRATIONS.slice(0, 22) }),
          entry.error,
        );
        assert.equal(database.pragma<number>("user_version", { simple: true }), 22);
        assert.equal(readLedger(database).length, 22);
        assert.deepEqual(snapshotRows(database), beforeRows);
        assert.deepEqual(readSchema(database), beforeSchema);
      } finally {
        database.close();
      }
    });
  }
});

void test("an incompatible v21 schema fails before any v22 tables or singleton state is created", async (context) => {
  for (const sql of [
    "DELETE FROM simulation_settings WHERE singleton = 1",
    "DROP TRIGGER trg_activity_log_no_update",
  ]) {
    await context.test(sql, () => {
      const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 21) });
      try {
        database.execute(sql);
        const beforeRows = snapshotRows(database);
        const beforeSchema = readSchema(database);
        assert.throws(
          () => initializeSchema(database, MIGRATIONS.slice(0, 22)),
          /required simulation_settings state is missing|schema objects do not match/,
        );
        assertNoSystemMigration(database);
        assert.deepEqual(snapshotRows(database), beforeRows);
        assert.deepEqual(readSchema(database), beforeSchema);
      } finally {
        database.close();
      }
    });
  }
});

void test("a failed v22 migration rolls back new tables, singleton seeds, existing writes, and ledger state", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 21) });
  try {
    seedExistingState(database);
    const beforeRows = snapshotRows(database);
    const beforeSchema = readSchema(database);
    const failingMigration: MigrationDefinition = {
      version: 22,
      name: "test-failing-system-administration",
      apply(transaction) {
        SYSTEM_ADMINISTRATION_MIGRATION.apply(transaction);
        transaction.execute("UPDATE activity_retention SET retention_days = 90 WHERE id = 1");
        throw new Error("injected System migration failure");
      },
    };
    assert.throws(
      () => initializeSchema(database, [...MIGRATIONS.slice(0, 21), failingMigration]),
      /injected System migration failure/,
    );
    assertNoSystemMigration(database);
    assert.deepEqual(snapshotRows(database), beforeRows);
    assert.deepEqual(readSchema(database), beforeSchema);
    initializeSchema(database, MIGRATIONS.slice(0, 22));
    assert.equal(database.pragma<number>("user_version", { simple: true }), 22);
    assertDefaultSettings(database);
    assert.deepEqual(snapshotRows(database, newTableNames), {
      ...beforeRows,
      schema_migrations: readLedger(database),
    });
  } finally {
    database.close();
  }
});
