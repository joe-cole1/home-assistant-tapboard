import type { DatabaseExecutor } from "./connection.ts";

export const FOUNDATION_SCHEMA_VERSION = 1;
export const FOUNDATION_INITIAL_MIGRATION_NAME = "foundation-schema";

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  apply(database: DatabaseExecutor): undefined;
}

interface SchemaObjectRow {
  readonly name: string;
  readonly type: string;
}

interface MigrationRow {
  readonly version: number;
  readonly name: string;
}

interface TableColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface IndexRow {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

interface IndexColumnRow {
  readonly seqno: number;
  readonly cid: number;
  readonly name: string;
}

const CREATE_SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )
`;

function normalizeCreateTableSql(sql: string): string {
  return sql
    .replaceAll(/["`\[\]]/g, "")
    .replaceAll(/\s+/g, "")
    .toLowerCase();
}

export const FOUNDATION_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: FOUNDATION_SCHEMA_VERSION,
    name: FOUNDATION_INITIAL_MIGRATION_NAME,
    apply(database) {
      database.execute(CREATE_SCHEMA_MIGRATIONS_SQL);
      return undefined;
    },
  },
];

function incompatibleSchema(reason: string): Error {
  return new Error(`Incompatible SQLite schema: ${reason}`);
}

function validateMigrationDefinitions(migrations: readonly MigrationDefinition[]): void {
  if (migrations.length === 0) {
    throw new Error("At least one database migration is required");
  }

  const names = new Set<string>();

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error("Database migrations must be ordered contiguously from version 1");
    }

    if (migration.name.trim().length === 0 || names.has(migration.name)) {
      throw new Error("Database migration names must be non-empty and unique");
    }

    names.add(migration.name);
  }
}

function readUserVersion(database: DatabaseExecutor): number {
  const version = database.pragma<number>("user_version", { simple: true });
  if (!Number.isSafeInteger(version) || version < 0) {
    throw incompatibleSchema("invalid schema version");
  }
  return version;
}

function readSchemaObjects(database: DatabaseExecutor): SchemaObjectRow[] {
  return database
    .prepare<[], SchemaObjectRow>(
      `SELECT type, name
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function validateCleanVersionZero(database: DatabaseExecutor): void {
  if (readSchemaObjects(database).length !== 0) {
    throw incompatibleSchema("version 0 database is not empty");
  }
}

function validateMigrationLedger(
  database: DatabaseExecutor,
  userVersion: number,
  migrations: readonly MigrationDefinition[],
): void {
  let rows: MigrationRow[];

  try {
    rows = database
      .prepare<[], MigrationRow>(
        `SELECT version, name
         FROM schema_migrations
         ORDER BY version`,
      )
      .all();
  } catch {
    throw incompatibleSchema("migration ledger is missing or unreadable");
  }

  if (rows.length !== userVersion) {
    throw incompatibleSchema("migration ledger does not match the schema version");
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = migrations[index];
    if (
      row === undefined ||
      expected === undefined ||
      row.version !== index + 1 ||
      row.version !== expected.version ||
      row.name !== expected.name
    ) {
      throw incompatibleSchema("migration ledger is inconsistent");
    }
  }
}

function validateFoundationSchema(database: DatabaseExecutor): void {
  const objects = readSchemaObjects(database);
  if (
    objects.length !== 1 ||
    objects[0]?.type !== "table" ||
    objects[0].name !== "schema_migrations"
  ) {
    throw incompatibleSchema("unexpected schema objects");
  }

  const columns = database.pragma<TableColumnRow[]>("table_info(schema_migrations)");
  const expectedColumns: readonly Omit<TableColumnRow, "cid">[] = [
    { name: "version", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "applied_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ];

  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => {
      const expected = expectedColumns[index];
      return (
        expected === undefined ||
        column.cid !== index ||
        column.name !== expected.name ||
        column.type.toUpperCase() !== expected.type ||
        column.notnull !== expected.notnull ||
        column.dflt_value !== expected.dflt_value ||
        column.pk !== expected.pk
      );
    })
  ) {
    throw incompatibleSchema("migration ledger structure is invalid");
  }

  const indexes = database.pragma<IndexRow[]>("index_list(schema_migrations)");
  const uniqueNameIndexes = indexes.filter((index) => {
    if (index.unique !== 1 || index.origin !== "u" || index.partial !== 0) {
      return false;
    }

    const columnsForIndex = database.pragma<IndexColumnRow[]>(`index_info(${index.name})`);
    return (
      columnsForIndex.length === 1 &&
      columnsForIndex[0]?.seqno === 0 &&
      columnsForIndex[0].cid === 1 &&
      columnsForIndex[0].name === "name"
    );
  });

  if (uniqueNameIndexes.length !== 1) {
    throw incompatibleSchema("migration ledger constraints are invalid");
  }

  const tableSql = database
    .prepare<[], { readonly sql: string | null }>(
      `SELECT sql
       FROM sqlite_schema
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get()?.sql;
  if (
    tableSql === undefined ||
    tableSql === null ||
    normalizeCreateTableSql(tableSql) !== normalizeCreateTableSql(CREATE_SCHEMA_MIGRATIONS_SQL)
  ) {
    throw incompatibleSchema("migration ledger constraints are invalid");
  }
}

function recordMigration(database: DatabaseExecutor, migration: MigrationDefinition): void {
  database
    .prepare<[number, string]>(
      `INSERT INTO schema_migrations (version, name, applied_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .run(migration.version, migration.name);
  database.pragma(`user_version = ${migration.version}`);
}

function applyMigration(database: DatabaseExecutor, migration: MigrationDefinition): void {
  database.withTransaction(() => {
    const result: unknown = migration.apply(database);
    if (
      ((typeof result === "object" && result !== null) || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new TypeError("Database migrations must complete synchronously");
    }

    recordMigration(database, migration);
  });
}

export function initializeSchema(
  database: DatabaseExecutor,
  migrations: readonly MigrationDefinition[],
): void {
  validateMigrationDefinitions(migrations);

  const currentVersion = migrations.length;
  const userVersion = readUserVersion(database);

  if (userVersion > currentVersion) {
    throw incompatibleSchema("schema version is newer than this application supports");
  }

  if (userVersion === 0) {
    validateCleanVersionZero(database);
  } else {
    validateMigrationLedger(database, userVersion, migrations);

    if (userVersion === FOUNDATION_SCHEMA_VERSION) {
      validateFoundationSchema(database);
    }
  }

  for (const migration of migrations.slice(userVersion)) {
    applyMigration(database, migration);
  }

  const finalVersion = readUserVersion(database);
  if (finalVersion !== currentVersion) {
    throw incompatibleSchema("schema version did not reach the supported version");
  }

  validateMigrationLedger(database, currentVersion, migrations);
  validateFoundationSchema(database);
}
