import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  CURRENT_SCHEMA_VERSION,
  DISPLAY_MIGRATION_NAME,
  DISPLAY_CUSTOM_ACCENT_MIGRATION_NAME,
  DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION,
  DISPLAY_FONT_MIGRATION_NAME,
  DISPLAY_FONT_SCHEMA_VERSION,
  TELEMETRY_DISABLED_LIFECYCLE_MIGRATION_NAME,
  TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION,
  TAP_CARD_DISPLAY_MIGRATION_NAME,
  TAP_CARD_DISPLAY_SCHEMA_VERSION,
  DISPLAY_CUSTOM_ACCENT_MIGRATION,
  TELEMETRY_DISABLED_LIFECYCLE_MIGRATION,
  initializeSchema,
  MIGRATIONS,
  type MigrationDefinition,
} from "../src/infrastructure/database/migrations.ts";

void test("v11 upgrades preserve data and seed canonical display settings", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 11) });
  try {
    database.prepare<[number]>("UPDATE health_global_config SET revision = ? WHERE id = 1").run(7);
    initializeSchema(database, MIGRATIONS);
    assert.equal(
      database
        .prepare<[], { readonly revision: number }>(
          "SELECT revision FROM health_global_config WHERE id = 1",
        )
        .get()?.revision,
      7,
    );
    assert.equal(
      database
        .prepare<[], { readonly revision: number }>(
          "SELECT revision FROM display_settings WHERE id = 1",
        )
        .get()?.revision,
      1,
    );
    initializeSchema(database, MIGRATIONS);
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(TAP_CARD_DISPLAY_SCHEMA_VERSION, 14);
    assert.equal(DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION, 15);
  } finally {
    if (database.isOpen) database.close();
  }
});

void test("v17 migration identity and defaults are canonical", () => {
  const database = openDatabase(":memory:");
  try {
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(DISPLAY_FONT_SCHEMA_VERSION, 17);
    assert.equal(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = 12",
        )
        .get()?.name,
      DISPLAY_MIGRATION_NAME,
    );
    assert.equal(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = 14",
        )
        .get()?.name,
      TAP_CARD_DISPLAY_MIGRATION_NAME,
    );
    assert.equal(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = 15",
        )
        .get()?.name,
      DISPLAY_CUSTOM_ACCENT_MIGRATION_NAME,
    );
    assert.equal(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = 16",
        )
        .get()?.name,
      TELEMETRY_DISABLED_LIFECYCLE_MIGRATION_NAME,
    );
    assert.equal(
      database
        .prepare<[], { readonly name: string }>(
          "SELECT name FROM schema_migrations WHERE version = 17",
        )
        .get()?.name,
      DISPLAY_FONT_MIGRATION_NAME,
    );
    assert.deepEqual(
      database
        .prepare<[], { readonly tapboard_name: string; readonly revision: number }>(
          "SELECT tapboard_name, revision FROM display_settings WHERE id = 1",
        )
        .get(),
      { tapboard_name: "Tapboard", revision: 1 },
    );
    assert.deepEqual(
      database
        .prepare<
          [],
          {
            readonly show_abv: number;
            readonly show_ibu: number;
            readonly show_og: number;
            readonly show_fg: number;
            readonly show_srm: number;
            readonly remaining_mode: string;
          }
        >(
          "SELECT show_abv, show_ibu, show_og, show_fg, show_srm, remaining_mode FROM tap_card_display_settings WHERE id = 1",
        )
        .get(),
      {
        show_abv: 1,
        show_ibu: 1,
        show_og: 1,
        show_fg: 1,
        show_srm: 0,
        remaining_mode: "percent",
      },
    );
    database.execute("DROP TABLE display_settings");
    assert.throws(() => initializeSchema(database, MIGRATIONS), /Incompatible SQLite schema/);
  } finally {
    if (database.isOpen) database.close();
  }
});

void test("v13 upgrades preserve existing rows while adding public card settings", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 13) });
  const beverageId = "00000000-0000-4000-8000-000000000001";
  const tapId = "00000000-0000-4000-8000-000000000002";
  try {
    database
      .prepare<[string, string, string, string]>(
        "INSERT INTO beverages (id, ownership_type, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(beverageId, "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database
      .prepare<[string, number, number, string, string]>(
        "INSERT INTO taps (id, tap_number, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(tapId, 1, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    initializeSchema(database, MIGRATIONS);
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(
      database
        .prepare<[], { readonly count: number }>("SELECT COUNT(*) AS count FROM beverages")
        .get()?.count,
      1,
    );
    assert.equal(
      database.prepare<[], { readonly count: number }>("SELECT COUNT(*) AS count FROM taps").get()
        ?.count,
      1,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM tap_card_display_settings",
        )
        .get()?.count,
      1,
    );
  } finally {
    database.close();
  }
});

