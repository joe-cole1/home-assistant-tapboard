import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { corpus, evaluateFixture } from "./fixtures/flavor/corpus.ts";

const recipeJson = evaluateFixture(corpus.batches[0]!.input).snapshot.recipeJson;
function fixture() {
  const db = openDatabase(":memory:");
  const service = createBeverageService(db);
  const beverage = service.createCustomBeverage({
    name: "Offline beer",
    sensoryOverrides: { malt: 0 },
  });
  return { db, service, id: beverage.beverage.id };
}
function controlled(action: () => unknown, category: string) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.category === category &&
      !error.message.includes(recipeJson),
  );
}
void test("offline normalized snapshot imports detached provenance without changing profiles or creating provider state", () => {
  const { db, service, id } = fixture();
  try {
    const before = service.getBeverage(id);
    const snapshot = service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson });
    assert.equal(snapshot.state, "detached");
    assert.equal(snapshot.accountId, "offline-history");
    assert.equal(snapshot.sourceRecipeId, null);
    assert.equal(snapshot.recipeFingerprint, createHash("sha256").update(recipeJson).digest("hex"));
    assert.equal(snapshot.recipeJson, recipeJson);
    const after = service.getBeverage(id);
    assert.deepEqual(after.customProfile, before.customProfile);
    assert.deepEqual(after.sensoryOverrides, before.sensoryOverrides);
    assert.deepEqual(after.beverage, before.beverage);
    assert.equal(after.customRecipe, undefined);
    assert.equal(after.brewfatherLink, undefined);
    for (const table of [
      "brewfather_accounts",
      "brewfather_beverage_links",
      "brewfather_source_profiles",
      "encrypted_secrets",
    ]) {
      assert.equal(
        db.prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`).get()?.count,
        0,
      );
    }
    assert.deepEqual(
      service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson }),
      snapshot,
    );
    assert.equal(service.getRecipeSnapshots(id).length, 1);
    controlled(
      () => service.attachOfflineRecipeSnapshot(id, { sourceKey: "other", recipeJson }),
      "conflict",
    );
    controlled(
      () =>
        service.attachOfflineRecipeSnapshot(id, {
          sourceKey: "B064",
          recipeJson: `${recipeJson} `,
        }),
      "conflict",
    );
    assert.deepEqual(service.getRecipeSnapshots(id), [snapshot]);
  } finally {
    db.close();
  }
});
void test("offline import rejects malformed, legacy, custom and byte-overflow evidence without writes", () => {
  const { db, service, id } = fixture();
  try {
    const parsed = JSON.parse(recipeJson) as Record<string, unknown>;
    for (const bad of [
      "{",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...parsed, snapshotSchemaVersion: 1 }),
      JSON.stringify({ ...parsed, brewingInputs: {} }),
      ...["custom", "legacy"].map((format) =>
        JSON.stringify({
          ...parsed,
          brewingInputs: { ...(parsed.brewingInputs as Record<string, unknown>), format },
        }),
      ),
      `${recipeJson}${" ".repeat(256 * 1024)}`,
    ]) {
      controlled(
        () => service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson: bad }),
        "validation",
      );
    }
    for (const sourceKey of ["", "   ", "é".repeat(129)])
      controlled(
        () => service.attachOfflineRecipeSnapshot(id, { sourceKey, recipeJson }),
        "validation",
      );
    controlled(
      () => service.attachOfflineRecipeSnapshot("missing", { sourceKey: "B064", recipeJson }),
      "not_found",
    );
    assert.equal(service.getRecipeSnapshots(id).length, 0);
  } finally {
    db.close();
  }
});
void test("offline import rejects editable recipes, active links, and inconsistent linked-current snapshots", () => {
  const { db, service, id } = fixture();
  try {
    const custom = service.createCustomBeverage({
      name: "Editable",
      recipe: { notes: "Operator recipe" },
    });
    controlled(
      () =>
        service.attachOfflineRecipeSnapshot(custom.beverage.id, { sourceKey: "B064", recipeJson }),
      "conflict",
    );
    db.execute(
      "INSERT INTO brewfather_accounts (id,user_id,created_at,updated_at) VALUES ('test-account','test-user','now','now')",
    );
    db.prepare(
      "INSERT INTO brewfather_beverage_links (beverage_id,account_id,source_batch_id,sync_state,created_at,updated_at) VALUES (?,'test-account','test-source','pending','now','now')",
    ).run(id);
    controlled(
      () => service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson }),
      "conflict",
    );
    db.prepare("DELETE FROM brewfather_beverage_links WHERE beverage_id = ?").run(id);
    const imported = service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson });
    db.prepare(
      "UPDATE beverage_source_recipe_snapshots SET state = 'linked_current' WHERE id = ?",
    ).run(imported.id);
    controlled(
      () => service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson }),
      "conflict",
    );
    db.prepare("UPDATE beverages SET ownership_type = 'brewfather' WHERE id = ?").run(id);
    controlled(
      () => service.attachOfflineRecipeSnapshot(id, { sourceKey: "B064", recipeJson }),
      "conflict",
    );
  } finally {
    db.close();
  }
});
