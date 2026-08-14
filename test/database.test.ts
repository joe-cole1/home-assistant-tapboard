import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  openDatabase,
  type DatabaseConnection,
  type DatabaseExecutor,
} from "../src/infrastructure/database/connection.ts";
import {
  CURRENT_SCHEMA_VERSION,
  FOUNDATION_INITIAL_MIGRATION_NAME,
  FOUNDATION_MIGRATIONS,
  FOUNDATION_SCHEMA_VERSION,
  MIGRATIONS,
  type MigrationDefinition,
} from "../src/infrastructure/database/migrations.ts";

interface UserVersionRow {
  readonly user_version: number;
}

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
}

interface LedgerRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
}

type AsyncMigrationApplyIsAssignable = ((
  database: DatabaseExecutor,
) => Promise<undefined>) extends MigrationDefinition["apply"]
  ? true
  : false;

const asyncMigrationApplyIsAssignable: AsyncMigrationApplyIsAssignable = false;

const validLedgerSql = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )
`;

function makeDatabasePath(context: TestContext): string {
  const root = mkdtempSync(
    join(process.platform === "win32" ? process.env.TEMP! : "/tmp", "tapboard-db-"),
  );
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "tapboard.sqlite");
}

function withFixture(path: string, work: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path);
  try {
    work(database);
  } finally {
    database.close();
  }
}

function seedLedger(database: DatabaseSync, rows: readonly (readonly [number, string])[]): void {
  database.exec(validLedgerSql);
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const [version, name] of rows) {
    insert.run(version, name, "2026-08-13T00:00:00.000Z");
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as unknown as UserVersionRow;
  return row.user_version;
}

function readSchemaObjects(database: DatabaseSync): SchemaObjectRow[] {
  const rows = database
    .prepare(
      `SELECT type, name
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as unknown as SchemaObjectRow[];
  return rows.map(({ type, name }) => ({ type, name }));
}

function readLedger(database: DatabaseSync): LedgerRow[] {
  const rows = database
    .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .all() as unknown as LedgerRow[];
  return rows.map(({ version, name, applied_at }) => ({ version, name, applied_at }));
}

