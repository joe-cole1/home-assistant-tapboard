import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  DashboardService,
  type DashboardServiceDependencies,
} from "../src/features/dashboard/service.ts";
import type { BrewfatherSyncState } from "../src/features/beverages/types.ts";
import { createBeverageService, type BeverageService } from "../src/features/beverages/service.ts";
import {
  insertBeverage,
  insertBeverageLink,
  updateBeverageLinkState,
} from "../src/features/beverages/repository.ts";
import type { HealthCheckSummary } from "../src/features/health/projections.ts";
import { createOutboundService, type OutboundService } from "../src/features/outbound/service.ts";
import type { OutboundDestination } from "../src/features/outbound/types.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { openDatabase, type DatabaseExecutor } from "../src/infrastructure/database/connection.ts";

const NOW = "2026-08-17T12:00:00.000Z";
const DESTINATION = "11111111-1111-4111-8111-111111111111";
const SECOND_DESTINATION = "11111111-1111-4111-8111-111111111112";
const LABELS = {
  healthy: "Connected",
  degraded: "Partial",
  disconnected: "Disconnected",
} as const;
type ScaleCheck = Pick<HealthCheckSummary, "checkId" | "state" | "severity" | "reason">;

interface Signals {
  taps: { id: string; enabled: boolean; isRetired: boolean }[];
  hasAuthority: boolean;
  scale: ScaleCheck | undefined;
  brewfatherEnabled: boolean;
  brewfatherApiKeyConfigured: boolean;
  brewfatherConnection: "disabled" | "unknown" | "healthy" | "partial" | "disconnected";
  brewfatherLinks: (BrewfatherSyncState | null)[];
  brewfatherLinkAccountId: string;
  extraBrewfatherAccounts: {
    id: string;
    enabled: boolean;
    connectionState: Signals["brewfatherConnection"];
  }[];
  destinations: readonly OutboundDestination[];
  unavailable: "health" | "brewfather" | "outbound" | undefined;
}

function harness(
  outbound?: Pick<OutboundService, "list">,
  beverage?: Pick<BeverageService, "getBrewfatherSyncHealth">,
) {
  const signals: Signals = {
    taps: [{ id: "tap-1", enabled: true, isRetired: false }],
    hasAuthority: true,
    scale: {
      checkId: "scale_availability",
      state: "healthy",
      severity: "none",
      reason: "scale_fresh",
    },
    brewfatherEnabled: false,
    brewfatherApiKeyConfigured: true,
    brewfatherConnection: "disabled",
    brewfatherLinks: [],
    brewfatherLinkAccountId: "default",
    extraBrewfatherAccounts: [],
    destinations: [],
    unavailable: undefined,
  };
  const service = new DashboardService({
    displayService: {
      getSettings: () => ({
        revision: 1,
        tapboardName: "Tapboard",
        theme: "modern_dark",
        font: "system",
        accent: "amber",
        unitSystem: "us",
        showServingTemperature: true,
        layoutMode: "scroll",
      }),
      getTapCardSettings: () => ({ remainingMode: "percent" }),
    },
    tapService: { listTaps: () => signals.taps },
    telemetryService: {
      getTapAuthority: () => (signals.hasAuthority ? { sourceId: "source-1" } : undefined),
    },
    healthService: {
      getAdminOverview: () => {
        if (signals.unavailable === "health") throw new Error("Health unavailable");
        return { checks: signals.scale === undefined ? [] : [signals.scale] };
      },
    },
    beverageService: beverage ?? {
      getBrewfatherSyncHealth: () => {
        if (signals.unavailable === "brewfather") throw new Error("Brewfather unavailable");
        const accounts = [
          {
            id: "default",
            enabled: signals.brewfatherEnabled,
            apiKeyConfigured: signals.brewfatherApiKeyConfigured,
            connectionState: signals.brewfatherConnection,
          },
          ...signals.extraBrewfatherAccounts.map((account) => ({
            ...account,
            apiKeyConfigured: true,
          })),
        ].filter((account) => account.enabled);
        return {
          accounts,
          hasUnsyncedLinks:
            accounts.length > 0 &&
            signals.brewfatherLinks.some(
              (state) =>
                state === null ||
                (state !== "synced" &&
                  accounts.some((account) => account.id === signals.brewfatherLinkAccountId)),
            ),
        };
      },
    },
    outboundService: {
      list: () => {
        if (signals.unavailable === "outbound") throw new Error("Outbound unavailable");
        return outbound?.list() ?? signals.destinations;
      },
    },
  } as unknown as DashboardServiceDependencies);
  return { service, signals };
}

function assertHeader(service: DashboardService, state: keyof typeof LABELS): void {
  assert.deepEqual(service.getHeader(), {
    tapboardName: "Tapboard",
    connectivity: state,
    connectivityLabel: LABELS[state],
  });
}

