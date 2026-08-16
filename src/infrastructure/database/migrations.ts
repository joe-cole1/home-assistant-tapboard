import type { DatabaseExecutor } from "./connection.ts";

export const FOUNDATION_SCHEMA_VERSION = 1;
export const FOUNDATION_INITIAL_MIGRATION_NAME = "foundation-schema";
export const SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION = 2;
export const SECURITY_ACTIVITY_OUTBOX_MIGRATION_NAME = "security-activity-outbox-primitives";
export const PHYSICAL_KEGS_SCHEMA_VERSION = 3;
export const PHYSICAL_KEGS_MIGRATION_NAME = "physical-kegs";
export const BEVERAGES_SCHEMA_VERSION = 4;
export const BEVERAGES_MIGRATION_NAME = "custom-and-brewfather-beverages";
export const FILLS_SCHEMA_VERSION = 5;
export const FILLS_MIGRATION_NAME = "fills-and-on-deck";
export const TAPS_SCHEMA_VERSION = 6;
export const TAPS_MIGRATION_NAME = "taps-and-assignment-lifecycles";
export const TELEMETRY_SCHEMA_VERSION = 7;
export const TELEMETRY_MIGRATION_NAME = "telemetry-sources-api-and-ingestion";
export const FORENSIC_QC_SCHEMA_VERSION = 8;
export const FORENSIC_QC_MIGRATION_NAME = "forensic-qc-telemetry-integrity";
export const TELEMETRY_EPOCHS_SCHEMA_VERSION = 9;
export const TELEMETRY_EPOCHS_MIGRATION_NAME = "telemetry-epochs-and-deterministic-pour-detector";
export const FORECASTING_SCHEMA_VERSION = 10;
export const FORECASTING_MIGRATION_NAME = "pour-history-forecasting";
export const HEALTH_MAINTENANCE_SCHEMA_VERSION = 11;
export const HEALTH_MAINTENANCE_MIGRATION_NAME = "draft-health-and-tap-maintenance";
export const DISPLAY_SCHEMA_VERSION = 12;
export const DISPLAY_MIGRATION_NAME = "ssr-dashboard-display-settings";
export const CURRENT_SCHEMA_VERSION = DISPLAY_SCHEMA_VERSION;

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

export const BEVERAGES_SCHEMA_SQL = `
  CREATE TABLE beverage_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    fallback_fg REAL NOT NULL DEFAULT 1.008 CHECK (fallback_fg BETWEEN 0.5 AND 2.0),
    brewfather_completion_policy TEXT NOT NULL DEFAULT 'never' CHECK (brewfather_completion_policy IN ('never', 'ask', 'completed')),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE beverages (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    ownership_type TEXT NOT NULL CHECK (ownership_type IN ('custom', 'brewfather')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE custom_beverage_profiles (
    beverage_id TEXT PRIMARY KEY REFERENCES beverages(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
    beverage_type TEXT NOT NULL CHECK (beverage_type IN ('beer', 'cider', 'mead', 'seltzer', 'soda', 'water', 'cocktail', 'kombucha', 'coffee', 'other')),
    style TEXT CHECK (style IS NULL OR length(CAST(style AS BLOB)) BETWEEN 1 AND 120),
    abv REAL CHECK (abv IS NULL OR (abv >= 0 AND abv <= 100)),
    ibu REAL CHECK (ibu IS NULL OR (ibu >= 0 AND ibu <= 2000)),
    og REAL CHECK (og IS NULL OR (og >= 0.5 AND og <= 2.0)),
    fg REAL CHECK (fg IS NULL OR (fg >= 0.5 AND fg <= 2.0)),
    srm REAL CHECK (srm IS NULL OR (srm >= 0 AND srm <= 100)),
    display_color TEXT CHECK (display_color IS NULL OR length(CAST(display_color AS BLOB)) BETWEEN 1 AND 32),
    description TEXT CHECK (description IS NULL OR length(CAST(description AS BLOB)) <= 4000),
    fill_glass TEXT CHECK (fill_glass IS NULL OR length(CAST(fill_glass AS BLOB)) BETWEEN 1 AND 64),
    manual_density_override REAL CHECK (manual_density_override IS NULL OR (manual_density_override >= 0.5 AND manual_density_override <= 2.0)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE custom_recipes (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    beverage_id TEXT NOT NULL UNIQUE REFERENCES beverages(id) ON DELETE CASCADE,
    notes TEXT CHECK (notes IS NULL OR length(CAST(notes AS BLOB)) <= 4000),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE custom_recipe_ingredients (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    recipe_id TEXT NOT NULL REFERENCES custom_recipes(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
    amount REAL CHECK (amount IS NULL OR amount >= 0),
    unit TEXT CHECK (unit IS NULL OR length(CAST(unit AS BLOB)) BETWEEN 1 AND 32),
    note TEXT CHECK (note IS NULL OR length(CAST(note AS BLOB)) <= 255)
  );
  CREATE INDEX idx_custom_recipe_ingredients_recipe ON custom_recipe_ingredients (recipe_id, sort_order);

  CREATE TABLE custom_recipe_steps (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    recipe_id TEXT NOT NULL REFERENCES custom_recipes(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
    temperature_c REAL CHECK (temperature_c IS NULL OR (temperature_c >= -50 AND temperature_c <= 150)),
    time_minutes REAL CHECK (time_minutes IS NULL OR time_minutes >= 0),
    note TEXT CHECK (note IS NULL OR length(CAST(note AS BLOB)) <= 1000)
  );
  CREATE INDEX idx_custom_recipe_steps_recipe ON custom_recipe_steps (recipe_id, sort_order);

  CREATE TABLE beverage_sensory_overrides (
    beverage_id TEXT PRIMARY KEY REFERENCES beverages(id) ON DELETE CASCADE,
    bitterness REAL CHECK (bitterness IS NULL OR (bitterness >= 0 AND bitterness <= 10)),
    sweetness REAL CHECK (sweetness IS NULL OR (sweetness >= 0 AND sweetness <= 10)),
    body REAL CHECK (body IS NULL OR (body >= 0 AND body <= 10)),
    roast REAL CHECK (roast IS NULL OR (roast >= 0 AND roast <= 10)),
    tartness REAL CHECK (tartness IS NULL OR (tartness >= 0 AND tartness <= 10)),
    alcohol REAL CHECK (alcohol IS NULL OR (alcohol >= 0 AND alcohol <= 10)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE brewfather_accounts (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) BETWEEN 1 AND 64),
    user_id TEXT NOT NULL CHECK (length(CAST(user_id AS BLOB)) BETWEEN 1 AND 120),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    discovery_statuses_json TEXT NOT NULL DEFAULT '["Planning","Brewing","Fermenting","Conditioning","Completed"]' CHECK (length(CAST(discovery_statuses_json AS BLOB)) <= 512),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE brewfather_candidate_cache (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    account_id TEXT NOT NULL REFERENCES brewfather_accounts(id) ON DELETE CASCADE,
    source_batch_id TEXT NOT NULL CHECK (length(CAST(source_batch_id AS BLOB)) BETWEEN 1 AND 256),
    batch_name TEXT CHECK (batch_name IS NULL OR length(CAST(batch_name AS BLOB)) <= 160),
    batch_number TEXT CHECK (batch_number IS NULL OR length(CAST(batch_number AS BLOB)) <= 64),
    status TEXT NOT NULL CHECK (length(CAST(status AS BLOB)) <= 32),
    brewer TEXT CHECK (brewer IS NULL OR length(CAST(brewer AS BLOB)) <= 120),
    recipe_name TEXT CHECK (recipe_name IS NULL OR length(CAST(recipe_name AS BLOB)) <= 160),
    style TEXT CHECK (style IS NULL OR length(CAST(style AS BLOB)) <= 120),
    brew_date TEXT,
    estimated_og REAL,
    estimated_fg REAL,
    estimated_abv REAL,
    estimated_ibu REAL,
    estimated_srm REAL,
    raw_summary_json TEXT CHECK (raw_summary_json IS NULL OR length(CAST(raw_summary_json AS BLOB)) <= 32768),
    summary_fingerprint TEXT NOT NULL CHECK (length(CAST(summary_fingerprint AS BLOB)) = 64),
    synced_at TEXT NOT NULL,
    UNIQUE (account_id, source_batch_id)
  );
  CREATE INDEX idx_brewfather_candidate_cache_account_status ON brewfather_candidate_cache (account_id, status);

  CREATE TABLE brewfather_beverage_links (
    beverage_id TEXT PRIMARY KEY REFERENCES beverages(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES brewfather_accounts(id) ON DELETE RESTRICT,
    source_batch_id TEXT NOT NULL CHECK (length(CAST(source_batch_id AS BLOB)) BETWEEN 1 AND 256),
    sync_state TEXT NOT NULL CHECK (sync_state IN ('synced', 'stale', 'error', 'pending')),
    last_synced_at TEXT,
    last_error_message TEXT CHECK (last_error_message IS NULL OR length(CAST(last_error_message AS BLOB)) <= 255),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (account_id, source_batch_id)
  );

  CREATE TABLE brewfather_source_profiles (
    beverage_id TEXT PRIMARY KEY REFERENCES beverages(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
    beverage_type TEXT NOT NULL CHECK (beverage_type IN ('beer', 'cider', 'mead', 'seltzer', 'soda', 'water', 'cocktail', 'kombucha', 'coffee', 'other')),
    style TEXT CHECK (style IS NULL OR length(CAST(style AS BLOB)) BETWEEN 1 AND 120),
    abv REAL CHECK (abv IS NULL OR (abv >= 0 AND abv <= 100)),
    ibu REAL CHECK (ibu IS NULL OR (ibu >= 0 AND ibu <= 2000)),
    og REAL CHECK (og IS NULL OR (og >= 0.5 AND og <= 2.0)),
    fg REAL CHECK (fg IS NULL OR (fg >= 0.5 AND fg <= 2.0)),
    srm REAL CHECK (srm IS NULL OR (srm >= 0 AND srm <= 100)),
    display_color TEXT CHECK (display_color IS NULL OR length(CAST(display_color AS BLOB)) BETWEEN 1 AND 32),
    description TEXT CHECK (description IS NULL OR length(CAST(description AS BLOB)) <= 4000),
    raw_source_json TEXT CHECK (raw_source_json IS NULL OR length(CAST(raw_source_json AS BLOB)) <= 65536),
    source_fingerprint TEXT NOT NULL CHECK (length(CAST(source_fingerprint AS BLOB)) = 64),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE brewfather_presentation_overrides (
    beverage_id TEXT PRIMARY KEY REFERENCES beverages(id) ON DELETE CASCADE,
    override_name_present INTEGER NOT NULL DEFAULT 0 CHECK (override_name_present IN (0, 1)),
    name TEXT CHECK (override_name_present = 0 OR (name IS NOT NULL AND length(CAST(name AS BLOB)) BETWEEN 1 AND 160)),
    override_beverage_type_present INTEGER NOT NULL DEFAULT 0 CHECK (override_beverage_type_present IN (0, 1)),
    beverage_type TEXT CHECK (beverage_type IS NULL OR beverage_type IN ('beer', 'cider', 'mead', 'seltzer', 'soda', 'water', 'cocktail', 'kombucha', 'coffee', 'other')),
    override_style_present INTEGER NOT NULL DEFAULT 0 CHECK (override_style_present IN (0, 1)),
    style TEXT CHECK (style IS NULL OR length(CAST(style AS BLOB)) BETWEEN 1 AND 120),
    override_abv_present INTEGER NOT NULL DEFAULT 0 CHECK (override_abv_present IN (0, 1)),
    abv REAL CHECK (abv IS NULL OR (abv >= 0 AND abv <= 100)),
    override_ibu_present INTEGER NOT NULL DEFAULT 0 CHECK (override_ibu_present IN (0, 1)),
    ibu REAL CHECK (ibu IS NULL OR (ibu >= 0 AND ibu <= 2000)),
    override_og_present INTEGER NOT NULL DEFAULT 0 CHECK (override_og_present IN (0, 1)),
    og REAL CHECK (og IS NULL OR (og >= 0.5 AND og <= 2.0)),
    override_fg_present INTEGER NOT NULL DEFAULT 0 CHECK (override_fg_present IN (0, 1)),
    fg REAL CHECK (fg IS NULL OR (fg >= 0.5 AND fg <= 2.0)),
    override_srm_present INTEGER NOT NULL DEFAULT 0 CHECK (override_srm_present IN (0, 1)),
    srm REAL CHECK (srm IS NULL OR (srm >= 0 AND srm <= 100)),
    override_display_color_present INTEGER NOT NULL DEFAULT 0 CHECK (override_display_color_present IN (0, 1)),
    display_color TEXT CHECK (display_color IS NULL OR length(CAST(display_color AS BLOB)) BETWEEN 1 AND 32),
    override_description_present INTEGER NOT NULL DEFAULT 0 CHECK (override_description_present IN (0, 1)),
    description TEXT CHECK (description IS NULL OR length(CAST(description AS BLOB)) <= 4000),
    override_fill_glass_present INTEGER NOT NULL DEFAULT 0 CHECK (override_fill_glass_present IN (0, 1)),
    fill_glass TEXT CHECK (fill_glass IS NULL OR length(CAST(fill_glass AS BLOB)) BETWEEN 1 AND 64),
    override_manual_density_override_present INTEGER NOT NULL DEFAULT 0 CHECK (override_manual_density_override_present IN (0, 1)),
    manual_density_override REAL CHECK (manual_density_override IS NULL OR (manual_density_override >= 0.5 AND manual_density_override <= 2.0)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE beverage_source_recipe_snapshots (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    beverage_id TEXT NOT NULL REFERENCES beverages(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL CHECK (length(CAST(account_id AS BLOB)) BETWEEN 1 AND 64),
    source_batch_id TEXT NOT NULL CHECK (length(CAST(source_batch_id AS BLOB)) BETWEEN 1 AND 256),
    source_recipe_id TEXT CHECK (source_recipe_id IS NULL OR length(CAST(source_recipe_id AS BLOB)) <= 256),
    state TEXT NOT NULL CHECK (state IN ('linked_current', 'detached', 'superseded')),
    version INTEGER NOT NULL CHECK (version >= 1),
    recipe_json TEXT NOT NULL CHECK (length(CAST(recipe_json AS BLOB)) BETWEEN 1 AND 262144),
    recipe_fingerprint TEXT NOT NULL CHECK (length(CAST(recipe_fingerprint AS BLOB)) = 64),
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_beverage_source_recipe_snapshots_linked ON beverage_source_recipe_snapshots (beverage_id) WHERE state = 'linked_current';
  CREATE INDEX idx_beverage_source_recipe_snapshots_beverage ON beverage_source_recipe_snapshots (beverage_id, version DESC);
`;

