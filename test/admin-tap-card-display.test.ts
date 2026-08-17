import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HEALTH_CONFIG } from "../src/features/health/config.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createRenderer } from "../src/infrastructure/rendering/renderer.ts";
import { createLogger } from "../src/shared/logging.ts";
import { DEFAULT_DETECTOR_CONFIG } from "../src/features/telemetry/detector-config.ts";
import { registerWebRoutes, type WebRouteDependencies } from "../src/features/web/routes.ts";

const ORIGIN = "http://127.0.0.1:3000";
const SESSION_TOKEN = "s".repeat(43);
const CSRF_TOKEN = "c".repeat(43);
const SESSION_ID = "tap-card-session";
const TAP_ID = "00000000-0000-4000-8000-000000000001";

const session = {
  id: SESSION_ID,
  credentialRevision: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-08-01T00:00:00.000Z",
  absoluteExpiresAt: "2027-08-01T00:00:00.000Z",
};

function form(values: Readonly<Record<string, string>>, csrf = CSRF_TOKEN): URLSearchParams {
  const result = new URLSearchParams(values);
  if (csrf.length > 0) result.set("_csrf", csrf);
  return result;
}

const TEST_NAME = "admin Tap-card settings render and persist shared and tri-state Tap changes";

void test(TEST_NAME, async (context) => {
  const shared = {
    revision: 1,
    tapboardName: "Tapboard",
    theme: "modern_dark" as const,
    font: "system" as const,
    accent: "amber" as const,
    unitSystem: "us" as const,
    showServingTemperature: false,
    layoutMode: "scroll" as const,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  let tapCardSettings = {
    revision: 1,
    showAbv: true,
    showIbu: true,
    showOg: true,
    showFg: true,
    showSrm: false,
    remainingMode: "percent" as const,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  let tapOverride: {
    tapId: string;
    showAbv: boolean | null;
    showIbu: boolean | null;
    showOg: boolean | null;
    showFg: boolean | null;
    showSrm: boolean | null;
    updatedAt: string;
  } | null = {
    tapId: TAP_ID,
    showAbv: null,
    showIbu: false,
    showOg: true,
    showFg: null,
    showSrm: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const sharedCalls: unknown[] = [];
  const overrideCalls: unknown[] = [];

  const displayService = {
    getSettings: () => shared,
    updateSettings: () => shared,
    getTapCardSettings: () => tapCardSettings,
    updateTapCardSettings(input: unknown) {
      sharedCalls.push(input);
      const value = input as typeof tapCardSettings;
      tapCardSettings = {
        ...tapCardSettings,
        ...value,
        revision: tapCardSettings.revision + 1,
      };
      return tapCardSettings;
    },
    getTapCardOverride: () => tapOverride ?? undefined,
    setTapCardOverride(_tapId: unknown, input: unknown) {
      overrideCalls.push(input);
      const value = input as NonNullable<typeof tapOverride>;
      if (
        value.showAbv === null &&
        value.showIbu === null &&
        value.showOg === null &&
        value.showFg === null &&
        value.showSrm === null
      ) {
        tapOverride = null;
      } else {
        tapOverride = {
          tapId: TAP_ID,
          showAbv: value.showAbv,
          showIbu: value.showIbu,
          showOg: value.showOg,
          showFg: value.showFg,
          showSrm: value.showSrm,
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
      }
      return tapOverride ?? undefined;
    },
    clearTapCardOverride: () => true,
    getEffectiveTapCardSettings: () => ({
      tapId: TAP_ID,
      settings: {
        showAbv: tapOverride?.showAbv ?? tapCardSettings.showAbv,
        showIbu: tapOverride?.showIbu ?? tapCardSettings.showIbu,
        showOg: tapOverride?.showOg ?? tapCardSettings.showOg,
        showFg: tapOverride?.showFg ?? tapCardSettings.showFg,
        showSrm: tapOverride?.showSrm ?? tapCardSettings.showSrm,
        remainingMode: tapCardSettings.remainingMode,
      },
      override: tapOverride,
    }),
  };

  const dependencies = {
    router: new Router(createLogger({ sink: () => undefined })),
    renderer: createRenderer(),
    canonicalOrigin: ORIGIN,
    authService: {
      authenticateSession: (token: string) => (token === SESSION_TOKEN ? session : undefined),
      authorizeCookieMutation: (input: {
        cookieHeader: string | readonly string[] | undefined;
        originHeader: string | readonly string[] | undefined | null;
        csrfHeader: string | readonly string[] | undefined | null;
      }) =>
        input.cookieHeader?.includes(`tapboard_admin_session=${SESSION_TOKEN}`) &&
        input.originHeader === ORIGIN &&
        input.csrfHeader === CSRF_TOKEN
          ? session
          : undefined,
    },
    dashboardService: {
      getTap: () => ({
        id: "private-card-id",
        tapNumber: 1,
        tapName: "Private Tap identity",
        graphicId: "pint_glass",
        displayColor: "#D97706",
        beverageName: "Private Beverage identity",
        style: null,
        abv: null,
        metrics: [],
        description: null,
        title: "Mystery Tap",
        accessibleLabel: "Private Tap identity, Private Beverage identity",
        fillId: "private-fill-id",
        fillPercent: null,
        remainingVolumeMl: null,
        capacityMl: null,
        servingsRemaining: null,
        daysRemaining: null,
        temperatureC: null,
        waitingForMeasurement: true,
        health: "healthy" as const,
      }),
      getDisplayDefaults: () => ({ unitSystem: "us", remainingMode: "percent" }),
    },
    storyService: {},
    displayService,
    beverageService: {},
    kegService: {},
    fillService: { listFills: () => [] },
    tapService: {
      listTaps: () => [
        {
          id: TAP_ID,
          tapNumber: 1,
          name: "Main",
          enabled: true,
          isRetired: false,
          gasType: null,
          servingPressureKpa: null,
          lineLengthMm: null,
          lineDiameterMm: null,
          notes: null,
          activeAssignment: null,
          firstUsedAt: null,
          retiredAt: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      getTap: () => ({
        id: TAP_ID,
        tapNumber: 1,
        name: "Main",
        enabled: true,
        isRetired: false,
        isOccupied: true,
        firstUsedAt: null,
        retiredAt: null,
        gasType: null,
        servingPressureKpa: null,
        lineLengthMm: null,
        lineDiameterMm: null,
        notes: null,
        activeAssignment: {
          id: "assignment-mystery-card",
          fillId: "fill-mystery-card",
          beverageId: "beverage-mystery-card",
          beverageName: "Private Beverage identity",
          beverageType: "beer",
          beverageStyle: null,
          beverageAbv: null,
          kegId: "keg-mystery-card",
          kegNumber: 1,
          kegLabel: null,
          assignedAt: "2026-08-01T00:00:00.000Z",
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
      getAssignmentMystery: () => ({
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
      }),
    },
    telemetryService: { listSources: () => [], getTapAuthority: () => undefined },
    detectorService: {
      getGlobalConfig: () => ({ config: DEFAULT_DETECTOR_CONFIG }),
      getTapOverride: () => undefined,
    },
    healthService: {
      getEffectiveConfig: () => ({ effective: DEFAULT_HEALTH_CONFIG, override: null }),
      getAdminOverview: () => ({ aggregate: { state: "healthy" } }),
    },
    liveUpdates: { stats: () => ({ public: {}, admin: {} }) },
  } as unknown as WebRouteDependencies;

  registerWebRoutes(dependencies);
  const server = new HttpServer({
    router: dependencies.router,
    logger: createLogger({ sink: () => undefined }),
    shutdownGraceMs: 250,
  });
  context.after(() => server.stop());
  const address = await server.start("127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = `tapboard_admin_session=${SESSION_TOKEN}; tapboard_admin_csrf=${CSRF_TOKEN}`;
  const headers = { cookie };

  const displayResponse = await fetch(`${base}/admin/display/shared`, { headers });
  assert.equal(displayResponse.status, 200);
  const displayHtml = await displayResponse.text();
  assert.match(displayHtml, /Tap-card settings/);
  assert.match(displayHtml, /name="showAbv"[^>]*checked/);
  assert.match(displayHtml, /name="showSrm"/);
  assert.match(displayHtml, /Remaining display/);
  assert.match(displayHtml, /A Tap can override metric visibility/);

  const tapsResponse = await fetch(`${base}/admin/taps`, { headers });
  assert.equal(tapsResponse.status, 200);
  const tapsHtml = await tapsResponse.text();
  assert.match(tapsHtml, new RegExp(`href="/admin/taps/${TAP_ID}"[^>]*>Open<`));
  assert.doesNotMatch(tapsHtml, /Public card/);

  const tapDetailResponse = await fetch(`${base}/admin/taps/${TAP_ID}`, { headers });
  assert.equal(tapDetailResponse.status, 200);
  const tapDetailHtml = await tapDetailResponse.text();
  assert.match(tapDetailHtml, /Public display override/);
  assert.match(tapDetailHtml, /name="showIbu"/);
  assert.match(tapDetailHtml, /value="hide" selected/);
  assert.match(tapDetailHtml, /Remaining mode follows Display/);
  assert.match(tapDetailHtml, new RegExp(`action="/admin/taps/${TAP_ID}/display"`));
  const publicPreviewHtml = tapDetailHtml.match(
    /<section class="admin-card tap-public-preview"[\s\S]*?<\/section>/u,
  )?.[0];
  assert.ok(publicPreviewHtml);
  assert.match(publicPreviewHtml, /Mystery Tap/);
  assert.doesNotMatch(publicPreviewHtml, /Private Tap identity/);
  assert.doesNotMatch(publicPreviewHtml, /Private Beverage identity/);
  assert.doesNotMatch(publicPreviewHtml, /private-card-id/);
  assert.doesNotMatch(publicPreviewHtml, /private-fill-id/);

  async function post(path: string, values: Readonly<Record<string, string>>, csrf = CSRF_TOKEN) {
    return fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form(values, csrf),
    });
  }

  const sharedResponse = await post("/admin/display/tap-card", {
    expectedRevision: "1",
    showAbv: "true",
    showOg: "true",
    showFg: "true",
    remainingMode: "pours",
  });
  assert.equal(sharedResponse.status, 303);
  assert.match(sharedResponse.headers.get("location") ?? "", /^\/admin\/display\/shared\?notice=/u);
  assert.deepEqual(sharedCalls.at(-1), {
    expectedRevision: 1,
    showAbv: true,
    showIbu: false,
    showOg: true,
    showFg: true,
    showSrm: false,
    remainingMode: "pours",
  });

  const overrideResponse = await post(`/admin/taps/${TAP_ID}/display`, {
    showAbv: "inherit",
    showIbu: "show",
    showOg: "hide",
    showFg: "inherit",
    showSrm: "hide",
  });
  assert.equal(overrideResponse.status, 303);
  assert.match(
    overrideResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/taps/${TAP_ID}\\?notice=`),
  );
  assert.deepEqual(overrideCalls.at(-1), {
    showAbv: null,
    showIbu: true,
    showOg: false,
    showFg: null,
    showSrm: false,
  });

  const inheritResponse = await post(`/admin/taps/${TAP_ID}/display`, {
    showAbv: "inherit",
    showIbu: "inherit",
    showOg: "inherit",
    showFg: "inherit",
    showSrm: "inherit",
  });
  assert.equal(inheritResponse.status, 303);
  assert.deepEqual(overrideCalls.at(-1), {
    showAbv: null,
    showIbu: null,
    showOg: null,
    showFg: null,
    showSrm: null,
  });
  assert.equal(tapOverride, null);

  const callCounts = [sharedCalls.length, overrideCalls.length];
  for (const csrf of ["wrong-csrf", ""] as const) {
    const response = await post(
      "/admin/display/tap-card",
      {
        expectedRevision: String(tapCardSettings.revision),
        remainingMode: "percent",
      },
      csrf,
    );
    assert.equal(response.status, 303);
  }
  assert.deepEqual([sharedCalls.length, overrideCalls.length], callCounts);
});