function createTransactionTable(database: DatabaseConnection): void {
  database.execute("CREATE TABLE transaction_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
}

function readTransactionValues(database: DatabaseConnection): string[] {
  return database
    .prepare<[], { readonly value: string }>("SELECT value FROM transaction_probe ORDER BY id")
    .all()
    .map((row) => row.value);
}

void test("a clean file database bootstraps the canonical v6 migration ledger", (context) => {
  const path = makeDatabasePath(context);
  const database = openDatabase(path);

  try {
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
      database
        .prepare<[], SchemaObjectRow>(
          `SELECT type, name
           FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
           ORDER BY type, name`,
        )
        .all(),
      [
        { type: "index", name: "idx_activity_log_occurred_at" },
        { type: "index", name: "idx_beverage_source_recipe_snapshots_beverage" },
        { type: "index", name: "idx_beverage_source_recipe_snapshots_linked" },
        { type: "index", name: "idx_brewfather_candidate_cache_account_status" },
        { type: "index", name: "idx_custom_recipe_ingredients_recipe" },
        { type: "index", name: "idx_custom_recipe_steps_recipe" },
        { type: "index", name: "idx_deletion_audit_deleted_at" },
        { type: "index", name: "idx_fills_active_keg" },
        { type: "index", name: "idx_fills_beverage_id" },
        { type: "index", name: "idx_fills_keg_id" },
        { type: "index", name: "idx_fills_on_deck_order" },
        { type: "index", name: "idx_keg_maintenance_keg_recorded" },
        { type: "index", name: "idx_keg_tare_history_keg_recorded" },
        { type: "index", name: "idx_outbound_deliveries_destination_state" },
        { type: "index", name: "idx_outbound_deliveries_due" },
        { type: "index", name: "idx_outbound_events_created_at" },
        { type: "index", name: "idx_outbound_events_type_coalescing" },
        { type: "index", name: "idx_tap_assignment_lifecycles_active_fill" },
        { type: "index", name: "idx_tap_assignment_lifecycles_active_tap" },
        { type: "index", name: "idx_tap_assignment_lifecycles_fill_id" },
        { type: "index", name: "idx_tap_assignment_lifecycles_tap_id" },
        { type: "index", name: "idx_taps_tap_number" },
        { type: "table", name: "activity_log" },
        { type: "table", name: "activity_retention" },
        { type: "table", name: "admin_credentials" },
        { type: "table", name: "admin_sessions" },
        { type: "table", name: "beverage_sensory_overrides" },
        { type: "table", name: "beverage_settings" },
        { type: "table", name: "beverage_source_recipe_snapshots" },
        { type: "table", name: "beverages" },
        { type: "table", name: "brewfather_accounts" },
        { type: "table", name: "brewfather_beverage_links" },
        { type: "table", name: "brewfather_candidate_cache" },
        { type: "table", name: "brewfather_presentation_overrides" },
        { type: "table", name: "brewfather_source_profiles" },
        { type: "table", name: "custom_beverage_profiles" },
        { type: "table", name: "custom_recipe_ingredients" },
        { type: "table", name: "custom_recipe_steps" },
        { type: "table", name: "custom_recipes" },
        { type: "table", name: "deletion_audit" },
        { type: "table", name: "encrypted_secrets" },
        { type: "table", name: "fill_settings" },
        { type: "table", name: "fills" },
        { type: "table", name: "keg_maintenance_records" },
        { type: "table", name: "keg_tare_history" },
        { type: "table", name: "kegs" },
        { type: "table", name: "login_throttle" },
        { type: "table", name: "machine_api_keys" },
        { type: "table", name: "outbound_deliveries" },
        { type: "table", name: "outbound_destination_versions" },
        { type: "table", name: "outbound_destinations" },
        { type: "table", name: "outbound_events" },
        { type: "table", name: "outbox_degradation" },
        { type: "table", name: "outbox_overflow_incidents" },
        { type: "table", name: "schema_migrations" },
        { type: "table", name: "secret_rotation_state" },
        { type: "table", name: "tap_assignment_lifecycles" },
        { type: "table", name: "taps" },
        { type: "trigger", name: "trg_activity_log_no_update" },
        { type: "trigger", name: "trg_deletion_audit_no_delete" },
        { type: "trigger", name: "trg_deletion_audit_no_update" },
        { type: "trigger", name: "trg_keg_maintenance_records_no_update" },
        { type: "trigger", name: "trg_keg_tare_history_no_update" },
        { type: "trigger", name: "trg_outbound_destination_versions_no_update" },
        { type: "trigger", name: "trg_outbox_overflow_incidents_no_delete" },
        { type: "trigger", name: "trg_outbox_overflow_incidents_no_insert" },
        { type: "trigger", name: "trg_tap_assignment_lifecycles_immutable_fields" },
        { type: "trigger", name: "trg_tap_assignment_lifecycles_no_open_reason" },
        { type: "trigger", name: "trg_tap_assignment_lifecycles_no_update_closed" },
        { type: "trigger", name: "trg_taps_first_used_at_monotonic" },
        { type: "trigger", name: "trg_taps_no_delete_if_used" },
      ],
    );
    const ledger = database
      .prepare<[], LedgerRow>(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();
    assert.equal(ledger.length, 6);
    assert.equal(ledger[0]?.version, FOUNDATION_SCHEMA_VERSION);
    assert.equal(ledger[0]?.name, FOUNDATION_INITIAL_MIGRATION_NAME);
    assert.equal(ledger[1]?.version, 2);
    assert.equal(ledger[1]?.name, "security-activity-outbox-primitives");
    assert.equal(ledger[2]?.version, 3);
    assert.equal(ledger[2]?.name, "physical-kegs");
    assert.equal(ledger[3]?.version, 4);
    assert.equal(ledger[3]?.name, "custom-and-brewfather-beverages");
    assert.equal(ledger[4]?.version, 5);
    assert.equal(ledger[4]?.name, "fills-and-on-deck");
    assert.equal(ledger[5]?.version, 6);
    assert.equal(ledger[5]?.name, "taps-and-assignment-lifecycles");
    assert.match(ledger[0]?.applied_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    database.close();
  }
});

void test("an in-memory database bootstraps the same canonical schema", () => {
  const database = openDatabase(":memory:");

  try {
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(
      database
        .prepare<[], SchemaObjectRow>(
          "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )
        .all().length,
      71,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM schema_migrations")
        .get()?.count,
      6,
    );
  } finally {
    database.close();
  }
});

void test("foreign-key enforcement is enabled and rejects an invalid reference", () => {
  const database = openDatabase(":memory:");

  try {
    assert.equal(database.pragma<number>("foreign_keys", { simple: true }), 1);
    database.withTransaction(() => {
      database.execute("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)");
      database.execute(
        "CREATE TABLE fk_child (parent_id INTEGER NOT NULL REFERENCES fk_parent(id))",
      );
      assert.throws(
        () => database.prepare<[number]>("INSERT INTO fk_child (parent_id) VALUES (?)").run(42),
        /FOREIGN KEY constraint failed/,
      );
      database.execute("DROP TABLE fk_child");
      database.execute("DROP TABLE fk_parent");
    });
  } finally {
    database.close();
  }
});

void test("v2 singleton and overflow seeds are present and immutable guards hold", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS });
  try {
    assert.deepEqual(
      database
        .prepare<
          [],
          { readonly id: number; readonly generation: number; readonly attempt_count: number }
        >("SELECT id, generation, attempt_count FROM login_throttle")
        .all(),
      [{ id: 1, generation: 0, attempt_count: 0 }],
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM outbox_overflow_incidents",
        )
        .get()?.count,
      16,
    );
    assert.equal(
      database
        .prepare<[], { readonly is_catchall: number }>(
          "SELECT is_catchall FROM outbox_overflow_incidents WHERE slot = 15",
        )
        .get()?.is_catchall,
      1,
    );
    assert.throws(
      () =>
        database
          .prepare<[number, number]>(
            "INSERT INTO outbox_overflow_incidents (slot, is_catchall, state, omitted_count) VALUES (?, ?, 'empty', 0)",
          )
          .run(16, 0),
      /rows are fixed/,
    );
  } finally {
    database.close();
  }
});