void test("v14->v15 rebuild preserves display rows and enforces canonical custom accents", () => {
  const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 14) });
  try {
    database
      .prepare<[number, string, number, string]>(
        "UPDATE display_settings SET revision = ?, accent = ?, show_serving_temperature = ?, updated_at = ? WHERE id = 1",
      )
      .run(7, "rose", 1, "2026-01-01T00:00:00.000Z");
    initializeSchema(database, MIGRATIONS.slice(0, DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION));
    assert.equal(database.pragma<number>("user_version", { simple: true }), 15);
    assert.deepEqual(
      database
        .prepare<
          [],
          {
            readonly revision: number;
            readonly tapboard_name: string;
            readonly theme: string;
            readonly font: string;
            readonly accent: string;
            readonly unit_system: string;
            readonly show_serving_temperature: number;
            readonly layout_mode: string;
            readonly updated_at: string;
          }
        >(
          "SELECT revision, tapboard_name, theme, font, accent, unit_system, show_serving_temperature, layout_mode, updated_at FROM display_settings WHERE id = 1",
        )
        .get(),
      {
        revision: 7,
        tapboard_name: "Tapboard",
        theme: "modern_dark",
        font: "system",
        accent: "rose",
        unit_system: "us",
        show_serving_temperature: 1,
        layout_mode: "scroll",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    );
    database
      .prepare<[string]>("UPDATE display_settings SET accent = ? WHERE id = 1")
      .run("#abcdef");
    for (const invalid of [
      "#ABCDEF",
      "#abcde",
      "#abcdef0",
      " rgb(1,2,3)",
      "#abcde\n",
      "#abcdef\u0000",
      "#abcdef\u0000suffix",
    ]) {
      assert.throws(() =>
        database
          .prepare<[string]>("UPDATE display_settings SET accent = ? WHERE id = 1")
          .run(invalid),
      );
    }
  } finally {
    database.close();
  }
});

void test("v16->v17 rebuild preserves display settings and accepts the new font allowlist", () => {
  const database = openDatabase(":memory:", {
    migrations: MIGRATIONS.slice(0, TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION),
  });
  try {
    database
      .prepare<[number, string, string]>(
        "UPDATE display_settings SET revision = ?, font = ?, updated_at = ? WHERE id = 1",
      )
      .run(9, "fredoka", "2026-01-02T00:00:00.000Z");
    assert.throws(
      () =>
        database
          .prepare<[string]>("UPDATE display_settings SET font = ? WHERE id = 1")
          .run("barlow_condensed"),
      /CHECK constraint/,
    );
    initializeSchema(database, MIGRATIONS);
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
      database
        .prepare<[], { readonly revision: number; readonly font: string }>(
          "SELECT revision, font FROM display_settings WHERE id = 1",
        )
        .get(),
      { revision: 9, font: "fredoka" },
    );
    for (const font of ["barlow_condensed", "bree_serif", "bungee", "rye", "special_elite"]) {
      database.prepare<[string]>("UPDATE display_settings SET font = ? WHERE id = 1").run(font);
    }
    assert.throws(
      () =>
        database
          .prepare<[string]>("UPDATE display_settings SET font = ? WHERE id = 1")
          .run("not-a-font"),
      /CHECK constraint/,
    );
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'display_settings_v17'",
        )
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

void test("v12-v14 display schemas retain the legacy named-accent contract", () => {
  for (const version of [12, 13, 14] as const) {
    const database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, version) });
    try {
      assert.throws(
        () =>
          database
            .prepare<[string]>("UPDATE display_settings SET accent = ? WHERE id = 1")
            .run("#abcdef"),
        /CHECK constraint/,
      );
      initializeSchema(database, MIGRATIONS.slice(0, version));
      assert.equal(database.pragma<number>("user_version", { simple: true }), version);
    } finally {
      database.close();
    }
  }
});

