import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { MIGRATIONS } from "../src/infrastructure/database/migrations.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
void test("schema23 copies six legacy overrides exactly, leaves new axes null, preserves detached snapshots and reopens", (context) => {
  const dir = mkdtempSync(join(tmpdir(), "flavor-migration-")),
    path = join(dir, "db.sqlite");
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = openDatabase(path, { migrations: MIGRATIONS.slice(0, 22) });
  old.execute(
    `INSERT INTO beverages (id,ownership_type,created_at,updated_at) VALUES ('11111111-1111-4111-8111-111111111111','custom','before','before'); INSERT INTO beverage_sensory_overrides VALUES ('11111111-1111-4111-8111-111111111111',0,2.25,10,4.5,NULL,8.125,'before'); INSERT INTO beverage_source_recipe_snapshots VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','default','batch',NULL,'detached',1,'{"ingredients":{"hops":[]}}','${"a".repeat(64)}','before');`,
  );
  const before = old.prepare("SELECT recipe_json FROM beverage_source_recipe_snapshots").get();
  old.close();
  const current = openDatabase(path, { migrations: MIGRATIONS });
  assert.deepEqual(
    current
      .prepare(
        "SELECT bitterness,sweetness,body,roast,tartness,alcohol,updated_at,malt,hops FROM beverage_sensory_overrides",
      )
      .get(),
    {
      bitterness: 0,
      sweetness: 2.25,
      body: 10,
      roast: 4.5,
      tartness: null,
      alcohol: 8.125,
      updated_at: "before",
      malt: null,
      hops: null,
    },
  );
  assert.deepEqual(
    current.prepare("SELECT recipe_json FROM beverage_source_recipe_snapshots").get(),
    before,
  );
  current.close();
  openDatabase(path, { migrations: MIGRATIONS }).close();
});
void test("new manual axes reject malformed values, preserve zero and clear one axis only", () => {
  const db = openDatabase(":memory:");
  try {
    const service = createBeverageService(db);
    const result = service.createCustomBeverage({
      name: "Beer",
      sensoryOverrides: { malt: 0, hops: 10, bitterness: 5 },
    });
    const id = result.beverage.id;
    assert.equal(result.sensoryOverrides?.malt, 0);
    assert.throws(() => service.updateSensoryOverrides(id, { hops: true }));
    assert.throws(() => service.updateSensoryOverrides(id, { hops: "5" }));
    assert.throws(() => service.updateSensoryOverrides(id, { hops: 10.1 }));
    const changed = service.updateSensoryOverrides(id, { hops: null });
    assert.equal(changed.sensoryOverrides.hops, null);
    assert.equal(changed.sensoryOverrides.malt, 0);
    assert.equal(changed.sensoryOverrides.bitterness, 5);
  } finally {
    db.close();
  }
});
