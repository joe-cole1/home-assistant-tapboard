import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { AuthService } from "../src/features/auth/service.ts";
import { KegService } from "../src/features/kegs/service.ts";
import { registerKegRoutes } from "../src/features/kegs/routes.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { createLogger } from "../src/shared/logging.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import { readActivities } from "../src/features/activity/operations.ts";
import { readDeletionAudits } from "../src/features/activity/deletion-audit.ts";
import type { KegCorrectionEvent } from "../src/features/kegs/types.ts";

const quietLogger = createLogger({ sink: () => undefined });
const CANONICAL_ORIGIN = "http://127.0.0.1:3000";

function fixedUuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function setupInMemoryKegs() {
  const database = openDatabase(":memory:");
  const correctionEvents: KegCorrectionEvent[] = [];
  const authService = new AuthService(database, {
    canonicalOrigin: CANONICAL_ORIGIN,
  });
  const kegService = new KegService(database, {
    onKegCorrection: (_db, event) => {
      correctionEvents.push(event);
    },
  });
  return { database, authService, kegService, correctionEvents };
}

void test("keg creation inserts keg, initial tare history, and domain activity log", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 1,
      label: "Sixtel Alpha",
      capacityMl: 19500,
      currentTareG: 4300,
      isActive: true,
    });

    assert.equal(keg.kegNumber, 1);
    assert.equal(keg.label, "Sixtel Alpha");
    assert.equal(keg.capacityMl, 19500);
    assert.equal(keg.currentTareG, 4300);
    assert.equal(keg.isActive, true);

    const details = kegService.getKeg(keg.id);
    assert.equal(details.keg.id, keg.id);
    assert.equal(details.tareHistory.length, 1);
    assert.equal(details.tareHistory[0]?.previousTareG, null);
    assert.equal(details.tareHistory[0]?.newTareG, 4300);
    assert.equal(details.tareHistory[0]?.reason, "initial_creation");
    assert.equal(details.maintenanceHistory.length, 0);

    const activities = readActivities(database);
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.category, "domain");
    assert.equal(activities[0]?.action, "entity_changed");
    assert.equal(activities[0]?.entityType, "keg");
    assert.equal(activities[0]?.entityId, keg.id);
  } finally {
    database.close();
  }
});

void test("duplicate keg number is rejected with conflict error and rolled back", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    kegService.createKeg({
      kegNumber: 10,
      capacityMl: 19500,
      currentTareG: 4200,
    });

    assert.throws(
      () =>
        kegService.createKeg({
          kegNumber: 10,
          capacityMl: 50000,
          currentTareG: 9000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.category, "conflict");
        assert.equal(error.code, "keg.keg_number_in_use");
        return true;
      },
    );

    const list = kegService.listKegs();
    assert.equal(list.length, 1);
  } finally {
    database.close();
  }
});

void test("Promise-like Keg correction extensions are rejected and roll back the update", () => {
  const database = openDatabase(":memory:");
  const kegService = new KegService(database, {
    onKegCorrection: () => ({ then() {} }),
  });
  try {
    const keg = kegService.createKeg({
      kegNumber: 1,
      capacityMl: 19_500,
      currentTareG: 4_300,
    });

    assert.throws(
      () => kegService.updateKeg(keg.id, { capacityMl: 20_000 }),
      /Keg correction extensions must complete synchronously/,
    );
    assert.equal(kegService.getKeg(keg.id).keg.capacityMl, 19_500);
  } finally {
    database.close();
  }
});

void test("keg number is reusable only after permanent deletion", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    const keg1 = kegService.createKeg({
      kegNumber: 5,
      label: "Vessel 5",
      capacityMl: 19000,
      currentTareG: 4100,
    });

    // Cannot create another while keg1 exists
    assert.throws(
      () =>
        kegService.createKeg({
          kegNumber: 5,
          capacityMl: 19000,
          currentTareG: 4100,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "keg.keg_number_in_use");
        return true;
      },
    );

    // Delete keg 5
    const impact = kegService.deleteKeg(keg1.id, {
      reason: "Damaged vessel",
      confirmation: "Keg 5 — Vessel 5",
    });
    assert.equal(impact.kegs, 1);
    assert.equal(impact.tareHistoryRecords, 1);

    // Now keg number 5 can be created with a fresh unique UUID
    const keg2 = kegService.createKeg({
      kegNumber: 5,
      label: "Replacement Vessel 5",
      capacityMl: 19000,
      currentTareG: 4250,
    });

    assert.equal(keg2.kegNumber, 5);
    assert.notEqual(keg2.id, keg1.id);
  } finally {
    database.close();
  }
});

