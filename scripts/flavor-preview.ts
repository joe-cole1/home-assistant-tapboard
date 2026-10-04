/** Offline isolated operator preview. Never opens the ordinary development database. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { BrewfatherSyncCoordinator } from "../src/features/beverages/brewfather/sync.ts";
import { sanitizeBatchSummary } from "../src/features/beverages/brewfather/sanitizer.ts";
import { upsertCandidate } from "../src/features/beverages/repository.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createLogger } from "../src/shared/logging.ts";
const port = 4177;
const origin = `http://127.0.0.1:${port}`;
const previewDirectory = "/tmp/tapboard-sensory-preview";
mkdirSync(previewDirectory, { recursive: true });
const workspace = mkdtempSync(join(previewDirectory, "workspace-"));
const databasePath = join(workspace, "preview.sqlite3");
const secretKey = Buffer.alloc(32, 11).toString("base64url");
const corpus = JSON.parse(
  readFileSync(new URL("../test/fixtures/flavor/development-corpus.json", import.meta.url), "utf8"),
) as { batches: { caseId: string; input: Record<string, unknown> }[] };
const selected = [
  { caseId: "B064", label: "Amber lager" },
  { caseId: "B033", label: "Hazy IPA" },
  { caseId: "B058", label: "Very dry saison" },
  { caseId: "B052", label: "Hefeweizen" },
  { caseId: "B060", label: "Spiced lager" },
  { caseId: "B026", label: "Bourbon-aged stout" },
  { caseId: "B053", label: "Incomplete hop recipe" },
  { caseId: "B026", label: "Hidden sensory Mystery", mystery: "hidden" },
  { caseId: "B026", label: "Sensory-only Mystery", mystery: "sensory" },
] as const;
const payloads = new Map<string, Record<string, unknown>>();
const database = openDatabase(databasePath);
await createAuthService(database, { canonicalOrigin: origin }).resetPin("1234", {
  actorType: "system",
});
const secrets = createSecretsService(database, { rootKey: secretKey });
const coordinator = new BrewfatherSyncCoordinator({
  fetchFn: (url) => {
    const id = new URL(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    ).pathname
      .split("/")
      .at(-1)!;
    const payload = payloads.get(id);
    if (!payload) throw new Error("Offline preview blocked an unexpected provider request.");
    return Promise.resolve(Response.json(payload));
  },
});
const beverages = createBeverageService(database, {
  secretsService: secrets,
  syncCoordinator: coordinator,
});
beverages.configureBrewfatherAccount({
  userId: "offline-preview",
  apiKey: "offline-fixture-key",
  discoveryStatuses: [],
  enabled: true,
});
const detector = new DetectorService(database);
const taps = createTapService(database, { extensionPort: detector });
const kegs = createKegService(database);
const fills = createFillService(database, {
  beverageService: beverages,
  assignmentPort: taps.asFillAssignmentPort(),
});
const manifest = [];
for (const [index, item] of selected.entries()) {
  const source = corpus.batches.find((row) => row.caseId === item.caseId);
  if (!source) throw new Error("Missing selected fixture.");
  const batch = structuredClone(source.input);
  const id = `offline-preview-${index + 1}`;
  const recipe = batch.recipe as Record<string, unknown>;
  batch._id = id;
  recipe._id = `offline-recipe-${index + 1}`;
  recipe.name = item.label;
  payloads.set(id, batch);
  const summary = sanitizeBatchSummary(batch);
  if (!summary) throw new Error("Invalid selected batch fixture.");
  upsertCandidate(database, {
    ...summary,
    accountId: "default",
    sourceBatchId: id,
    syncedAt: "2026-10-04T00:00:00.000Z",
  });
  const beverage = beverages.linkBrewfatherCandidate({ sourceBatchId: id });
  const keg = kegs.createKeg({
    kegNumber: index + 1,
    label: item.label,
    capacityMl: 19000,
    currentTareG: 4200,
  });
  const fill = fills.createFill({
    beverageId: beverage.beverage.id,
    kegId: keg.id,
    fillDate: "2026-10-04",
  });
  const tap = taps.createTap({ tapNumber: index + 1, name: item.label, enabled: true });
  taps.assignFill(tap.id, { fillId: fill.id });
  if ("mystery" in item)
    taps.updateAssignmentMystery(tap.id, {
      enabled: true,
      revealBeverageType: false,
      revealStyle: false,
      revealAbv: false,
      revealIbu: false,
      revealOg: false,
      revealFg: false,
      revealSrm: false,
      revealDescription: false,
      revealRecipe: false,
      revealHistory: false,
      revealSensory: item.mystery === "sensory",
    });
  manifest.push({
    caseId: item.caseId,
    label: item.label,
    tapId: tap.id,
    beverageId: beverage.beverage.id,
    storyPath: `/taps/${tap.id}/story`,
  });
}
await beverages.syncBrewfather();
// The fixture fetcher is discarded; the running application has no enabled provider.
beverages.configureBrewfatherAccount({ userId: "offline-preview", enabled: false });
beverages.dispose();
database.close();
writeFileSync(
  join(previewDirectory, "manifest.json"),
  JSON.stringify({ origin, databasePath, pin: "1234", taps: manifest }, null, 2),
);
const application = createApplication({
  config: {
    host: "127.0.0.1",
    port,
    databasePath,
    shutdownGraceMs: 2000,
    canonicalExternalOrigin: origin,
    trustedProxies: [],
    sessionInactivityMs: 86400000,
    sessionAbsoluteMs: 86400000,
    secretKey,
    secretKeyState: "available",
  },
  logger: createLogger({ sink: () => undefined }),
});
await application.start();
console.log(
  `Offline sensory preview: ${origin}. Disposable database: ${databasePath}. Fixture Admin PIN: 1234.`,
);
async function stop() {
  await application.stop();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