export const FILLS_SCHEMA_SQL = `
  CREATE TABLE fill_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    auto_delete_beverage_on_last_fill INTEGER NOT NULL DEFAULT 0 CHECK (auto_delete_beverage_on_last_fill IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE fills (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    beverage_id TEXT NOT NULL REFERENCES beverages(id) ON DELETE CASCADE,
    keg_id TEXT NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
    fill_date TEXT NOT NULL CHECK (length(CAST(fill_date AS BLOB)) = 10),
    on_deck_order INTEGER CHECK (on_deck_order IS NULL OR on_deck_order >= 1),
    ended_at TEXT,
    end_reason TEXT CHECK (end_reason IS NULL OR length(CAST(end_reason AS BLOB)) <= 255),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_fills_beverage_id ON fills (beverage_id);
  CREATE INDEX idx_fills_keg_id ON fills (keg_id);
  CREATE UNIQUE INDEX idx_fills_active_keg ON fills (keg_id) WHERE ended_at IS NULL;
  CREATE INDEX idx_fills_on_deck_order ON fills (on_deck_order) WHERE on_deck_order IS NOT NULL;
`;

export const TAPS_SCHEMA_SQL = `
  CREATE TABLE taps (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    tap_number INTEGER NOT NULL UNIQUE CHECK (tap_number >= 1),
    name TEXT CHECK (name IS NULL OR length(CAST(name AS BLOB)) BETWEEN 1 AND 120),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    first_used_at TEXT,
    retired_at TEXT,
    gas_type TEXT CHECK (gas_type IS NULL OR length(CAST(gas_type AS BLOB)) BETWEEN 1 AND 64),
    serving_pressure_kpa REAL CHECK (serving_pressure_kpa IS NULL OR serving_pressure_kpa >= 0),
    line_length_mm INTEGER CHECK (line_length_mm IS NULL OR line_length_mm >= 0),
    line_diameter_mm REAL CHECK (line_diameter_mm IS NULL OR line_diameter_mm > 0),
    notes TEXT CHECK (notes IS NULL OR length(CAST(notes AS BLOB)) <= 2048),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_taps_tap_number ON taps (tap_number);
  CREATE TRIGGER trg_taps_first_used_at_monotonic
    BEFORE UPDATE OF first_used_at ON taps
    FOR EACH ROW
    WHEN OLD.first_used_at IS NOT NULL AND (NEW.first_used_at IS NULL OR NEW.first_used_at <> OLD.first_used_at)
    BEGIN
      SELECT RAISE(ABORT, 'first_used_at is monotonic and cannot be cleared or changed');
    END;
  CREATE TRIGGER trg_taps_no_delete_if_used
    BEFORE DELETE ON taps
    FOR EACH ROW
    WHEN OLD.first_used_at IS NOT NULL OR OLD.retired_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'used or retired taps cannot be deleted');
    END;

  CREATE TABLE tap_assignment_lifecycles (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE RESTRICT,
    fill_id TEXT NOT NULL REFERENCES fills(id) ON DELETE CASCADE,
    assigned_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT CHECK (end_reason IS NULL OR length(CAST(end_reason AS BLOB)) <= 255),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tap_assignment_lifecycles_tap_id ON tap_assignment_lifecycles (tap_id);
  CREATE INDEX idx_tap_assignment_lifecycles_fill_id ON tap_assignment_lifecycles (fill_id);
  CREATE UNIQUE INDEX idx_tap_assignment_lifecycles_active_tap ON tap_assignment_lifecycles (tap_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX idx_tap_assignment_lifecycles_active_fill ON tap_assignment_lifecycles (fill_id) WHERE ended_at IS NULL;
  CREATE TRIGGER trg_tap_assignment_lifecycles_no_update_closed
    BEFORE UPDATE ON tap_assignment_lifecycles
    FOR EACH ROW
    WHEN OLD.ended_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'closed assignment lifecycles are immutable');
    END;
  CREATE TRIGGER trg_tap_assignment_lifecycles_immutable_fields
    BEFORE UPDATE ON tap_assignment_lifecycles
    FOR EACH ROW
    WHEN NEW.id <> OLD.id OR NEW.tap_id <> OLD.tap_id OR NEW.fill_id <> OLD.fill_id OR NEW.assigned_at <> OLD.assigned_at OR NEW.created_at <> OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'assignment lifecycle identities and open timestamps are immutable');
    END;
  CREATE TRIGGER trg_tap_assignment_lifecycles_no_open_reason
    BEFORE UPDATE ON tap_assignment_lifecycles
    FOR EACH ROW
    WHEN NEW.ended_at IS NULL AND NEW.end_reason IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'open assignment lifecycles cannot have an end reason');
    END;
`;

export const TELEMETRY_SCHEMA_SQL = `
  CREATE TABLE telemetry_sources (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    name TEXT NOT NULL UNIQUE CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 120),
    current_machine_key_id TEXT NOT NULL UNIQUE REFERENCES machine_api_keys(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_telemetry_sources_current_machine_key ON telemetry_sources (current_machine_key_id);

  CREATE TABLE tap_telemetry_authority (
    tap_id TEXT PRIMARY KEY REFERENCES taps(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES telemetry_sources(id) ON DELETE RESTRICT,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX idx_tap_telemetry_authority_source ON tap_telemetry_authority (source_id);

  CREATE TABLE telemetry_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    max_batch_size INTEGER NOT NULL DEFAULT 100 CHECK (max_batch_size BETWEEN 1 AND 100),
    max_future_skew_seconds INTEGER NOT NULL DEFAULT 300 CHECK (max_future_skew_seconds BETWEEN 0 AND 3600),
    reconnect_horizon_seconds INTEGER NOT NULL DEFAULT 21600 CHECK (reconnect_horizon_seconds BETWEEN 60 AND 86400),
    raw_retention_seconds INTEGER NOT NULL DEFAULT 21600 CHECK (raw_retention_seconds BETWEEN 300 AND 86400),
    receipt_retention_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (receipt_retention_seconds BETWEEN 3600 AND 604800),
    rate_limit_samples_per_minute INTEGER NOT NULL DEFAULT 600 CHECK (rate_limit_samples_per_minute BETWEEN 1 AND 6000),
    rate_limit_burst_samples INTEGER NOT NULL DEFAULT 100 CHECK (rate_limit_burst_samples BETWEEN 1 AND 1000),
    updated_at TEXT NOT NULL,
    CHECK (receipt_retention_seconds >= reconnect_horizon_seconds AND receipt_retention_seconds >= raw_retention_seconds AND max_batch_size <= rate_limit_burst_samples)
  );

  CREATE TABLE telemetry_ingest_receipts (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    source_id TEXT NOT NULL REFERENCES telemetry_sources(id) ON DELETE RESTRICT,
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE,
    identity_kind TEXT NOT NULL CHECK (identity_kind IN ('client_sample_id', 'fallback')),
    client_sample_id TEXT CHECK (client_sample_id IS NULL OR length(CAST(client_sample_id AS BLOB)) BETWEEN 1 AND 128),
    measured_at_epoch_ms INTEGER NOT NULL,
    payload_digest TEXT NOT NULL CHECK (
      length(CAST(payload_digest AS BLOB)) = 64
      AND payload_digest NOT GLOB '*[^0-9a-f]*'
    ),
    normalization_version INTEGER NOT NULL CHECK (normalization_version = 1),
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    outcome_code TEXT NOT NULL CHECK (length(CAST(outcome_code AS BLOB)) BETWEEN 1 AND 64),
    accepted_measurement_id TEXT CHECK (accepted_measurement_id IS NULL OR length(CAST(accepted_measurement_id AS BLOB)) = 36),
    measured_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    CHECK (
      (outcome = 'accepted' AND accepted_measurement_id IS NOT NULL)
      OR (outcome = 'rejected' AND accepted_measurement_id IS NULL)
    ),
    CHECK (
      (identity_kind = 'client_sample_id' AND client_sample_id IS NOT NULL)
      OR (identity_kind = 'fallback' AND client_sample_id IS NULL)
    )
  );
  CREATE UNIQUE INDEX idx_telemetry_receipts_client_identity ON telemetry_ingest_receipts (source_id, client_sample_id) WHERE client_sample_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_telemetry_receipts_fallback_identity ON telemetry_ingest_receipts (source_id, tap_id, measured_at_epoch_ms) WHERE client_sample_id IS NULL;
  CREATE INDEX idx_telemetry_receipts_processed_at ON telemetry_ingest_receipts (processed_at);

  CREATE TABLE telemetry_measurements (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    source_id TEXT NOT NULL REFERENCES telemetry_sources(id) ON DELETE RESTRICT,
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE,
    measured_at TEXT NOT NULL,
    measured_at_epoch_ms INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    normalization_version INTEGER NOT NULL CHECK (normalization_version = 1),
    primary_kind TEXT NOT NULL CHECK (primary_kind IN ('total_weight', 'remaining_volume', 'fill_percentage')),
    total_mass_g REAL CHECK (total_mass_g IS NULL OR total_mass_g >= 0),
    remaining_volume_ml REAL CHECK (remaining_volume_ml IS NULL OR remaining_volume_ml >= 0),
    fill_percentage REAL CHECK (fill_percentage IS NULL OR (fill_percentage >= 0 AND fill_percentage <= 100)),
    temperature_c REAL CHECK (temperature_c IS NULL OR (temperature_c >= -273.15 AND temperature_c <= 1000)),
    captured_assignment_id TEXT REFERENCES tap_assignment_lifecycles(id) ON DELETE SET NULL,
    captured_fill_id TEXT REFERENCES fills(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    CHECK ((primary_kind = 'total_weight' AND total_mass_g IS NOT NULL AND remaining_volume_ml IS NULL AND fill_percentage IS NULL) OR (primary_kind = 'remaining_volume' AND remaining_volume_ml IS NOT NULL AND total_mass_g IS NULL AND fill_percentage IS NULL) OR (primary_kind = 'fill_percentage' AND fill_percentage IS NOT NULL AND total_mass_g IS NULL AND remaining_volume_ml IS NULL)),
    CHECK ((captured_assignment_id IS NULL AND captured_fill_id IS NULL) OR (captured_assignment_id IS NOT NULL AND captured_fill_id IS NOT NULL))
  );
  CREATE INDEX idx_telemetry_measurements_tap_measured ON telemetry_measurements (tap_id, measured_at_epoch_ms);
  CREATE INDEX idx_telemetry_measurements_created_at ON telemetry_measurements (created_at);

  CREATE TABLE telemetry_source_tap_status (
    source_id TEXT NOT NULL REFERENCES telemetry_sources(id) ON DELETE RESTRICT,
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE,
    latest_measurement_id TEXT REFERENCES telemetry_measurements(id) ON DELETE SET NULL,
    latest_measured_at TEXT NOT NULL,
    latest_measured_at_epoch_ms INTEGER NOT NULL,
    latest_received_at TEXT NOT NULL,
    normalization_version INTEGER NOT NULL CHECK (normalization_version = 1),
    primary_kind TEXT NOT NULL CHECK (primary_kind IN ('total_weight', 'remaining_volume', 'fill_percentage')),
    total_mass_g REAL CHECK (total_mass_g IS NULL OR total_mass_g >= 0),
    remaining_volume_ml REAL CHECK (remaining_volume_ml IS NULL OR remaining_volume_ml >= 0),
    fill_percentage REAL CHECK (fill_percentage IS NULL OR (fill_percentage >= 0 AND fill_percentage <= 100)),
    temperature_c REAL CHECK (temperature_c IS NULL OR (temperature_c >= -273.15 AND temperature_c <= 1000)),
    captured_assignment_id TEXT REFERENCES tap_assignment_lifecycles(id) ON DELETE SET NULL,
    captured_fill_id TEXT REFERENCES fills(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    CHECK ((primary_kind = 'total_weight' AND total_mass_g IS NOT NULL AND remaining_volume_ml IS NULL AND fill_percentage IS NULL) OR (primary_kind = 'remaining_volume' AND remaining_volume_ml IS NOT NULL AND total_mass_g IS NULL AND fill_percentage IS NULL) OR (primary_kind = 'fill_percentage' AND fill_percentage IS NOT NULL AND total_mass_g IS NULL AND remaining_volume_ml IS NULL)),
    CHECK ((captured_assignment_id IS NULL AND captured_fill_id IS NULL) OR (captured_assignment_id IS NOT NULL AND captured_fill_id IS NOT NULL)),
    PRIMARY KEY (source_id, tap_id)
  );
  CREATE INDEX idx_telemetry_source_tap_status_tap ON telemetry_source_tap_status (tap_id);
`;

