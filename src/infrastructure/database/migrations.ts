import type { DatabaseExecutor } from "./connection.ts";

export const FOUNDATION_SCHEMA_VERSION = 1;
export const FOUNDATION_INITIAL_MIGRATION_NAME = "foundation-schema";
export const SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION = 2;
export const SECURITY_ACTIVITY_OUTBOX_MIGRATION_NAME = "security-activity-outbox-primitives";
export const PHYSICAL_KEGS_SCHEMA_VERSION = 3;
export const PHYSICAL_KEGS_MIGRATION_NAME = "physical-kegs";
export const CURRENT_SCHEMA_VERSION = PHYSICAL_KEGS_SCHEMA_VERSION;

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  apply(database: DatabaseExecutor): undefined;
}

interface SchemaObjectRow {
  readonly name: string;
  readonly type: string;
  readonly sql: string | null;
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

/*
 * SQLite preserves the declaration text in sqlite_schema, but normalizes
 * quoting and insignificant whitespace in a few versions. This comparison is
 * deliberately conservative: it does not strip SQL punctuation or comments,
 * so a semantically different declaration cannot masquerade as the canonical
 * one.
 */
function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/[`\[\]"]/g, "")
    .replaceAll(/\s+/g, "")
    .replace(/;$/, "")
    .toLowerCase();
}

function incompatibleSchema(reason: string): Error {
  return new Error(`Incompatible SQLite schema: ${reason}`);
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
      `SELECT name, type, sql
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

  validateFoundationLedgerStructure(database);
}

function validateFoundationLedgerStructure(database: DatabaseExecutor): void {
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
    normalizeSql(tableSql) !== normalizeSql(CREATE_SCHEMA_MIGRATIONS_SQL)
  ) {
    throw incompatibleSchema("migration ledger constraints are invalid");
  }
}

const SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL = `
  CREATE TABLE admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    verifier_version INTEGER NOT NULL CHECK (verifier_version = 1),
    scrypt_n INTEGER NOT NULL CHECK (scrypt_n = 16384),
    scrypt_r INTEGER NOT NULL CHECK (scrypt_r = 8),
    scrypt_p INTEGER NOT NULL CHECK (scrypt_p = 1),
    scrypt_key_length INTEGER NOT NULL CHECK (scrypt_key_length = 32),
    salt BLOB NOT NULL CHECK (length(salt) = 16),
    verifier BLOB NOT NULL CHECK (length(verifier) = scrypt_key_length),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE login_throttle (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence >= 0),
    window_started_at TEXT,
    attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 5),
    blocked_until TEXT,
    CHECK ((window_started_at IS NULL) = (attempt_count = 0)),
    CHECK (blocked_until IS NULL OR (window_started_at IS NOT NULL AND attempt_count = 5))
  );

  CREATE TABLE admin_sessions (
    id TEXT PRIMARY KEY,
    session_digest BLOB NOT NULL UNIQUE CHECK (length(session_digest) = 32),
    csrf_digest BLOB NOT NULL CHECK (length(csrf_digest) = 32),
    credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    CHECK (expires_at >= created_at),
    CHECK (absolute_expires_at >= created_at)
  );

  CREATE TABLE activity_retention (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE activity_log (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('security', 'admin', 'domain', 'integration', 'outbox', 'system')),
    action TEXT NOT NULL CHECK (length(CAST(action AS BLOB)) BETWEEN 1 AND 80),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'operator', 'system', 'machine')),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255),
    session_id TEXT CHECK (session_id IS NULL OR length(CAST(session_id AS BLOB)) BETWEEN 1 AND 255),
    entity_type TEXT CHECK (entity_type IS NULL OR length(CAST(entity_type AS BLOB)) BETWEEN 1 AND 255),
    entity_id TEXT CHECK (entity_id IS NULL OR length(CAST(entity_id AS BLOB)) BETWEEN 1 AND 255),
    details_json TEXT CHECK (details_json IS NULL OR length(CAST(details_json AS BLOB)) <= 2048),
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX idx_activity_log_occurred_at ON activity_log (occurred_at);
  CREATE TRIGGER trg_activity_log_no_update
    BEFORE UPDATE ON activity_log
    BEGIN
      SELECT RAISE(ABORT, 'activity_log is append-only');
    END;

  CREATE TABLE deletion_audit (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    entity_type TEXT NOT NULL CHECK (length(CAST(entity_type AS BLOB)) BETWEEN 1 AND 255),
    entity_id TEXT NOT NULL CHECK (length(CAST(entity_id AS BLOB)) BETWEEN 1 AND 255),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'operator', 'system', 'machine')),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255),
    reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 255),
    impacts_json TEXT NOT NULL CHECK (length(CAST(impacts_json AS BLOB)) BETWEEN 1 AND 2048),
    deleted_at TEXT NOT NULL
  );
  CREATE INDEX idx_deletion_audit_deleted_at ON deletion_audit (deleted_at);
  CREATE TRIGGER trg_deletion_audit_no_update
    BEFORE UPDATE ON deletion_audit
    BEGIN
      SELECT RAISE(ABORT, 'deletion_audit is immutable');
    END;
  CREATE TRIGGER trg_deletion_audit_no_delete
    BEFORE DELETE ON deletion_audit
    BEGIN
      SELECT RAISE(ABORT, 'deletion_audit is immutable');
    END;

  CREATE TABLE encrypted_secrets (
    id TEXT PRIMARY KEY,
    integration_type TEXT NOT NULL CHECK (length(CAST(integration_type AS BLOB)) BETWEEN 1 AND 255),
    record_id TEXT NOT NULL CHECK (length(CAST(record_id AS BLOB)) BETWEEN 1 AND 255),
    field_name TEXT NOT NULL CHECK (length(CAST(field_name AS BLOB)) BETWEEN 1 AND 255),
    envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
    nonce BLOB NOT NULL CHECK (length(nonce) = 12),
    ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 16384),
    auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (integration_type, record_id, field_name)
  );

  CREATE TABLE secret_rotation_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE machine_api_keys (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE CHECK (length(CAST(public_id AS BLOB)) = 16),
    verification_digest BLOB NOT NULL CHECK (length(verification_digest) = 32),
    label TEXT NOT NULL CHECK (length(CAST(label AS BLOB)) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    replacement_for_id TEXT
  );

  CREATE TABLE outbound_destinations (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL CHECK (length(CAST(label AS BLOB)) BETWEEN 1 AND 120),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE outbound_destination_versions (
    id TEXT PRIMARY KEY,
    destination_id TEXT NOT NULL REFERENCES outbound_destinations(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    created_at TEXT NOT NULL,
    UNIQUE (destination_id, version_number),
    UNIQUE (id, destination_id)
  );
  CREATE TRIGGER trg_outbound_destination_versions_no_update
    BEFORE UPDATE ON outbound_destination_versions
    BEGIN
      SELECT RAISE(ABORT, 'outbound_destination_versions is immutable');
    END;
  CREATE TABLE outbound_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (length(CAST(event_type AS BLOB)) BETWEEN 1 AND 255),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at TEXT NOT NULL,
    envelope_json TEXT NOT NULL CHECK (length(CAST(envelope_json AS BLOB)) BETWEEN 1 AND 16384),
    envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes = length(CAST(envelope_json AS BLOB)) AND envelope_bytes BETWEEN 1 AND 16384),
    coalescing_key TEXT CHECK (coalescing_key IS NULL OR length(CAST(coalescing_key AS BLOB)) BETWEEN 1 AND 255),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_outbound_events_created_at ON outbound_events (created_at);
  CREATE INDEX idx_outbound_events_type_coalescing ON outbound_events (event_type, coalescing_key);

  CREATE TABLE outbound_deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES outbound_events(id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL REFERENCES outbound_destinations(id) ON DELETE RESTRICT,
    destination_version_id TEXT NOT NULL REFERENCES outbound_destination_versions(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'retry', 'terminal', 'succeeded', 'dismissed')),
    attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 8),
    next_attempt_at TEXT NOT NULL,
    lease_owner TEXT CHECK (lease_owner IS NULL OR length(CAST(lease_owner AS BLOB)) BETWEEN 1 AND 255),
    lease_expires_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 120),
    envelope_bytes INTEGER NOT NULL CHECK (envelope_bytes BETWEEN 1 AND 16384),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    terminal_at TEXT,
    UNIQUE (event_id, destination_id),
    FOREIGN KEY (destination_version_id, destination_id)
      REFERENCES outbound_destination_versions(id, destination_id) ON DELETE RESTRICT,
    CHECK (
      (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK ((state IN ('terminal', 'succeeded', 'dismissed')) = (terminal_at IS NOT NULL))
  );
  CREATE INDEX idx_outbound_deliveries_due ON outbound_deliveries (state, next_attempt_at);
  CREATE INDEX idx_outbound_deliveries_destination_state ON outbound_deliveries (destination_id, state);

  CREATE TABLE outbox_overflow_incidents (
    slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 0 AND 15),
    is_catchall INTEGER NOT NULL CHECK (is_catchall IN (0, 1) AND ((slot = 15 AND is_catchall = 1) OR (slot < 15 AND is_catchall = 0))),
    incident_key TEXT UNIQUE CHECK (incident_key IS NULL OR length(CAST(incident_key AS BLOB)) BETWEEN 1 AND 255),
    destination_id TEXT CHECK (destination_id IS NULL OR length(CAST(destination_id AS BLOB)) BETWEEN 1 AND 255),
    event_type TEXT CHECK (event_type IS NULL OR length(CAST(event_type AS BLOB)) BETWEEN 1 AND 255),
    state TEXT NOT NULL CHECK (state IN ('empty', 'open', 'recovered')),
    first_at TEXT,
    last_at TEXT,
    omitted_count INTEGER NOT NULL CHECK (omitted_count >= 0),
    representative_json TEXT CHECK (representative_json IS NULL OR length(CAST(representative_json AS BLOB)) BETWEEN 1 AND 1024),
    CHECK (
      (state = 'empty' AND incident_key IS NULL AND destination_id IS NULL AND event_type IS NULL AND first_at IS NULL AND last_at IS NULL AND omitted_count = 0 AND representative_json IS NULL)
      OR
      (state IN ('open', 'recovered') AND incident_key IS NOT NULL AND first_at IS NOT NULL AND last_at IS NOT NULL AND omitted_count > 0 AND representative_json IS NOT NULL)
    )
  );
  CREATE TABLE outbox_degradation (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded')),
    opened_at TEXT,
    recovered_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    CHECK (state = 'healthy' OR (opened_at IS NOT NULL AND recovered_at IS NULL))
  );
`;

const OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL = `
  CREATE TRIGGER trg_outbox_overflow_incidents_no_insert
    BEFORE INSERT ON outbox_overflow_incidents
    BEGIN
      SELECT RAISE(ABORT, 'outbox_overflow_incidents rows are fixed');
    END;
  CREATE TRIGGER trg_outbox_overflow_incidents_no_delete
    BEFORE DELETE ON outbox_overflow_incidents
    BEGIN
      SELECT RAISE(ABORT, 'outbox_overflow_incidents rows are fixed');
    END;
`;

export const PHYSICAL_KEGS_SCHEMA_SQL = `
  CREATE TABLE kegs (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    keg_number INTEGER NOT NULL UNIQUE CHECK (keg_number >= 1),
    label TEXT CHECK (label IS NULL OR length(CAST(label AS BLOB)) BETWEEN 1 AND 120),
    capacity_ml INTEGER NOT NULL CHECK (capacity_ml > 0),
    current_tare_g INTEGER NOT NULL CHECK (current_tare_g >= 0),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE keg_tare_history (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    keg_id TEXT NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
    previous_tare_g INTEGER CHECK (previous_tare_g IS NULL OR previous_tare_g >= 0),
    new_tare_g INTEGER NOT NULL CHECK (new_tare_g >= 0),
    recorded_at TEXT NOT NULL,
    reason TEXT CHECK (reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 255),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'operator', 'system', 'machine')),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255)
  );
  CREATE INDEX idx_keg_tare_history_keg_recorded ON keg_tare_history (keg_id, recorded_at);
  CREATE TRIGGER trg_keg_tare_history_no_update
    BEFORE UPDATE ON keg_tare_history
    BEGIN
      SELECT RAISE(ABORT, 'keg_tare_history is append-only');
    END;

  CREATE TABLE keg_maintenance_records (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    keg_id TEXT NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
    maintenance_type TEXT NOT NULL CHECK (length(CAST(maintenance_type AS BLOB)) BETWEEN 1 AND 80),
    notes TEXT CHECK (notes IS NULL OR length(CAST(notes AS BLOB)) BETWEEN 1 AND 2048),
    recorded_at TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'operator', 'system', 'machine')),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255)
  );
  CREATE INDEX idx_keg_maintenance_keg_recorded ON keg_maintenance_records (keg_id, recorded_at);
  CREATE TRIGGER trg_keg_maintenance_records_no_update
    BEFORE UPDATE ON keg_maintenance_records
    BEGIN
      SELECT RAISE(ABORT, 'keg_maintenance_records is append-only');
    END;
`;

