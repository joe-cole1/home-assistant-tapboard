import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { registerSimulationRoutes } from "../src/features/simulation/routes.ts";
import type {
  SimulationController,
  SimulationSensorView,
} from "../src/features/simulation/ui-types.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";
import { createLogger } from "../src/shared/logging.ts";

const ORIGIN = "https://tapboard.example";
const SENSOR_ID = "test-sensor";
const secret = "projection-must-not-include-this-value";

class Response {
  status = 0;
  headers: Record<string, string | readonly string[]> = {};
  body = "";
  setHeader(name: string, value: string | readonly string[]): void {
    this.headers[name.toLowerCase()] = value;
  }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    Object.assign(this.headers, headers);
  }
  end(body = ""): void {
    this.body = body;
  }
}

async function fixture(context: TestContext) {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const auth = createAuthService(database, { canonicalOrigin: ORIGIN });
  await auth.setPin("1234");
  const login = await auth.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const csrf = login.csrfToken;
  let cookie = `tapboard_admin_session=${login.session}; tapboard_admin_csrf=${csrf}`;
  const calls: unknown[][] = [];
  const logs: string[] = [];
  const state = {
    enabled: true,
    revision: 1,
    changing: false,
    sensors: [
      {
        tapId: SENSOR_ID,
        tapNumber: 1,
        label: '<script>alert("sample")</script>',
        remainingMl: 10000,
        temperatureC: 4,
        online: true,
        noiseEnabled: false,
        pouring: false,
        status: "ready",
        error: null,
      },
    ] as SimulationSensorView[],
  };
  const rotate = (token: string) => {
    const session = auth.rotateForWorkspace(token);
    assert.ok(session);
    return Promise.resolve(session);
  };
  const controller: SimulationController = {
    status: () => ({
      ...state,
      credentials: secret,
      sensors: state.sensors.map((sensor) => ({ ...sensor, sourceId: secret, machineKey: secret })),
    }),
    setEnabled(enabled, token) {
      calls.push(["enabled", enabled]);
      state.enabled = enabled;
      state.revision += 1;
      return rotate(token);
    },
    reset(token) {
      calls.push(["reset"]);
      state.revision += 1;
      return rotate(token);
    },
    pour(tapId, ounces) {
      calls.push(["pour", tapId, ounces]);
    },
    setOnline(tapId, online) {
      calls.push(["online", tapId, online]);
    },
    setNoise(tapId, enabled) {
      calls.push(["noise", tapId, enabled]);
    },
  };
  const logger = createLogger({ sink: (line) => logs.push(line) });
  const router = new Router(logger);
  registerSimulationRoutes({
    router,
    renderer: createRenderer(),
    authService: auth,
    canonicalOrigin: ORIGIN,
    logger,
    controller,
  });
  const request = async (
    path: string,
    values?: Readonly<Record<string, string>> | string,
    headers: IncomingHttpHeaders = {},
  ): Promise<Response> => {
    const body =
      values === undefined
        ? ""
        : typeof values === "string"
          ? values
          : new URLSearchParams({ _csrf: csrf, ...values }).toString();
    const input = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method: values === undefined ? "GET" : "POST",
      url: path,
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
    });
    const response = new Response();
    await router.handle(input as never, response as never);
    return response;
  };
  return {
    request,
    state,
    calls,
    csrf,
    controller,
    logs,
    updateCookie(value: string) {
      cookie = value;
    },
  };
}