export const FORENSIC_QC_SCHEMA_SQL = `
  CREATE TRIGGER trg_telemetry_fill_delete_context
    BEFORE DELETE ON fills
    FOR EACH ROW
    BEGIN
      UPDATE telemetry_source_tap_status
      SET captured_assignment_id = NULL, captured_fill_id = NULL
      WHERE captured_fill_id = OLD.id;
      DELETE FROM telemetry_measurements WHERE captured_fill_id = OLD.id;
    END;
  CREATE TRIGGER trg_telemetry_assignment_delete_context
    BEFORE DELETE ON tap_assignment_lifecycles
    FOR EACH ROW
    BEGIN
      UPDATE telemetry_source_tap_status
      SET captured_assignment_id = NULL, captured_fill_id = NULL
      WHERE captured_assignment_id = OLD.id;
      DELETE FROM telemetry_measurements WHERE captured_assignment_id = OLD.id;
    END;
  CREATE TRIGGER trg_telemetry_measurements_no_update
    BEFORE UPDATE ON telemetry_measurements
    BEGIN
      SELECT RAISE(ABORT, 'telemetry measurements are immutable');
    END;
  CREATE TRIGGER trg_telemetry_measurements_validate_attribution
    BEFORE INSERT ON telemetry_measurements
    FOR EACH ROW
    WHEN NEW.captured_assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM tap_assignment_lifecycles
      WHERE id = NEW.captured_assignment_id
        AND fill_id = NEW.captured_fill_id
        AND tap_id = NEW.tap_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'telemetry measurement attribution is inconsistent');
    END;
  CREATE TRIGGER trg_telemetry_receipts_no_update
    BEFORE UPDATE ON telemetry_ingest_receipts
    BEGIN
      SELECT RAISE(ABORT, 'telemetry receipts are immutable');
    END;
  CREATE TRIGGER trg_telemetry_source_tap_status_validate_insert
    BEFORE INSERT ON telemetry_source_tap_status
    FOR EACH ROW
    WHEN
      (NEW.captured_assignment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tap_assignment_lifecycles
        WHERE id = NEW.captured_assignment_id
          AND fill_id = NEW.captured_fill_id
          AND tap_id = NEW.tap_id
      ))
      OR
      (NEW.latest_measurement_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM telemetry_measurements
        WHERE id = NEW.latest_measurement_id
          AND source_id = NEW.source_id
          AND tap_id = NEW.tap_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'telemetry status references inconsistent context');
    END;
  CREATE TRIGGER trg_telemetry_source_tap_status_validate_update
    BEFORE UPDATE ON telemetry_source_tap_status
    FOR EACH ROW
    WHEN
      (NEW.captured_assignment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM tap_assignment_lifecycles
        WHERE id = NEW.captured_assignment_id
          AND fill_id = NEW.captured_fill_id
          AND tap_id = NEW.tap_id
      ))
      OR
      (NEW.latest_measurement_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM telemetry_measurements
        WHERE id = NEW.latest_measurement_id
          AND source_id = NEW.source_id
          AND tap_id = NEW.tap_id
      ))
    BEGIN
      SELECT RAISE(ABORT, 'telemetry status references inconsistent context');
    END;
`;

const DETECTOR_CONFIG_COLUMNS_SQL = `
    candidate_loss_ml REAL NOT NULL CHECK (typeof(candidate_loss_ml) IN ('integer', 'real') AND candidate_loss_ml > 0),
    candidate_samples INTEGER NOT NULL CHECK (typeof(candidate_samples) = 'integer' AND candidate_samples >= 1),
    candidate_sample_window_ms INTEGER NOT NULL CHECK (typeof(candidate_sample_window_ms) = 'integer' AND candidate_sample_window_ms >= 0),
    candidate_lookback_ms INTEGER NOT NULL CHECK (typeof(candidate_lookback_ms) = 'integer' AND candidate_lookback_ms >= 0),
    arbitration_ms INTEGER NOT NULL CHECK (typeof(arbitration_ms) = 'integer' AND arbitration_ms >= 0),
    arbitration_minimum_ml REAL NOT NULL CHECK (typeof(arbitration_minimum_ml) IN ('integer', 'real') AND arbitration_minimum_ml > 0),
    arbitration_dominance_ratio REAL NOT NULL CHECK (typeof(arbitration_dominance_ratio) IN ('integer', 'real') AND arbitration_dominance_ratio >= 1),
    meaningful_flow_ml REAL NOT NULL CHECK (typeof(meaningful_flow_ml) IN ('integer', 'real') AND meaningful_flow_ml > 0),
    quiet_period_ms INTEGER NOT NULL CHECK (typeof(quiet_period_ms) = 'integer' AND quiet_period_ms >= 0),
    hard_timeout_ms INTEGER NOT NULL CHECK (typeof(hard_timeout_ms) = 'integer' AND hard_timeout_ms > 0),
    minimum_pour_ml REAL NOT NULL CHECK (typeof(minimum_pour_ml) IN ('integer', 'real') AND minimum_pour_ml > 0),
    implausible_jump_ml REAL NOT NULL CHECK (typeof(implausible_jump_ml) IN ('integer', 'real') AND implausible_jump_ml > 0),
    jump_stable_samples INTEGER NOT NULL CHECK (typeof(jump_stable_samples) = 'integer' AND jump_stable_samples >= 1),
    jump_stable_span_ms INTEGER NOT NULL CHECK (typeof(jump_stable_span_ms) = 'integer' AND jump_stable_span_ms >= 0),
    jump_band_ml REAL NOT NULL CHECK (typeof(jump_band_ml) IN ('integer', 'real') AND jump_band_ml >= 0),
    baseline_samples INTEGER NOT NULL CHECK (typeof(baseline_samples) = 'integer' AND baseline_samples >= 1),
    baseline_span_ms INTEGER NOT NULL CHECK (typeof(baseline_span_ms) = 'integer' AND baseline_span_ms >= 0),
    baseline_band_ml REAL NOT NULL CHECK (typeof(baseline_band_ml) IN ('integer', 'real') AND baseline_band_ml >= 0),
    settled_samples INTEGER NOT NULL CHECK (typeof(settled_samples) = 'integer' AND settled_samples >= 1),
    settled_span_ms INTEGER NOT NULL CHECK (typeof(settled_span_ms) = 'integer' AND settled_span_ms >= 0),
    settled_band_ml REAL NOT NULL CHECK (typeof(settled_band_ml) IN ('integer', 'real') AND settled_band_ml >= 0),
    cooldown_ms INTEGER NOT NULL CHECK (typeof(cooldown_ms) = 'integer' AND cooldown_ms >= 0),
    history_ms INTEGER NOT NULL CHECK (typeof(history_ms) = 'integer' AND history_ms > 0)`;
const DETECTOR_CONFIG_CONSTRAINTS_SQL = `
    CHECK (candidate_sample_window_ms <= candidate_lookback_ms),
    CHECK (hard_timeout_ms >= quiet_period_ms),
    CHECK (history_ms >= candidate_lookback_ms)`;
const NULLABLE_DETECTOR_CONFIG_COLUMNS_SQL = `
    candidate_loss_ml REAL CHECK (candidate_loss_ml IS NULL OR (typeof(candidate_loss_ml) IN ('integer', 'real') AND candidate_loss_ml > 0)),
    candidate_samples INTEGER CHECK (candidate_samples IS NULL OR (typeof(candidate_samples) = 'integer' AND candidate_samples >= 1)),
    candidate_sample_window_ms INTEGER CHECK (candidate_sample_window_ms IS NULL OR (typeof(candidate_sample_window_ms) = 'integer' AND candidate_sample_window_ms >= 0)),
    candidate_lookback_ms INTEGER CHECK (candidate_lookback_ms IS NULL OR (typeof(candidate_lookback_ms) = 'integer' AND candidate_lookback_ms >= 0)),
    arbitration_ms INTEGER CHECK (arbitration_ms IS NULL OR (typeof(arbitration_ms) = 'integer' AND arbitration_ms >= 0)),
    arbitration_minimum_ml REAL CHECK (arbitration_minimum_ml IS NULL OR (typeof(arbitration_minimum_ml) IN ('integer', 'real') AND arbitration_minimum_ml > 0)),
    arbitration_dominance_ratio REAL CHECK (arbitration_dominance_ratio IS NULL OR (typeof(arbitration_dominance_ratio) IN ('integer', 'real') AND arbitration_dominance_ratio >= 1)),
    meaningful_flow_ml REAL CHECK (meaningful_flow_ml IS NULL OR (typeof(meaningful_flow_ml) IN ('integer', 'real') AND meaningful_flow_ml > 0)),
    quiet_period_ms INTEGER CHECK (quiet_period_ms IS NULL OR (typeof(quiet_period_ms) = 'integer' AND quiet_period_ms >= 0)),
    hard_timeout_ms INTEGER CHECK (hard_timeout_ms IS NULL OR (typeof(hard_timeout_ms) = 'integer' AND hard_timeout_ms > 0)),
    minimum_pour_ml REAL CHECK (minimum_pour_ml IS NULL OR (typeof(minimum_pour_ml) IN ('integer', 'real') AND minimum_pour_ml > 0)),
    implausible_jump_ml REAL CHECK (implausible_jump_ml IS NULL OR (typeof(implausible_jump_ml) IN ('integer', 'real') AND implausible_jump_ml > 0)),
    jump_stable_samples INTEGER CHECK (jump_stable_samples IS NULL OR (typeof(jump_stable_samples) = 'integer' AND jump_stable_samples >= 1)),
    jump_stable_span_ms INTEGER CHECK (jump_stable_span_ms IS NULL OR (typeof(jump_stable_span_ms) = 'integer' AND jump_stable_span_ms >= 0)),
    jump_band_ml REAL CHECK (jump_band_ml IS NULL OR (typeof(jump_band_ml) IN ('integer', 'real') AND jump_band_ml >= 0)),
    baseline_samples INTEGER CHECK (baseline_samples IS NULL OR (typeof(baseline_samples) = 'integer' AND baseline_samples >= 1)),
    baseline_span_ms INTEGER CHECK (baseline_span_ms IS NULL OR (typeof(baseline_span_ms) = 'integer' AND baseline_span_ms >= 0)),
    baseline_band_ml REAL CHECK (baseline_band_ml IS NULL OR (typeof(baseline_band_ml) IN ('integer', 'real') AND baseline_band_ml >= 0)),
    settled_samples INTEGER CHECK (settled_samples IS NULL OR (typeof(settled_samples) = 'integer' AND settled_samples >= 1)),
    settled_span_ms INTEGER CHECK (settled_span_ms IS NULL OR (typeof(settled_span_ms) = 'integer' AND settled_span_ms >= 0)),
    settled_band_ml REAL CHECK (settled_band_ml IS NULL OR (typeof(settled_band_ml) IN ('integer', 'real') AND settled_band_ml >= 0)),
    cooldown_ms INTEGER CHECK (cooldown_ms IS NULL OR (typeof(cooldown_ms) = 'integer' AND cooldown_ms >= 0)),
    history_ms INTEGER CHECK (history_ms IS NULL OR (typeof(history_ms) = 'integer' AND history_ms > 0))`;

