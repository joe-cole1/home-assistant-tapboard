import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SimulationStatus } from "../src/features/simulation/ui-types.ts";
import type { PublicDashboardView } from "../src/features/dashboard/types.ts";
import { createApplication } from "../src/application.ts";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createLogger } from "../src/shared/logging.ts";

const origin = "http://127.0.0.1:3000";
async function setup(context: test.TestContext, hooks: { onOpenSimulation?: () => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tapboard-simulation-"));
  const path = join(directory, "live.sqlite3");
  const db = openDatabase(path);
  await createAuthService(db).resetPin("1234");
  const beverage = createBeverageService(db).createCustomBeverage({
    name: "REAL inventory - never reset",
  });
  const tap = createTapService(db).createTap({ tapNumber: 1 });
  const telemetry = new TelemetryService({
    database: db,
    machineKeyService: createMachineKeyService(db),
  });
  const source = telemetry.createSource({ name: "Real hardware", label: "Real source" });
  telemetry.setTapAuthority(tap.id, { sourceId: source.source.id });
  db.close();
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath: path,
    shutdownGraceMs: 1000,
    canonicalExternalOrigin: origin,
  };
  const create = () =>
    createApplication({
      config,
      logger: createLogger({ sink: () => undefined }),
      openDatabase: (databasePath) => {
        const database = openDatabase(databasePath);
        if (databasePath.endsWith(".simulation.sqlite3")) hooks.onOpenSimulation?.();
        return database;
      },
    });
  let application = create();
  let address = await application.start();
  let cookies = "";
  let csrf = "";
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...options,
      redirect: "manual",
      headers: { Cookie: cookies, ...options.headers },
    });
    const set = response.headers.getSetCookie();
    if (set.length) {
      cookies = set.map((c) => c.split(";")[0]).join("; ");
      csrf = /tapboard_admin_csrf=([^;]+)/.exec(cookies)?.[1] ?? "";
    }
    return response;
  }
  const post = (
    path: string,
    fields: Record<string, string> = {},
    extra: Record<string, string> = {},
  ) =>
    request(path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", ...extra },
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    });
  await request("/admin/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: "1234" }),
  });
  context.after(async () => {
    await application.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    source,
    tap,
    beverage,
    request,
    post,
    getCsrf: () => csrf,
    stop: () => application.stop(),
    async restart() {
      await application.stop();
      application = create();
      address = await application.start();
    },
  };
}

void test("simulation toggles isolated data, keeps hardware in live, rotates forms and persists/reset sample state", async (context) => {
  const h = await setup(context);
  const before = (await (await h.request("/api/public/dashboard")).json()) as PublicDashboardView;
  const oldCsrf = h.getCsrf();
  const enable = await h.post("/admin/simulation/enable");
  assert.equal(enable.status, 303);
  assert.match(enable.headers.get("location") ?? "", /notice=/);
  assert.notEqual(h.getCsrf(), oldCsrf);
  const status = (await (await h.request("/api/admin/simulation")).json()) as SimulationStatus;
  assert.equal(status.enabled, true);
  assert.equal(status.sensors.length, 5);
  const simulator = await h.request("/admin/simulator");
  assert.equal(simulator.status, 200);
  assert.match(await simulator.text(), /SIMULATION/);
  const dashboard = (await (
    await h.request("/api/public/dashboard")
  ).json()) as PublicDashboardView;
  assert.notDeepEqual(dashboard, before);
  const sample = status.sensors[0]!;
  const pause = await h.post(
    "/admin/simulation/sensor",
    { tapId: sample.tapId, online: "false" },
    { Accept: "application/json" },
  );
  assert.equal(pause.status, 200);
  const stale = await h.post(
    "/admin/simulation/sensor",
    { tapId: sample.tapId, online: "true", _csrf: oldCsrf },
    { Accept: "application/json" },
  );
  assert.equal(stale.status, 403);
  for (const path of ["/admin/integrations", "/admin//integrations/"]) {
    assert.equal((await h.request(path)).status, 409);
  }
  assert.equal((await h.request("/api//admin/simulation/")).status, 200);
  const batch = await h.request("/api/v1//telemetry/batch/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${h.source.initialToken}`,
    },
    body: JSON.stringify({ samples: [] }),
  });
  // A real key authenticates on the live service before the intentionally empty batch fails validation.
  assert.equal(batch.status, 400);
  const hardware = await h.request("/api/v1/telemetry/taps/1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${h.source.initialToken}`,
    },
    body: JSON.stringify({
      measurement: { kind: "remaining_volume", value: 5000, unit: "ml" },
      measured_at: new Date().toISOString(),
    }),
  });
  assert.equal(hardware.status, 200);
  await h.restart();
  const restored = (await (await h.request("/api/admin/simulation")).json()) as SimulationStatus;
  assert.equal(restored.enabled, true);
  assert.equal(restored.sensors.find((s) => s.tapId === sample.tapId)!.online, false);
  const noConfirmation = await h.post("/admin/simulation/reset");
  assert.match(noConfirmation.headers.get("location") ?? "", /error=/);
  const reset = await h.post("/admin/simulation/reset", { confirm: "yes" });
  assert.match(reset.headers.get("location") ?? "", /notice=/);
  const resetStatus = (await (await h.request("/api/admin/simulation")).json()) as SimulationStatus;
  assert.equal(resetStatus.sensors.length, 5);
  assert.ok(resetStatus.sensors.every((s: { tapId: string }) => s.tapId !== sample.tapId));
  const staleSimulationCsrf = h.getCsrf();
  await h.post("/admin/simulation/disable");
  assert.equal(
    ((await (await h.request("/api/public/workspace")).json()) as { enabled: boolean }).enabled,
    false,
  );
  const staleSwitch = await h.post("/admin/simulation/enable", { _csrf: staleSimulationCsrf });
  assert.match(staleSwitch.headers.get("location") ?? "", /error=/);
  const real = openDatabase(h.path);
  assert.equal(
    createBeverageService(real).getBeverage(h.beverage.beverage.id)?.effectivePresentation.name,
    "REAL inventory - never reset",
  );
  assert.equal(
    real.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM simulation_sensors").get()!.n,
    0,
  );
  assert.equal(
    real.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM telemetry_measurements").get()!.n,
    1,
  );
  real.close();
});