void test("v2 outbound delivery lease fields reject one-sided stale values", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS });
  try {
    database.execute(`
      INSERT INTO outbound_destinations (id, label, enabled, created_at, updated_at)
      VALUES ('dest-1', 'Destination', 1, '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z');
      INSERT INTO outbound_destination_versions (id, destination_id, version_number, created_at)
      VALUES ('version-1', 'dest-1', 1, '2026-08-13T00:00:00Z');
      INSERT INTO outbound_events
        (id, event_type, schema_version, occurred_at, envelope_json, envelope_bytes, created_at)
      VALUES ('event-1', 'test.event', 1, '2026-08-13T00:00:00Z', '{}', 2, '2026-08-13T00:00:00Z');
    `);
    const insert = database.prepare(
      `INSERT INTO outbound_deliveries
       (id, event_id, destination_id, destination_version_id, state, attempt_count,
        next_attempt_at, lease_owner, lease_expires_at, revision, envelope_bytes,
        created_at, updated_at)
       VALUES (?, 'event-1', 'dest-1', 'version-1', 'pending', 0,
        '2026-08-13T00:00:00Z', ?, ?, 0, 2,
        '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')`,
    );
    assert.throws(() => insert.run("delivery-owner-only", "worker-1", null), /CHECK constraint/);
    assert.throws(
      () => insert.run("delivery-expiry-only", null, "2026-08-13T00:01:00Z"),
      /CHECK constraint/,
    );
  } finally {
    database.close();
  }
});

void test("an exact v1 database upgrades to v6 with all ledger entries", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path, { migrations: FOUNDATION_MIGRATIONS }).close();
  const database = openDatabase(path, { migrations: MIGRATIONS });
  try {
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
      database
        .prepare<[], { readonly version: number; readonly name: string }>(
          "SELECT version, name FROM schema_migrations ORDER BY version",
        )
        .all(),
      [
        { version: 1, name: FOUNDATION_INITIAL_MIGRATION_NAME },
        { version: 2, name: "security-activity-outbox-primitives" },
        { version: 3, name: "physical-kegs" },
        { version: 4, name: "custom-and-brewfather-beverages" },
        { version: 5, name: "fills-and-on-deck" },
        { version: 6, name: "taps-and-assignment-lifecycles" },
      ],
    );
  } finally {
    database.close();
  }
});

void test("canonical v6 reopen rejects an extra user object", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path, { migrations: MIGRATIONS }).close();
  withFixture(path, (database) => database.exec("CREATE TABLE unexpected_v6_table (id INTEGER)"));
  assert.throws(
    () => openDatabase(path, { migrations: MIGRATIONS }),
    /schema objects do not match|unexpected schema objects/,
  );
});

void test("v6 validation rejects a tampered DDL definition on reopen", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path, { migrations: MIGRATIONS }).close();
  withFixture(path, (database) => {
    database.exec("ALTER TABLE activity_log RENAME TO activity_log_original");
    database.exec("DROP INDEX idx_activity_log_occurred_at");
    database.exec(
      "CREATE TABLE activity_log (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, session_id TEXT, entity_type TEXT, entity_id TEXT, details_json TEXT, occurred_at TEXT NOT NULL)",
    );
    database.exec("DROP TABLE activity_log_original");
  });
  assert.throws(
    () => openDatabase(path, { migrations: MIGRATIONS }),
    /invalid DDL|structure|schema objects/,
  );
});

void test("a current database reopens idempotently", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path).close();

  const reopened = openDatabase(path);
  try {
    assert.equal(
      reopened
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM schema_migrations")
        .get()?.count,
      6,
    );
  } finally {
    reopened.close();
  }
});

void test("a clean version 0 database upgrades through the canonical v6 schema", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => assert.equal(readUserVersion(database), 0));

  openDatabase(path).close();

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), CURRENT_SCHEMA_VERSION);
    assert.equal(readSchemaObjects(database).length, 71);
  });
});