function outboundHarness() {
  const database = openDatabase(":memory:");
  const secrets = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 9).toString("base64url"),
  });
  let now = Date.parse(NOW);
  // No transport worker or lifecycle callback is installed: all destination
  // status changes are local, deterministic fixture operations.
  const outbound = createOutboundService(database, { secrets, now: () => new Date(now) });
  return {
    database,
    outbound,
    secrets,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

void test("Connected requires an eligible check; disabled and retired telemetry is excluded", () => {
  const { service, signals } = harness();
  assertHeader(service, "healthy");
  signals.taps = [];
  assertHeader(service, "disconnected");
  signals.taps = [
    { id: "disabled", enabled: false, isRetired: false },
    { id: "retired", enabled: true, isRetired: true },
  ];
  signals.scale = {
    checkId: "scale_availability",
    state: "active",
    severity: "critical",
    reason: "scale_unavailable",
  };
  assertHeader(service, "disconnected");
  signals.brewfatherEnabled = true;
  signals.brewfatherConnection = "healthy";
  assertHeader(service, "healthy");
  signals.brewfatherApiKeyConfigured = false;
  assertHeader(service, "disconnected");
  signals.brewfatherApiKeyConfigured = true;

  signals.taps = [{ id: "tap-1", enabled: true, isRetired: false }];
  signals.hasAuthority = false;
  signals.scale = {
    checkId: "scale_availability",
    state: "not_configured",
    severity: "none",
    reason: "check_disabled",
  };
  assertHeader(service, "healthy");
  signals.brewfatherEnabled = false;
  assertHeader(service, "disconnected");
});

void test("missing authority, pending measurements, and degraded scales are Partial", () => {
  const { service, signals } = harness();
  signals.hasAuthority = false;
  assertHeader(service, "degraded");
  signals.hasAuthority = true;
  for (const scale of [
    undefined,
    {
      checkId: "scale_availability",
      state: "not_configured",
      severity: "info",
      reason: "missing_measurement",
    },
    {
      checkId: "scale_availability",
      state: "degraded",
      severity: "warning",
      reason: "scale_degraded",
    },
  ] satisfies (ScaleCheck | undefined)[]) {
    signals.scale = scale;
    assertHeader(service, "degraded");
  }
});

void test("critical telemetry dominates working Brewfather and clears only after recovery", () => {
  const { service, signals } = harness();
  signals.brewfatherEnabled = true;
  signals.brewfatherConnection = "healthy";
  signals.brewfatherLinks = ["synced"];
  signals.scale = {
    checkId: "scale_availability",
    state: "active",
    severity: "critical",
    reason: "scale_unavailable",
  };
  assertHeader(service, "disconnected");
  signals.brewfatherLinks = ["stale"];
  assertHeader(service, "disconnected");
  signals.scale = { ...signals.scale, state: "healthy", severity: "none", reason: "scale_fresh" };
  assertHeader(service, "degraded");
  signals.brewfatherLinks = ["synced"];
  assertHeader(service, "healthy");
});

void test("Brewfather needs current connection evidence and every enabled link to be healthy", () => {
  const { service, signals } = harness();
  signals.brewfatherEnabled = true;
  for (const connection of ["unknown", "partial"] as const) {
    signals.brewfatherConnection = connection;
    // A cached data timestamp and a working scale cannot turn unknown green.
    assertHeader(service, "degraded");
  }
  signals.brewfatherConnection = "disconnected";
  assertHeader(service, "disconnected");
  signals.brewfatherConnection = "healthy";
  assertHeader(service, "healthy");
  for (const link of ["pending", "stale", "error", null] as const) {
    signals.brewfatherLinks = ["synced", link];
    assertHeader(service, "degraded");
  }
  signals.brewfatherLinks = ["synced"];
  assertHeader(service, "healthy");
  signals.brewfatherEnabled = false;
  signals.brewfatherConnection = "disconnected";
  signals.brewfatherLinks = ["error"];
  assertHeader(service, "healthy");
});

void test("every enabled Brewfather account counts and disabled-account links are excluded", () => {
  const { service, signals } = harness();
  signals.brewfatherEnabled = true;
  signals.brewfatherConnection = "healthy";
  const secondary = { id: "secondary", enabled: true, connectionState: "disconnected" } as {
    id: string;
    enabled: boolean;
    connectionState: Signals["brewfatherConnection"];
  };
  signals.extraBrewfatherAccounts = [secondary];
  assertHeader(service, "disconnected");
  secondary.connectionState = "unknown";
  assertHeader(service, "degraded");
  secondary.connectionState = "healthy";
  assertHeader(service, "healthy");
  signals.brewfatherLinkAccountId = "secondary";
  signals.brewfatherLinks = ["error"];
  assertHeader(service, "degraded");
  secondary.enabled = false;
  assertHeader(service, "healthy");
  secondary.enabled = true;
  signals.brewfatherEnabled = false;
  signals.brewfatherLinkAccountId = "default";
  assertHeader(service, "healthy");
});

void test("the header reads bounded Brewfather sync health without hydrating profiles or recipes", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const statements: string[] = [];
  const tracked: DatabaseExecutor = {
    execute: (sql) => database.execute(sql),
    prepare: (sql) => {
      statements.push(sql);
      return database.prepare(sql);
    },
    pragma: (statement, options) => database.pragma(statement, options),
    withTransaction: (work) => database.withTransaction(work),
  };
  const secretsService = createSecretsService(database, {
    rootKey: Buffer.alloc(32, 8).toString("base64url"),
  });
  const beverage = createBeverageService(tracked, { secretsService, now: () => new Date(NOW) });
  const { service, signals } = harness(undefined, beverage);
  const configure = (accountId: string, enabled: boolean) =>
    beverage.configureBrewfatherAccount({
      accountId,
      userId: "fixture-user",
      apiKey: "fixture-key",
      discoveryStatuses: ["Fermenting"],
      enabled,
    });
  configure("default", true);
  configure("secondary", false);
  assertHeader(service, "degraded");
  await beverage.syncBrewfather({
    fetchFn: () => Promise.resolve(new Response("[]", { status: 200 })),
  });
  assertHeader(service, "healthy");

  const addLink = (accountId: string, state: BrewfatherSyncState) => {
    const id = randomUUID();
    insertBeverage(database, {
      id,
      ownershipType: "brewfather",
      createdAt: NOW,
      updatedAt: NOW,
    });
    insertBeverageLink(database, {
      beverageId: id,
      accountId,
      sourceBatchId: id,
      syncState: state,
      lastSyncedAt: NOW,
      lastErrorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  };
  const first = addLink("default", "synced");
  const countHeaderQueries = () => {
    statements.length = 0;
    assertHeader(service, "healthy");
    assert.ok(statements.some((sql) => sql.includes("brewfather_beverage_links")));
    assert.ok(
      statements.every((sql) => !/profiles|recipes|recipe_snapshots|candidate_cache/u.test(sql)),
    );
    return statements.length;
  };
  const smallQueryCount = countHeaderQueries();
  for (let index = 0; index < 40; index += 1) addLink("default", "synced");
  addLink("secondary", "error");
  assert.equal(countHeaderQueries(), smallQueryCount, "query count must not grow with beverages");

  for (const state of ["pending", "error", "stale"] as const) {
    updateBeverageLinkState(database, first, state, "Fixture failure", NOW);
    assertHeader(service, "degraded");
  }
  updateBeverageLinkState(database, first, "synced", null, NOW);
  assertHeader(service, "healthy");
  const missingLink = randomUUID();
  insertBeverage(database, {
    id: missingLink,
    ownershipType: "brewfather",
    createdAt: NOW,
    updatedAt: NOW,
  });
  assertHeader(service, "degraded");
  database.prepare("UPDATE beverages SET ownership_type = 'custom' WHERE id = ?").run(missingLink);
  assertHeader(service, "healthy");

  beverage.removeBrewfatherApiKey();
  assertHeader(service, "disconnected");
  configure("default", false);
  updateBeverageLinkState(database, first, "stale", null, NOW);
  assert.deepEqual(beverage.getBrewfatherSyncHealth(), { accounts: [], hasUnsyncedLinks: false });
  assertHeader(service, "healthy");
  signals.taps = [];
  assertHeader(service, "disconnected");
});

for (const unavailable of ["health", "brewfather", "outbound"] as const) {
  void test(`an unavailable ${unavailable} projection is Disconnected, never silently Connected`, () => {
    const { service, signals } = harness();
    signals.unavailable = unavailable;
    assertHeader(service, "disconnected");
  });
}

void test("optional HA failure is ignored, while required failure becomes red at five minutes", () => {
  const { database, outbound, advance } = outboundHarness();
  try {
    const { service, signals } = harness(outbound);
    outbound.create({
      id: DESTINATION,
      label: "Fixture Home Assistant",
      transport: "home_assistant",
      baseUrl: "http://ha.example.test:8123",
      secret: "fixture-token",
    });
    outbound.recordFailure(DESTINATION, "connect_timeout", "connectivity");
    assertHeader(service, "healthy");
    const workingTaps = signals.taps;
    signals.taps = [];
    assertHeader(service, "disconnected");
    signals.taps = workingTaps;
    outbound.setRequired(DESTINATION, true);
    assertHeader(service, "degraded");
    advance(5 * 60_000 - 1);
    assertHeader(service, "degraded");
    advance(1);
    assertHeader(service, "disconnected");
    outbound.recordSuccess(DESTINATION);
    assertHeader(service, "healthy");
    outbound.recordFailure(DESTINATION, "auth_invalid", "authentication");
    assertHeader(service, "disconnected");
    outbound.disable(DESTINATION);
    assertHeader(service, "healthy");
    outbound.enable(DESTINATION);
    outbound.recordFailure(DESTINATION, "auth_invalid", "authentication");
    outbound.retire(DESTINATION);
    assertHeader(service, "healthy");
  } finally {
    database.close();
  }
});

void test("required outbound is never green before success and every failed destination must recover", () => {
  const { database, outbound, advance } = outboundHarness();
  try {
    const { service, signals } = harness(outbound);
    signals.taps = [];
    for (const id of [DESTINATION, SECOND_DESTINATION]) {
      outbound.create({
        id,
        label: "Required fixture webhook",
        transport: "webhook",
        webhookUrl: "https://webhook.example.test/hook",
        required: true,
      });
    }
    assertHeader(service, "degraded");
    outbound.recordSuccess(DESTINATION);
    assertHeader(service, "degraded");
    outbound.recordSuccess(SECOND_DESTINATION);
    assertHeader(service, "healthy");
    outbound.recordFailure(DESTINATION, "connect_timeout", "connectivity");
    outbound.recordFailure(SECOND_DESTINATION, "webhook_http_500", "connectivity");
    assertHeader(service, "degraded");
    advance(5 * 60_000);
    assertHeader(service, "disconnected");
    outbound.recordSuccess(DESTINATION);
    assertHeader(service, "disconnected");
    outbound.recordSuccess(SECOND_DESTINATION);
    assertHeader(service, "healthy");

    const successful = outbound.get(DESTINATION)!;
    signals.destinations = [{ ...successful, lastSuccessAt: null }];
    assertHeader(harness({ list: () => signals.destinations }).service, "degraded");
  } finally {
    database.close();
  }
});

void test("required auto-disabled missing tokens and header secrets remain Disconnected", () => {
  const { database, outbound } = outboundHarness();
  try {
    const { service } = harness(outbound);
    const missingToken = outbound.create({
      id: DESTINATION,
      label: "Missing required token",
      transport: "home_assistant",
      baseUrl: "http://ha.example.test:8123",
      required: true,
    });
    assert.equal(missingToken.disabledReason, "token_missing");
    assertHeader(service, "disconnected");
    outbound.setToken(DESTINATION, "fixture-token");
    outbound.enable(DESTINATION);
    // Replacing credentials does not prove the previous auth failure recovered.
    assertHeader(service, "disconnected");
    outbound.recordSuccess(DESTINATION);
    assertHeader(service, "healthy");

    const missingHeader = outbound.create({
      id: SECOND_DESTINATION,
      label: "Missing required header",
      transport: "webhook",
      webhookUrl: "https://webhook.example.test/hook",
      required: true,
      secretHeaders: [{ name: "Authorization" }],
    });
    assert.equal(missingHeader.disabledReason, "secret_missing");
    assertHeader(service, "disconnected");
    outbound.setRequired(SECOND_DESTINATION, false);
    assertHeader(service, "healthy");
  } finally {
    database.close();
  }
});

void test("unavailable configured secrets and missing required config cannot retain a green badge", () => {
  const { database, outbound, secrets } = outboundHarness();
  try {
    outbound.create({
      id: DESTINATION,
      label: "Required fixture HA",
      transport: "home_assistant",
      baseUrl: "http://ha.example.test:8123",
      secret: "fixture-token",
      required: true,
    });
    outbound.recordSuccess(DESTINATION);
    assertHeader(harness(outbound).service, "healthy");
    const lockedSecrets = createOutboundService(database, {
      secrets: createSecretsService(database),
      now: () => new Date(NOW),
    });
    assertHeader(harness(lockedSecrets).service, "disconnected");
    const successful = outbound.get(DESTINATION)!;
    assertHeader(
      harness({ list: () => [{ ...successful, currentVersion: null }] }).service,
      "disconnected",
    );

    const webhook = outbound.create({
      id: SECOND_DESTINATION,
      label: "Required fixture webhook",
      transport: "webhook",
      webhookUrl: "https://webhook.example.test/hook",
      required: true,
    });
    outbound.recordSuccess(SECOND_DESTINATION);
    assertHeader(harness(outbound).service, "healthy");
    secrets.remove("outbound", webhook.currentVersion!.id, "endpoint");
    assertHeader(harness(outbound).service, "disconnected");
  } finally {
    database.close();
  }
});
