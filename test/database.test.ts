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

void test("a clean file database bootstraps the canonical v2 migration ledger", (context) => {
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
        { type: "index", name: "idx_deletion_audit_deleted_at" },
        { type: "index", name: "idx_outbound_deliveries_destination_state" },
        { type: "index", name: "idx_outbound_deliveries_due" },
        { type: "index", name: "idx_outbound_events_created_at" },
        { type: "index", name: "idx_outbound_events_type_coalescing" },
        { type: "table", name: "activity_log" },
        { type: "table", name: "activity_retention" },
        { type: "table", name: "admin_credentials" },
        { type: "table", name: "admin_sessions" },
        { type: "table", name: "deletion_audit" },
        { type: "table", name: "encrypted_secrets" },
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
        { type: "trigger", name: "trg_activity_log_no_update" },
        { type: "trigger", name: "trg_deletion_audit_no_delete" },
        { type: "trigger", name: "trg_deletion_audit_no_update" },
        { type: "trigger", name: "trg_outbound_destination_versions_no_update" },
        { type: "trigger", name: "trg_outbox_overflow_incidents_no_delete" },
        { type: "trigger", name: "trg_outbox_overflow_incidents_no_insert" },
      ],
    );
    const ledger = database
      .prepare<[], LedgerRow>(
        "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
      )
      .all();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.version, FOUNDATION_SCHEMA_VERSION);
    assert.equal(ledger[0]?.name, FOUNDATION_INITIAL_MIGRATION_NAME);
    assert.equal(ledger[1]?.version, CURRENT_SCHEMA_VERSION);
    assert.equal(ledger[1]?.name, "security-activity-outbox-primitives");
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
      28,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT count(*) AS count FROM schema_migrations")
        .get()?.count,
      2,
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

void test("an exact v1 database upgrades to v2 with both ledger entries", (context) => {
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
      ],
    );
  } finally {
    database.close();
  }
});

void test("canonical v2 reopen rejects an extra user object", (context) => {
  const path = makeDatabasePath(context);
  openDatabase(path, { migrations: MIGRATIONS }).close();
  withFixture(path, (database) => database.exec("CREATE TABLE unexpected_v2_table (id INTEGER)"));
  assert.throws(
    () => openDatabase(path, { migrations: MIGRATIONS }),
    /schema objects do not match|unexpected schema objects/,
  );
});

void test("v2 validation rejects a tampered DDL definition on reopen", (context) => {
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
      2,
    );
  } finally {
    reopened.close();
  }
});

void test("a clean version 0 database upgrades through the canonical v2 schema", (context) => {
  const path = makeDatabasePath(context);
  withFixture(path, (database) => assert.equal(readUserVersion(database), 0));

  openDatabase(path).close();

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), CURRENT_SCHEMA_VERSION);
    assert.equal(readSchemaObjects(database).length, 28);
  });
});

void test("migration definitions must be contiguous with nonempty unique names", async (context) => {
  const invalidSets: readonly (readonly MigrationDefinition[])[] = [
    [{ version: 2, name: "starts-late", apply: () => undefined }],
    [{ version: 1, name: "   ", apply: () => undefined }],
    [
      { version: 1, name: "duplicate", apply: () => undefined },
      { version: 2, name: "duplicate", apply: () => undefined },
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
  withFixture(path, (database) => database.exec("PRAGMA user_version = 3"));

  assert.throws(() => openDatabase(path), /schema version is newer/);

  withFixture(path, (database) => {
    assert.equal(readUserVersion(database), 3);
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