void test("migration definitions must be contiguous with nonempty unique names", async (context) => {
  const invalidSets: readonly (readonly MigrationDefinition[])[] = [
    [{ version: 2, name: "starts-late", apply: () => undefined }],
    [{ version: 1, name: "   ", apply: () => undefined }],
    [
      { version: 1, name: "ok-1", apply: () => undefined },
      { version: 3, name: "gap", apply: () => undefined },
    ],
    [
      { version: 1, name: "duplicate-version", apply: () => undefined },
      { version: 1, name: "duplicate-version-2", apply: () => undefined },
    ],
    [
      { version: 1, name: "duplicate-name", apply: () => undefined },
      { version: 2, name: "duplicate-name", apply: () => undefined },
    ],
  ];

  for (const [index, migrations] of invalidSets.entries()) {
    await context.test(`invalid definition set ${index + 1}`, (subcontext) => {
      const path = makeDatabasePath(subcontext);
      assert.throws(() => openDatabase(path, { migrations }), /Database migration/);
      withFixture(path, (database) => {
        assert.equal(readUserVersion(database), 0);
        assert.deepEqual(readSchemaObjects(database), []);
      });
    });
  }
});

void test("an unsupported future schema is rejected without mutation", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => database.exec("PRAGMA user_version = 7"));

  assert.throws(() => openDatabase(path), /schema version is newer/);

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 7);
    assert.deepEqual(readSchemaObjects(database), []);
  });
});

void test("a nonempty version 0 database is rejected without adoption or mutation", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => database.exec("CREATE TABLE unknown_table (id INTEGER)"));

  assert.throws(() => openDatabase(path), /version 0 database is not empty/);

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 0);
    assert.deepEqual(readSchemaObjects(database), [{ type: "table", name: "unknown_table" }]);
  });
});

void test("migration ledger inconsistencies fail closed", async (context) => {
  const cases = [
    {
      name: "missing ledger",
      userVersion: 1,
      rows: undefined,
      migrations: FOUNDATION_MIGRATIONS,
    },
    {
      name: "mismatched name",
      userVersion: 1,
      rows: [[1, "not-the-foundation-migration"]] as const,
      migrations: FOUNDATION_MIGRATIONS,
    },
    {
      name: "gapped ledger",
      userVersion: 3,
      rows: [
        [1, FOUNDATION_INITIAL_MIGRATION_NAME],
        [3, "third"],
      ] as const,
      migrations: [
        FOUNDATION_MIGRATIONS[0]!,
        { version: 2, name: "second", apply: () => undefined },
        { version: 3, name: "third", apply: () => undefined },
      ],
    },
    {
      name: "extra ledger row",
      userVersion: 1,
      rows: [
        [1, FOUNDATION_INITIAL_MIGRATION_NAME],
        [2, "extra"],
      ] as const,
      migrations: FOUNDATION_MIGRATIONS,
    },
  ] as const;

  for (const fixture of cases) {
    await context.test(fixture.name, (subcontext) => {
      const path = makeDatabasePath(subcontext);
      withFixture(path, (database) => {
        if (fixture.rows !== undefined) {
          seedLedger(database, fixture.rows);
        }
        database.exec(`PRAGMA user_version = ${fixture.userVersion}`);
      });

      assert.throws(
        () => openDatabase(path, { migrations: fixture.migrations }),
        /migration ledger/,
      );

      withFixture(path, (database) => {
        assert.equal(readUserVersion(database), fixture.userVersion);
        if (fixture.rows === undefined) {
          assert.deepEqual(readSchemaObjects(database), []);
        } else {
          assert.deepEqual(
            readLedger(database).map(({ version, name }) => ({ version, name })),
            fixture.rows.map(([version, name]) => ({ version, name })),
          );
        }
      });
    });
  }
});

void test("unexpected objects in a current schema are rejected without repair", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => {
    seedLedger(database, [[1, FOUNDATION_INITIAL_MIGRATION_NAME]]);
    database.exec("CREATE TABLE unexpected_table (id INTEGER); PRAGMA user_version = 1");
  });

  assert.throws(() => openDatabase(path), /unexpected schema objects/);

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 1);
    assert.deepEqual(readSchemaObjects(database), [
      { type: "table", name: "schema_migrations" },
      { type: "table", name: "unexpected_table" },
    ]);
  });
});

void test("an invalid v1 schema is rejected before a pending migration can mutate it", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => {
    seedLedger(database, [[1, FOUNDATION_INITIAL_MIGRATION_NAME]]);
    database.exec("CREATE TABLE unexpected_table (id INTEGER); PRAGMA user_version = 1");
  });

  let pendingMigrationCalled = false;
  const migrations: readonly MigrationDefinition[] = [
    FOUNDATION_MIGRATIONS[0]!,
    {
      version: 2,
      name: "must-not-run",
      apply(database) {
        pendingMigrationCalled = true;
        database.execute("CREATE TABLE pending_migration_table (id INTEGER)");
        return undefined;
      },
    },
  ];

  assert.throws(() => openDatabase(path, { migrations }), /unexpected schema objects/);
  assert.equal(pendingMigrationCalled, false);

  withFixture(path, (database) => {
    database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    try {
      assert.equal(readUserVersion(database), 1);
      assert.deepEqual(readSchemaObjects(database), [
        { type: "table", name: "schema_migrations" },
        { type: "table", name: "unexpected_table" },
      ]);
      assert.deepEqual(
        readLedger(database).map(({ version, name }) => ({ version, name })),
        [{ version: 1, name: FOUNDATION_INITIAL_MIGRATION_NAME }],
      );
    } finally {
      database.exec("ROLLBACK");
    }
  });
});