export const TELEMETRY_EPOCHS_SCHEMA_SQL = `
  CREATE TABLE detector_global_config (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 1),
    ${DETECTOR_CONFIG_COLUMNS_SQL}, updated_at TEXT NOT NULL, ${DETECTOR_CONFIG_CONSTRAINTS_SQL}
  );
  CREATE TABLE detector_tap_overrides (
    tap_id TEXT PRIMARY KEY REFERENCES taps(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision >= 1),
    ${NULLABLE_DETECTOR_CONFIG_COLUMNS_SQL}, updated_at TEXT NOT NULL
  );
  CREATE TABLE detector_arbitration_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 128), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_detector_arbitration_groups_name_ci ON detector_arbitration_groups (lower(name));
  CREATE TABLE detector_arbitration_members (
    tap_id TEXT PRIMARY KEY REFERENCES taps(id) ON DELETE CASCADE, group_id TEXT NOT NULL REFERENCES detector_arbitration_groups(id) ON DELETE CASCADE, joined_at TEXT NOT NULL
  );
  CREATE INDEX idx_detector_arbitration_members_group_id ON detector_arbitration_members (group_id);
  CREATE TABLE telemetry_epochs (
    id TEXT PRIMARY KEY, tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE, source_id TEXT REFERENCES telemetry_sources(id) ON DELETE RESTRICT, fill_id TEXT NOT NULL REFERENCES fills(id) ON DELETE CASCADE, assignment_id TEXT NOT NULL REFERENCES tap_assignment_lifecycles(id) ON DELETE CASCADE, keg_id TEXT NOT NULL REFERENCES kegs(id) ON DELETE CASCADE,
    capacity_ml REAL NOT NULL CHECK (typeof(capacity_ml) IN ('integer','real') AND capacity_ml > 0), tare_g REAL NOT NULL CHECK (typeof(tare_g) IN ('integer','real') AND tare_g >= 0), density_g_per_ml REAL NOT NULL CHECK (typeof(density_g_per_ml) IN ('integer','real') AND density_g_per_ml > 0), density_source TEXT NOT NULL CHECK (density_source IN ('manual_override','fg_derived','fallback_fg')), normalization_version INTEGER NOT NULL CHECK (normalization_version = 1), detector_config_version TEXT NOT NULL CHECK (length(CAST(detector_config_version AS BLOB)) > 0), global_config_revision INTEGER NOT NULL CHECK (global_config_revision >= 1), tap_override_revision INTEGER CHECK (tap_override_revision >= 1),
    ${DETECTOR_CONFIG_COLUMNS_SQL}, arbitration_group_id TEXT REFERENCES detector_arbitration_groups(id) ON DELETE RESTRICT, started_at TEXT NOT NULL, started_at_epoch_ms INTEGER NOT NULL, ended_at TEXT, ended_at_epoch_ms INTEGER, close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('assignment_unassigned','assignment_moved','fill_ended','source_changed','capacity_changed','tare_changed','density_changed','detector_config_changed','manual_rebaseline','arbitration_changed')),
    ${DETECTOR_CONFIG_CONSTRAINTS_SQL},
    CHECK ((ended_at IS NULL AND ended_at_epoch_ms IS NULL AND close_reason IS NULL) OR (ended_at IS NOT NULL AND ended_at_epoch_ms IS NOT NULL AND close_reason IS NOT NULL AND ended_at_epoch_ms >= started_at_epoch_ms))
  );
  CREATE UNIQUE INDEX idx_telemetry_epochs_open_tap ON telemetry_epochs (tap_id) WHERE ended_at IS NULL;
  CREATE INDEX idx_telemetry_epochs_fill_id ON telemetry_epochs (fill_id);
  CREATE INDEX idx_telemetry_epochs_assignment_id ON telemetry_epochs (assignment_id);
  CREATE INDEX idx_telemetry_epochs_started_at ON telemetry_epochs (started_at_epoch_ms);
  CREATE TRIGGER trg_telemetry_epochs_close_once BEFORE UPDATE ON telemetry_epochs FOR EACH ROW WHEN NOT (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND NEW.id = OLD.id AND NEW.tap_id = OLD.tap_id AND NEW.source_id IS OLD.source_id AND NEW.fill_id = OLD.fill_id AND NEW.assignment_id = OLD.assignment_id AND NEW.keg_id = OLD.keg_id AND NEW.capacity_ml = OLD.capacity_ml AND NEW.tare_g = OLD.tare_g AND NEW.density_g_per_ml = OLD.density_g_per_ml AND NEW.density_source = OLD.density_source AND NEW.normalization_version = OLD.normalization_version AND NEW.detector_config_version = OLD.detector_config_version AND NEW.global_config_revision = OLD.global_config_revision AND NEW.tap_override_revision IS OLD.tap_override_revision AND NEW.arbitration_group_id IS OLD.arbitration_group_id AND NEW.started_at = OLD.started_at AND NEW.started_at_epoch_ms = OLD.started_at_epoch_ms AND NEW.candidate_loss_ml = OLD.candidate_loss_ml AND NEW.candidate_samples = OLD.candidate_samples AND NEW.candidate_sample_window_ms = OLD.candidate_sample_window_ms AND NEW.candidate_lookback_ms = OLD.candidate_lookback_ms AND NEW.arbitration_ms = OLD.arbitration_ms AND NEW.arbitration_minimum_ml = OLD.arbitration_minimum_ml AND NEW.arbitration_dominance_ratio = OLD.arbitration_dominance_ratio AND NEW.meaningful_flow_ml = OLD.meaningful_flow_ml AND NEW.quiet_period_ms = OLD.quiet_period_ms AND NEW.hard_timeout_ms = OLD.hard_timeout_ms AND NEW.minimum_pour_ml = OLD.minimum_pour_ml AND NEW.implausible_jump_ml = OLD.implausible_jump_ml AND NEW.jump_stable_samples = OLD.jump_stable_samples AND NEW.jump_stable_span_ms = OLD.jump_stable_span_ms AND NEW.jump_band_ml = OLD.jump_band_ml AND NEW.baseline_samples = OLD.baseline_samples AND NEW.baseline_span_ms = OLD.baseline_span_ms AND NEW.baseline_band_ml = OLD.baseline_band_ml AND NEW.settled_samples = OLD.settled_samples AND NEW.settled_span_ms = OLD.settled_span_ms AND NEW.settled_band_ml = OLD.settled_band_ml AND NEW.cooldown_ms = OLD.cooldown_ms AND NEW.history_ms = OLD.history_ms) BEGIN SELECT RAISE(ABORT, 'telemetry epochs are immutable after close'); END;
  CREATE TABLE telemetry_epoch_state (
    epoch_id TEXT PRIMARY KEY REFERENCES telemetry_epochs(id) ON DELETE CASCADE, phase TEXT NOT NULL CHECK (phase IN ('waiting_for_measurement','ready','candidate','pouring','cooldown','warning','closed')), baseline_volume_ml REAL, baseline_at_epoch_ms INTEGER, last_measurement_id TEXT, last_measured_at_epoch_ms INTEGER, last_primary_kind TEXT CHECK (last_primary_kind IS NULL OR last_primary_kind IN ('total_weight','remaining_volume','fill_percentage')), last_primary_value REAL, last_temperature_c REAL, last_interpreted_volume_ml REAL, last_stabilized_volume_ml REAL, last_public_volume_ml REAL, last_diagnostic_code TEXT CHECK (last_diagnostic_code IS NULL OR last_diagnostic_code IN ('ok','below_tare','negative_volume','above_capacity','implausible_jump')), candidate_session_id TEXT, candidate_started_at_epoch_ms INTEGER, candidate_baseline_volume_ml REAL, candidate_loss_ml REAL, arbitration_deadline_epoch_ms INTEGER, lowest_flow_volume_ml REAL, last_meaningful_flow_at_epoch_ms INTEGER, quiet_since_epoch_ms INTEGER, timeout_at_epoch_ms INTEGER, cooldown_until_epoch_ms INTEGER, warning_code TEXT CHECK (warning_code IS NULL OR warning_code = 'implausible_jump'), warning_activity_flag INTEGER NOT NULL DEFAULT 0 CHECK (warning_activity_flag IN (0,1)), warning_started_at_epoch_ms INTEGER, warning_reference_volume_ml REAL, last_cancellation_reason TEXT CHECK (last_cancellation_reason IS NULL OR last_cancellation_reason IN ('rebound','timeout','jump','arbitration')), updated_at TEXT NOT NULL,
    CHECK ((baseline_volume_ml IS NULL) = (baseline_at_epoch_ms IS NULL)),
    CHECK ((phase IN ('candidate','pouring') AND candidate_session_id IS NOT NULL AND candidate_started_at_epoch_ms IS NOT NULL AND candidate_baseline_volume_ml IS NOT NULL AND candidate_loss_ml IS NOT NULL) OR (phase NOT IN ('candidate','pouring') AND candidate_session_id IS NULL AND candidate_started_at_epoch_ms IS NULL AND candidate_baseline_volume_ml IS NULL AND candidate_loss_ml IS NULL)),
    CHECK ((phase = 'warning' AND warning_code = 'implausible_jump' AND warning_activity_flag = 1 AND warning_started_at_epoch_ms IS NOT NULL AND warning_reference_volume_ml IS NOT NULL) OR (phase <> 'warning' AND warning_code IS NULL AND warning_activity_flag = 0 AND warning_started_at_epoch_ms IS NULL AND warning_reference_volume_ml IS NULL)),
    CHECK ((phase = 'cooldown') = (cooldown_until_epoch_ms IS NOT NULL)),
    CHECK ((phase = 'pouring') = (timeout_at_epoch_ms IS NOT NULL))
  );
  CREATE TABLE telemetry_epoch_samples (
    epoch_id TEXT NOT NULL REFERENCES telemetry_epochs(id) ON DELETE CASCADE, measurement_id TEXT NOT NULL, measured_at_epoch_ms INTEGER NOT NULL, interpreted_volume_ml REAL NOT NULL CHECK (typeof(interpreted_volume_ml) IN ('integer','real') AND interpreted_volume_ml = interpreted_volume_ml), PRIMARY KEY (epoch_id, measurement_id), UNIQUE (epoch_id, measured_at_epoch_ms)
  );
  CREATE INDEX idx_telemetry_epoch_samples_epoch_time ON telemetry_epoch_samples (epoch_id, measured_at_epoch_ms);
  CREATE TABLE pours (
    id TEXT PRIMARY KEY, effect_key TEXT NOT NULL UNIQUE, fill_id TEXT NOT NULL REFERENCES fills(id) ON DELETE CASCADE, tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE, assignment_id TEXT NOT NULL REFERENCES tap_assignment_lifecycles(id) ON DELETE CASCADE, epoch_id TEXT NOT NULL REFERENCES telemetry_epochs(id) ON DELETE CASCADE, detector_session_id TEXT NOT NULL, canonical_volume_ml REAL NOT NULL CHECK (typeof(canonical_volume_ml) IN ('integer','real') AND canonical_volume_ml > 0), started_at TEXT NOT NULL, completed_at TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (epoch_id, detector_session_id)
  );
  CREATE INDEX idx_pours_fill_id ON pours (fill_id);
  CREATE INDEX idx_pours_tap_completed_at ON pours (tap_id, completed_at);
  CREATE TRIGGER trg_pours_no_update BEFORE UPDATE ON pours BEGIN SELECT RAISE(ABORT, 'pours are immutable'); END;
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

const BEVERAGES_SCHEMA_OBJECTS = [
  ...PHYSICAL_KEGS_SCHEMA_OBJECTS,
  ["table", "beverage_settings"],
  ["table", "beverages"],
  ["table", "custom_beverage_profiles"],
  ["table", "custom_recipes"],
  ["table", "custom_recipe_ingredients"],
  ["table", "custom_recipe_steps"],
  ["table", "beverage_sensory_overrides"],
  ["table", "brewfather_accounts"],
  ["table", "brewfather_candidate_cache"],
  ["table", "brewfather_beverage_links"],
  ["table", "brewfather_source_profiles"],
  ["table", "brewfather_presentation_overrides"],
  ["table", "beverage_source_recipe_snapshots"],
  ["index", "idx_custom_recipe_ingredients_recipe"],
  ["index", "idx_custom_recipe_steps_recipe"],
  ["index", "idx_brewfather_candidate_cache_account_status"],
  ["index", "idx_beverage_source_recipe_snapshots_linked"],
  ["index", "idx_beverage_source_recipe_snapshots_beverage"],
] as const;

const FILLS_SCHEMA_OBJECTS = [
  ...BEVERAGES_SCHEMA_OBJECTS,
  ["table", "fill_settings"],
  ["table", "fills"],
  ["index", "idx_fills_beverage_id"],
  ["index", "idx_fills_keg_id"],
  ["index", "idx_fills_active_keg"],
  ["index", "idx_fills_on_deck_order"],
] as const;

const TAPS_SCHEMA_OBJECTS = [
  ...FILLS_SCHEMA_OBJECTS,
  ["table", "taps"],
  ["table", "tap_assignment_lifecycles"],
  ["index", "idx_taps_tap_number"],
  ["index", "idx_tap_assignment_lifecycles_tap_id"],
  ["index", "idx_tap_assignment_lifecycles_fill_id"],
  ["index", "idx_tap_assignment_lifecycles_active_tap"],
  ["index", "idx_tap_assignment_lifecycles_active_fill"],
  ["trigger", "trg_taps_first_used_at_monotonic"],
  ["trigger", "trg_taps_no_delete_if_used"],
  ["trigger", "trg_tap_assignment_lifecycles_no_update_closed"],
  ["trigger", "trg_tap_assignment_lifecycles_immutable_fields"],
  ["trigger", "trg_tap_assignment_lifecycles_no_open_reason"],
] as const;

const TELEMETRY_SCHEMA_OBJECTS = [
  ...TAPS_SCHEMA_OBJECTS,
  ["table", "telemetry_sources"],
  ["table", "tap_telemetry_authority"],
  ["table", "telemetry_settings"],
  ["table", "telemetry_ingest_receipts"],
  ["table", "telemetry_measurements"],
  ["table", "telemetry_source_tap_status"],
  ["index", "idx_telemetry_sources_current_machine_key"],
  ["index", "idx_tap_telemetry_authority_source"],
  ["index", "idx_telemetry_receipts_client_identity"],
  ["index", "idx_telemetry_receipts_fallback_identity"],
  ["index", "idx_telemetry_receipts_processed_at"],
  ["index", "idx_telemetry_measurements_tap_measured"],
  ["index", "idx_telemetry_measurements_created_at"],
  ["index", "idx_telemetry_source_tap_status_tap"],
] as const;

const FORENSIC_QC_SCHEMA_OBJECTS = [
  ...TELEMETRY_SCHEMA_OBJECTS,
  ["trigger", "trg_telemetry_assignment_delete_context"],
  ["trigger", "trg_telemetry_fill_delete_context"],
  ["trigger", "trg_telemetry_measurements_no_update"],
  ["trigger", "trg_telemetry_measurements_validate_attribution"],
  ["trigger", "trg_telemetry_receipts_no_update"],
  ["trigger", "trg_telemetry_source_tap_status_validate_insert"],
  ["trigger", "trg_telemetry_source_tap_status_validate_update"],
] as const;

const TELEMETRY_EPOCHS_SCHEMA_OBJECTS = [
  ...FORENSIC_QC_SCHEMA_OBJECTS,
  ["table", "detector_global_config"],
  ["table", "detector_tap_overrides"],
  ["table", "detector_arbitration_groups"],
  ["table", "detector_arbitration_members"],
  ["table", "telemetry_epochs"],
  ["table", "telemetry_epoch_state"],
  ["table", "telemetry_epoch_samples"],
  ["table", "pours"],
  ["index", "idx_detector_arbitration_groups_name_ci"],
  ["index", "idx_detector_arbitration_members_group_id"],
  ["index", "idx_telemetry_epochs_open_tap"],
  ["index", "idx_telemetry_epochs_fill_id"],
  ["index", "idx_telemetry_epochs_assignment_id"],
  ["index", "idx_telemetry_epochs_started_at"],
  ["index", "idx_telemetry_epoch_samples_epoch_time"],
  ["index", "idx_pours_fill_id"],
  ["index", "idx_pours_tap_completed_at"],
  ["trigger", "trg_telemetry_epochs_close_once"],
  ["trigger", "trg_pours_no_update"],
] as const;

export const FORECASTING_SCHEMA_SQL = `
  CREATE TABLE forecast_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    serving_size_ml REAL NOT NULL CHECK (
      typeof(serving_size_ml) IN ('integer', 'real') AND
      serving_size_ml > 0 AND
      serving_size_ml < 1.7976931348623157e308
    ),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_pours_fill_completed_at ON pours (fill_id, completed_at DESC, id DESC);
  CREATE INDEX idx_tap_assignments_fill_assigned_at ON tap_assignment_lifecycles (fill_id, assigned_at, id);