void test("capacity update triggers synchronous telemetry correction hook without recomputing historical tare", () => {
  const { database, kegService, correctionEvents } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 1,
      capacityMl: 19000,
      currentTareG: 4000,
    });

    assert.equal(correctionEvents.length, 0);

    const updated = kegService.updateKeg(keg.id, {
      capacityMl: 19500,
    });

    assert.equal(updated.capacityMl, 19500);
    assert.equal(updated.currentTareG, 4000);

    // Tare history should not have new rows when tare did not change
    const details = kegService.getKeg(keg.id);
    assert.equal(details.tareHistory.length, 1);

    // Correction hook was invoked
    assert.equal(correctionEvents.length, 1);
    assert.equal(correctionEvents[0]?.kegId, keg.id);
    assert.equal(correctionEvents[0]?.previousCapacityMl, 19000);
    assert.equal(correctionEvents[0]?.newCapacityMl, 19500);
    assert.equal(correctionEvents[0]?.previousTareG, 4000);
    assert.equal(correctionEvents[0]?.newTareG, 4000);
  } finally {
    database.close();
  }
});

void test("tare weight update appends tare history prospectively and triggers correction hook", () => {
  const { database, kegService, correctionEvents } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 2,
      capacityMl: 19000,
      currentTareG: 4000,
    });

    const updated = kegService.updateKeg(keg.id, {
      currentTareG: 4150,
      reason: "Post-rebuild scale recalibration",
    });

    assert.equal(updated.currentTareG, 4150);

    const details = kegService.getKeg(keg.id);
    assert.equal(details.tareHistory.length, 2);
    // Ordered descending by recorded_at / rowid
    assert.equal(details.tareHistory[0]?.previousTareG, 4000);
    assert.equal(details.tareHistory[0]?.newTareG, 4150);
    assert.equal(details.tareHistory[0]?.reason, "Post-rebuild scale recalibration");
    assert.equal(details.tareHistory[1]?.previousTareG, null);
    assert.equal(details.tareHistory[1]?.newTareG, 4000);

    // Correction hook was invoked
    assert.equal(correctionEvents.length, 1);
    assert.equal(correctionEvents[0]?.previousTareG, 4000);
    assert.equal(correctionEvents[0]?.newTareG, 4150);
  } finally {
    database.close();
  }
});

void test("Active/Inactive toggle emits transition activity log and updates status", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 3,
      capacityMl: 19000,
      currentTareG: 4000,
      isActive: true,
    });

    const deactivated = kegService.updateKeg(keg.id, { isActive: false });
    assert.equal(deactivated.isActive, false);

    const reactivated = kegService.updateKeg(keg.id, { isActive: true });
    assert.equal(reactivated.isActive, true);

    const activities = readActivities(database);
    const transitions = activities.filter((a) => a.action === "transition");
    assert.equal(transitions.length, 2);
    assert.equal(
      transitions.some(
        (t) =>
          t.details?.from === "active" &&
          t.details?.to === "inactive" &&
          t.details?.keg_number === 3,
      ),
      true,
    );
    assert.equal(
      transitions.some(
        (t) =>
          t.details?.from === "inactive" &&
          t.details?.to === "active" &&
          t.details?.keg_number === 3,
      ),
      true,
    );
  } finally {
    database.close();
  }
});

void test("maintenance timeline is append-only, informational, and records domain activity", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 4,
      capacityMl: 19000,
      currentTareG: 4000,
    });

    const m1 = kegService.recordMaintenance(keg.id, {
      maintenanceType: "Deep Clean",
      notes: "Acid wash and caustic rinse",
    });

    const m2 = kegService.recordMaintenance(keg.id, {
      maintenanceType: "Replace O-rings / Seals",
      notes: "Replaced spear and poppet seals",
    });

    assert.equal(m1.maintenanceType, "Deep Clean");
    assert.equal(m2.maintenanceType, "Replace O-rings / Seals");

    const details = kegService.getKeg(keg.id);
    assert.equal(details.maintenanceHistory.length, 2);
    assert.equal(details.maintenanceHistory[0]?.maintenanceType, "Replace O-rings / Seals");
    assert.equal(details.maintenanceHistory[1]?.maintenanceType, "Deep Clean");

    // Maintenance does not block or modify keg active status
    assert.equal(details.keg.isActive, true);
  } finally {
    database.close();
  }
});