void test("an invalid current ledger structure is rejected", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, '${FOUNDATION_INITIAL_MIGRATION_NAME}', 'now');
      PRAGMA user_version = 1;
    `);
  });

  assert.throws(() => openDatabase(path), /ledger constraints are invalid/);
});

void test("text resembling the canonical CHECK constraint does not validate fake DDL", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL CHECK ('check(version>0)' <> '')
      );
      INSERT INTO schema_migrations VALUES (1, '${FOUNDATION_INITIAL_MIGRATION_NAME}', 'now');
      PRAGMA user_version = 1;
    `);
  });

  assert.throws(() => openDatabase(path), /ledger constraints are invalid/);

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 1);
    assert.equal(readLedger(database).length, 1);
  });
});

void test("a failed migration rolls back its DDL, ledger row, and version", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path, { migrations: FOUNDATION_MIGRATIONS }).close();

  const failingMigrations: readonly MigrationDefinition[] = [
    FOUNDATION_MIGRATIONS[0]!,
    {
      version: 2,
      name: "injected-failure",
      apply(database) {
        database.execute("CREATE TABLE migration_should_rollback (id INTEGER)");
        throw new Error("injected migration failure");
      },
    },
  ];

  assert.throws(
    () => openDatabase(path, { migrations: failingMigrations }),
    /injected migration failure/,
  );

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 1);
    assert.deepEqual(readSchemaObjects(database), [{ type: "table", name: "schema_migrations" }]);
    assert.equal(readLedger(database).length, 1);
  });
});

void test("Promise-like migration results roll back without advancing schema state", async (context) => {
  assert.equal(asyncMigrationApplyIsAssignable, false);

  const cases = [
    {
      name: "Promise",
      makeResult: () => Promise.resolve(undefined),
    },
    {
      name: "custom thenable",
      makeResult: () => ({ then() {} }),
    },
  ] as const;

  for (const fixture of cases) {
    await context.test(fixture.name, (subcontext) => {
      const path = makeDatabasePath(subcontext);
      openDatabase(path, { migrations: FOUNDATION_MIGRATIONS }).close();

      const unsafeApply = ((database: DatabaseExecutor): unknown => {
        database.execute("CREATE TABLE asynchronous_migration_table (id INTEGER)");
        return fixture.makeResult();
      }) as MigrationDefinition["apply"];
      const migrations: readonly MigrationDefinition[] = [
        FOUNDATION_MIGRATIONS[0]!,
        { version: 2, name: `unsafe-${fixture.name}`, apply: unsafeApply },
      ];

      assert.throws(
        () => openDatabase(path, { migrations }),
        /migrations must complete synchronously/,
      );

      withFixture(path, (database) => {
        database.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
        try {
          assert.equal(readUserVersion(database), 1);
          assert.deepEqual(readSchemaObjects(database), [
            { type: "table", name: "schema_migrations" },
          ]);
          assert.deepEqual(
            readLedger(database).map(({ version, name }) => ({ version, name })),
            [{ version: 1, name: FOUNDATION_INITIAL_MIGRATION_NAME }],
          );
        } finally {
          database.exec("ROLLBACK");
        }
      });
    });
  }
});

void test("transactions commit their synchronous work", () => {
  const database = openDatabase(":memory:");
  try {
    createTransactionTable(database);
    const result = database.withTransaction(() => {
      database.prepare<[string]>("INSERT INTO transaction_probe (value) VALUES (?)").run("kept");
      return 42;
    });

    assert.equal(result, 42);
    assert.deepEqual(readTransactionValues(database), ["kept"]);
  } finally {
    database.close();
  }
});

void test("a synchronous transaction failure rolls back", () => {
  const database = openDatabase(":memory:");
  try {
    createTransactionTable(database);
    assert.throws(
      () =>
        database.withTransaction(() => {
          database
            .prepare<[string]>("INSERT INTO transaction_probe (value) VALUES (?)")
            .run("rolled back");
          throw new Error("stop transaction");
        }),
      /stop transaction/,
    );
    assert.deepEqual(readTransactionValues(database), []);
  } finally {
    database.close();
  }
});