`;

const FORECASTING_SCHEMA_OBJECTS = [
  ...TELEMETRY_EPOCHS_SCHEMA_OBJECTS,
  ["table", "forecast_settings"],
  ["index", "idx_pours_fill_completed_at"],
  ["index", "idx_tap_assignments_fill_assigned_at"],
] as const;

const HEALTH_BOOLEAN_CHECK = (column: string): string =>
  `typeof(${column}) = 'integer' AND ${column} IN (0, 1)`;
const HEALTH_MAX_DURATION_MS = 31_536_000_000;
const HEALTH_MAX_VOLUME_ML = 1_000_000_000;
const HEALTH_MAX_DAYS = 3_650;
const HEALTH_FINITE_REAL_CHECK = (column: string): string =>
  `typeof(${column}) IN ('integer', 'real') AND ${column} = ${column} AND ${column} > -1.7976931348623157e308 AND ${column} < 1.7976931348623157e308`;
const HEALTH_FINITE_NONNEGATIVE_REAL_CHECK = (column: string): string =>
  `${HEALTH_FINITE_REAL_CHECK(column)} AND ${column} >= 0`;
const HEALTH_INTEGER_POSITIVE_CHECK = (column: string): string =>
  `typeof(${column}) = 'integer' AND ${column} >= 1`;

const HEALTH_GLOBAL_CONFIG_COLUMNS_SQL = `
    low_keg_enabled INTEGER NOT NULL CHECK (${HEALTH_BOOLEAN_CHECK("low_keg_enabled")}),
    low_keg_threshold_percent REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("low_keg_threshold_percent")} AND low_keg_threshold_percent BETWEEN 0 AND 100),
    low_keg_critical_percent REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("low_keg_critical_percent")} AND low_keg_critical_percent BETWEEN 0 AND 100),
    low_keg_fixed_threshold_ml REAL NOT NULL CHECK (${HEALTH_FINITE_NONNEGATIVE_REAL_CHECK("low_keg_fixed_threshold_ml")} AND low_keg_fixed_threshold_ml <= ${HEALTH_MAX_VOLUME_ML}),
    low_keg_settling_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("low_keg_settling_ms")} AND low_keg_settling_ms <= ${HEALTH_MAX_DURATION_MS}),
    scale_availability_enabled INTEGER NOT NULL CHECK (${HEALTH_BOOLEAN_CHECK("scale_availability_enabled")}),
    scale_degraded_after_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("scale_degraded_after_ms")} AND scale_degraded_after_ms <= ${HEALTH_MAX_DURATION_MS}),
    scale_active_after_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("scale_active_after_ms")} AND scale_active_after_ms <= ${HEALTH_MAX_DURATION_MS}),
    suspected_leak_enabled INTEGER NOT NULL CHECK (${HEALTH_BOOLEAN_CHECK("suspected_leak_enabled")}),
    suspected_leak_loss_threshold_ml REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("suspected_leak_loss_threshold_ml")} AND suspected_leak_loss_threshold_ml > 0 AND suspected_leak_loss_threshold_ml <= ${HEALTH_MAX_VOLUME_ML}),
    suspected_leak_window_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_window_ms")} AND suspected_leak_window_ms <= ${HEALTH_MAX_DURATION_MS}),
    suspected_leak_pour_grace_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_pour_grace_ms")} AND suspected_leak_pour_grace_ms <= ${HEALTH_MAX_DURATION_MS}),
    suspected_leak_settling_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_settling_ms")} AND suspected_leak_settling_ms <= ${HEALTH_MAX_DURATION_MS}),
    suspected_leak_reset_movement_ml REAL NOT NULL CHECK (${HEALTH_FINITE_NONNEGATIVE_REAL_CHECK("suspected_leak_reset_movement_ml")} AND suspected_leak_reset_movement_ml > 0 AND suspected_leak_reset_movement_ml <= ${HEALTH_MAX_VOLUME_ML}),
    suspected_leak_max_samples INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_max_samples")} AND suspected_leak_max_samples <= 64),
    serving_temperature_enabled INTEGER NOT NULL CHECK (${HEALTH_BOOLEAN_CHECK("serving_temperature_enabled")}),
    serving_temperature_normal_min_c REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("serving_temperature_normal_min_c")} AND serving_temperature_normal_min_c BETWEEN -100 AND 100),
    serving_temperature_normal_max_c REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("serving_temperature_normal_max_c")} AND serving_temperature_normal_max_c BETWEEN -100 AND 100),
    serving_temperature_critical_min_c REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("serving_temperature_critical_min_c")} AND serving_temperature_critical_min_c BETWEEN -100 AND 100),
    serving_temperature_critical_max_c REAL NOT NULL CHECK (${HEALTH_FINITE_REAL_CHECK("serving_temperature_critical_max_c")} AND serving_temperature_critical_max_c BETWEEN -100 AND 100),
    serving_temperature_duration_ms INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("serving_temperature_duration_ms")} AND serving_temperature_duration_ms <= ${HEALTH_MAX_DURATION_MS}),
    line_cleaning_due_enabled INTEGER NOT NULL CHECK (${HEALTH_BOOLEAN_CHECK("line_cleaning_due_enabled")}),
    line_cleaning_due_interval_days INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("line_cleaning_due_interval_days")} AND line_cleaning_due_interval_days <= ${HEALTH_MAX_DAYS}),
    line_cleaning_due_critical_grace_days INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("line_cleaning_due_critical_grace_days")} AND line_cleaning_due_critical_grace_days <= ${HEALTH_MAX_DAYS})`;

const HEALTH_GLOBAL_CONFIG_CONSTRAINTS_SQL = `
    CHECK (low_keg_critical_percent <= low_keg_threshold_percent),
    CHECK (scale_degraded_after_ms < scale_active_after_ms),
    CHECK (serving_temperature_critical_min_c < serving_temperature_normal_min_c),
    CHECK (serving_temperature_normal_min_c < serving_temperature_normal_max_c),
    CHECK (serving_temperature_normal_max_c < serving_temperature_critical_max_c)`;

const HEALTH_OVERRIDE_CONFIG_COLUMNS_SQL = `
    low_keg_enabled INTEGER CHECK (low_keg_enabled IS NULL OR ${HEALTH_BOOLEAN_CHECK("low_keg_enabled")}),
    low_keg_threshold_percent REAL CHECK (low_keg_threshold_percent IS NULL OR (${HEALTH_FINITE_REAL_CHECK("low_keg_threshold_percent")} AND low_keg_threshold_percent BETWEEN 0 AND 100)),
    low_keg_critical_percent REAL CHECK (low_keg_critical_percent IS NULL OR (${HEALTH_FINITE_REAL_CHECK("low_keg_critical_percent")} AND low_keg_critical_percent BETWEEN 0 AND 100)),
    low_keg_fixed_threshold_ml REAL CHECK (low_keg_fixed_threshold_ml IS NULL OR (${HEALTH_FINITE_NONNEGATIVE_REAL_CHECK("low_keg_fixed_threshold_ml")} AND low_keg_fixed_threshold_ml <= ${HEALTH_MAX_VOLUME_ML})),
    low_keg_settling_ms INTEGER CHECK (low_keg_settling_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("low_keg_settling_ms")} AND low_keg_settling_ms <= ${HEALTH_MAX_DURATION_MS})),
    scale_availability_enabled INTEGER CHECK (scale_availability_enabled IS NULL OR ${HEALTH_BOOLEAN_CHECK("scale_availability_enabled")}),
    scale_degraded_after_ms INTEGER CHECK (scale_degraded_after_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("scale_degraded_after_ms")} AND scale_degraded_after_ms <= ${HEALTH_MAX_DURATION_MS})),
    scale_active_after_ms INTEGER CHECK (scale_active_after_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("scale_active_after_ms")} AND scale_active_after_ms <= ${HEALTH_MAX_DURATION_MS})),
    suspected_leak_enabled INTEGER CHECK (suspected_leak_enabled IS NULL OR ${HEALTH_BOOLEAN_CHECK("suspected_leak_enabled")}),
    suspected_leak_loss_threshold_ml REAL CHECK (suspected_leak_loss_threshold_ml IS NULL OR (${HEALTH_FINITE_REAL_CHECK("suspected_leak_loss_threshold_ml")} AND suspected_leak_loss_threshold_ml > 0 AND suspected_leak_loss_threshold_ml <= ${HEALTH_MAX_VOLUME_ML})),
    suspected_leak_window_ms INTEGER CHECK (suspected_leak_window_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_window_ms")} AND suspected_leak_window_ms <= ${HEALTH_MAX_DURATION_MS})),
    suspected_leak_pour_grace_ms INTEGER CHECK (suspected_leak_pour_grace_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_pour_grace_ms")} AND suspected_leak_pour_grace_ms <= ${HEALTH_MAX_DURATION_MS})),
    suspected_leak_settling_ms INTEGER CHECK (suspected_leak_settling_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_settling_ms")} AND suspected_leak_settling_ms <= ${HEALTH_MAX_DURATION_MS})),
    suspected_leak_reset_movement_ml REAL CHECK (suspected_leak_reset_movement_ml IS NULL OR (${HEALTH_FINITE_NONNEGATIVE_REAL_CHECK("suspected_leak_reset_movement_ml")} AND suspected_leak_reset_movement_ml > 0 AND suspected_leak_reset_movement_ml <= ${HEALTH_MAX_VOLUME_ML})),
    suspected_leak_max_samples INTEGER CHECK (suspected_leak_max_samples IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("suspected_leak_max_samples")} AND suspected_leak_max_samples <= 64)),
    serving_temperature_enabled INTEGER CHECK (serving_temperature_enabled IS NULL OR ${HEALTH_BOOLEAN_CHECK("serving_temperature_enabled")}),
    serving_temperature_normal_min_c REAL CHECK (serving_temperature_normal_min_c IS NULL OR (${HEALTH_FINITE_REAL_CHECK("serving_temperature_normal_min_c")} AND serving_temperature_normal_min_c BETWEEN -100 AND 100)),
    serving_temperature_normal_max_c REAL CHECK (serving_temperature_normal_max_c IS NULL OR (${HEALTH_FINITE_REAL_CHECK("serving_temperature_normal_max_c")} AND serving_temperature_normal_max_c BETWEEN -100 AND 100)),
    serving_temperature_critical_min_c REAL CHECK (serving_temperature_critical_min_c IS NULL OR (${HEALTH_FINITE_REAL_CHECK("serving_temperature_critical_min_c")} AND serving_temperature_critical_min_c BETWEEN -100 AND 100)),
    serving_temperature_critical_max_c REAL CHECK (serving_temperature_critical_max_c IS NULL OR (${HEALTH_FINITE_REAL_CHECK("serving_temperature_critical_max_c")} AND serving_temperature_critical_max_c BETWEEN -100 AND 100)),
    serving_temperature_duration_ms INTEGER CHECK (serving_temperature_duration_ms IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("serving_temperature_duration_ms")} AND serving_temperature_duration_ms <= ${HEALTH_MAX_DURATION_MS})),
    line_cleaning_due_enabled INTEGER CHECK (line_cleaning_due_enabled IS NULL OR ${HEALTH_BOOLEAN_CHECK("line_cleaning_due_enabled")}),
    line_cleaning_due_interval_days INTEGER CHECK (line_cleaning_due_interval_days IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("line_cleaning_due_interval_days")} AND line_cleaning_due_interval_days <= ${HEALTH_MAX_DAYS})),
    line_cleaning_due_critical_grace_days INTEGER CHECK (line_cleaning_due_critical_grace_days IS NULL OR (${HEALTH_INTEGER_POSITIVE_CHECK("line_cleaning_due_critical_grace_days")} AND line_cleaning_due_critical_grace_days <= ${HEALTH_MAX_DAYS}))`;

const HEALTH_OVERRIDE_CONFIG_CONSTRAINTS_SQL = `
    CHECK (low_keg_critical_percent IS NULL OR low_keg_threshold_percent IS NULL OR low_keg_critical_percent <= low_keg_threshold_percent),
    CHECK (scale_degraded_after_ms IS NULL OR scale_active_after_ms IS NULL OR scale_degraded_after_ms < scale_active_after_ms),
    CHECK (serving_temperature_critical_min_c IS NULL OR serving_temperature_normal_min_c IS NULL OR serving_temperature_critical_min_c < serving_temperature_normal_min_c),
    CHECK (serving_temperature_normal_min_c IS NULL OR serving_temperature_normal_max_c IS NULL OR serving_temperature_normal_min_c < serving_temperature_normal_max_c),
    CHECK (serving_temperature_normal_max_c IS NULL OR serving_temperature_critical_max_c IS NULL OR serving_temperature_normal_max_c < serving_temperature_critical_max_c)`;

export const HEALTH_MAINTENANCE_SCHEMA_SQL = `
  CREATE INDEX idx_pours_epoch_completed ON pours (epoch_id, completed_at DESC, id DESC);
  CREATE TABLE health_global_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("revision")}),
    ${HEALTH_GLOBAL_CONFIG_COLUMNS_SQL},
    updated_at TEXT NOT NULL,
    ${HEALTH_GLOBAL_CONFIG_CONSTRAINTS_SQL}
  );
  CREATE TABLE health_tap_overrides (
    tap_id TEXT PRIMARY KEY REFERENCES taps(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("revision")}),
    ${HEALTH_OVERRIDE_CONFIG_COLUMNS_SQL},
    updated_at TEXT NOT NULL,
    ${HEALTH_OVERRIDE_CONFIG_CONSTRAINTS_SQL}
  );
  CREATE TABLE health_check_state (
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE,
    check_id TEXT NOT NULL CHECK (check_id IN ('low_keg', 'scale_availability', 'suspected_leak', 'serving_temperature', 'line_cleaning_due')),
    state TEXT NOT NULL CHECK (state IN ('not_configured', 'healthy', 'degraded', 'active')),
    severity TEXT NOT NULL CHECK (severity IN ('none', 'info', 'warning', 'critical')),
    reason_code TEXT CHECK (reason_code IS NULL OR length(CAST(reason_code AS BLOB)) BETWEEN 1 AND 80),
    evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(evidence_json AS BLOB)) <= 2048),
    condition_started_at TEXT,
    last_observation_at TEXT,
    suppression_until TEXT,
    cooldown_until TEXT,
    revision INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("revision")}),
    evaluated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tap_id, check_id)
  );
  CREATE TABLE health_incidents (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE RESTRICT,
    check_id TEXT NOT NULL CHECK (check_id IN ('low_keg', 'scale_availability', 'suspected_leak', 'serving_temperature', 'line_cleaning_due')),
    opened_at TEXT NOT NULL,
    current_severity TEXT NOT NULL CHECK (current_severity IN ('warning', 'critical')),
    max_severity TEXT NOT NULL CHECK (max_severity IN ('warning', 'critical')),
    resolved_at TEXT,
    acknowledged_at TEXT,
    by_actor_id TEXT CHECK (by_actor_id IS NULL OR length(CAST(by_actor_id AS BLOB)) BETWEEN 1 AND 255),
    by_session_id TEXT CHECK (by_session_id IS NULL OR length(CAST(by_session_id AS BLOB)) BETWEEN 1 AND 255),
    open_reason_code TEXT NOT NULL CHECK (length(CAST(open_reason_code AS BLOB)) BETWEEN 1 AND 80),
    open_evidence_json TEXT NOT NULL CHECK (length(CAST(open_evidence_json AS BLOB)) BETWEEN 1 AND 2048),
    resolution_reason_code TEXT CHECK (resolution_reason_code IS NULL OR length(CAST(resolution_reason_code AS BLOB)) BETWEEN 1 AND 80),
    revision INTEGER NOT NULL CHECK (${HEALTH_INTEGER_POSITIVE_CHECK("revision")}),
    updated_at TEXT NOT NULL,
    CHECK (current_severity = 'warning' OR max_severity = 'critical'),
    CHECK ((acknowledged_at IS NULL AND by_actor_id IS NULL AND by_session_id IS NULL) OR (acknowledged_at IS NOT NULL AND by_session_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX idx_health_incidents_open_tap_check ON health_incidents (tap_id, check_id) WHERE resolved_at IS NULL;
  CREATE INDEX idx_health_incidents_tap_opened ON health_incidents (tap_id, opened_at);
  CREATE INDEX idx_health_incidents_resolved_at ON health_incidents (resolved_at);
  CREATE TABLE health_incident_transitions (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    incident_id TEXT NOT NULL REFERENCES health_incidents(id) ON DELETE CASCADE,
    transition_kind TEXT NOT NULL CHECK (transition_kind IN ('opened', 'severity_changed', 'resolved', 'acknowledged', 'cooldown_changed')),
    state TEXT CHECK (state IS NULL OR state IN ('not_configured', 'healthy', 'degraded', 'active')),
    severity TEXT CHECK (severity IS NULL OR severity IN ('none', 'info', 'warning', 'critical')),
    reason_code TEXT CHECK (reason_code IS NULL OR length(CAST(reason_code AS BLOB)) BETWEEN 1 AND 80),
    evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(evidence_json AS BLOB)) <= 2048),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255),
    session_id TEXT CHECK (session_id IS NULL OR length(CAST(session_id AS BLOB)) BETWEEN 1 AND 255),
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_health_incident_transitions_incident_occurred ON health_incident_transitions (incident_id, occurred_at, id);
  CREATE TRIGGER trg_health_incident_transitions_no_update
    BEFORE UPDATE ON health_incident_transitions
    BEGIN
      SELECT RAISE(ABORT, 'health_incident_transitions is append-only');
    END;
  CREATE TABLE health_leak_samples (
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE CASCADE,
    measurement_id TEXT NOT NULL CHECK (length(CAST(measurement_id AS BLOB)) = 36),
    epoch_id TEXT NOT NULL CHECK (length(CAST(epoch_id AS BLOB)) = 36),
    measured_at_epoch_ms INTEGER NOT NULL CHECK (typeof(measured_at_epoch_ms) = 'integer'),
    stabilized_volume_ml REAL NOT NULL CHECK (${HEALTH_FINITE_NONNEGATIVE_REAL_CHECK("stabilized_volume_ml")}),
    created_at TEXT NOT NULL,
    PRIMARY KEY (tap_id, measurement_id)
  );
  CREATE INDEX idx_health_leak_samples_tap_time ON health_leak_samples (tap_id, measured_at_epoch_ms);
  CREATE TABLE tap_line_maintenance_records (
    id TEXT PRIMARY KEY CHECK (length(CAST(id AS BLOB)) = 36),
    tap_id TEXT NOT NULL REFERENCES taps(id) ON DELETE RESTRICT,
    maintenance_type TEXT NOT NULL CHECK (maintenance_type IN ('line_cleaned', 'sanitized', 'inspection', 'repair', 'other')),
    performed_at TEXT NOT NULL,
    notes TEXT CHECK (notes IS NULL OR length(CAST(notes AS BLOB)) BETWEEN 1 AND 2048),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('operator', 'admin', 'system')),
    actor_id TEXT CHECK (actor_id IS NULL OR length(CAST(actor_id AS BLOB)) BETWEEN 1 AND 255),
    session_id TEXT CHECK (session_id IS NULL OR length(CAST(session_id AS BLOB)) BETWEEN 1 AND 255),
    recorded_at TEXT NOT NULL,
    resulting_due_at TEXT
  );
  CREATE INDEX idx_tap_line_maintenance_records_tap_performed_id ON tap_line_maintenance_records (tap_id, performed_at, id);
  CREATE TRIGGER trg_tap_line_maintenance_records_no_update
    BEFORE UPDATE ON tap_line_maintenance_records
    BEGIN
      SELECT RAISE(ABORT, 'tap_line_maintenance_records is append-only');
    END;
