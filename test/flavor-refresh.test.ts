import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { BrewfatherSyncCoordinator } from "../src/features/beverages/brewfather/sync.ts";
import { sanitizeBatchSummary } from "../src/features/beverages/brewfather/sanitizer.ts";
import {
  saveRecipeSnapshot,
  upsertCandidate,
  readRecipeSnapshots,
} from "../src/features/beverages/repository.ts";
const payload = {
  _id: "batch",
  measuredFg: 1.01,
  recipe: {
    _id: "recipe",
    name: "Fixture",
    fg: 1.015,
    hops: [],
    fermentables: [],
    yeasts: [],
    miscs: [],
  },
};
function setup(fetchFn: typeof fetch) {
  const db = openDatabase(":memory:");
  const secrets = createSecretsService(db, { rootKey: Buffer.alloc(32, 4).toString("base64url") });
  const coordinator = new BrewfatherSyncCoordinator({ fetchFn });
  const service = createBeverageService(db, {
    secretsService: secrets,
    syncCoordinator: coordinator,
  });
  service.configureBrewfatherAccount({
    userId: "fixture",
    apiKey: "fixture-key",
    discoveryStatuses: [],
  });
  const summary = sanitizeBatchSummary({ ...payload, status: "Fermenting" })!;
  upsertCandidate(db, {
    ...summary,
    accountId: "default",
    sourceBatchId: "batch",
    syncedAt: "before",
  });
  const linked = service.linkBrewfatherCandidate({ sourceBatchId: "batch" });
  const id = linked.beverage.id;
  saveRecipeSnapshot(db, {
    beverageId: id,
    accountId: "default",
    sourceBatchId: "batch",
    sourceRecipeId: "recipe",
    state: "linked_current",
    recipeJson: '{"name":"Legacy","ingredients":{"hops":[]}}',
    recipeFingerprint: "a".repeat(64),
    createdAt: "before",
  });
  return { db, service, id };
}
void test("unchanged remote detail enriches old schema once, then snapshot hash no-op retains same history", async () => {
  let calls = 0;
  const c = setup(() => {
    calls++;
    return Promise.resolve(Response.json(payload));
  });
  try {
    assert.equal(c.service.getBeverage(c.id).brewingEnrichmentPending, true);
    await c.service.syncBrewfather();
    assert.equal(c.service.getBeverage(c.id).brewingEnrichmentPending, false);
    const first = readRecipeSnapshots(c.db, c.id);
    assert.equal(first.length, 2);
    await c.service.syncBrewfather();
    assert.equal(calls, 2);
    assert.deepEqual(readRecipeSnapshots(c.db, c.id), first);
    c.service.unlinkBeverage(c.id);
    assert.equal(c.service.getBeverage(c.id).recipeSnapshot?.state, "detached");
  } finally {
    c.service.dispose();
    c.db.close();
  }
});
void test("same-link response from replaced credentials cannot enrich or change last-good state", async () => {
  let resolve!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const c = setup(async () => {
    started();
    return new Promise<Response>((r) => (resolve = r));
  });
  try {
    const before = readRecipeSnapshots(c.db, c.id);
    const pending = c.service.syncBrewfather();
    await ready;
    c.service.configureBrewfatherAccount({
      userId: "fixture",
      apiKey: "replacement-fixture-key",
      discoveryStatuses: [],
    });
    resolve(Response.json(payload));
    const result = await pending;
    assert.equal(result[0]?.linkedSynced, 0);
    assert.deepEqual(readRecipeSnapshots(c.db, c.id), before);
  } finally {
    c.service.dispose();
    c.db.close();
  }
});
void test("oversized enriched snapshot preserves last-good profile and source history atomically", async () => {
  const row = {
    name: "x".repeat(160),
    supplier: "x".repeat(120),
    laboratory: "x".repeat(120),
    productId: "x".repeat(80),
    type: "x".repeat(80),
    grainCategory: "x".repeat(80),
    use: "x".repeat(80),
    usage: "x".repeat(80),
    form: "x".repeat(80),
    amount: 1,
  };
  const huge = {
    ...payload,
    measuredFg: 1.1,
    recipe: {
      ...payload.recipe,
      ...Object.fromEntries(
        ["hops", "fermentables", "yeasts", "miscs"].map((role) => [role, Array(100).fill(row)]),
      ),
    },
  };
  const c = setup(() => Promise.resolve(Response.json(huge)));
  try {
    const before = c.service.getBeverage(c.id),
      history = readRecipeSnapshots(c.db, c.id);
    const result = await c.service.syncBrewfather();
    assert.equal(result[0]?.linkedErrors, 1);
    assert.equal(
      c.service.getBeverage(c.id).effectivePresentation.fg,
      before.effectivePresentation.fg,
    );
    assert.deepEqual(readRecipeSnapshots(c.db, c.id), history);
  } finally {
    c.service.dispose();
    c.db.close();
  }
});