void test("Promise-like transaction results are rejected before commit and rolled back", () => {
  const database = openDatabase(":memory:");
  try {
    createTransactionTable(database);
    const maliciousCallback = (() => {
      database
        .prepare<[string]>("INSERT INTO transaction_probe (value) VALUES (?)")
        .run("rolled back");
      return Promise.resolve(1);
    }) as unknown as () => number;

    assert.throws(
      () => database.withTransaction(maliciousCallback),
      /transactions must complete synchronously/,
    );
    assert.deepEqual(readTransactionValues(database), []);
  } finally {
    database.close();
  }
});

void test("thenable transaction results are rejected before commit and rolled back", () => {
  const database = openDatabase(":memory:");
  try {
    createTransactionTable(database);
    const maliciousCallback = (() => {
      database
        .prepare<[string]>("INSERT INTO transaction_probe (value) VALUES (?)")
        .run("rolled back");
      return { then() {} };
    }) as unknown as () => number;

    assert.throws(
      () => database.withTransaction(maliciousCallback),
      /transactions must complete synchronously/,
    );
    assert.deepEqual(readTransactionValues(database), []);
  } finally {
    database.close();
  }
});

void test("nested transactions use savepoints so an inner rollback can be isolated", () => {
  const database = openDatabase(":memory:");
  try {
    createTransactionTable(database);
    const insert = database.prepare<[string]>("INSERT INTO transaction_probe (value) VALUES (?)");

    database.withTransaction(() => {
      insert.run("outer-before");
      assert.throws(
        () =>
          database.withTransaction(() => {
            insert.run("inner-rolled-back");
            throw new Error("inner failure");
          }),
        /inner failure/,
      );
      insert.run("outer-after");
    });

    assert.deepEqual(readTransactionValues(database), ["outer-before", "outer-after"]);
  } finally {
    database.close();
  }
});

void test("close is idempotent and later database use is rejected", () => {
  const database = openDatabase(":memory:");
  assert.equal(database.isOpen, true);

  database.close();
  database.close();

  assert.equal(database.isOpen, false);
  assert.throws(() => database.pragma("user_version"), /connection is closed/);
  assert.throws(() => database.execute("SELECT 1"), /connection is closed/);
});

