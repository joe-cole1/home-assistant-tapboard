import assert from "node:assert/strict";
import test from "node:test";
import { createAuthService } from "../src/features/auth/service.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createFillService } from "../src/features/fills/service.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createForecastService } from "../src/features/forecasting/service.ts";
import { registerForecastRoutes } from "../src/features/forecasting/routes.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";

const origin = "http://127.0.0.1:3000";
const logger = createLogger({ sink: () => undefined });

void test("forecast HTTP requires auth and strictly protects settings", async (context) => {
  const db = openDatabase(":memory:"),
    auth = createAuthService(db, { canonicalOrigin: origin });
  await auth.setPin("1234");
  const login = await auth.authenticate("1234");
  assert.ok(login.authenticated);
  const keg = createKegService(db).createKeg({ kegNumber: 1, capacityMl: 1000 });
  const beverage = createBeverageService(db).createCustomBeverage({
    name: "Forecast",
    beverageType: "beer",
    fg: 1,
  });
  const fill = createFillService(db).createFill({
    beverageId: beverage.beverage.id,
    kegId: keg.id,
  });
  const router = new Router(logger);
  registerForecastRoutes({ router, forecastService: createForecastService(db), authService: auth });
  const server = new HttpServer({ router, logger, shutdownGraceMs: 100 });
  context.after(async () => {
    await server.stop();
    db.close();
  });
  const address = await server.start("127.0.0.1", 0),
    base = `http://127.0.0.1:${address.port}`,
    cookie = `tapboard_admin_session=${login.session}`,
    csrf = login.csrfToken!;
  for (const path of [
    `/api/admin/fills/${fill.id}/pours`,
    `/api/admin/fills/${fill.id}/forecast`,
    "/api/admin/forecast/settings",
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 401);
  const activityBeforeReads = db
    .prepare<[], { n: number }>("SELECT count(*) AS n FROM activity_log")
    .get()!.n;
  const forecast = await fetch(`${base}/api/admin/fills/${fill.id}/forecast`, {
    headers: { cookie },
  });
  assert.equal(forecast.status, 200);
  const payload = (await forecast.json()) as { forecast: Record<string, unknown> };
  assert.equal(payload.forecast.reason, "no_assignment_history");
  assert.ok("currentVolume" in payload.forecast);
  assert.ok("confidence" in payload.forecast);
  assert.ok("anomalies" in payload.forecast);
  assert.equal(
    (await fetch(`${base}/api/admin/forecast/settings`, { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    db.prepare<[], { n: number }>("SELECT count(*) AS n FROM activity_log").get()!.n,
    activityBeforeReads,
  );
  for (const query of ["?limit=0", "?limit=-1", "?limit=1&limit=2", "?wat=1", "?cursor=bad"])
    assert.equal(
      (await fetch(`${base}/api/admin/fills/${fill.id}/pours${query}`, { headers: { cookie } }))
        .status,
      400,
    );
  const patch = (headers: Record<string, string>, body: string) =>
    fetch(`${base}/api/admin/forecast/settings`, { method: "PATCH", headers, body });
  assert.equal((await patch({}, "{}")).status, 401);
  assert.equal(
    (await patch({ cookie, origin, "content-type": "application/json" }, '{"servingSizeMl":1}'))
      .status,
    401,
  );
  const missingContentType = await patch({ cookie, origin, "x-csrf-token": csrf }, "{}");
  assert.equal(missingContentType.status, 400);
  assert.equal(
    ((await missingContentType.json()) as { error: { code: string } }).error.code,
    "http.unsupported_media_type",
  );
  assert.equal(
    (
      await patch(
        {
          cookie,
          origin: "http://wrong",
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        '{"servingSizeMl":1}',
      )
    ).status,
    401,
  );
  for (const body of [
    "{}",
    '{"servingSizeMl":0}',
    '{"servingSizeMl":-1}',
    '{"servingSizeMl":1,"extra":true}',
    "{",
  ])
    assert.equal(
      (
        await patch(
          { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" },
          body,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await patch(
        { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" },
        `{"servingSizeMl":1,"pad":"${"x".repeat(17 * 1024)}"}`,
      )
    ).status,
    413,
  );
  const before = db.prepare<[], { n: number }>("SELECT count(*) AS n FROM activity_log").get()!.n;
  const unchanged = await patch(
    { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" },
    '{"servingSizeMl":354.88235475}',
  );
  assert.equal(unchanged.status, 200);
  assert.equal(
    db.prepare<[], { n: number }>("SELECT count(*) AS n FROM activity_log").get()!.n,
    before,
  );
  const changed = await patch(
    { cookie, origin, "x-csrf-token": csrf, "content-type": "application/json" },
    '{"servingSizeMl":355}',
  );
  assert.equal(changed.status, 200);
  assert.equal(
    db.prepare<[], { n: number }>("SELECT count(*) AS n FROM activity_log").get()!.n,
    before + 1,
  );
  assert.equal(
    db.prepare<[], { n: number }>("SELECT count(*) AS n FROM outbound_events").get()!.n,
    0,
  );
});