`;

const HEALTH_MAINTENANCE_SCHEMA_OBJECTS = [
  ...FORECASTING_SCHEMA_OBJECTS,
  ["index", "idx_pours_epoch_completed"],
  ["table", "health_global_config"],
  ["table", "health_tap_overrides"],
  ["table", "health_check_state"],
  ["table", "health_incidents"],
  ["table", "health_incident_transitions"],
  ["table", "health_leak_samples"],
  ["table", "tap_line_maintenance_records"],
  ["index", "idx_health_incidents_open_tap_check"],
  ["index", "idx_health_incidents_tap_opened"],
  ["index", "idx_health_incidents_resolved_at"],
  ["index", "idx_health_incident_transitions_incident_occurred"],
  ["index", "idx_health_leak_samples_tap_time"],
  ["index", "idx_tap_line_maintenance_records_tap_performed_id"],
  ["trigger", "trg_health_incident_transitions_no_update"],
  ["trigger", "trg_tap_line_maintenance_records_no_update"],
] as const;

export const DISPLAY_SCHEMA_SQL = `
  CREATE TABLE display_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    tapboard_name TEXT NOT NULL CHECK (length(trim(tapboard_name)) BETWEEN 1 AND 80),
    theme TEXT NOT NULL CHECK (theme IN ('modern_dark', 'warm_pub', 'cyberpunk', 'light_minimal')),
    font TEXT NOT NULL CHECK (font IN ('system', 'outfit', 'inter', 'roboto', 'fredoka', 'montserrat')),
    accent TEXT NOT NULL CHECK (accent IN ('amber', 'sky', 'rose', 'cyan', 'tan', 'orange', 'blue')),
    unit_system TEXT NOT NULL CHECK (unit_system IN ('us', 'metric')),
    show_serving_temperature INTEGER NOT NULL CHECK (show_serving_temperature IN (0, 1)),
    layout_mode TEXT NOT NULL CHECK (layout_mode IN ('scroll', 'rotation')),
    updated_at TEXT NOT NULL
  );
