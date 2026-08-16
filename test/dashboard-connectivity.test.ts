import assert from "node:assert/strict";
import test from "node:test";

import { DashboardService } from "../src/features/dashboard/service.ts";

void test("Brewfather link connectivity follows enabled account state and clears after unlink", () => {
  let enabled = true;
  let linked = true;
  let syncState: "stale" | "error" = "stale";
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
    },
    tapService: {
      listTaps: () => [{ id: "tap-1", enabled: true, isRetired: false }],
    },
    telemetryService: { getTapAuthority: () => ({ sourceId: "source-1" }) },
    healthService: { getAdminOverview: () => ({ checks: [] }) },
    beverageService: {
      getBrewfatherStatus: () => ({
        account: { enabled },
        apiKeyConfigured: true,
      }),
      listBeverages: () =>
        linked ? [{ beverage: { id: "beverage-1", ownershipType: "brewfather" } }] : [],
      getBeverage: () => ({ brewfatherLink: { syncState } }),
    },
  } as never);

  assert.equal(service.getHeader().connectivity, "degraded");
  syncState = "error";
  assert.equal(service.getHeader().connectivity, "degraded");
  enabled = false;
  assert.equal(service.getHeader().connectivity, "healthy");
  enabled = true;
  assert.equal(service.getHeader().connectivity, "degraded");
  linked = false;
  assert.equal(service.getHeader().connectivity, "healthy");
});