void test("Simulator requires Admin auth and projects only the public control fields", async (context) => {
  const f = await fixture(context);
  const unauthorized = await f.request("/api/admin/simulation", undefined, { cookie: "" });
  assert.equal(unauthorized.status, 401);
  const pageUnauthorized = await f.request("/admin/simulator", undefined, { cookie: "" });
  assert.equal(pageUnauthorized.status, 303);
  assert.equal(pageUnauthorized.headers.location, "/admin/login");
  const response = await f.request("/api/admin/simulation");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(response.body), f.state);
  assert.doesNotMatch(response.body, new RegExp(secret, "u"));
  const page = await f.request("/admin/simulator");
  assert.equal(page.status, 200);
  assert.match(page.body, /SIMULATION/u);
  assert.match(page.body, /data-workspace-revision="1"/u);
  assert.match(page.body, /aria-current="page"[^>]*><span[^>]*>S<\/span><span[^>]*>Simulator/u);
  assert.match(page.body, /&lt;script&gt;/u);
  assert.doesNotMatch(page.body, /<script>alert/u);
  assert.doesNotMatch(page.body, new RegExp(secret, "u"));
  assert.match(page.body, /action="\/admin\/simulation\/pour" method="post"/u);
  assert.match(page.body, /name="confirm" value="yes" required/u);
  assert.match(page.body, /target="_blank" rel="noopener"/u);
});

void test("Simulator mutations reject Origin, session, CSRF, unknown fields and oversized forms", async (context) => {
  const f = await fixture(context);
  for (const headers of [
    { origin: undefined },
    { origin: "https://other.example" },
    { origin: "null" },
    { cookie: "" },
  ]) {
    const result = await f.request(
      "/admin/simulation/pour",
      { tapId: SENSOR_ID, ounces: "12" },
      { ...headers, accept: "application/json" },
    );
    assert.equal(result.status, 403);
    assert.match(result.body, /could not be authorized/u);
  }
  const invalidCsrf = await f.request(
    "/admin/simulation/pour",
    { _csrf: "wrong", tapId: SENSOR_ID, ounces: "12" },
    { accept: "application/json" },
  );
  assert.equal(invalidCsrf.status, 403);
  const unknown = await f.request(
    "/admin/simulation/pour",
    { tapId: SENSOR_ID, ounces: "12", destination: "https://other.example" },
    { accept: "application/json" },
  );
  assert.equal(unknown.status, 400);
  const duplicate = await f.request(
    "/admin/simulation/pour",
    `_csrf=${f.csrf}&tapId=${SENSOR_ID}&ounces=4&ounces=12`,
    { accept: "application/json" },
  );
  assert.equal(duplicate.status, 400);
  const oversized = await f.request(
    "/admin/simulation/pour",
    { tapId: "a".repeat(1_100), ounces: "12" },
    { accept: "application/json" },
  );
  assert.equal(oversized.status, 413);
  assert.equal(f.calls.length, 0);
});

void test("Simulator validates bounded pours and booleans while retaining no-JavaScript redirects", async (context) => {
  const f = await fixture(context);
  for (const ounces of ["0", "33", "Infinity", "1e1", "12.345", "", "-1"]) {
    const result = await f.request(
      "/admin/simulation/pour",
      { tapId: SENSOR_ID, ounces },
      { accept: "application/json" },
    );
    assert.equal(result.status, 400, ounces);
  }
  for (const [path, field] of [
    ["sensor", "online"],
    ["noise", "enabled"],
  ]) {
    const result = await f.request(
      `/admin/simulation/${path!}`,
      { tapId: SENSOR_ID, [field!]: "yes" },
      { accept: "application/json" },
    );
    assert.equal(result.status, 400);
  }
  assert.equal(f.calls.length, 0);
  for (const ounces of ["1", "12", "16.25", "32"]) {
    const result = await f.request("/admin/simulation/pour", { tapId: SENSOR_ID, ounces });
    assert.equal(result.status, 303);
    assert.match(String(result.headers.location), /^\/admin\/simulator\?notice=/u);
  }
  const sensor = await f.request(
    "/admin/simulation/sensor",
    { tapId: SENSOR_ID, online: "false" },
    { accept: "application/json" },
  );
  assert.equal(sensor.status, 200);
  assert.deepEqual(f.calls.at(-1), ["online", SENSOR_ID, false]);
  f.state.changing = true;
  const busy = await f.request(
    "/admin/simulation/pour",
    { tapId: SENSOR_ID, ounces: "12" },
    { accept: "application/json" },
  );
  assert.equal(busy.status, 409);
  f.state.changing = false;
  f.state.enabled = false;
  const disabled = await f.request(
    "/admin/simulation/noise",
    { tapId: SENSOR_ID, enabled: "true" },
    { accept: "application/json" },
  );
  assert.equal(disabled.status, 409);
});

