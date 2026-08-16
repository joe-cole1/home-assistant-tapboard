import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  CURRENT_SCHEMA_VERSION,
  BREW_STORY_SENSORY_MYSTERY_MIGRATION_NAME,
  DISPLAY_MIGRATION_NAME,
  initializeSchema,
  MIGRATIONS,
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
  } finally {
    if (database.isOpen) database.close();
  }
});

void test("v12 migration identity and defaults are canonical", () => {
  const database = openDatabase(":memory:");
  try {
    assert.equal(database.pragma<number>("user_version", { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(CURRENT_SCHEMA_VERSION, 13);
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
          "SELECT name FROM schema_migrations WHERE version = 13",
        )
        .get()?.name,
      BREW_STORY_SENSORY_MYSTERY_MIGRATION_NAME,
    );
    assert.deepEqual(
      database
        .prepare<[], { readonly tapboard_name: string; readonly revision: number }>(
          "SELECT tapboard_name, revision FROM display_settings WHERE id = 1",
        )
        .get(),
      { tapboard_name: "Tapboard", revision: 1 },
    );
    database.execute("DROP TABLE display_settings");
    assert.throws(() => initializeSchema(database, MIGRATIONS), /Incompatible SQLite schema/);
  } finally {
    if (database.isOpen) database.close();
  }
});