const SECURITY_ACTIVITY_OUTBOX_SCHEMA_OBJECTS = [
  ["table", "admin_credentials"],
  ["table", "activity_log"],
  ["table", "activity_retention"],
  ["table", "admin_sessions"],
  ["table", "deletion_audit"],
  ["table", "encrypted_secrets"],
  ["table", "login_throttle"],
  ["table", "machine_api_keys"],
  ["table", "outbound_deliveries"],
  ["table", "outbound_destination_versions"],
  ["table", "outbound_destinations"],
  ["table", "outbound_events"],
  ["table", "outbox_degradation"],
  ["table", "outbox_overflow_incidents"],
  ["table", "schema_migrations"],
  ["table", "secret_rotation_state"],
  ["index", "idx_activity_log_occurred_at"],
  ["index", "idx_deletion_audit_deleted_at"],
  ["index", "idx_outbound_deliveries_destination_state"],
  ["index", "idx_outbound_deliveries_due"],
  ["index", "idx_outbound_events_created_at"],
  ["index", "idx_outbound_events_type_coalescing"],
  ["trigger", "trg_deletion_audit_no_delete"],
  ["trigger", "trg_deletion_audit_no_update"],
  ["trigger", "trg_activity_log_no_update"],
  ["trigger", "trg_outbound_destination_versions_no_update"],
  ["trigger", "trg_outbox_overflow_incidents_no_delete"],
  ["trigger", "trg_outbox_overflow_incidents_no_insert"],
] as const;

const PHYSICAL_KEGS_SCHEMA_OBJECTS = [
  ...SECURITY_ACTIVITY_OUTBOX_SCHEMA_OBJECTS,
  ["table", "kegs"],
  ["table", "keg_tare_history"],
  ["table", "keg_maintenance_records"],
  ["index", "idx_keg_tare_history_keg_recorded"],
  ["index", "idx_keg_maintenance_keg_recorded"],
  ["trigger", "trg_keg_tare_history_no_update"],
  ["trigger", "trg_keg_maintenance_records_no_update"],
] as const;

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let triggerBody = false;
  let quote: "'" | '"' | "`" | "[" | undefined;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote === undefined) {
      if (character === "'" || character === '"' || character === "`" || character === "[") {
        quote = character;
      } else if (character === ";") {
        const statement = sql.slice(start, index).trim();
        if (!triggerBody && /^CREATE\s+TRIGGER\b/i.test(statement) && !/\bEND$/i.test(statement)) {
          triggerBody = true;
          continue;
        }
        if (triggerBody && !/\bEND$/i.test(statement)) continue;
        if (statement.length > 0) {
          statements.push(statement);
        }
        triggerBody = false;
        start = index + 1;
      }
    } else if (
      (quote === "'" && character === "'") ||
      (quote === '"' && character === '"') ||
      (quote === "`" && character === "`") ||
      (quote === "[" && character === "]")
    ) {
      // SQL escapes a quote by doubling it. Leave the first quote open when
      // the next character is the same delimiter.
      if (sql[index + 1] !== character) {
        quote = undefined;
      } else {
        index += 1;
      }
    }
  }
  const trailing = sql.slice(start).trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements;
}