void test("v15->v16 adds disabled lifecycle guards and is idempotent", () => {
  const database = openDatabase(":memory:", {
    migrations: MIGRATIONS.slice(0, DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION),
  });
  try {
    const keyId = "11111111-1111-4111-8111-111111111111";
    const sourceId = "22222222-2222-4222-8222-222222222222";
    database
      .prepare<[string, string, Buffer, string, string]>(
        "INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        keyId,
        "aaaaaaaaaaaaaaaa",
        Buffer.alloc(32),
        "migration source",
        "2026-01-01T00:00:00.000Z",
      );
    database
      .prepare<[string, string, string, string, string]>(
        "INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        sourceId,
        "Migration source",
        keyId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
    initializeSchema(database, MIGRATIONS.slice(0, TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION));
    assert.equal(
      database.pragma<number>("user_version", { simple: true }),
      TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION,
    );
    assert.deepEqual(
      database.pragma<readonly { name: string }[]>("table_info(telemetry_sources)").at(-1),
      { cid: 5, name: "disabled_at", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    );
    assert.deepEqual(
      database
        .prepare<[], Record<string, unknown>>(
          "SELECT id, name, current_machine_key_id, created_at, updated_at, disabled_at FROM telemetry_sources",
        )
        .get(),
      {
        id: sourceId,
        name: "Migration source",
        current_machine_key_id: keyId,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        disabled_at: null,
      },
    );
    const sourceSchemaSql = database
      .prepare<[], { readonly sql: string | null }>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_sources'",
      )
      .get()?.sql;
    assert.equal(
      sourceSchemaSql
        ?.replaceAll(/[`\[\]"]/g, "")
        .replaceAll(/\s+/g, "")
        .replace(/;$/, "")
        .toLowerCase(),
      "createtabletelemetry_sources(idtextprimarykeycheck(length(cast(idasblob))=36),nametextnotnulluniquecheck(length(cast(nameasblob))between1and120),current_machine_key_idtextnotnulluniquereferencesmachine_api_keys(id)ondeleterestrict,created_attextnotnull,updated_attextnotnull,disabled_attextnull)",
    );
    for (const name of [
      "trg_tap_telemetry_authority_no_disabled_insert",
      "trg_tap_telemetry_authority_no_disabled_update",
      "trg_telemetry_sources_no_disable_with_authority",
      "trg_telemetry_sources_disabled_immutable",
      "trg_telemetry_sources_disabled_no_delete",
    ]) {
      assert.equal(
        database
          .prepare<[string], { readonly count: number }>(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?",
          )
          .get(name)?.count,
        1,
      );
    }
    initializeSchema(database, MIGRATIONS.slice(0, TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION));
    assert.equal(
      database.pragma<number>("user_version", { simple: true }),
      TELEMETRY_DISABLED_LIFECYCLE_SCHEMA_VERSION,
    );
    const tapId = "33333333-3333-4333-8333-333333333333";
    database
      .prepare<[string, number, string, string]>(
        "INSERT INTO taps (id, tap_number, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(tapId, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database
      .prepare<[string, string, string]>(
        "INSERT INTO tap_telemetry_authority (tap_id, source_id, changed_at) VALUES (?, ?, ?)",
      )
      .run(tapId, sourceId, "2026-01-02T00:00:00.000Z");
    assert.throws(
      () =>
        database
          .prepare<[string, string]>("UPDATE telemetry_sources SET disabled_at = ? WHERE id = ?")
          .run("2026-01-03T00:00:00.000Z", sourceId),
      /cannot be disabled/,
    );
    assert.equal(
      database
        .prepare<[string], { readonly disabled_at: string | null }>(
          "SELECT disabled_at FROM telemetry_sources WHERE id = ?",
        )
        .get(sourceId)?.disabled_at,
      null,
    );
    database.prepare<[string]>("DELETE FROM tap_telemetry_authority WHERE tap_id = ?").run(tapId);
    database
      .prepare<[string, string]>("UPDATE telemetry_sources SET disabled_at = ? WHERE id = ?")
      .run("2026-01-03T00:00:00.000Z", sourceId);
    assert.throws(
      () =>
        database
          .prepare<[string]>("UPDATE telemetry_sources SET disabled_at = NULL WHERE id = ?")
          .run(sourceId),
      /immutable/,
    );
    for (const update of [
      `UPDATE telemetry_sources SET id = id WHERE id = '${sourceId}'`,
      `UPDATE telemetry_sources SET created_at = created_at WHERE id = '${sourceId}'`,
      `UPDATE telemetry_sources SET updated_at = updated_at WHERE id = '${sourceId}'`,
      `UPDATE telemetry_sources SET name = name WHERE id = '${sourceId}'`,
      `UPDATE telemetry_sources SET current_machine_key_id = current_machine_key_id WHERE id = '${sourceId}'`,
      `UPDATE telemetry_sources SET disabled_at = disabled_at WHERE id = '${sourceId}'`,
    ]) {
      assert.throws(() => database.execute(update), /immutable/);
    }
    assert.throws(
      () => database.execute(`DELETE FROM telemetry_sources WHERE id = '${sourceId}'`),
      /cannot be deleted/,
    );

    const activeKeyId = "66666666-6666-4666-8666-666666666666";
    const activeSourceId = "77777777-7777-4777-8777-777777777777";
    const activeTapId = "88888888-8888-4888-8888-888888888888";
    database
      .prepare<[string, string, Buffer, string, string]>(
        "INSERT INTO machine_api_keys (id, public_id, verification_digest, label, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        activeKeyId,
        "bbbbbbbbbbbbbbbb",
        Buffer.alloc(32, 1),
        "active migration source",
        "2026-01-01T00:00:00.000Z",
      );
    database
      .prepare<[string, string, string, string, string]>(
        "INSERT INTO telemetry_sources (id, name, current_machine_key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        activeSourceId,
        "Active migration source",
        activeKeyId,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    database
      .prepare<[string, number, string, string]>(
        "INSERT INTO taps (id, tap_number, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(activeTapId, 2, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database
      .prepare<[string, string, string]>(
        "INSERT INTO tap_telemetry_authority (tap_id, source_id, changed_at) VALUES (?, ?, ?)",
      )
      .run(activeTapId, activeSourceId, "2026-01-02T00:00:00.000Z");
    assert.throws(
      () =>
        database
          .prepare<[string, string]>(
            "UPDATE tap_telemetry_authority SET source_id = ? WHERE tap_id = ?",
          )
          .run(sourceId, activeTapId),
      /disabled telemetry sources cannot be Tap authority/,
    );
    assert.equal(
      database
        .prepare<[string], { readonly source_id: string }>(
          "SELECT source_id FROM tap_telemetry_authority WHERE tap_id = ?",
        )
        .get(activeTapId)?.source_id,
      activeSourceId,
    );
  } finally {
    database.close();
  }
});

void test("v15 and v16 migration failures roll back schema, ledger, and user_version", () => {
  const v15Database = openDatabase(":memory:", { migrations: MIGRATIONS.slice(0, 14) });
  try {
    const failingV15: MigrationDefinition = {
      version: DISPLAY_CUSTOM_ACCENT_MIGRATION.version,
      name: "test-failing-v15",
      apply(database) {
        DISPLAY_CUSTOM_ACCENT_MIGRATION.apply(database);
        throw new Error("injected v15 failure");
      },
    };
    assert.throws(
      () => initializeSchema(v15Database, [...MIGRATIONS.slice(0, 14), failingV15]),
      /injected v15 failure/,
    );
    assert.equal(v15Database.pragma<number>("user_version", { simple: true }), 14);
    assert.equal(
      v15Database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      v15Database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'display_settings_v15'",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      v15Database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'display_settings'",
        )
        .get()?.count,
      1,
    );
  } finally {
    v15Database.close();
  }

  const v16Database = openDatabase(":memory:", {
    migrations: MIGRATIONS.slice(0, DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION),
  });
  try {
    const failingV16: MigrationDefinition = {
      version: TELEMETRY_DISABLED_LIFECYCLE_MIGRATION.version,
      name: "test-failing-v16",
      apply(database) {
        TELEMETRY_DISABLED_LIFECYCLE_MIGRATION.apply(database);
        throw new Error("injected v16 failure");
      },
    };
    assert.throws(
      () =>
        initializeSchema(v16Database, [
          ...MIGRATIONS.slice(0, DISPLAY_CUSTOM_ACCENT_SCHEMA_VERSION),
          failingV16,
        ]),
      /injected v16 failure/,
    );
    assert.equal(v16Database.pragma<number>("user_version", { simple: true }), 15);
    assert.equal(
      v16Database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      v16Database
        .pragma<readonly { name: string }[]>("table_info(telemetry_sources)")
        .some((column) => column.name === "disabled_at"),
      false,
    );
    initializeSchema(v16Database, MIGRATIONS);
    assert.equal(
      v16Database.pragma<number>("user_version", { simple: true }),
      CURRENT_SCHEMA_VERSION,
    );
  } finally {
    v16Database.close();
  }
});
