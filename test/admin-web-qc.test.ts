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
const SESSION_ID = "session-qc";
const LINKED_BEVERAGE_ID = "beverage-qc";
const TAP_ID = "tap-qc";
const KEG_ID = "keg-qc";
const FILL_ID = "fill-qc";

const hostile = '<script>alert("hostile")</script>&';
const rawSourceSecret = "raw-source-secret-qc";
const recipeSecret = "recipe-secret-qc";
const sensorySecret = "sensory-secret-qc";

const session = {
  id: SESSION_ID,
  credentialRevision: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastUsedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-08-01T00:00:00.000Z",
  absoluteExpiresAt: "2027-08-01T00:00:00.000Z",
};

const linkedBeverageSummary = {
  beverage: {
    id: LINKED_BEVERAGE_ID,
    ownershipType: "brewfather",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  effectivePresentation: {
    name: hostile,
    beverageType: "beer",
    style: "Effective Style",
    abv: 6.2,
    ibu: null,
    og: null,
    fg: null,
    srm: null,
    displayColor: "#D97706",
    description: "Effective description",
    fillGlass: "secret-fill-glass",
    manualDensityOverride: null,
  },
  density: {
    densityGPerMl: 1,
    specificGravity: 1,
    source: "fallback_fg",
  },
};

const linkedBeverageDetail = {
  ...linkedBeverageSummary,
  brewfatherSourceProfile: {
    beverageId: LINKED_BEVERAGE_ID,
    name: hostile,
    beverageType: "beer",
    style: "Source Style",
    abv: 5.4,
    ibu: 44,
    og: 1.05,
    fg: 1.01,
    srm: 6,
    displayColor: "#123456",
    description: hostile,
    rawSourceJson: rawSourceSecret,
    sourceFingerprint: "fingerprint",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  presentationOverrides: {
    beverageId: LINKED_BEVERAGE_ID,
    overrideNamePresent: true,
    name: "Override Name",
    overrideBeverageTypePresent: false,
    beverageType: null,
    overrideStylePresent: true,
    style: null,
    overrideAbvPresent: true,
    abv: 6.2,
    overrideIbuPresent: true,
    ibu: 99,
    overrideOgPresent: false,
    og: null,
    overrideFgPresent: false,
    fg: null,
    overrideSrmPresent: false,
    srm: null,
    overrideDisplayColorPresent: false,
    displayColor: null,
    overrideDescriptionPresent: true,
    description: "Effective description",
    overrideFillGlassPresent: true,
    fillGlass: "secret-override-fill-glass",
    overrideManualDensityOverridePresent: true,
    manualDensityOverride: 1.01,
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  recipeSnapshot: { recipeJson: recipeSecret },
  sensoryOverrides: { bitterness: sensorySecret },
};

const tap = {
  id: TAP_ID,
  tapNumber: 3,
  name: "QC Tap",
  enabled: true,
  isRetired: false,
  isOccupied: false,
  firstUsedAt: null,
  retiredAt: null,
  gasType: "CO2 & <tag>",
  servingPressureKpa: 82.5,
  lineLengthMm: 1800,
  lineDiameterMm: 4,
  notes: "Line note & <tag>",
  activeAssignment: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const fill = {
  id: FILL_ID,
  beverageId: LINKED_BEVERAGE_ID,
  beverageName: "Historical Lager",
  beverageType: "beer",
  beverageStyle: "Lager",
  beverageAbv: 5,
  kegId: KEG_ID,
  kegNumber: 7,
  kegLabel: "QC Keg",
  fillDate: "2026-08-02",
  state: "ended",
  onDeckOrder: null,
  endedAt: "2026-08-03T00:00:00.000Z",
  endReason: "finished",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const keg = {
  id: KEG_ID,
  kegNumber: 7,
  label: "QC Keg",
  capacityMl: 19000,
  currentTareG: 1200,
  isActive: true,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function form(values: Readonly<Record<string, string>>, csrf = CSRF_TOKEN): URLSearchParams {
  const result = new URLSearchParams(values);
  if (csrf.length > 0) result.set("_csrf", csrf);
  return result;
}

void test("admin web pages and mutations keep projections safe and PRG-protected", async (context) => {
  const presentationCalls: Array<{ input: unknown; actor: unknown }> = [];
  const fillCalls: Array<{ input: unknown; actor: unknown }> = [];
  const tapUpdateCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const tapCreateCalls: Array<{ input: unknown; actor: unknown }> = [];

  const authService = {
    authenticateSession(token: string) {
      return token === SESSION_TOKEN ? session : undefined;
    },
    authorizeCookieMutation(input: {
      cookieHeader: string | readonly string[] | undefined;
      originHeader: string | readonly string[] | undefined | null;
      csrfHeader: string | readonly string[] | undefined | null;
    }) {
      return input.cookieHeader?.includes(`tapboard_admin_session=${SESSION_TOKEN}`) &&
        input.originHeader === ORIGIN &&
        input.csrfHeader === CSRF_TOKEN
        ? session
        : undefined;
    },
  };

  const fillService = {
    listFills(query?: unknown) {
      if (
        typeof query === "object" &&
        query !== null &&
        "state" in query &&
        query.state === "available"
      ) {
        return [];
      }
      return [fill];
    },
    createFill(input: unknown, actor: unknown) {
      fillCalls.push({ input, actor });
      return fill;
    },
  };

  const dependencies = {
    router: new Router(createLogger({ sink: () => undefined })),
    renderer: createRenderer(),
    canonicalOrigin: ORIGIN,
    authService,
    dashboardService: {
      getDashboard: () => ({}),
      getHeader: () => ({
        tapboardName: "QC Tapboard",
        connectivity: "healthy",
        connectivityLabel: "All systems operational",
      }),
      getDisplayDefaults: () => ({}),
      getOnDeck: () => ({}),
      getTap: () => undefined,
    },
    displayService: { getSettings: () => ({}) },
    beverageService: {
      listBeverages: () => [linkedBeverageSummary],
      getBeverage: () => linkedBeverageDetail,
      getDeletionImpact: () => ({ impacts: [] }),
      listCandidates: () => [],
      getBrewfatherStatus: () => ({
        configured: true,
        apiKeyConfigured: true,
        account: { enabled: true },
        totalLinkedBeverages: 1,
        totalCandidates: 0,
      }),
      updatePresentationOverrides(_id: unknown, input: unknown, actor: unknown) {
        presentationCalls.push({ input, actor });
      },
      createCustomBeverage: () => linkedBeverageDetail,
      updateCustomBeverage: () => linkedBeverageDetail,
      unlinkBeverage: () => linkedBeverageDetail,
      deleteBeverage: () => undefined,
      linkBrewfatherCandidate: () => linkedBeverageDetail,
    },
    kegService: {
      listKegs: () => [keg],
      getKeg: () => ({
        ...keg,
        tareHistory: [
          {
            previousTareG: 1100,
            newTareG: 1200,
            recordedAt: "2026-08-02T00:00:00.000Z",
            reason: "QC calibration",
          },
        ],
        maintenanceHistory: [],
      }),
      getDeletionImpact: () => ({ impacts: [] }),
    },
    fillService,
    tapService: {
      listTaps: () => [tap],
      getTap: () => tap,
      updateTap(id: unknown, input: unknown, actor: unknown) {
        tapUpdateCalls.push({ id, input, actor });
        return tap;
      },
      createTap(input: unknown, actor: unknown) {
        tapCreateCalls.push({ input, actor });
        return tap;
      },
    },
    telemetryService: {
      listSources: () => [],
      getTapAuthority: () => undefined,
    },
    detectorService: {
      getGlobalConfig: () => ({ config: DEFAULT_DETECTOR_CONFIG }),
      getTapOverride: () => undefined,
    },
    healthService: {
      listAdminOverview: () => [
        {
          tapId: TAP_ID,
          aggregate: { state: "healthy", severity: "none" },
        },
      ],
      getAdminOverview: () => ({ aggregate: { state: "healthy", severity: "none" } }),
      getEffectiveConfig: () => ({ effective: DEFAULT_HEALTH_CONFIG, override: null }),
    },
    liveUpdates: {
      connectPublic: () => undefined,
      connectAdmin: () => undefined,
      stats: () => ({ connected: 0 }),
    },
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
  const getHeaders = { cookie };

  for (const [path, heading] of [
    ["/admin/overview", "Overview"],
    ["/admin/beverages", "Beverages"],
    ["/admin/kegs", "Kegs"],
    ["/admin/taps", "Taps"],
  ] as const) {
    const response = await fetch(`${base}${path}`, { headers: getHeaders });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
  }

  const beverageResponse = await fetch(`${base}/admin/beverages`, { headers: getHeaders });
  const beverageHtml = await beverageResponse.text();
  assert.match(beverageHtml, /Source:/);
  assert.match(beverageHtml, /Effective:/);
  assert.match(beverageHtml, /Inherit \(source\)/);
  assert.match(beverageHtml, /Clear/);
  assert.match(beverageHtml, /Value \(override\)/);
  assert.match(beverageHtml, /Source: Source Style/);
  assert.match(beverageHtml, /Source: 5\.4%/);
  assert.match(beverageHtml, /Source: #123456/);
  assert.match(beverageHtml, /pattern="#\[0-9A-Fa-f\]\{6\}"/);
  assert.match(beverageHtml, /&lt;script&gt;/);
  assert.doesNotMatch(beverageHtml, /<script>/);
  for (const secret of [rawSourceSecret, recipeSecret, sensorySecret, "secret-fill-glass"])
    assert.doesNotMatch(beverageHtml, new RegExp(secret));
  assert.match(beverageHtml, /Fill Glass/);
  assert.match(beverageHtml, /Sensory guidance/);

  const kegHtml = await (await fetch(`${base}/admin/kegs`, { headers: getHeaders })).text();
  assert.match(kegHtml, /Fill history/);
  assert.match(kegHtml, /Historical Lager/);
  const tapHtml = await (await fetch(`${base}/admin/taps`, { headers: getHeaders })).text();
  assert.match(tapHtml, /CO2 &amp; &lt;tag&gt;/);
  assert.match(tapHtml, /Serving pressure \(kPa\)/);
  assert.match(tapHtml, /name="gasType"/);
  assert.match(tapHtml, /name="servingPressureKpa"/);
  assert.match(tapHtml, /name="lineLengthMm"/);
  assert.match(tapHtml, /name="lineDiameterMm"/);
  assert.match(tapHtml, /name="notes"/);

  async function post(path: string, values: Readonly<Record<string, string>>, csrf = CSRF_TOKEN) {
    return fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form(values, csrf),
    });
  }

  const presentationResponse = await post(`/admin/beverages/${LINKED_BEVERAGE_ID}/presentation`, {
    nameMode: "value",
    name: "Local Name",
    beverageTypeMode: "inherit",
    beverageType: "beer",
    styleMode: "clear",
    style: "ignored",
    abvMode: "value",
    abv: "6.4",
    displayColorMode: "inherit",
    displayColor: "#123456",
    descriptionMode: "value",
    description: "Local description",
  });
  assert.equal(presentationResponse.status, 303);
  assert.match(presentationResponse.headers.get("location") ?? "", /^\/admin\/beverages\?notice=/);
  assert.deepEqual(presentationCalls.at(-1), {
    input: {
      name: { value: "Local Name" },
      beverageType: { inherit: true },
      style: { clear: true },
      abv: { value: 6.4 },
      displayColor: { inherit: true },
      description: { value: "Local description" },
      fillGlass: { value: "" },
    },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const fillResponse = await post(`/admin/beverages/${LINKED_BEVERAGE_ID}/create-fill`, {
    kegId: KEG_ID,
    fillDate: "2026-08-10",
  });
  assert.equal(fillResponse.status, 303);
  assert.deepEqual(fillCalls.at(-1), {
    input: { beverageId: LINKED_BEVERAGE_ID, kegId: KEG_ID, fillDate: "2026-08-10" },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const tapUpdateResponse = await post(`/admin/taps/${TAP_ID}/update`, {
    tapNumber: "3",
    name: "QC Tap Updated",
    enabled: "true",
    gasType: "Nitrogen",
    servingPressureKpa: "83.5",
    lineLengthMm: "2000",
    lineDiameterMm: "5",
    notes: "Updated notes",
  });
  assert.equal(tapUpdateResponse.status, 303);
  assert.deepEqual(tapUpdateCalls.at(-1), {
    id: TAP_ID,
    input: {
      tapNumber: 3,
      name: "QC Tap Updated",
      enabled: true,
      gasType: "Nitrogen",
      servingPressureKpa: 83.5,
      lineLengthMm: 2000,
      lineDiameterMm: 5,
      notes: "Updated notes",
      acknowledgeTelemetryEndpointImpact: false,
    },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const tapCreateResponse = await post("/admin/taps/create", {
    tapNumber: "4",
    name: "Created Tap",
    enabled: "true",
    gasType: "CO2",
    servingPressureKpa: "80",
    lineLengthMm: "1600",
    lineDiameterMm: "4",
    notes: "Created notes",
  });
  assert.equal(tapCreateResponse.status, 303);
  assert.deepEqual(tapCreateCalls.at(-1), {
    input: {
      tapNumber: 4,
      name: "Created Tap",
      enabled: true,
      gasType: "CO2",
      servingPressureKpa: 80,
      lineLengthMm: 1600,
      lineDiameterMm: 4,
      notes: "Created notes",
    },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const callCounts = [
    presentationCalls.length,
    fillCalls.length,
    tapUpdateCalls.length,
    tapCreateCalls.length,
  ];
  for (const csrf of ["wrong-csrf", ""] as const) {
    for (const [path, values] of [
      [`/admin/beverages/${LINKED_BEVERAGE_ID}/presentation`, { nameMode: "inherit" }],
      [`/admin/beverages/${LINKED_BEVERAGE_ID}/create-fill`, { kegId: KEG_ID }],
      [`/admin/taps/${TAP_ID}/update`, { tapNumber: "3" }],
    ] as const) {
      const response = await post(path, values, csrf);
      assert.equal(response.status, 303, `${path} (${csrf === "" ? "missing" : "invalid"} CSRF)`);
    }
  }
  assert.deepEqual(
    [presentationCalls.length, fillCalls.length, tapUpdateCalls.length, tapCreateCalls.length],
    callCounts,
  );
});
