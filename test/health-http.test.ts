import assert from "node:assert/strict";
import test from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { insertHealthIncident } from "../src/features/health/repository.ts";
import { createHealthService } from "../src/features/health/service.ts";
import { registerHealthRoutes } from "../src/features/health/routes.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "http://127.0.0.1:3000";
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const logger = createLogger({ sink: () => undefined });

function ids(start: number): () => string {
  let next = start;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

void test("health Admin routes enforce security, pagination, DTO privacy, and derived maintenance", async (context) => {
  const database = openDatabase(":memory:");
  const tapService = createTapService(database, {
    now: () => new Date(NOW),
    idFactory: ids(1),
  });
  const tap = tapService.createTap({ tapNumber: 1, name: "Cellar" });
  const healthService = createHealthService(database, {
    now: () => new Date(NOW),
    idFactory: ids(100),
  });
  healthService.onTapCreated(database, tap.id, NOW);
  const authService = createAuthService(database, { canonicalOrigin: ORIGIN });
  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.equal(login.authenticated, true);
  assert.ok(login.session);
  assert.ok(login.csrfToken);

  const router = new Router(logger);
  registerHealthRoutes({ router, healthService, authService });
  const server = new HttpServer({ router, logger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `tapboard_admin_session=${login.session}`;
  const mutationHeaders = {
    cookie,
    origin: ORIGIN,
    "x-csrf-token": login.csrfToken,
    "content-type": "application/json",
  };

  assert.equal((await fetch(`${base}/api/admin/health/overview`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/health/settings`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/admin/health/settings`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/health/settings`, {
        method: "PATCH",
        headers: {
          cookie,
          origin: "http://wrong",
          "x-csrf-token": login.csrfToken,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    401,
  );

  const missingContentType = await fetch(`${base}/api/admin/health/settings`, {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN, "x-csrf-token": login.csrfToken },
    body: "{}",
  });
  assert.equal(missingContentType.status, 400);
  const missingContentTypeBody = await json(missingContentType);
  assert.equal(typeof missingContentTypeBody.error, "object");

  for (const body of [
    "{",
    JSON.stringify({ unknown: true }),
    JSON.stringify({ low_keg: { unknown: true } }),
  ]) {
    assert.equal(
      (
        await fetch(`${base}/api/admin/health/settings`, {
          method: "PATCH",
          headers: mutationHeaders,
          body,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await fetch(`${base}/api/admin/health/settings`, {
        method: "PATCH",
        headers: mutationHeaders,
        body: `{"low_keg":{"enabled":true},"pad":"${"x".repeat(16 * 1024)}"}`,
      })
    ).status,
    413,
  );

  for (const query of ["?limit=0", "?limit=201", "?limit=1&limit=2", "?unknown=1", "?cursor=bad"]) {
    assert.equal(
      (
        await fetch(`${base}/api/admin/taps/${tap.id}/health/incidents${query}`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/admin/taps/${tap.id}/maintenance${query}`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
  }

  assert.equal(
    (await fetch(`${base}/api/admin/taps/not-a-uuid/health`, { headers: { cookie } })).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/api/admin/health/incidents/not-a-uuid/acknowledge`, {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      })
    ).status,
    400,
  );

  const settingsResponse = await fetch(`${base}/api/admin/health/settings`, {
    headers: { cookie },
  });
  assert.equal(settingsResponse.status, 200);
  const settings = await json(settingsResponse);
  assert.equal(
    (
      ((settings.settings as Record<string, unknown>).config as Record<string, unknown>)
        .low_keg as Record<string, unknown>
    ).enabled,
    true,
  );

  const overviewResponse = await fetch(`${base}/api/admin/health/overview`, {
    headers: { cookie },
  });
  assert.equal(overviewResponse.status, 200);
  const overview = await json(overviewResponse);
  const overviewText = JSON.stringify(overview);
  assert.equal(overviewText.includes("notes"), false);
  assert.equal(overviewText.includes("actorId"), false);
  assert.equal(overviewText.includes("sessionId"), false);
  assert.equal(overviewText.includes("measurementId"), false);

  const detailResponse = await fetch(`${base}/api/admin/taps/${tap.id}/health`, {
    headers: { cookie },
  });
  assert.equal(detailResponse.status, 200);
  assert.equal(JSON.stringify(await json(detailResponse)).includes("notes"), false);

  const overrideResponse = await fetch(`${base}/api/admin/taps/${tap.id}/health-overrides`, {
    method: "PATCH",
    headers: mutationHeaders,
    body: JSON.stringify({ low_keg: { thresholdPercent: 25, criticalPercent: null } }),
  });
  assert.equal(overrideResponse.status, 200);
  assert.equal(
    (
      ((await json(overrideResponse)).override as Record<string, unknown>).low_keg as Record<
        string,
        unknown
      >
    ).thresholdPercent,
    25,
  );
  const clearedOverride = await fetch(`${base}/api/admin/taps/${tap.id}/health-overrides`, {
    method: "DELETE",
    headers: mutationHeaders,
  });
  assert.equal(clearedOverride.status, 200);

  const performedAt = "2026-07-31T12:00:00.000Z";
  const maintenanceResponse = await fetch(`${base}/api/admin/taps/${tap.id}/maintenance`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      maintenanceType: "line_cleaned",
      performedAt,
      notes: "private maintenance note",
    }),
  });
  assert.equal(maintenanceResponse.status, 201);
  const maintenanceBody = await json(maintenanceResponse);
  const maintenance = maintenanceBody.record as Record<string, unknown>;
  assert.equal(maintenance.notes, "private maintenance note");
  assert.equal(maintenance.dueAtMs, Date.parse(performedAt) + 14 * 86_400_000);
  assert.equal("actorId" in maintenance, false);
  assert.equal("sessionId" in maintenance, false);
  const maintenanceId = maintenance.id;
  assert.equal(typeof maintenanceId, "string");
  const maintenanceIdValue = maintenanceId as string;

  const secondMaintenanceResponse = await fetch(`${base}/api/admin/taps/${tap.id}/maintenance`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ maintenanceType: "inspection" }),
  });
  assert.equal(secondMaintenanceResponse.status, 201);

  const maintenancePageResponse = await fetch(
    `${base}/api/admin/taps/${tap.id}/maintenance?limit=1`,
    { headers: { cookie } },
  );
  assert.equal(maintenancePageResponse.status, 200);
  const maintenancePage = await json(maintenancePageResponse);
  const records = maintenancePage.records as readonly Record<string, unknown>[];
  assert.equal(records.length, 1);
  assert.equal("notes" in records[0]!, false);
  assert.equal(typeof maintenancePage.nextCursor, "string");
  const nextPage = await fetch(
    `${base}/api/admin/taps/${tap.id}/maintenance?cursor=${encodeURIComponent(String(maintenancePage.nextCursor))}`,
    { headers: { cookie } },
  );
  assert.equal(nextPage.status, 200);

  const maintenanceDetailResponse = await fetch(
    `${base}/api/admin/taps/${tap.id}/maintenance/${maintenanceIdValue}`,
    { headers: { cookie } },
  );
  assert.equal(maintenanceDetailResponse.status, 200);
  const maintenanceDetail = await json(maintenanceDetailResponse);
  assert.equal(
    (maintenanceDetail.maintenance as Record<string, unknown>).notes,
    "private maintenance note",
  );

  const incidentId = "00000000-0000-4000-8000-000000000901";
  insertHealthIncident(database, {
    id: incidentId,
    tapId: tap.id,
    checkId: "low_keg",
    openedAtMs: NOW,
    severity: "warning",
    reason: "below_threshold",
    evidence: { reason: "below_threshold" },
    updatedAt: new Date(NOW).toISOString(),
  });
  const acknowledged = await fetch(`${base}/api/admin/health/incidents/${incidentId}/acknowledge`, {
    method: "POST",
    headers: mutationHeaders,
    body: "{}",
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(
    ((await json(acknowledged)).incident as Record<string, unknown>).acknowledgedAtMs,
    NOW,
  );
  const cooldown = await fetch(`${base}/api/admin/health/incidents/${incidentId}/cooldown`, {
    method: "PATCH",
    headers: mutationHeaders,
    body: JSON.stringify({ cooldownUntil: "2026-08-01T13:00:00.000Z" }),
  });
  assert.equal(cooldown.status, 200);
  for (const body of [
    {},
    { cooldownUntil: 1 },
    { cooldownUntil: "2026-08-01T13:00:00Z", extra: true },
  ]) {
    assert.equal(
      (
        await fetch(`${base}/api/admin/health/incidents/${incidentId}/cooldown`, {
          method: "PATCH",
          headers: mutationHeaders,
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  }
});