`;

const DISPLAY_SCHEMA_OBJECTS = [
  ...HEALTH_MAINTENANCE_SCHEMA_OBJECTS,
  ["table", "display_settings"],
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
  const match = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
    sql.trim(),
  );
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

function validateBeveragesColumns(database: DatabaseExecutor): void {
  validatePhysicalKegsColumns(database);
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    beverage_settings: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "fallback_fg", type: "REAL", notnull: 1, dflt_value: "1.008", pk: 0 },
      {
        name: "brewfather_completion_policy",
        type: "TEXT",
        notnull: 1,
        dflt_value: "'never'",
        pk: 0,
      },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    beverages: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "ownership_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    custom_beverage_profiles: [
      { name: "beverage_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "beverage_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "style", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "abv", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "ibu", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "og", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fg", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "srm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "display_color", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "description", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fill_glass", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "manual_density_override", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    custom_recipes: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "beverage_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    custom_recipe_ingredients: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "recipe_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "sort_order", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "amount", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "unit", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    custom_recipe_steps: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "recipe_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "sort_order", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "temperature_c", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "time_minutes", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "note", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
    beverage_sensory_overrides: [
      { name: "beverage_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "bitterness", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "sweetness", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "body", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "roast", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "tartness", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "alcohol", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    brewfather_accounts: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "user_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "enabled", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
      {
        name: "discovery_statuses_json",
        type: "TEXT",
        notnull: 1,
        dflt_value: '\'["Planning","Brewing","Fermenting","Conditioning","Completed"]\'',
        pk: 0,
      },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    brewfather_candidate_cache: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "account_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_batch_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "batch_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "batch_number", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "brewer", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "recipe_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "style", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "brew_date", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "estimated_og", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "estimated_fg", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "estimated_abv", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "estimated_ibu", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "estimated_srm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "raw_summary_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "summary_fingerprint", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "synced_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    brewfather_beverage_links: [
      { name: "beverage_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "account_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_batch_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "sync_state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_synced_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_error_message", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    brewfather_source_profiles: [
      { name: "beverage_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "beverage_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "style", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "abv", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "ibu", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "og", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fg", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "srm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "display_color", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "description", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "raw_source_json", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "source_fingerprint", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    brewfather_presentation_overrides: [
      { name: "beverage_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "override_name_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "override_beverage_type_present",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
        pk: 0,
      },
      { name: "beverage_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_style_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "style", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_abv_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "abv", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_ibu_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "ibu", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_og_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "og", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_fg_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "fg", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_srm_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "srm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "override_display_color_present",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
        pk: 0,
      },
      { name: "display_color", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_description_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "description", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "override_fill_glass_present", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "fill_glass", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "override_manual_density_override_present",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
        pk: 0,
      },
      { name: "manual_density_override", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    beverage_source_recipe_snapshots: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "beverage_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "account_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_batch_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_recipe_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "recipe_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "recipe_fingerprint", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validateBeveragesSchema(database: DatabaseExecutor): void {
  const expected = new Map(
    BEVERAGES_SCHEMA_OBJECTS.map(([type, name]) => [`${type}:${name}`, type]),
  );
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema("schema objects do not match the supported v4 schema");
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}\n${PHYSICAL_KEGS_SCHEMA_SQL}\n${BEVERAGES_SCHEMA_SQL}`,
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
  validateBeveragesColumns(database);
}

function validateFillsColumns(database: DatabaseExecutor): void {
  validateBeveragesColumns(database);
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    fill_settings: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      {
        name: "auto_delete_beverage_on_last_fill",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
        pk: 0,
      },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    fills: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "beverage_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "keg_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "fill_date", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "on_deck_order", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "ended_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "end_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validateFillsSchema(database: DatabaseExecutor): void {
  const expected = new Map(FILLS_SCHEMA_OBJECTS.map(([type, name]) => [`${type}:${name}`, type]));
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema("schema objects do not match the supported v5 schema");
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}\n${PHYSICAL_KEGS_SCHEMA_SQL}\n${BEVERAGES_SCHEMA_SQL}\n${FILLS_SCHEMA_SQL}`,
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
  validateFillsColumns(database);
}

function validateTapsColumns(database: DatabaseExecutor): void {
  validateFillsColumns(database);
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    taps: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "tap_number", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "enabled", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
      { name: "first_used_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "retired_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "gas_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "serving_pressure_kpa", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "line_length_mm", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "line_diameter_mm", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    tap_assignment_lifecycles: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "fill_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "assigned_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "ended_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "end_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validateTapsSchema(database: DatabaseExecutor): void {
  const expected = new Map(TAPS_SCHEMA_OBJECTS.map(([type, name]) => [`${type}:${name}`, type]));
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema("schema objects do not match the supported v6 schema");
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}\n${PHYSICAL_KEGS_SCHEMA_SQL}\n${BEVERAGES_SCHEMA_SQL}\n${FILLS_SCHEMA_SQL}\n${TAPS_SCHEMA_SQL}`,
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
  validateTapsColumns(database);
}