function schemaDefinitionKey(sql: string): string | undefined {
  const match = /^CREATE\s+(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql.trim());
  return match === null ? undefined : `${match[1]!.toLowerCase()}:${match[2]!.toLowerCase()}`;
}

function validateSecurityActivityOutboxSchema(database: DatabaseExecutor): void {
  const expected = new Map(
    SECURITY_ACTIVITY_OUTBOX_SCHEMA_OBJECTS.map(([type, name]) => [`${type}:${name}`, type]),
  );
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema("schema objects do not match the supported v2 schema");
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}`,
  )) {
    const key = schemaDefinitionKey(statement);
    if (key !== undefined) {
      expectedSql.set(key, normalizeSql(statement));
    }
  }
  expectedSql.set("table:schema_migrations", normalizeSql(CREATE_SCHEMA_MIGRATIONS_SQL));
  for (const row of actual) {
    const expectedType = expected.get(`${row.type}:${row.name}`);
    const expectedDefinition = expectedSql.get(`${row.type}:${row.name}`);
    if (
      expectedType === undefined ||
      expectedDefinition === undefined ||
      row.sql === null ||
      normalizeSql(row.sql) !== expectedDefinition
    ) {
      throw incompatibleSchema(`schema object ${row.name} has invalid DDL`);
    }
  }
  validateSecurityActivityOutboxColumns(database);
}

function expectColumns(
  database: DatabaseExecutor,
  table: string,
  expected: readonly Omit<TableColumnRow, "cid">[],
): void {
  const columns = database.pragma<TableColumnRow[]>(`table_info(${table})`);
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index];
      return (
        wanted === undefined ||
        column.cid !== index ||
        column.name !== wanted.name ||
        column.type.toUpperCase() !== wanted.type ||
        column.notnull !== wanted.notnull ||
        column.dflt_value !== wanted.dflt_value ||
        column.pk !== wanted.pk
      );
    })
  ) {
    throw incompatibleSchema(`${table} structure is invalid`);
  }
}

function validateSecurityActivityOutboxColumns(database: DatabaseExecutor): void {
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    admin_credentials: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "verifier_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scrypt_n", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scrypt_r", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scrypt_p", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scrypt_key_length", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "salt", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "verifier", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    login_throttle: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "generation", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "attempt_sequence", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "window_started_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "attempt_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "blocked_until", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    admin_sessions: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "session_digest", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "csrf_digest", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "credential_revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_used_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "expires_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "absolute_expires_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "revoked_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    activity_retention: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "retention_days", type: "INTEGER", notnull: 1, dflt_value: "90", pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    activity_log: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "category", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "action", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "entity_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "entity_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "details_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "occurred_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    deletion_audit: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "schema_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "entity_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "entity_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "impacts_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "deleted_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    encrypted_secrets: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "integration_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "record_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "field_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "envelope_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "nonce", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "ciphertext", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "auth_tag", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    secret_rotation_state: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "generation", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    machine_api_keys: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "public_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "verification_digest", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "label", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_used_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "revoked_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "replacement_for_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    outbound_destinations: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "label", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    outbound_destination_versions: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "destination_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "version_number", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    outbound_events: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "event_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "schema_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "occurred_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "envelope_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "envelope_bytes", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "coalescing_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    outbound_deliveries: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "event_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "destination_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "destination_version_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "attempt_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "next_attempt_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "lease_owner", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "lease_expires_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_error_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "envelope_bytes", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "terminal_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    outbox_overflow_incidents: [
      { name: "slot", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "is_catchall", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "incident_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "destination_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "event_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "first_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "omitted_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "representative_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    outbox_degradation: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "opened_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "recovered_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validatePhysicalKegsColumns(database: DatabaseExecutor): void {
  validateSecurityActivityOutboxColumns(database);
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    kegs: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "keg_number", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "label", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "capacity_ml", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "current_tare_g", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "is_active", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    keg_tare_history: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "keg_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "previous_tare_g", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "new_tare_g", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "recorded_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "actor_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    keg_maintenance_records: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "keg_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "maintenance_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "recorded_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validatePhysicalKegsSchema(database: DatabaseExecutor): void {
  const expected = new Map(
    PHYSICAL_KEGS_SCHEMA_OBJECTS.map(([type, name]) => [`${type}:${name}`, type]),
  );
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema("schema objects do not match the supported v3 schema");
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}\n${PHYSICAL_KEGS_SCHEMA_SQL}`,
  )) {
    const key = schemaDefinitionKey(statement);
    if (key !== undefined) {
      expectedSql.set(key, normalizeSql(statement));
    }
  }
  expectedSql.set("table:schema_migrations", normalizeSql(CREATE_SCHEMA_MIGRATIONS_SQL));
  for (const row of actual) {
    const expectedType = expected.get(`${row.type}:${row.name}`);
    const expectedDefinition = expectedSql.get(`${row.type}:${row.name}`);
    if (
      expectedType === undefined ||
      expectedDefinition === undefined ||
      row.sql === null ||
      normalizeSql(row.sql) !== expectedDefinition
    ) {
      throw incompatibleSchema(`schema object ${row.name} has invalid DDL`);
    }
  }
  validatePhysicalKegsColumns(database);
}