void test("Workspace forms rotate session and CSRF cookies and require an explicit reset confirmation", async (context) => {
  const f = await fixture(context);
  const unconfirmed = await f.request("/admin/simulation/reset", {});
  assert.match(String(unconfirmed.headers.location), /\?error=/u);
  assert.equal(f.calls.length, 0);
  const reset = await f.request("/admin/simulation/reset", { confirm: "yes" });
  assert.equal(reset.status, 303);
  const cookies = reset.headers["set-cookie"];
  assert.ok(cookies !== undefined && typeof cookies !== "string");
  assert.equal(cookies.length, 2);
  assert.match(
    cookies[0]!,
    /^tapboard_admin_session=.+; HttpOnly; Path=\/; SameSite=Strict; Secure;/u,
  );
  assert.match(cookies[1]!, /^tapboard_admin_csrf=.+; Path=\/; SameSite=Strict; Secure;/u);
  const staleSession = await f.request("/admin/simulation/disable", {});
  assert.match(String(staleSession.headers.location), /could%20not%20be%20authorized/u);
  f.updateCookie(cookies.map((cookie) => cookie.split(";")[0]).join("; "));
  const staleForm = await f.request("/admin/simulation/disable", {});
  assert.match(String(staleForm.headers.location), /could%20not%20be%20authorized/u);
  const replacementCsrf = cookies[1]!.split(";")[0]!.split("=")[1]!;
  const exit = await f.request("/admin/simulation/disable", { _csrf: replacementCsrf });
  assert.match(String(exit.headers.location), /^\/admin\/system\?notice=/u);
  assert.deepEqual(f.calls, [["reset"], ["enabled", false]]);
});

void test("Simulator renders accurate stopped states and enables pouring only when ready", async (context) => {
  const f = await fixture(context);
  for (const [status, label] of [
    ["ready", "Ready"],
    ["settling", "Settling"],
    ["empty", "Empty"],
    ["unassigned", "No fill"],
    ["unavailable", "Retired"],
    ["stopped", "Stopped"],
    ["error", "Needs attention"],
  ]) {
    f.state.sensors[0] = { ...f.state.sensors[0]!, status: status! };
    const result = await f.request("/admin/simulator");
    assert.match(result.body, new RegExp(`data-sensor-status-label>${label!}<`, "u"));
    assert.equal(/data-pour-button disabled/u.test(result.body), status !== "ready");
  }
  f.state.enabled = false;
  const disabled = await f.request("/admin/simulator");
  assert.match(disabled.body, /Enable simulation/u);
  assert.doesNotMatch(disabled.body, /class="workspace-banner"/u);
  assert.doesNotMatch(disabled.body, /data-simulation-sensor=/u);
});

void test("Unexpected Simulator errors retain safe client messages and a diagnostic log", async (context) => {
  const f = await fixture(context);
  f.controller.pour = () => {
    throw new Error(secret);
  };
  const result = await f.request(
    "/admin/simulation/pour",
    { tapId: SENSOR_ID, ounces: "12" },
    { accept: "application/json" },
  );
  assert.equal(result.status, 500);
  assert.match(result.body, /could not be completed/u);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs.join("\n"), /admin\.simulation:\/admin\/simulation\/pour/u);
  assert.match(result.body, /Reference:/u);
  assert.doesNotMatch(result.body + f.logs.join("\n"), new RegExp(secret, "u"));
});