void test("kegs schema enforces uniqueness, capacity, tare, and lifecycle constraints", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    // Duplicate keg_number rejected
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
          VALUES ('22222222-2222-4222-8222-222222222222', 1, 'Duplicate Keg', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /UNIQUE constraint failed: kegs\.keg_number/,
    );

    // Negative capacity rejected
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
          VALUES ('33333333-3333-4333-8333-333333333333', 2, 'Keg 2', 0, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /CHECK constraint failed/,
    );

    // Negative tare rejected
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
          VALUES ('44444444-4444-4444-8444-444444444444', 3, 'Keg 3', 19000, -1, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /CHECK constraint failed/,
    );

    // Invalid is_active rejected
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
          VALUES ('55555555-5555-4555-8555-555555555555', 4, 'Keg 4', 19000, 4200, 2, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

void test("keg tare history and maintenance records are append-only and cascade on keg deletion", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO keg_tare_history (id, keg_id, previous_tare_g, new_tare_g, recorded_at, reason, actor_type, actor_id)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', NULL, 4200, '2026-08-14T00:00:00.000Z', 'initial', 'admin', 'admin-1');
      INSERT INTO keg_maintenance_records (id, keg_id, maintenance_type, notes, recorded_at, actor_type, actor_id)
      VALUES ('bbbbbbbb-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'deep_clean', 'clean notes', '2026-08-14T00:00:00.000Z', 'admin', 'admin-1');
    `);

    // Updates to tare history are blocked by trigger
    assert.throws(
      () =>
        database.execute(
          "UPDATE keg_tare_history SET new_tare_g = 5000 WHERE id = 'aaaaaaaa-1111-4111-8111-111111111111'",
        ),
      /keg_tare_history is append-only/,
    );

    // Updates to maintenance records are blocked by trigger
    assert.throws(
      () =>
        database.execute(
          "UPDATE keg_maintenance_records SET notes = 'tampered' WHERE id = 'bbbbbbbb-1111-4111-8111-111111111111'",
        ),
      /keg_maintenance_records is append-only/,
    );

    // Deleting keg cascades to tare history and maintenance records
    database.execute("DELETE FROM kegs WHERE id = '11111111-1111-4111-8111-111111111111'");
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM keg_tare_history")
        .get()?.count,
      0,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM keg_maintenance_records",
        )
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

void test("fills schema enforces active keg uniqueness partial index and check constraints", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO beverages (id, ownership_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'custom', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO custom_beverage_profiles (beverage_id, name, beverage_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'IPA', 'beer', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
      VALUES ('f1111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    // Duplicate active fill on the same keg is blocked by unique index idx_fills_active_keg
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
          VALUES ('f2222222-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /UNIQUE constraint failed: fills\.keg_id/,
    );

    // After ending fill 1, a new active fill on the same keg succeeds
    database.execute(`
      UPDATE fills SET ended_at = '2026-08-14T12:00:00.000Z', on_deck_order = NULL WHERE id = 'f1111111-1111-4111-8111-111111111111';
    `);

    database.execute(`
      INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
      VALUES ('f2222222-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    // Multiple ended fills on the same keg are allowed
    database.execute(`
      UPDATE fills SET ended_at = '2026-08-14T18:00:00.000Z' WHERE id = 'f2222222-2222-4222-8222-222222222222';
    `);

    const count = database
      .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM fills")
      .get()?.count;
    assert.equal(count, 2);
  } finally {
    database.close();
  }
});

void test("fills cascade on physical keg or beverage deletion", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO beverages (id, ownership_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'custom', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO custom_beverage_profiles (beverage_id, name, beverage_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'IPA', 'beer', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
      VALUES ('f1111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    // Deleting keg cascades and deletes fill, but leaves beverage intact
    database.execute("DELETE FROM kegs WHERE id = '11111111-1111-4111-8111-111111111111'");
    assert.equal(
      database.prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM fills").get()
        ?.count,
      0,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM beverages")
        .get()?.count,
      1,
    );
  } finally {
    database.close();
  }
});

void test("taps schema enforces unique tap numbers, monotonicity trigger, and delete triggers", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, gas_type, serving_pressure_kpa, line_length_mm, line_diameter_mm, notes, created_at, updated_at)
      VALUES ('t1111111-1111-4111-8111-111111111111', 1, 'Nitro Stout', 1, NULL, NULL, 'Nitro', 240.5, 1800, 4.76, 'Standard nitro tap', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);

    // Duplicate tap_number is blocked
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
          VALUES ('t2222222-2222-4222-8222-222222222222', 1, 'Tap 1 Duplicate', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /UNIQUE constraint failed: taps\.tap_number/,
    );

    // Negative tap_number is blocked
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
          VALUES ('t2222222-2222-4222-8222-222222222222', 0, 'Tap 0', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
        `),
      /CHECK constraint failed/,
    );

    // Setting first_used_at from NULL -> T1 succeeds
    database.execute(`
      UPDATE taps SET first_used_at = '2026-08-14T10:00:00.000Z' WHERE id = 't1111111-1111-4111-8111-111111111111';
    `);

    // Updating first_used_at to a different value T2 is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE taps SET first_used_at = '2026-08-14T11:00:00.000Z' WHERE id = 't1111111-1111-4111-8111-111111111111';
        `),
      /first_used_at is monotonic and cannot be cleared or changed/,
    );

    // Clearing first_used_at to NULL is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE taps SET first_used_at = NULL WHERE id = 't1111111-1111-4111-8111-111111111111';
        `),
      /first_used_at is monotonic and cannot be cleared or changed/,
    );

    // Deleting used tap is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          DELETE FROM taps WHERE id = 't1111111-1111-4111-8111-111111111111';
        `),
      /used or retired taps cannot be deleted/,
    );

    // Never-used tap can be inserted and deleted
    database.execute(`
      INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
      VALUES ('t3333333-3333-4333-8333-333333333333', 99, 'Disposable', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);
    database.execute("DELETE FROM taps WHERE id = 't3333333-3333-4333-8333-333333333333'");
    assert.equal(
      database
        .prepare<[string], { readonly count: number }>(
          "SELECT count(*) AS count FROM taps WHERE id = ?",
        )
        .get("t3333333-3333-4333-8333-333333333333")?.count,
      0,
    );

    // Retired tap (even if first_used_at was null) cannot be deleted
    database.execute(`
      INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
      VALUES ('t4444444-4444-4444-8444-444444444444', 100, 'Retired Tap', 1, NULL, '2026-08-14T12:00:00.000Z', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
    `);
    assert.throws(
      () =>
        database.execute(`
          DELETE FROM taps WHERE id = 't4444444-4444-4444-8444-444444444444';
        `),
      /used or retired taps cannot be deleted/,
    );
  } finally {
    database.close();
  }
});

void test("tap assignment lifecycles enforce partial unique indexes and immutability triggers", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('22222222-2222-4222-8222-222222222222', 2, 'Keg 2', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO beverages (id, ownership_type, created_at, updated_at)
      VALUES
        ('aaaaaaaa-1111-4111-8111-111111111111', 'custom', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('bbbbbbbb-2222-4222-8222-222222222222', 'custom', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO custom_beverage_profiles (beverage_id, name, beverage_type, created_at, updated_at)
      VALUES
        ('aaaaaaaa-1111-4111-8111-111111111111', 'IPA', 'beer', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('bbbbbbbb-2222-4222-8222-222222222222', 'Stout', 'beer', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
      VALUES
        ('f1111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('f2222222-2222-4222-8222-222222222222', 'bbbbbbbb-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
      VALUES
        ('t1111111-1111-4111-8111-111111111111', 1, 'Tap 1', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z'),
        ('t2222222-2222-4222-8222-222222222222', 2, 'Tap 2', 1, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at)
      VALUES ('a1111111-1111-4111-8111-111111111111', 't1111111-1111-4111-8111-111111111111', 'f1111111-1111-4111-8111-111111111111', '2026-08-14T10:00:00.000Z', NULL, NULL, '2026-08-14T10:00:00.000Z');
    `);

    // Second open assignment on same Tap is blocked by partial unique index
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at)
          VALUES ('a2222222-2222-4222-8222-222222222222', 't1111111-1111-4111-8111-111111111111', 'f2222222-2222-4222-8222-222222222222', '2026-08-14T10:00:00.000Z', NULL, NULL, '2026-08-14T10:00:00.000Z');
        `),
      /UNIQUE constraint failed: tap_assignment_lifecycles\.tap_id/,
    );

    // Second open assignment for same Fill on different Tap is blocked by partial unique index
    assert.throws(
      () =>
        database.execute(`
          INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at)
          VALUES ('a2222222-2222-4222-8222-222222222222', 't2222222-2222-4222-8222-222222222222', 'f1111111-1111-4111-8111-111111111111', '2026-08-14T10:00:00.000Z', NULL, NULL, '2026-08-14T10:00:00.000Z');
        `),
      /UNIQUE constraint failed: tap_assignment_lifecycles\.fill_id/,
    );

    // Mutating tap_id of open lifecycle is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE tap_assignment_lifecycles SET tap_id = 't2222222-2222-4222-8222-222222222222' WHERE id = 'a1111111-1111-4111-8111-111111111111';
        `),
      /assignment lifecycle identities and open timestamps are immutable/,
    );

    // Attempting to set end_reason on an open lifecycle without ended_at is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE tap_assignment_lifecycles SET end_reason = 'unassigned' WHERE id = 'a1111111-1111-4111-8111-111111111111';
        `),
      /open assignment lifecycles cannot have an end reason/,
    );

    // Closing lifecycle with ended_at and end_reason succeeds
    database.execute(`
      UPDATE tap_assignment_lifecycles SET ended_at = '2026-08-14T12:00:00.000Z', end_reason = 'unassigned' WHERE id = 'a1111111-1111-4111-8111-111111111111';
    `);

    // Modifying closed lifecycle is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE tap_assignment_lifecycles SET end_reason = 'tampered' WHERE id = 'a1111111-1111-4111-8111-111111111111';
        `),
      /closed assignment lifecycles are immutable/,
    );

    // Reopening closed lifecycle is blocked by trigger
    assert.throws(
      () =>
        database.execute(`
          UPDATE tap_assignment_lifecycles SET ended_at = NULL, end_reason = NULL WHERE id = 'a1111111-1111-4111-8111-111111111111';
        `),
      /closed assignment lifecycles are immutable/,
    );
  } finally {
    database.close();
  }
});

