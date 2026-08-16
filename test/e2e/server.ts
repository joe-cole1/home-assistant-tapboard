import { rmSync } from "node:fs";

import { createApplication } from "../../src/application.ts";
import { createAuthService } from "../../src/features/auth/service.ts";
import { createBeverageService } from "../../src/features/beverages/service.ts";
import { createFillService } from "../../src/features/fills/service.ts";
import { createKegService } from "../../src/features/kegs/service.ts";
import { createMachineKeyService } from "../../src/features/machine-keys/service.ts";
import { createSecretsService } from "../../src/features/secrets/service.ts";
import { createTapService } from "../../src/features/taps/service.ts";
import { TelemetryService } from "../../src/features/telemetry/service.ts";
import { openDatabase } from "../../src/infrastructure/database/connection.ts";
import { createLogger } from "../../src/shared/logging.ts";

const databasePath = "/tmp/tapboard-issue-76-e2e.sqlite3";
const origin = "http://127.0.0.1:4176";
const secretKey = Buffer.alloc(32, 7).toString("base64url");
rmSync(databasePath, { force: true });

const database = openDatabase(databasePath);
const auth = createAuthService(database, { canonicalOrigin: origin });
await auth.resetPin("1234", { actorType: "system" });
const secrets = createSecretsService(database, { rootKey: secretKey });
const beverages = createBeverageService(database, { secretsService: secrets });
const taps = createTapService(database);
const kegs = createKegService(database);
const fills = createFillService(database, {
  beverageService: beverages,
  assignmentPort: taps.asFillAssignmentPort(),
});
const telemetry = new TelemetryService({
  database,
  machineKeyService: createMachineKeyService(database),
});
telemetry.createSource({ name: "Private fixture source", label: "Private machine key" });
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