void test("simulation actions reject absent credentials, hostile origins, malformed controls, and unsafe data paths", async (context) => {
  const h = await setup(context);
  const anonymous = await h.request("/api/admin/simulation", { headers: { Cookie: "" } });
  assert.equal(anonymous.status, 401);
  const malformed = await h.post("/admin/simulation/enable", { unexpected: "value" });
  assert.match(malformed.headers.get("location") ?? "", /error=/);
  const forbidden = await h.post(
    "/admin/simulation/enable",
    {},
    { Origin: "https://other.invalid" },
  );
  assert.match(forbidden.headers.get("location") ?? "", /error=/);
  assert.equal(
    ((await (await h.request("/api/public/workspace")).json()) as { enabled: boolean }).enabled,
    false,
  );
  symlinkSync(h.path, h.path + ".simulation.sqlite3");
  const unsafe = await h.post("/admin/simulation/enable");
  assert.match(unsafe.headers.get("location") ?? "", /error=/);
  assert.equal(
    ((await (await h.request("/api/public/workspace")).json()) as { enabled: boolean }).enabled,
    false,
  );
});

void test("reset failure after replacing data returns to normal and invalidates old workspace pages", async (context) => {
  const hooks: { onOpenSimulation?: () => void } = {};
  const h = await setup(context, hooks);
  await h.post("/admin/simulation/enable");
  const before = (await (await h.request("/api/public/workspace")).json()) as { revision: number };
  hooks.onOpenSimulation = () => {
    const live = openDatabase(h.path);
    try {
      createAuthService(live).revokeAll();
    } finally {
      live.close();
    }
  };
  const result = await h.post("/admin/simulation/reset", { confirm: "yes" });
  assert.match(result.headers.get("location") ?? "", /error=/);
  const after = (await (await h.request("/api/public/workspace")).json()) as {
    enabled: boolean;
    revision: number;
  };
  assert.equal(after.enabled, false);
  assert.ok(after.revision > before.revision);
  assert.equal((await h.request("/api/admin/simulation")).status, 401);
  assert.equal((await h.request("/healthz")).status, 200);
  const live = openDatabase(h.path);
  try {
    assert.equal(
      createBeverageService(live).getBeverage(h.beverage.beverage.id).effectivePresentation.name,
      "REAL inventory - never reset",
    );
  } finally {
    live.close();
  }
});

void test("shutdown during embedded startup waits for the workspace transition before closing databases", async (context) => {
  const hooks: { onOpenSimulation?: () => void } = {};
  const h = await setup(context, hooks);
  let stopped: Promise<void> | undefined;
  hooks.onOpenSimulation = () => {
    stopped = h.stop();
  };
  const response = await h.post("/admin/simulation/enable");
  assert.match(response.headers.get("location") ?? "", /error=/);
  assert.ok(stopped);
  await stopped;
  const live = openDatabase(h.path);
  try {
    assert.equal(
      live.prepare<[], { enabled: number }>("SELECT enabled FROM simulation_settings").get()!
        .enabled,
      0,
    );
  } finally {
    live.close();
  }
});