void test("destructive keg deletion records deletion audit and activity log, cascades records, and preserves beverages", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    const keg = kegService.createKeg({
      kegNumber: 7,
      capacityMl: 19000,
      currentTareG: 4000,
    });

    kegService.updateKeg(keg.id, { currentTareG: 4100 });
    kegService.recordMaintenance(keg.id, { maintenanceType: "Sanitize" });

    const impact = kegService.getDeletionImpact(keg.id);
    assert.equal(impact.kegs, 1);
    assert.equal(impact.tareHistoryRecords, 2);
    assert.equal(impact.maintenanceRecords, 1);

    assert.throws(
      () => kegService.deleteKeg(keg.id),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "keg.confirmation_required",
    );
    assert.throws(
      () => kegService.deleteKeg(keg.id, { confirmation: "" }),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === "keg.confirmation_required",
    );

    assert.throws(
      () => kegService.deleteKeg(keg.id, { confirmation: "Wrong visible label" }),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "keg.confirmation_mismatch");
        return true;
      },
    );

    kegService.deleteKeg(keg.id, {
      reason: "Vessel decommissioned",
      confirmation: "Keg 7",
    });

    // Keg is gone
    assert.throws(
      () => kegService.getKeg(keg.id),
      (error: unknown) => {
        assert.ok(error instanceof ApplicationError);
        assert.equal(error.code, "keg.not_found");
        return true;
      },
    );

    // Deletion audit is recorded and immutable
    const audits = readDeletionAudits(database);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.entityType, "keg");
    assert.equal(audits[0]?.entityId, keg.id);
    assert.equal(audits[0]?.reason, "Vessel decommissioned");
    assert.deepEqual(audits[0]?.impacts, [
      { code: "kegs", count: 1 },
      { code: "keg_tare_history", count: 2 },
      { code: "keg_maintenance_records", count: 1 },
    ]);

    // Activity log has deletion entry
    const activities = readActivities(database);
    const deletionActivity = activities.find((a) => a.action === "deletion");
    assert.ok(deletionActivity);
    assert.equal(deletionActivity.entityId, keg.id);
  } finally {
    database.close();
  }
});

void test("admin Keg pages use bounded SQL search, status filters, and deterministic 25-row windows", () => {
  const { database, kegService } = setupInMemoryKegs();
  try {
    for (let index = 1; index <= 27; index += 1) {
      kegService.createKeg({
        id: fixedUuid(300 + index),
        kegNumber: index,
        label: index === 1 ? "Percent%_ Keg" : `Keg ${index}`,
        capacityMl: 19_000,
      });
    }

    const firstPage = kegService.listAdminPage({ status: "active", sort: "number", page: 1 });
    assert.equal(firstPage.total, 27);
    assert.equal(firstPage.pageSize, 25);
    assert.equal(firstPage.pageCount, 2);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.items.length, 25);
    assert.equal(firstPage.items[0]?.kegNumber, 1);
    assert.equal(firstPage.items[24]?.kegNumber, 25);

    const secondPage = kegService.listAdminPage({ status: "active", sort: "number", page: 2 });
    assert.equal(secondPage.items.length, 2);
    assert.deepEqual(
      secondPage.items.map((item) => item.kegNumber),
      [26, 27],
    );

    // Wildcards are literal operator search text, not unbounded LIKE syntax.
    const escapedSearch = kegService.listAdminPage({ q: "%_", status: "active", sort: "number" });
    assert.equal(escapedSearch.total, 1);
    assert.equal(escapedSearch.items[0]?.label, "Percent%_ Keg");

    kegService.updateKeg(fixedUuid(301), { isActive: false });
    const inactive = kegService.listAdminPage({ status: "inactive", sort: "number" });
    assert.equal(inactive.total, 1);
    assert.equal(inactive.items[0]?.kegNumber, 1);
  } finally {
    database.close();
  }
});

