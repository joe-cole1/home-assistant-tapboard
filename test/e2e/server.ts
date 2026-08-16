import { rmSync } from "node:fs";

import { createApplication } from "../../src/application.ts";
import { createAuthService } from "../../src/features/auth/service.ts";
import { createBeverageService } from "../../src/features/beverages/service.ts";
import { createFillService } from "../../src/features/fills/service.ts";
import { createKegService } from "../../src/features/kegs/service.ts";
import { createMachineKeyService } from "../../src/features/machine-keys/service.ts";
import { createSecretsService } from "../../src/features/secrets/service.ts";
import { createTapService } from "../../src/features/taps/service.ts";
import { DetectorService } from "../../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../../src/features/telemetry/service.ts";
import { openDatabase } from "../../src/infrastructure/database/connection.ts";
import { createLogger } from "../../src/shared/logging.ts";

const databasePath = "/tmp/tapboard-issue-76-e2e.sqlite3";
const origin = "http://127.0.0.1:4176";
const secretKey = Buffer.alloc(32, 7).toString("base64url");
const LIVE_MYSTERY_SECRET = "LIVE_MYSTERY_SECRET_77";
rmSync(databasePath, { force: true });

const database = openDatabase(databasePath);
const auth = createAuthService(database, { canonicalOrigin: origin });
await auth.resetPin("1234", { actorType: "system" });
const secrets = createSecretsService(database, { rootKey: secretKey });
const beverages = createBeverageService(database, { secretsService: secrets });
const detector = new DetectorService(database);
const taps = createTapService(database, { extensionPort: detector });
const kegs = createKegService(database);
const fills = createFillService(database, {
  beverageService: beverages,
  assignmentPort: taps.asFillAssignmentPort(),
});
const telemetry = new TelemetryService({
  database,
  machineKeyService: createMachineKeyService(database),
  authorityExtensionPort: detector,
  acceptedExtensionPort: detector,
});
const source = telemetry.createSource({
  name: "Private fixture source",
  label: "Private machine key",
}).source;
beverages.configureBrewfatherAccount({
  userId: "PRIVATE_BREWFATHER_USER",
  apiKey: "PRIVATE_BREWFATHER_API_KEY",
  enabled: false,
});

const beverage = beverages.createCustomBeverage({
  name: "E2E Pale Ale",
  beverageType: "beer",
  style: "American Pale Ale",
  abv: 5.4,
  displayColor: "#D97706",
  description: "A bright test fixture with a bounded description.",
});
const keg = kegs.createKeg({
  kegNumber: 1,
  label: "On Deck",
  capacityMl: 19_000,
  currentTareG: 4_200,
});
const fill = fills.createFill({
  beverageId: beverage.beverage.id,
  kegId: keg.id,
  fillDate: "2026-08-15",
});
fills.markOnDeck(fill.id);
for (let number = 1; number <= 6; number += 1)
  taps.createTap({
    tapNumber: number,
    name: `Fixture Tap ${number}`,
    enabled: true,
    ...(number === 1 ? { notes: "PRIVATE_MAINTENANCE_NOTE" } : {}),
  });