function validateTelemetryColumns(database: DatabaseExecutor): void {
  validateTapsColumns(database);
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    telemetry_sources: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "current_machine_key_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    tap_telemetry_authority: [
      { name: "tap_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "source_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "changed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    telemetry_settings: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "max_batch_size", type: "INTEGER", notnull: 1, dflt_value: "100", pk: 0 },
      { name: "max_future_skew_seconds", type: "INTEGER", notnull: 1, dflt_value: "300", pk: 0 },
      {
        name: "reconnect_horizon_seconds",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "21600",
        pk: 0,
      },
      { name: "raw_retention_seconds", type: "INTEGER", notnull: 1, dflt_value: "21600", pk: 0 },
      {
        name: "receipt_retention_seconds",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "86400",
        pk: 0,
      },
      {
        name: "rate_limit_samples_per_minute",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "600",
        pk: 0,
      },
      { name: "rate_limit_burst_samples", type: "INTEGER", notnull: 1, dflt_value: "100", pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    telemetry_ingest_receipts: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "source_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "identity_kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "client_sample_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "measured_at_epoch_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "payload_digest", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "normalization_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "outcome", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "outcome_code", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "accepted_measurement_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "measured_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "received_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "processed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    telemetry_measurements: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "source_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "measured_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "measured_at_epoch_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "received_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "normalization_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "primary_kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "total_mass_g", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "remaining_volume_ml", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fill_percentage", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "temperature_c", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "captured_assignment_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "captured_fill_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    telemetry_source_tap_status: [
      { name: "source_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "latest_measurement_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "latest_measured_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "latest_measured_at_epoch_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "latest_received_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "normalization_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "primary_kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "total_mass_g", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "remaining_volume_ml", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "fill_percentage", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "temperature_c", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "captured_assignment_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "captured_fill_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validateTelemetrySchemaDefinition(
  database: DatabaseExecutor,
  objects: readonly (readonly [string, string])[],
  additionalSql: string,
  version: number,
): void {
  const expected = new Map(objects.map(([type, name]) => [`${type}:${name}`, type]));
  const actual = readSchemaObjects(database).filter(
    ({ type, name }) => !(type === "index" && name.startsWith("sqlite_autoindex")),
  );
  if (
    actual.length !== expected.size ||
    actual.some(({ type, name }) => !expected.has(`${type}:${name}`))
  ) {
    throw incompatibleSchema(`schema objects do not match the supported v${version} schema`);
  }
  const expectedSql = new Map<string, string>();
  for (const statement of splitSqlStatements(
    `${SECURITY_ACTIVITY_OUTBOX_SCHEMA_SQL}\n${OUTBOX_OVERFLOW_GUARD_TRIGGERS_SQL}\n${PHYSICAL_KEGS_SCHEMA_SQL}\n${BEVERAGES_SCHEMA_SQL}\n${FILLS_SCHEMA_SQL}\n${TAPS_SCHEMA_SQL}\n${TELEMETRY_SCHEMA_SQL}\n${additionalSql}`,
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
  validateTelemetryColumns(database);
}

function validateTelemetryV7Schema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(database, TELEMETRY_SCHEMA_OBJECTS, "", 7);
}

function validateTelemetrySchema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(
    database,
    FORENSIC_QC_SCHEMA_OBJECTS,
    FORENSIC_QC_SCHEMA_SQL,
    FORENSIC_QC_SCHEMA_VERSION,
  );
}

function validateTelemetryEpochsSchema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(
    database,
    TELEMETRY_EPOCHS_SCHEMA_OBJECTS,
    `${FORENSIC_QC_SCHEMA_SQL}\n${TELEMETRY_EPOCHS_SCHEMA_SQL}`,
    TELEMETRY_EPOCHS_SCHEMA_VERSION,
  );
  // DDL comparison above is authoritative; these PRAGMA checks additionally guard
  // against SQLite declaration/column metadata drift in the detector tables.
  for (const table of [
    "detector_global_config",
    "detector_tap_overrides",
    "detector_arbitration_groups",
    "detector_arbitration_members",
    "telemetry_epochs",
    "telemetry_epoch_state",
    "telemetry_epoch_samples",
    "pours",
  ]) {
    if (database.pragma<TableColumnRow[]>(`table_info(${table})`).length === 0) {
      throw incompatibleSchema(`schema table ${table} has invalid columns`);
    }
  }
}

function validateForecastingSchema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(
    database,
    FORECASTING_SCHEMA_OBJECTS,
    `${FORENSIC_QC_SCHEMA_SQL}\n${TELEMETRY_EPOCHS_SCHEMA_SQL}\n${FORECASTING_SCHEMA_SQL}`,
    FORECASTING_SCHEMA_VERSION,
  );
  for (const table of ["forecast_settings", "pours", "tap_assignment_lifecycles"]) {
    if (database.pragma<TableColumnRow[]>(`table_info(${table})`).length === 0) {
      throw incompatibleSchema(`schema table ${table} has invalid columns`);
    }
  }
}

function validateHealthMaintenanceColumns(database: DatabaseExecutor): void {
  const required: Readonly<Record<string, readonly Omit<TableColumnRow, "cid">[]>> = {
    health_global_config: [
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_threshold_percent", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_critical_percent", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_fixed_threshold_ml", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_settling_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scale_availability_enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scale_degraded_after_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "scale_active_after_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "suspected_leak_enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_loss_threshold_ml",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_window_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_pour_grace_ms",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_settling_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_reset_movement_ml",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_max_samples", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "serving_temperature_enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      {
        name: "serving_temperature_normal_min_c",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_normal_max_c",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_critical_min_c",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_critical_max_c",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_duration_ms",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      { name: "line_cleaning_due_enabled", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      {
        name: "line_cleaning_due_interval_days",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "line_cleaning_due_critical_grace_days",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    health_tap_overrides: [
      { name: "tap_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "low_keg_enabled", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "low_keg_threshold_percent", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "low_keg_critical_percent", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "low_keg_fixed_threshold_ml", type: "REAL", notnull: 0, dflt_value: null, pk: 0 },
      { name: "low_keg_settling_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "scale_availability_enabled", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "scale_degraded_after_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "scale_active_after_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "suspected_leak_enabled", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_loss_threshold_ml",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_window_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_pour_grace_ms",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_settling_ms", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "suspected_leak_reset_movement_ml",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "suspected_leak_max_samples", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "serving_temperature_enabled", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "serving_temperature_normal_min_c",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_normal_max_c",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_critical_min_c",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_critical_max_c",
        type: "REAL",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "serving_temperature_duration_ms",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "line_cleaning_due_enabled", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      {
        name: "line_cleaning_due_interval_days",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        name: "line_cleaning_due_critical_grace_days",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    health_check_state: [
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "check_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "severity", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "evidence_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
      { name: "condition_started_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_observation_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "suppression_until", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "cooldown_until", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "evaluated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    health_incidents: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "check_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "opened_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "current_severity", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "max_severity", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "resolved_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "acknowledged_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "by_actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "by_session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "open_reason_code", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "open_evidence_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "resolution_reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    health_incident_transitions: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "incident_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "transition_kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "state", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "severity", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "reason_code", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "evidence_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "occurred_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    health_leak_samples: [
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { name: "measurement_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
      { name: "epoch_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "measured_at_epoch_ms", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "stabilized_volume_ml", type: "REAL", notnull: 1, dflt_value: null, pk: 0 },
      { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ],
    tap_line_maintenance_records: [
      { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      { name: "tap_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "maintenance_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "performed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "notes", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "actor_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "actor_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "recorded_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "resulting_due_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    ],
  };

  for (const [table, columns] of Object.entries(required)) {
    expectColumns(database, table, columns);
  }
}

function validateHealthMaintenanceSchema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(
    database,
    HEALTH_MAINTENANCE_SCHEMA_OBJECTS,
    `${FORENSIC_QC_SCHEMA_SQL}\n${TELEMETRY_EPOCHS_SCHEMA_SQL}\n${FORECASTING_SCHEMA_SQL}\n${HEALTH_MAINTENANCE_SCHEMA_SQL}`,
    HEALTH_MAINTENANCE_SCHEMA_VERSION,
  );
  validateHealthMaintenanceColumns(database);
}

function validateDisplaySchema(database: DatabaseExecutor): void {
  validateTelemetrySchemaDefinition(
    database,
    DISPLAY_SCHEMA_OBJECTS,
    `${FORENSIC_QC_SCHEMA_SQL}\n${TELEMETRY_EPOCHS_SCHEMA_SQL}\n${FORECASTING_SCHEMA_SQL}\n${HEALTH_MAINTENANCE_SCHEMA_SQL}\n${DISPLAY_SCHEMA_SQL}`,
    DISPLAY_SCHEMA_VERSION,
  );
  validateHealthMaintenanceColumns(database);
  expectColumns(database, "display_settings", [
    { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
    { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "tapboard_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "theme", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "font", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "accent", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "unit_system", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "show_serving_temperature", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "layout_mode", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  ]);
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

function seedBeverages(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO beverage_settings (id, fallback_fg, brewfather_completion_policy, updated_at)
    VALUES (1, 1.008, 'never', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
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

export const BEVERAGES_MIGRATION: MigrationDefinition = {
  version: BEVERAGES_SCHEMA_VERSION,
  name: BEVERAGES_MIGRATION_NAME,
  apply(database) {
    database.execute(BEVERAGES_SCHEMA_SQL);
    seedBeverages(database);
    return undefined;
  },
};

function seedFills(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO fill_settings (id, auto_delete_beverage_on_last_fill, updated_at)
    VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

export const FILLS_MIGRATION: MigrationDefinition = {
  version: FILLS_SCHEMA_VERSION,
  name: FILLS_MIGRATION_NAME,
  apply(database) {
    database.execute(FILLS_SCHEMA_SQL);
    seedFills(database);
    return undefined;
  },
};

export const TAPS_MIGRATION: MigrationDefinition = {
  version: TAPS_SCHEMA_VERSION,
  name: TAPS_MIGRATION_NAME,
  apply(database) {
    database.execute(TAPS_SCHEMA_SQL);
    return undefined;
  },
};

function seedTelemetrySettings(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO telemetry_settings (
      id, max_batch_size, max_future_skew_seconds, reconnect_horizon_seconds,
      raw_retention_seconds, receipt_retention_seconds, rate_limit_samples_per_minute,
      rate_limit_burst_samples, updated_at
    ) VALUES (
      1, 100, 300, 21600, 21600, 86400, 600, 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
  `);
}

export const TELEMETRY_MIGRATION: MigrationDefinition = {
  version: TELEMETRY_SCHEMA_VERSION,
  name: TELEMETRY_MIGRATION_NAME,
  apply(database) {
    database.execute(TELEMETRY_SCHEMA_SQL);
    seedTelemetrySettings(database);
    return undefined;
  },
};

export const FORENSIC_QC_MIGRATION: MigrationDefinition = {
  version: FORENSIC_QC_SCHEMA_VERSION,
  name: FORENSIC_QC_MIGRATION_NAME,
  apply(database) {
    database.execute(FORENSIC_QC_SCHEMA_SQL);
    return undefined;
  },
};

function seedDetectorGlobalConfig(database: DatabaseExecutor): void {
  database.execute(
    `INSERT INTO detector_global_config (id, revision, candidate_loss_ml, candidate_samples, candidate_sample_window_ms, candidate_lookback_ms, arbitration_ms, arbitration_minimum_ml, arbitration_dominance_ratio, meaningful_flow_ml, quiet_period_ms, hard_timeout_ms, minimum_pour_ml, implausible_jump_ml, jump_stable_samples, jump_stable_span_ms, jump_band_ml, baseline_samples, baseline_span_ms, baseline_band_ml, settled_samples, settled_span_ms, settled_band_ml, cooldown_ms, history_ms, updated_at) VALUES (1, 1, 23.65882365, 3, 400, 3000, 400, 14.78676478125, 1.5, 5.9147059125, 5000, 15000, 29.5735295625, 887.205886875, 5, 3000, 14.78676478125, 5, 800, 8.87205886875, 5, 800, 8.87205886875, 5000, 6000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  );
}

export const TELEMETRY_EPOCHS_MIGRATION: MigrationDefinition = {
  version: TELEMETRY_EPOCHS_SCHEMA_VERSION,
  name: TELEMETRY_EPOCHS_MIGRATION_NAME,
  apply(database) {
    database.execute(TELEMETRY_EPOCHS_SCHEMA_SQL);
    seedDetectorGlobalConfig(database);
    return undefined;
  },
};

function seedForecastSettings(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO forecast_settings (id, serving_size_ml, updated_at)
    VALUES (1, 354.88235475, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

export const FORECASTING_MIGRATION: MigrationDefinition = {
  version: FORECASTING_SCHEMA_VERSION,
  name: FORECASTING_MIGRATION_NAME,
  apply(database) {
    database.execute(FORECASTING_SCHEMA_SQL);
    seedForecastSettings(database);
    return undefined;
  },
};

function seedHealthMaintenance(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO health_global_config (
      id, revision,
      low_keg_enabled, low_keg_threshold_percent, low_keg_critical_percent,
      low_keg_fixed_threshold_ml, low_keg_settling_ms,
      scale_availability_enabled, scale_degraded_after_ms, scale_active_after_ms,
      suspected_leak_enabled, suspected_leak_loss_threshold_ml, suspected_leak_window_ms,
      suspected_leak_pour_grace_ms, suspected_leak_settling_ms,
      suspected_leak_reset_movement_ml, suspected_leak_max_samples,
      serving_temperature_enabled, serving_temperature_normal_min_c,
      serving_temperature_normal_max_c, serving_temperature_critical_min_c,
      serving_temperature_critical_max_c, serving_temperature_duration_ms,
      line_cleaning_due_enabled, line_cleaning_due_interval_days,
      line_cleaning_due_critical_grace_days, updated_at
    ) VALUES (
      1, 1,
      1, 20, 5, 0, 30000,
      1, 300000, 1800000,
      0, 236.5882365, 900000, 120000, 600000, 946.352946, 64,
      0, 1.1111111111111112, 5.555555555555555, -1.1111111111111112, 10, 900000,
      0, 14, 7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
    INSERT INTO health_check_state (
      tap_id, check_id, state, severity, evidence_json, revision, evaluated_at, updated_at
    )
    SELECT taps.id, checks.check_id, 'not_configured', 'none', '{}', 1,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM taps
    CROSS JOIN (
      SELECT 'low_keg' AS check_id
      UNION ALL SELECT 'scale_availability'
      UNION ALL SELECT 'suspected_leak'
      UNION ALL SELECT 'serving_temperature'
      UNION ALL SELECT 'line_cleaning_due'
    ) AS checks;
  `);
}

export const HEALTH_MAINTENANCE_MIGRATION: MigrationDefinition = {
  version: HEALTH_MAINTENANCE_SCHEMA_VERSION,
  name: HEALTH_MAINTENANCE_MIGRATION_NAME,
  apply(database) {
    database.execute(HEALTH_MAINTENANCE_SCHEMA_SQL);
    seedHealthMaintenance(database);
    return undefined;
  },
};

function seedDisplaySettings(database: DatabaseExecutor): void {
  database.execute(`
    INSERT INTO display_settings (
      id, revision, tapboard_name, theme, font, accent, unit_system,
      show_serving_temperature, layout_mode, updated_at
    ) VALUES (1, 1, 'Tapboard', 'modern_dark', 'system', 'amber', 'us', 0, 'scroll',
      '1970-01-01T00:00:00.000Z');
  `);
}

export const DISPLAY_MIGRATION: MigrationDefinition = {
  version: DISPLAY_SCHEMA_VERSION,
  name: DISPLAY_MIGRATION_NAME,
  apply(database) {
    database.execute(DISPLAY_SCHEMA_SQL);
    seedDisplaySettings(database);
    return undefined;
  },
};

/** Canonical production migration list. Keep this array identity stable. */
export const MIGRATIONS: readonly MigrationDefinition[] = [
  FOUNDATION_MIGRATIONS[0]!,
  SECURITY_ACTIVITY_OUTBOX_MIGRATION,
  PHYSICAL_KEGS_MIGRATION,
  BEVERAGES_MIGRATION,
  FILLS_MIGRATION,
  TAPS_MIGRATION,
  TELEMETRY_MIGRATION,
  FORENSIC_QC_MIGRATION,
  TELEMETRY_EPOCHS_MIGRATION,
  FORECASTING_MIGRATION,
  HEALTH_MAINTENANCE_MIGRATION,
  DISPLAY_MIGRATION,
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

function isCanonicalMigrationPrefix(migrations: readonly MigrationDefinition[]): boolean {
  return (
    migrations.length <= MIGRATIONS.length &&
    migrations.every((migration, index) => migration === MIGRATIONS[index])
  );
}

function expectRequiredRows(
  database: DatabaseExecutor,
  table: string,
  predicate: string,
  expectedCount: number,
): void {
  const row = database
    .prepare<[], { readonly count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
    )
    .get();
  if (row?.count !== expectedCount) {
    throw incompatibleSchema(`required ${table} state is missing or invalid`);
  }
}

function validateRequiredCanonicalState(database: DatabaseExecutor, version: number): void {
  if (version >= SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION) {
    expectRequiredRows(database, "activity_retention", "id = 1", 1);
    expectRequiredRows(database, "secret_rotation_state", "id = 1", 1);
    expectRequiredRows(database, "login_throttle", "id = 1", 1);
    expectRequiredRows(database, "outbox_degradation", "id = 1", 1);
    expectRequiredRows(database, "outbox_overflow_incidents", "slot BETWEEN 0 AND 15", 16);
  }
  if (version >= BEVERAGES_SCHEMA_VERSION) {
    expectRequiredRows(database, "beverage_settings", "id = 1", 1);
  }
  if (version >= FILLS_SCHEMA_VERSION) {
    expectRequiredRows(database, "fill_settings", "id = 1", 1);
  }
  if (version >= TELEMETRY_SCHEMA_VERSION) {
    expectRequiredRows(database, "telemetry_settings", "id = 1", 1);
  }
  if (version >= TELEMETRY_EPOCHS_SCHEMA_VERSION) {
    expectRequiredRows(database, "detector_global_config", "id = 1", 1);
  }
  if (version >= FORECASTING_SCHEMA_VERSION) {
    expectRequiredRows(database, "forecast_settings", "id = 1", 1);
  }
  if (version >= HEALTH_MAINTENANCE_SCHEMA_VERSION) {
    expectRequiredRows(database, "health_global_config", "id = 1", 1);
  }
  if (version >= DISPLAY_SCHEMA_VERSION) {
    expectRequiredRows(database, "display_settings", "id = 1", 1);
  }
}

function validateCanonicalSchemaAtVersion(database: DatabaseExecutor, version: number): void {
  if (version === FOUNDATION_SCHEMA_VERSION) {
    validateFoundationSchema(database);
    return;
  }

  validateFoundationLedgerStructure(database);
  if (version === SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION) {
    validateSecurityActivityOutboxSchema(database);
  } else if (version === PHYSICAL_KEGS_SCHEMA_VERSION) {
    validatePhysicalKegsSchema(database);
  } else if (version === BEVERAGES_SCHEMA_VERSION) {
    validateBeveragesSchema(database);
  } else if (version === FILLS_SCHEMA_VERSION) {
    validateFillsSchema(database);
  } else if (version === TAPS_SCHEMA_VERSION) {
    validateTapsSchema(database);
  } else if (version === TELEMETRY_SCHEMA_VERSION) {
    validateTelemetryV7Schema(database);
  } else if (version === FORENSIC_QC_SCHEMA_VERSION) {
    validateTelemetrySchema(database);
  } else if (version === TELEMETRY_EPOCHS_SCHEMA_VERSION) {
    validateTelemetryEpochsSchema(database);
  } else if (version === FORECASTING_SCHEMA_VERSION) {
    validateForecastingSchema(database);
  } else if (version === HEALTH_MAINTENANCE_SCHEMA_VERSION) {
    validateHealthMaintenanceSchema(database);
  } else if (version === DISPLAY_SCHEMA_VERSION) {
    validateDisplaySchema(database);
  } else {
    throw incompatibleSchema("schema version is not a canonical Tapboard version");
  }
  validateRequiredCanonicalState(database, version);
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
    if (isCanonicalMigrationPrefix(migrations)) {
      validateCanonicalSchemaAtVersion(database, userVersion);
    } else if (userVersion === FOUNDATION_SCHEMA_VERSION) {
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

  if (isCanonicalMigrationPrefix(migrations) && currentVersion === DISPLAY_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateDisplaySchema(database);
  } else if (
    isCanonicalMigrationPrefix(migrations) &&
    currentVersion === HEALTH_MAINTENANCE_SCHEMA_VERSION
  ) {
    validateFoundationLedgerStructure(database);
    validateHealthMaintenanceSchema(database);
  } else if (
    isCanonicalMigrationPrefix(migrations) &&
    currentVersion === FORECASTING_SCHEMA_VERSION
  ) {
    validateFoundationLedgerStructure(database);
    validateForecastingSchema(database);
  } else if (currentVersion === TELEMETRY_EPOCHS_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateTelemetryEpochsSchema(database);
  } else if (currentVersion === FORENSIC_QC_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateTelemetrySchema(database);
  } else if (currentVersion === TELEMETRY_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateTelemetryV7Schema(database);
  } else if (currentVersion === TAPS_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateTapsSchema(database);
  } else if (currentVersion === FILLS_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateFillsSchema(database);
  } else if (currentVersion === BEVERAGES_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateBeveragesSchema(database);
  } else if (currentVersion === PHYSICAL_KEGS_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validatePhysicalKegsSchema(database);
  } else if (currentVersion === SECURITY_ACTIVITY_OUTBOX_SCHEMA_VERSION) {
    validateFoundationLedgerStructure(database);
    validateSecurityActivityOutboxSchema(database);
  } else if (currentVersion === FOUNDATION_SCHEMA_VERSION) {
    validateFoundationSchema(database);
  }

  if (isCanonicalMigrationPrefix(migrations)) {
    validateRequiredCanonicalState(database, currentVersion);
  }
}