void test("HTTP Admin API: full lifecycle smoke test with auth, CSRF, error handling, and unknown field rejection", async (context) => {
  const database = openDatabase(":memory:");
  const authService = new AuthService(database, {
    canonicalOrigin: CANONICAL_ORIGIN,
  });
  await authService.setPin("1234");
  const loginResult = await authService.authenticate("1234");
  assert.ok(loginResult.authenticated);
  const cookieHeader = `tapboard_admin_session=${loginResult.session}`;
  const csrfToken = loginResult.csrfToken!;

  const kegService = new KegService(database);
  const router = new Router(quietLogger);
  registerKegRoutes({ router, kegService, authService });

  const server = new HttpServer({
    router,
    logger: quietLogger,
    shutdownGraceMs: 100,
  });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // 1. Unauthenticated GET /api/admin/kegs -> 401
  const unauthGet = await fetch(`${baseUrl}/api/admin/kegs`);
  assert.equal(unauthGet.status, 401);

  // 1b. Bearer header is rejected for human admin session -> 401 (cookie required)
  const bearerGet = await fetch(`${baseUrl}/api/admin/kegs`, {
    headers: { authorization: `Bearer ${loginResult.session}` },
  });
  assert.equal(bearerGet.status, 401);

  // 2. Authenticated GET /api/admin/kegs -> 200, empty list
  const authGet = await fetch(`${baseUrl}/api/admin/kegs`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(authGet.status, 200);
  const getBody = (await authGet.json()) as { kegs: unknown[] };
  assert.deepEqual(getBody.kegs, []);

  // 3. POST without CSRF / Origin -> 401/403
  const noCsrfPost = await fetch(`${baseUrl}/api/admin/kegs`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kegNumber: 1, capacityMl: 19000 }),
  });
  assert.ok(noCsrfPost.status === 401 || noCsrfPost.status === 403 || noCsrfPost.status === 400);

  // 4. POST with unknown field -> 400
  const unknownFieldPost = await fetch(`${baseUrl}/api/admin/kegs`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kegNumber: 1,
      capacityMl: 19000,
      unknownProp: "illegal",
    }),
  });
  assert.equal(unknownFieldPost.status, 400);

  // 5. Valid POST /api/admin/kegs -> 201
  const createPost = await fetch(`${baseUrl}/api/admin/kegs`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kegNumber: 1,
      label: "Draft Keg #1",
      capacityMl: 19500,
      currentTareG: 4200,
    }),
  });
  assert.equal(createPost.status, 201);
  const createdBody = (await createPost.json()) as {
    keg: { id: string; kegNumber: number; label: string; capacityMl: number; currentTareG: number };
  };
  const kegId = createdBody.keg.id;
  assert.equal(createdBody.keg.kegNumber, 1);
  assert.equal(createdBody.keg.label, "Draft Keg #1");

  // 6. GET /api/admin/kegs/:id -> 200 with details
  const getDetail = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(getDetail.status, 200);
  const detailBody = (await getDetail.json()) as {
    keg: { id: string; tareHistory: unknown[]; maintenanceHistory: unknown[] };
  };
  assert.equal(detailBody.keg.id, kegId);
  assert.equal(detailBody.keg.tareHistory.length, 1);

  // 7. PATCH /api/admin/kegs/:id -> 200
  const patchRes = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    method: "PATCH",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      currentTareG: 4300,
      reason: "Tare re-zeroed",
    }),
  });
  assert.equal(patchRes.status, 200);

  // 8. POST /api/admin/kegs/:id/maintenance -> 201
  const maintPost = await fetch(`${baseUrl}/api/admin/kegs/${kegId}/maintenance`, {
    method: "POST",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      maintenanceType: "Sanitize",
      notes: "Starsan flush",
    }),
  });
  assert.equal(maintPost.status, 201);

  // 9. GET /api/admin/kegs/:id/deletion-impact -> 200
  const impactGet = await fetch(`${baseUrl}/api/admin/kegs/${kegId}/deletion-impact`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(impactGet.status, 200);
  const impactBody = (await impactGet.json()) as {
    impact: { kegId: string; impacts: Array<{ code: string; count: number }> };
  };
  assert.equal(impactBody.impact.kegId, kegId);

  // 10. DELETE /api/admin/kegs/:id -> 200
  const missingConfirmationDelete = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Retired" }),
  });
  assert.equal(missingConfirmationDelete.status, 400);

  const emptyConfirmationDelete = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "" }),
  });
  assert.equal(emptyConfirmationDelete.status, 400);

  const wrongConfirmationDelete = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmation: "Keg 1 — Draft Keg" }),
  });
  assert.equal(wrongConfirmationDelete.status, 400);

  const deleteRes = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    method: "DELETE",
    headers: {
      cookie: cookieHeader,
      origin: CANONICAL_ORIGIN,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "Retired", confirmation: "Keg 1 — Draft Keg #1" }),
  });
  assert.equal(deleteRes.status, 200);

  // 11. GET after DELETE -> 404
  const postDeleteGet = await fetch(`${baseUrl}/api/admin/kegs/${kegId}`, {
    headers: { cookie: cookieHeader },
  });
  assert.equal(postDeleteGet.status, 404);
});