const measuredBeverage = beverages.createCustomBeverage({
  name: `Measured fixture beer (${LIVE_MYSTERY_SECRET})`,
  beverageType: "beer",
  style: `Pale Ale (${LIVE_MYSTERY_SECRET})`,
  abv: 5,
  description: `Measured fixture description ${LIVE_MYSTERY_SECRET}`,
  recipe: {
    notes: `Bounded fixture recipe <safe-note> ${LIVE_MYSTERY_SECRET}\nMash | hold & café`,
    ingredients: [
      {
        name: `Pale <malt> | 二 ${LIVE_MYSTERY_SECRET}`,
        amount: 4.5,
        unit: "kg | bag",
        note: "safe & measured\n& <ingredient-note>",
      },
    ],
    steps: [
      {
        name: "Mash & hold | rest",
        temperatureC: 66,
        timeMinutes: 60,
        note: `step <note> & café\n${LIVE_MYSTERY_SECRET}`,
      },
    ],
  },
});
beverages.updateSensoryOverrides(measuredBeverage.beverage.id, {
  bitterness: 3,
  sweetness: 2,
  body: 3,
  roast: 0,
  tartness: 1,
  alcohol: 2,
});
const measuredKeg = kegs.createKeg({
  kegNumber: 2,
  label: "Measured fixture keg",
  capacityMl: 19_000,
  currentTareG: 4_200,
});
const measuredFill = fills.createFill({
  beverageId: measuredBeverage.beverage.id,
  kegId: measuredKeg.id,
  fillDate: "2026-08-15",
});
const measuredTap = taps.listTaps().find((tap) => tap.tapNumber === 1)!;
telemetry.setTapAuthority(measuredTap.id, { sourceId: source.id });
taps.assignFill(measuredTap.id, { fillId: measuredFill.id });
const mysteryBeverage = beverages.createCustomBeverage({
  name: "MYSTERY_SECRET_DO_NOT_LEAK_77 name",
  beverageType: "beer",
  style: "MYSTERY_SECRET_DO_NOT_LEAK_77 style",
  abv: 7.1,
  displayColor: "#8B5CF6",
  description: "MYSTERY_SECRET_DO_NOT_LEAK_77 description",
  recipe: {
    notes: "MYSTERY_SECRET_DO_NOT_LEAK_77 recipe notes",
    ingredients: [
      {
        name: "MYSTERY_SECRET_DO_NOT_LEAK_77 ingredient",
        amount: 1,
        unit: "kg",
        note: "MYSTERY_SECRET_DO_NOT_LEAK_77 ingredient note",
      },
    ],
    steps: [
      {
        name: "MYSTERY_SECRET_DO_NOT_LEAK_77 step",
        temperatureC: 66,
        timeMinutes: 60,
        note: "MYSTERY_SECRET_DO_NOT_LEAK_77 step note",
      },
    ],
  },
});
const mysteryKeg = kegs.createKeg({
  kegNumber: 3,
  label: "Mystery fixture keg",
  capacityMl: 19_000,
  currentTareG: 4_200,
});
const mysteryFill = fills.createFill({
  beverageId: mysteryBeverage.beverage.id,
  kegId: mysteryKeg.id,
  fillDate: "2026-08-15",
});
const mysteryTap = taps.listTaps().find((tap) => tap.tapNumber === 3)!;
taps.assignFill(mysteryTap.id, { fillId: mysteryFill.id });
taps.updateAssignmentMystery(mysteryTap.id, {
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
  revealSensory: false,
  revealHistory: false,
});
const measurementStart = Date.now();
for (let index = 0; index < 5; index += 1) {
  telemetry.ingestSingle(source, 1, {
    clientSampleId: `fixture-measurement-${index}`,
    measuredAt: new Date(measurementStart + index * 250).toISOString(),
    remainingVolume: { value: 12_000, unit: "ml" },
    temperature: { value: 4, unit: "c" },
  });
}
const measuredAssignment = taps.getTap(measuredTap.id).activeAssignment;
const measuredEpoch = database
  .prepare<[string], { id: string }>(
    "SELECT id FROM telemetry_epochs WHERE fill_id = ? AND ended_at IS NULL ORDER BY started_at_epoch_ms DESC LIMIT 1",
  )
  .get(measuredFill.id);
if (measuredAssignment === null || measuredEpoch === undefined) {
  throw new Error("Expected the measured fixture assignment and telemetry epoch.");
}
database
  .prepare<unknown[]>(
    `INSERT INTO pours (
      id, effect_key, fill_id, tap_id, assignment_id, epoch_id, detector_session_id,
      canonical_volume_ml, started_at, completed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    "00000000-0000-4000-8000-000000000077",
    "issue-77-e2e-history-pour",
    measuredFill.id,
    measuredTap.id,
    measuredAssignment.id,
    measuredEpoch.id,
    "issue-77-e2e-history-session",
    500,
    "2026-08-15T11:59:00.000Z",
    "2026-08-15T11:59:30.000Z",
    "2026-08-15T11:59:30.000Z",
  );
const now = "2026-08-15T12:00:00.000Z";
const insertPrivateTap = database.prepare(`
  INSERT INTO taps (
    id, tap_number, name, enabled, first_used_at, retired_at,
    gas_type, serving_pressure_kpa, line_length_mm, line_diameter_mm,
    notes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
`);
insertPrivateTap.run(
  "00000000-0000-4000-8000-000000000008",
  8,
  "Disabled fixture",
  0,
  null,
  "PRIVATE_DISABLED_NOTE",
  now,
  now,
);
insertPrivateTap.run(
  "00000000-0000-4000-8000-000000000009",
  9,
  "Retired fixture",
  1,
  now,
  "PRIVATE_RETIRED_NOTE",
  now,
  now,
);
database.close();

const application = createApplication({
  config: {
    host: "127.0.0.1",
    port: 4176,
    databasePath,
    shutdownGraceMs: 2_000,
    canonicalExternalOrigin: origin,
    trustedProxies: [],
    sessionInactivityMs: 86_400_000,
    sessionAbsoluteMs: 86_400_000,
    secretKey,
    secretKeyState: "available",
  },
  logger: createLogger({ sink: () => undefined }),
});

await application.start();
async function stop(): Promise<void> {
  await application.stop();
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