function seedSecurityActivityOutbox(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO activity_retention (id, retention_days, updated_at)
    VALUES (1, 90, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    INSERT INTO secret_rotation_state (id, generation, updated_at)
    VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    INSERT INTO login_throttle
      (id, generation, attempt_sequence, window_started_at, attempt_count, blocked_until)
    VALUES (1, 0, 0, NULL, 0, NULL);
    INSERT INTO outbox_degradation (id, state, opened_at, recovered_at, revision)
    VALUES (1, 'healthy', NULL, NULL, 0);
  `);
  for (let slot = 0; slot < 16; slot += 1) {
    database
      .prepare<[number, number]>(
        `INSERT INTO outbox_overflow_incidents
         (slot, is_catchall, incident_key, destination_id, event_type, state,
          first_at, last_at, omitted_count, representative_json)
         VALUES (?, ?, NULL, NULL, NULL, 'empty', NULL, NULL, 0, NULL)`,
      )
      .run(slot, slot === 15 ? 1 : 0);
  }
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

export const SECURITY_ACTIVITY_OUTBOX_MIGRATION: MigrationDefinition = {
  version: SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION,
  name: SECURITY_ACTIVITY_OUTBOX_MIGRATION_NAME,
  apply(database) {
    database.execute(SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL);
    seedSecurityActivityOutbox(database);
    database.execute(OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL);
    return undefined;
  },
};

export const PHYSICAL_KEGS_MIGRATION: MigrationDefinition = {
  version: PHYSICAL_KEGS_SCHEMA_VERSION,
  name: PHYSICAL_KEGS_MIGRATION_NAME,
  apply(database) {
    database.execute(PHYSICAL_KEGS_SCHEMA_SQL);
    return undefined;
  },
};

/** Canonical production migration list. Keep this array identity stable. */
export const MIGRATIONS: readonly MigrationDefinition[] = [
  FOUNDATION_MIGRATIONS[0]!,
  SECURITY_ACTIVITY_OUTBOX_MIGRATION,
  PHYSICAL_KEGS_MIGRATION,
];

// Compatibility aliases for callers that prefer an explicit application name.
export const DATABASE_MIGRATIONS = MIGRATIONS;
export const APPLICATION_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

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

  if (migrations === MIGRATIONS && currentVersion === PHYSICAL_KEGS_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validatePhysicalKegsSchema(database);
  } else if (currentVersion === SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateSecurityActivityOutboxSchema(database);
  } else if (currentVersion === FOUNDATION_SCHEMA_VERSION) {
    validateFoundationSchema(database);
  }
}