void test("tap assignment lifecycles cascade on fill deletion, but tap remains with first_used_at", () => {
  const database = openDatabase(":memory:");
  try {
    database.execute(`
      INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Keg 1', 19000, 4200, 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO beverages (id, ownership_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'custom', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO custom_beverage_profiles (beverage_id, name, beverage_type, created_at, updated_at)
      VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'IPA', 'beer', '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');
      INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
      VALUES ('f1111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '2026-08-14', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO taps (id, tap_number, name, enabled, first_used_at, retired_at, created_at, updated_at)
      VALUES ('t1111111-1111-4111-8111-111111111111', 1, 'Tap 1', 1, '2026-08-14T10:00:00.000Z', NULL, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

      INSERT INTO tap_assignment_lifecycles (id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at)
      VALUES ('a1111111-1111-4111-8111-111111111111', 't1111111-1111-4111-8111-111111111111', 'f1111111-1111-4111-8111-111111111111', '2026-08-14T10:00:00.000Z', NULL, NULL, '2026-08-14T10:00:00.000Z');
    `);

    // Deleting fill cascades and removes tap_assignment_lifecycles
    database.execute("DELETE FROM fills WHERE id = 'f1111111-1111-4111-8111-111111111111'");
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT count(*) AS count FROM tap_assignment_lifecycles",
        )
        .get()?.count,
      0,
    );

    // Tap remains with first_used_at intact
    const tap = database
      .prepare<[string], { readonly id: string; readonly first_used_at: string | null }>(
        "SELECT id, first_used_at FROM taps WHERE id = ?",
      )
      .get("t1111111-1111-4111-8111-111111111111");
    assert.equal(tap?.first_used_at, "2026-08-14T10:00:00.000Z");

    // Tap still cannot be deleted because it is historically used
    assert.throws(
      () => database.execute("DELETE FROM taps WHERE id = 't1111111-1111-4111-8111-111111111111'"),
      /used or retired taps cannot be deleted/,
    );
  } finally {
    database.close();
  }
});
