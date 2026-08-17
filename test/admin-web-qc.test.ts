import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
const CUSTOM_BEVERAGE_ID = "beverage-custom-qc";
const TAP_ID = "tap-qc";
const KEG_ID = "keg-qc";
const FILL_ID = "fill-qc";
const CREATED_TELEMETRY_TOKEN = "tbk_created_telemetry_qc";
const ROTATED_TELEMETRY_TOKEN = "tbk_rotated_telemetry_qc";

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
  sensoryOverrides: { bitterness: sensorySecret, sweetness: 8 },
};

const customRecipeForQc = {
  notes: "Mash | hold\n& <safe-note> café",
  ingredients: [
    {
      name: "Pale | malt\n二",
      amount: 4.5,
      unit: "kg | bag",
      note: "& <ingredient-note>",
    },
  ],
  steps: [
    {
      name: "Step | one\né",
      temperatureC: 66,
      timeMinutes: 60,
      note: "note & <step-note>",
    },
  ],
};

const customBeverageSummary = {
  ...linkedBeverageSummary,
  beverage: {
    ...linkedBeverageSummary.beverage,
    id: CUSTOM_BEVERAGE_ID,
    ownershipType: "custom",
  },
  effectivePresentation: {
    ...linkedBeverageSummary.effectivePresentation,
    name: "QC Custom Beverage",
  },
};

const customBeverageDetail = {
  ...customBeverageSummary,
  customRecipe: {
    id: "recipe-custom-qc",
    beverageId: CUSTOM_BEVERAGE_ID,
    ...customRecipeForQc,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ingredients: customRecipeForQc.ingredients.map((ingredient, index) => ({
      ...ingredient,
      id: `ingredient-${index}`,
      recipeId: "recipe-custom-qc",
      sortOrder: index,
    })),
    steps: customRecipeForQc.steps.map((step, index) => ({
      ...step,
      id: `step-${index}`,
      recipeId: "recipe-custom-qc",
      sortOrder: index,
    })),
  },
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

const retiredTap = {
  ...tap,
  id: "tap-retired-qc",
  tapNumber: 4,
  name: "Retired QC Tap",
  enabled: true,
  isRetired: true,
  retiredAt: "2026-08-02T00:00:00.000Z",
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

const availableFill = {
  ...fill,
  id: "fill-available-qc",
  beverageName: "Available Ale",
  state: "available",
  onDeckOrder: null,
  endedAt: null,
  endReason: null,
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const onDeckFill = {
  ...fill,
  id: "fill-on-deck-qc",
  beverageName: "Queued Pilsner",
  state: "on_deck",
  onDeckOrder: 1,
  endedAt: null,
  endReason: null,
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const onTapFill = {
  ...fill,
  id: "fill-on-tap-qc",
  beverageName: "Measured Stout",
  state: "on_tap",
  onDeckOrder: null,
  endedAt: null,
  endReason: null,
  updatedAt: "2026-08-02T00:00:00.000Z",
};

const publicTapCard = {
  id: TAP_ID,
  tapNumber: 3,
  tapName: "QC Tap",
  graphicId: "pint_glass",
  displayColor: "#D97706",
  beverageName: "Public projection name must not replace Admin identity",
  style: "Public projection style",
  abv: null,
  metrics: [],
  description: null,
  fillId: onTapFill.id,
  fillPercent: 63.2,
  remainingVolumeMl: null,
  capacityMl: null,
  servingsRemaining: null,
  daysRemaining: null,
  temperatureC: null,
  waitingForMeasurement: true,
  health: "healthy",
};

const normalMysteryNamedPreview = {
  ...publicTapCard,
  title: "Mystery Tap",
  beverageName: "Mystery Tap",
  style: "Normal-style-only",
  accessibleLabel: "Tap 3, Mystery Tap — normal beverage identity",
};
const redactedMysteryPreview = {
  ...normalMysteryNamedPreview,
  beverageName: "Secret Mystery Beverage",
  style: null,
};
let currentPublicPreview: typeof normalMysteryNamedPreview | typeof redactedMysteryPreview =
  normalMysteryNamedPreview;
let previewAssignment: unknown = null;
let previewMysteryEnabled = false;
let previewMysteryLookupThrows = false;

function activePreviewAssignment(id: string) {
  return {
    id,
    fillId: onTapFill.id,
    beverageId: onTapFill.beverageId,
    beverageName: onTapFill.beverageName,
    beverageType: onTapFill.beverageType,
    beverageStyle: onTapFill.beverageStyle,
    beverageAbv: onTapFill.beverageAbv,
    kegId: onTapFill.kegId,
    kegNumber: onTapFill.kegNumber,
    kegLabel: onTapFill.kegLabel,
    assignedAt: "2026-08-02T12:30:00.000Z",
  };
}

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
  const recipeCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const fillCalls: Array<{ input: unknown; actor: unknown }> = [];
  const fillDeleteCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const kegDeleteCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const tapDeleteCalls: Array<{
    id: unknown;
    confirmation: unknown;
    input: unknown;
    actor: unknown;
  }> = [];
  const tapGetCalls: unknown[] = [];
  const tapAssignCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const tapAutosaveCalls: Array<{
    id: unknown;
    updatedAt: unknown;
    input: unknown;
    actor: unknown;
  }> = [];
  const tapUpdateCalls: Array<{ id: unknown; input: unknown; actor: unknown }> = [];
  const tapCreateCalls: Array<{ input: unknown; actor: unknown }> = [];
  const telemetryDisableCalls: Array<{ id: unknown; actor: unknown }> = [];
  const telemetryPageCalls: Array<{ q: string; state: string; page: number }> = [];
  const telemetrySources = [
    {
      id: "telemetry-active-qc",
      name: "QC telemetry source",
      currentMachineKeyId: "machine-key-qc",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      disabledAt: null,
      currentMachineKey: {
        id: "machine-key-qc",
        publicId: "public-key-qc",
        label: "QC source key",
        createdAt: "2026-08-01T00:00:00.000Z",
        revokedAt: null,
      },
    },
    {
      id: "telemetry-disabled-qc",
      name: "Disabled QC source",
      currentMachineKeyId: "machine-key-disabled-qc",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      disabledAt: "2026-08-02T00:00:00.000Z",
      currentMachineKey: {
        id: "machine-key-disabled-qc",
        publicId: "disabled-key-qc",
        label: "Disabled source key",
        createdAt: "2026-08-01T00:00:00.000Z",
        revokedAt: "2026-08-02T00:00:00.000Z",
      },
    },
  ];

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
      if (typeof query === "object" && query !== null && ("state" in query || "kegId" in query)) {
        if ("state" in query && query.state === "available") return [availableFill];
        if ("state" in query && query.state === "on_deck") return [onDeckFill];
        return [fill];
      }
      return [fill, availableFill, onDeckFill, onTapFill];
    },
    getFill(id: string) {
      return [fill, availableFill, onDeckFill, onTapFill].find((item) => item.id === id) ?? fill;
    },
    createFill(input: unknown, actor: unknown) {
      fillCalls.push({ input, actor });
      return fill;
    },
    deleteFill(id: unknown, input: unknown, actor: unknown) {
      fillDeleteCalls.push({ id, input, actor });
      const confirmation =
        typeof input === "object" && input !== null && "confirmation" in input
          ? (input as { readonly confirmation?: unknown }).confirmation
          : undefined;
      if (confirmation !== "Historical Lager — Keg 7 — QC Keg") {
        throw new Error("confirmation mismatch");
      }
      return { fillId: id };
    },
  };

  const dependencies = {
    router: new Router(createLogger({ sink: () => undefined })),
    renderer: createRenderer(),
    canonicalOrigin: ORIGIN,
    authService,
    dashboardService: {
      getDashboard: () => ({}),
      listTaps: () => [publicTapCard],
      getHeader: () => ({
        tapboardName: "QC Tapboard",
        connectivity: "healthy",
        connectivityLabel: "All systems operational",
      }),
      getDisplayDefaults: () => ({}),
      getOnDeck: () => ({}),
      getTap: () => currentPublicPreview,
    },
    displayService: { getSettings: () => ({}) },
    beverageService: {
      listBeverages: () => [linkedBeverageSummary, customBeverageSummary],
      listBeveragePage: () => ({
        items: [linkedBeverageSummary, customBeverageSummary],
        total: 2,
        page: 1,
        pageSize: 25,
        pageCount: 1,
        query: "",
      }),
      getBeverage: (id: string) =>
        id === CUSTOM_BEVERAGE_ID ? customBeverageDetail : linkedBeverageDetail,
      getBeverageUsage: () => ({ current: 1, total: 2 }),
      getDeletionImpact: () => ({ impacts: [] }),
      listCandidates: () => [],
      getBrewfatherStatus: () => ({
        configured: true,
        apiKeyConfigured: true,
        account: { enabled: true },
        totalLinkedBeverages: 1,
        totalCandidates: 0,
        lastDataUpdateAt: "2026-08-03T00:00:00.000Z",
      }),
      updatePresentationOverrides(_id: unknown, input: unknown, actor: unknown) {
        presentationCalls.push({ input, actor });
      },
      createCustomBeverage: () => linkedBeverageDetail,
      updateCustomBeverage(id: unknown, input: unknown, actor: unknown) {
        recipeCalls.push({ id, input, actor });
        return customBeverageDetail;
      },
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
      deleteKeg(id: unknown, input: unknown, actor: unknown) {
        kegDeleteCalls.push({ id, input, actor });
        const confirmation =
          typeof input === "object" && input !== null && "confirmation" in input
            ? (input as { readonly confirmation?: unknown }).confirmation
            : undefined;
        if (confirmation !== "Keg 7 — QC Keg") throw new Error("confirmation mismatch");
        return { kegId: id };
      },
    },
    fillService,
    tapService: {
      listTaps: () => [tap, retiredTap],
      getTap(id: unknown) {
        tapGetCalls.push(id);
        return { ...tap, activeAssignment: previewAssignment };
      },
      getAssignmentMystery: () => {
        if (previewMysteryLookupThrows) throw new Error("mystery lookup unavailable");
        return {
          enabled: previewMysteryEnabled,
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
        };
      },
      getTapDeletionImpact: () => ({
        tapId: TAP_ID,
        tapNumber: 3,
        canDelete: true,
        reasonsCannotDelete: [],
        firstUsedAt: null,
        retiredAt: null,
        activeAssignmentCount: 0,
        historicalAssignmentCount: 0,
        impacts: [{ code: "taps", count: 1 }],
      }),
      deleteTapConfirmed(id: unknown, confirmation: unknown, input: unknown, actor: unknown) {
        tapDeleteCalls.push({ id, confirmation, input, actor });
        if (confirmation !== "Tap 3 — QC Tap") throw new Error("confirmation mismatch");
      },
      assignFill(id: unknown, input: unknown, actor: unknown) {
        tapAssignCalls.push({ id, input, actor });
        return { tap, assignment: input };
      },
      autosaveName(id: unknown, updatedAt: unknown, input: unknown, actor: unknown) {
        tapAutosaveCalls.push({ id, updatedAt, input, actor });
        return { ...tap, name: (input as { readonly name?: string | null }).name };
      },
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
      listSources: () => telemetrySources,
      listAdminSourcePage(input: { q: string; state: string; page: number }) {
        telemetryPageCalls.push(input);
        const items = telemetrySources.filter((source) =>
          input.state === "disabled" ? source.disabledAt !== null : source.disabledAt === null,
        );
        return {
          items,
          total: 50,
          page: input.page,
          pageSize: 25,
          pageCount: 2,
          query: input.q,
          state: input.state,
        };
      },
      getTapAuthority: () => undefined,
      createSource(input: unknown, _actor: unknown) {
        const values = input as { readonly name?: string; readonly label?: string };
        const source = telemetrySources[0]!;
        return {
          source: {
            ...source,
            id: "telemetry-created-qc",
            name: values.name ?? "Created telemetry source",
            currentMachineKey: {
              ...source.currentMachineKey,
              label: values.label ?? "Created key",
            },
          },
          initialToken: CREATED_TELEMETRY_TOKEN,
        };
      },
      rotateSourceKey(_id: unknown, _input: unknown, _actor: unknown) {
        return {
          source: telemetrySources[0],
          replacementToken: ROTATED_TELEMETRY_TOKEN,
        };
      },
      disableSource(id: unknown, actor: unknown) {
        telemetryDisableCalls.push({ id, actor });
      },
    },
    detectorService: {
      getGlobalConfig: () => ({ config: DEFAULT_DETECTOR_CONFIG }),
      getTapOverride: () => undefined,
    },
    healthService: {
      listAdminOverview: () => [
        {
          tapId: TAP_ID,
          aggregate: { state: "degraded", severity: "warning" },
          checks: [
            { checkId: "low_keg", state: "degraded", severity: "warning", reason: "Low fill" },
          ],
        },
      ],
      getAdminOverview: () => ({ aggregate: { state: "healthy", severity: "none" } }),
      getEffectiveConfig: () => ({ effective: DEFAULT_HEALTH_CONFIG, override: null }),
    },
    tapWarsService: {
      getCurrentUnfinished: () => undefined,
      getPublishedResult: () => undefined,
      listCompletedHistory: () => [],
      listEligibleParticipants: () => [],
    },
    publicTapWarsService: {
      getVisible: () => null,
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

  const overviewResponse = await fetch(`${base}/admin/overview`, { headers: getHeaders });
  assert.equal(overviewResponse.status, 200);
  const overviewHtml = await overviewResponse.text();
  assert.ok(
    overviewHtml.indexOf('id="quick-actions-heading"') <
      overviewHtml.indexOf('id="attention-heading"'),
  );
  assert.match(overviewHtml, /Low keg level/);
  assert.doesNotMatch(overviewHtml, />low_keg</u);
  assert.match(
    overviewHtml,
    /Retired QC Tap[\s\S]*?status-badge status-badge--muted">Retired<[\s\S]*?<td>Hidden<\/td>/u,
  );

  const integrationsResponse = await fetch(`${base}/admin/integrations`, { headers: getHeaders });
  assert.equal(integrationsResponse.status, 200);
  const integrationsHtml = await integrationsResponse.text();
  assert.match(integrationsHtml, /href="\/admin\/integrations\/brewfather"/);
  assert.match(integrationsHtml, /href="\/admin\/integrations\/telemetry"/);
  assert.doesNotMatch(integrationsHtml, /Quick actions|Save Brewfather configuration/);
  assert.doesNotMatch(integrationsHtml, /tbk_/);

  const brewfatherResponse = await fetch(`${base}/admin/integrations/brewfather`, {
    headers: getHeaders,
  });
  assert.equal(brewfatherResponse.status, 200);
  const brewfatherHtml = await brewfatherResponse.text();
  assert.match(brewfatherHtml, /Last data update:/);
  assert.match(
    brewfatherHtml,
    /datetime="2026-08-03T00:00:00\.000Z">Aug 3, 2026, 12:00 AM UTC<\/time>/,
  );

  const telemetryResponse = await fetch(`${base}/admin/integrations/telemetry`, {
    headers: getHeaders,
  });
  assert.equal(telemetryResponse.status, 200);
  const telemetryHtml = await telemetryResponse.text();
  assert.match(telemetryHtml, /Active sources/);
  assert.match(telemetryHtml, /Disabled source history/);
  assert.match(telemetryHtml, /QC telemetry source/);
  assert.match(telemetryHtml, /Disabled QC source/);
  assert.match(telemetryHtml, /Create a source and copy the machine key shown once/);
  assert.match(telemetryHtml, /assign the source to a Tap/i);
  assert.match(telemetryHtml, /POST \/api\/v1\/telemetry\/taps\/\{tapNumber\}/);
  assert.match(
    telemetryHtml,
    /datetime="2026-08-01T00:00:00\.000Z">Aug 1, 2026, 12:00 AM UTC<\/time>/,
  );
  assert.doesNotMatch(telemetryHtml, /2026-08-01T00:00:00\.000Z<\/time>/);
  assert.doesNotMatch(telemetryHtml, /tbk_/);

  const telemetryPagedResponse = await fetch(
    `${base}/admin/integrations/telemetry?q=QC&activePage=2&historyPage=2`,
    { headers: getHeaders },
  );
  assert.equal(telemetryPagedResponse.status, 200);
  const telemetryPagedHtml = await telemetryPagedResponse.text();
  assert.match(
    telemetryPagedHtml,
    /href="\/admin\/integrations\/telemetry\?q=QC&activePage=1&historyPage=2"/,
  );
  assert.match(
    telemetryPagedHtml,
    /href="\/admin\/integrations\/telemetry\?q=QC&historyPage=1&activePage=2"/,
  );
  assert.deepEqual(telemetryPageCalls.slice(-2), [
    { q: "QC", state: "active", page: 2 },
    { q: "QC", state: "disabled", page: 2 },
  ]);

  const sourceResponse = await fetch(
    `${base}/admin/integrations/telemetry-sources/telemetry-active-qc`,
    { headers: getHeaders },
  );
  assert.equal(sourceResponse.status, 200);
  const sourceHtml = await sourceResponse.text();
  assert.match(sourceHtml, /Rotate key and show replacement once/);
  assert.match(sourceHtml, /Disable source/);
  assert.match(sourceHtml, /Key ID \(audit reference\)/);
  assert.match(sourceHtml, /not sent in the URL or request/);
  assert.match(sourceHtml, /POST \/api\/v1\/telemetry\/taps\/\{tapNumber\}/);
  assert.match(
    sourceHtml,
    /datetime="2026-08-01T00:00:00\.000Z">Aug 1, 2026, 12:00 AM UTC<\/time>/,
  );
  assert.doesNotMatch(sourceHtml, /tbk_/);

  const tokenInAttribute = (html: string, token: string): boolean =>
    new RegExp(`<[^>]*\\s[^=\\s>]+="[^"]*${token}`).test(html);
  const createdKeyResponse = await fetch(`${base}/admin/integrations/telemetry-sources/create`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: form({ name: "Created telemetry source", label: "Created key" }),
  });
  assert.equal(createdKeyResponse.status, 200);
  assert.equal(createdKeyResponse.headers.get("location"), null);
  const createdKeyHtml = await createdKeyResponse.text();
  assert.match(createdKeyHtml, new RegExp(CREATED_TELEMETRY_TOKEN));
  assert.match(createdKeyHtml, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/telemetry\/taps\/1/);
  assert.match(createdKeyHtml, /client_sample_id/);
  assert.match(createdKeyHtml, /total_weight/);
  assert.doesNotMatch(createdKeyHtml, new RegExp(`Location[^\n]*${CREATED_TELEMETRY_TOKEN}`));
  assert.equal(tokenInAttribute(createdKeyHtml, CREATED_TELEMETRY_TOKEN), false);

  const rotatedKeyResponse = await fetch(
    `${base}/admin/integrations/telemetry-sources/telemetry-active-qc/rotate`,
    {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({ label: "Rotated key" }),
    },
  );
  assert.equal(rotatedKeyResponse.status, 200);
  assert.equal(rotatedKeyResponse.headers.get("location"), null);
  const rotatedKeyHtml = await rotatedKeyResponse.text();
  assert.match(rotatedKeyHtml, new RegExp(ROTATED_TELEMETRY_TOKEN));
  assert.match(rotatedKeyHtml, /http:\/\/127\.0\.0\.1:3000\/api\/v1\/telemetry\/taps\/1/);
  assert.doesNotMatch(rotatedKeyHtml, new RegExp(`Location[^\n]*${ROTATED_TELEMETRY_TOKEN}`));
  assert.equal(tokenInAttribute(rotatedKeyHtml, ROTATED_TELEMETRY_TOKEN), false);

  const disabledResponse = await fetch(
    `${base}/admin/integrations/telemetry-sources/telemetry-disabled-qc`,
    { headers: getHeaders },
  );
  assert.equal(disabledResponse.status, 200);
  const disabledHtml = await disabledResponse.text();
  assert.match(disabledHtml, /Immutable history/);
  assert.doesNotMatch(disabledHtml, /Rotate key/);
  assert.doesNotMatch(disabledHtml, /Disable source/);

  const disableResponse = await fetch(
    `${base}/admin/integrations/telemetry-sources/telemetry-active-qc/disable`,
    {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form({}),
    },
  );
  assert.equal(disableResponse.status, 303);
  assert.match(
    disableResponse.headers.get("location") ?? "",
    /^\/admin\/integrations\/telemetry\?notice=/,
  );
  assert.deepEqual(telemetryDisableCalls, [
    { id: "telemetry-active-qc", actor: { actorType: "admin", sessionId: SESSION_ID } },
  ]);

  const newTapResponse = await fetch(`${base}/admin/taps/new`, { headers: getHeaders });
  assert.equal(newTapResponse.status, 200);
  const newTapHtml = await newTapResponse.text();
  assert.match(newTapHtml, /<h1>New Tap<\/h1>/);
  assert.match(newTapHtml, /action="\/admin\/taps\/create"/);
  assert.doesNotMatch(newTapHtml, /Tap 3 — QC Tap/);
  assert.equal(tapGetCalls.includes("new"), false);

  const tapDetailResponse = await fetch(`${base}/admin/taps/${TAP_ID}`, { headers: getHeaders });
  assert.equal(tapDetailResponse.status, 200);
  const tapDetailHtml = await tapDetailResponse.text();
  assert.match(tapDetailHtml, /<h1>Tap 3 — QC Tap<\/h1>/);
  assert.match(tapDetailHtml, /Identity and lifecycle/);
  assert.match(tapDetailHtml, /name="updatedAt"/);
  assert.match(tapDetailHtml, /Telemetry authority/);
  assert.match(tapDetailHtml, /Mystery Tap reveal fields/);
  assert.match(tapDetailHtml, /Permanent deletion/);
  assert.match(tapDetailHtml, /class="admin-table admin-detail-table"/);
  assert.match(tapDetailHtml, /<th scope="col">First used<\/th>/);
  assert.match(tapDetailHtml, /<td>Never<\/td>/);
  assert.match(tapDetailHtml, /Aug 1, 2026, 12:00 AM UTC/);
  assert.match(tapDetailHtml, /Detection start/);
  assert.match(tapDetailHtml, /Candidate loss \(mL\)/);
  assert.match(tapDetailHtml, /Low keg level/);
  assert.match(tapDetailHtml, /Inherited: 23\.66 mL/);
  assert.doesNotMatch(tapDetailHtml, />candidateLossMl</u);
  assert.doesNotMatch(tapDetailHtml, />low_keg</u);
  assert.match(tapDetailHtml, /href="\/assets\/css\/dashboard\.css"/);
  assert.match(tapDetailHtml, /Available Ale/);
  assert.match(tapDetailHtml, /Queued Pilsner/);

  previewAssignment = activePreviewAssignment("assignment-normal-qc");
  previewMysteryEnabled = false;
  currentPublicPreview = normalMysteryNamedPreview;
  const normalNamedTapDetailResponse = await fetch(`${base}/admin/taps/${TAP_ID}`, {
    headers: getHeaders,
  });
  assert.equal(normalNamedTapDetailResponse.status, 200);
  const normalNamedTapDetailHtml = await normalNamedTapDetailResponse.text();
  assert.match(normalNamedTapDetailHtml, /Normal-style-only/);
  assert.match(normalNamedTapDetailHtml, /normal beverage identity/);
  assert.match(normalNamedTapDetailHtml, /href="\/admin\/keg-room\/fills\/fill-on-tap-qc"/);
  assert.match(normalNamedTapDetailHtml, /href="\/admin\/keg-room\/kegs\/keg-qc"/);
  assert.match(normalNamedTapDetailHtml, /Aug 2, 2026, 12:30 PM UTC/);

  previewAssignment = activePreviewAssignment("assignment-mystery-qc");
  previewMysteryEnabled = true;
  currentPublicPreview = redactedMysteryPreview;
  const mysteryTapDetailResponse = await fetch(`${base}/admin/taps/${TAP_ID}`, {
    headers: getHeaders,
  });
  assert.equal(mysteryTapDetailResponse.status, 200);
  const mysteryTapDetailHtml = await mysteryTapDetailResponse.text();
  assert.match(mysteryTapDetailHtml, /Mystery Tap/);
  assert.doesNotMatch(mysteryTapDetailHtml, /Secret Mystery Beverage/);
  assert.doesNotMatch(mysteryTapDetailHtml, /normal beverage identity/);

  previewMysteryLookupThrows = true;
  currentPublicPreview = redactedMysteryPreview;
  const mysteryLookupFailureResponse = await fetch(`${base}/admin/taps/${TAP_ID}`, {
    headers: getHeaders,
  });
  assert.equal(mysteryLookupFailureResponse.status, 200);
  const mysteryLookupFailureHtml = await mysteryLookupFailureResponse.text();
  assert.match(
    mysteryLookupFailureHtml,
    /No public card is available for this disabled, retired, or unassigned Tap\./u,
  );
  assert.doesNotMatch(mysteryLookupFailureHtml, /class="tap-card"/u);
  assert.doesNotMatch(mysteryLookupFailureHtml, /Secret Mystery Beverage/u);
  assert.doesNotMatch(mysteryLookupFailureHtml, /normal beverage identity/u);

  currentPublicPreview = normalMysteryNamedPreview;
  previewAssignment = null;
  previewMysteryEnabled = false;
  previewMysteryLookupThrows = false;

  const canonicalKegRoom = await fetch(`${base}/admin/keg-room`, { headers: getHeaders });
  assert.equal(canonicalKegRoom.status, 200);
  const kegRoomHtml = await canonicalKegRoom.text();
  assert.match(kegRoomHtml, /<h1>Keg Room<\/h1>/);
  assert.match(kegRoomHtml, /action="\/admin\/fills\/fill-on-deck-qc\/move"/);
  assert.match(kegRoomHtml, /Move up/);
  assert.match(kegRoomHtml, /Move down/);
  assert.match(kegRoomHtml, /class="admin-table keg-room-table"/);
  assert.match(kegRoomHtml, /<tbody data-reorder-list>/);
  assert.match(kegRoomHtml, /action="\/admin\/fills\/reorder-on-deck"/);
  assert.match(kegRoomHtml, /name="fillIds"/);
  const adminShellSource = await readFile(
    new URL("../public/js/admin-shell.js", import.meta.url),
    "utf8",
  );
  assert.match(adminShellSource, /const list = queue\.querySelector\("\[data-reorder-list\]"\)/);
  assert.match(adminShellSource, /list\.insertBefore\(/);
  assert.match(adminShellSource, /\.join\(","\)/);
  assert.doesNotMatch(adminShellSource, /item\.draggable\s*=\s*true/);
  assert.match(kegRoomHtml, /href="\/admin\/keg-room\/fills\/fill-on-tap-qc"/);
  assert.match(kegRoomHtml, /Measured Stout/);
  assert.doesNotMatch(kegRoomHtml, /Public projection name must not replace Admin identity/);
  assert.match(kegRoomHtml, /Waiting for measurement/);
  assert.match(kegRoomHtml, /data-fill-id="fill-available-qc"[\s\S]*?data-fill-percent="100"/);
  assert.match(kegRoomHtml, /data-fill-id="fill-on-deck-qc"[\s\S]*?data-fill-percent="100"/);
  assert.match(kegRoomHtml, /data-fill-id="fill-on-tap-qc"[\s\S]*?data-fill-percent="63\.2"/);
  const historyKegRoom = await fetch(`${base}/admin/keg-room?state=ended`, { headers: getHeaders });
  assert.equal(historyKegRoom.status, 200);
  const historyKegRoomHtml = await historyKegRoom.text();
  assert.match(historyKegRoomHtml, /data-fill-id="fill-qc"[\s\S]*?data-fill-percent="0"/);

  for (const [path, heading] of [
    ["/admin/keg-room/kegs", "Kegs"],
    ["/admin/keg-room/kegs/new", "Add a Physical Keg"],
    ["/admin/keg-room/fills/new", "Fill a Keg"],
    [`/admin/keg-room/kegs/${KEG_ID}`, "Keg 7"],
    [`/admin/keg-room/fills/${FILL_ID}`, "Filled Keg"],
  ] as const) {
    const response = await fetch(`${base}${path}`, { headers: getHeaders });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
  }

  for (const [path, destination] of [
    ["/admin/fills", "/admin/keg-room"],
    ["/admin/kegs", "/admin/keg-room/kegs"],
  ] as const) {
    const response = await fetch(`${base}${path}`, {
      headers: getHeaders,
      redirect: "manual",
    });
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("location"), destination);
  }

  const beverageResponse = await fetch(`${base}/admin/beverages`, { headers: getHeaders });
  const beverageHtml = await beverageResponse.text();
  assert.match(beverageHtml, /Beverage library/);
  assert.match(beverageHtml, /QC Custom Beverage/);
  assert.match(beverageHtml, /Current use/);
  assert.match(beverageHtml, /href="\/admin\/beverages\/beverage-qc"/);
  assert.match(beverageHtml, /href="\/admin\/beverages\/new"/);
  assert.doesNotMatch(beverageHtml, new RegExp(rawSourceSecret));

  const newBeverageHtml = await (
    await fetch(`${base}/admin/beverages/new`, { headers: getHeaders })
  ).text();
  assert.match(newBeverageHtml, /<h1>New beverage<\/h1>/);
  assert.match(newBeverageHtml, /action="\/admin\/beverages\/create"/);

  const detailResponse = await fetch(`${base}/admin/beverages/${LINKED_BEVERAGE_ID}`, {
    headers: getHeaders,
  });
  assert.equal(detailResponse.status, 200);
  const detailHtml = await detailResponse.text();
  assert.match(detailHtml, /Brewfather presentation/);
  assert.match(detailHtml, /Source:<\/strong> Source Style/);
  assert.match(detailHtml, /Reset to inherited/);
  assert.match(detailHtml, /Override/);
  assert.match(detailHtml, /Source:<\/strong> 5\.4%/);
  assert.match(detailHtml, /Source:<\/strong> #123456/);
  assert.match(detailHtml, /name="confirmationName"/);
  assert.match(detailHtml, /name="updatedAt"/);
  assert.match(detailHtml, /data-beverage-updated-at=/);
  assert.match(detailHtml, /&lt;script&gt;/);
  assert.doesNotMatch(detailHtml, /<script>/);
  for (const secret of [rawSourceSecret, recipeSecret, sensorySecret, "secret-fill-glass"])
    assert.doesNotMatch(detailHtml, new RegExp(secret));

  const kegDetailHtml = await (
    await fetch(`${base}/admin/keg-room/kegs/${KEG_ID}`, { headers: getHeaders })
  ).text();
  assert.match(kegDetailHtml, /readonly value="Keg 7 — QC Keg"/);
  const fillDetailHtml = await (
    await fetch(`${base}/admin/keg-room/fills/${FILL_ID}`, { headers: getHeaders })
  ).text();
  assert.match(fillDetailHtml, /readonly value="Historical Lager — Keg 7 — QC Keg"/);

  const kegHtml = await (await fetch(`${base}/admin/kegs`, { headers: getHeaders })).text();
  assert.match(kegHtml, /Fill history/);
  assert.match(kegHtml, /href="\/admin\/keg-room\/fills\/fill-qc">1 fill record<\/a>/);
  assert.match(kegHtml, /class="admin-table keg-inventory-table"/);
  assert.match(kegHtml, /href="\/admin\/keg-room\/kegs\/keg-qc"/);
  assert.doesNotMatch(kegHtml, /class="resource-card keg-inventory-card"/);
  const tapHtml = await (await fetch(`${base}/admin/taps`, { headers: getHeaders })).text();
  assert.match(tapHtml, /class="admin-table tap-list"/);
  assert.match(tapHtml, /Tap 3 — QC Tap/);
  assert.match(tapHtml, /Open/);
  assert.doesNotMatch(tapHtml, /class="resource-card tap-list-card"/);
  const tapWarsResponse = await fetch(`${base}/admin/tap-wars`, { headers: getHeaders });
  assert.equal(tapWarsResponse.status, 200);
  const tapWarsHtml = await tapWarsResponse.text();
  assert.match(tapWarsHtml, /Start a Tap War/);
  assert.match(tapWarsHtml, /data-tap-wars-start/);
  assert.match(tapWarsHtml, /data-tap-wars-selector="1"[^>]*disabled/);
  assert.match(tapWarsHtml, /data-tap-wars-selector="2"[^>]*disabled/);
  assert.match(tapWarsHtml, /data-tap-wars-start-submit[^>]*disabled/);
  assert.match(tapWarsHtml, /href="\/admin\/keg-room"/);
  assert.match(tapWarsHtml, /href="\/admin\/taps"/);
  assert.doesNotMatch(tapHtml, /name="gasType"/);
  assert.doesNotMatch(tapHtml, /href="\/assets\/css\/dashboard\.css"/);
  assert.match(tapDetailHtml, /CO2 &amp; &lt;tag&gt;/);
  assert.match(tapDetailHtml, /Serving pressure \(kPa\)/);
  assert.match(tapDetailHtml, /name="gasType"/);
  assert.match(tapDetailHtml, /name="servingPressureKpa"/);
  assert.match(tapDetailHtml, /name="lineLengthMm"/);
  assert.match(tapDetailHtml, /name="lineDiameterMm"/);
  assert.match(tapDetailHtml, /name="notes"/);
  assert.match(tapDetailHtml, /readonly value="Tap 3 — QC Tap"/);

  async function post(path: string, values: Readonly<Record<string, string>>, csrf = CSRF_TOKEN) {
    return fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form(values, csrf),
    });
  }

  const tapNameResponse = await post(`/admin/taps/${TAP_ID}/update`, {
    updatedAt: tap.updatedAt,
    name: "No-JS Tap Name",
  });
  assert.equal(tapNameResponse.status, 303);
  assert.match(
    tapNameResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/taps/${TAP_ID}\\?notice=`),
  );
  assert.deepEqual(tapAutosaveCalls.at(-1), {
    id: TAP_ID,
    updatedAt: tap.updatedAt,
    input: { name: "No-JS Tap Name" },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });
  assert.equal(tapUpdateCalls.length, 0);

  const missingFillConfirmation = await post(`/admin/fills/${FILL_ID}/delete`, {
    reason: "QC delete",
  });
  assert.equal(missingFillConfirmation.status, 303);
  assert.match(missingFillConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(fillDeleteCalls.length, 0);

  const mismatchedFillConfirmation = await post(`/admin/fills/${FILL_ID}/delete`, {
    confirmation: "Wrong visible label",
    reason: "QC delete",
  });
  assert.equal(mismatchedFillConfirmation.status, 303);
  assert.match(mismatchedFillConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(fillDeleteCalls.length, 1);

  const acceptedFillConfirmation = await post(`/admin/fills/${FILL_ID}/delete`, {
    confirmation: "Historical Lager — Keg 7 — QC Keg",
    reason: "QC delete",
  });
  assert.equal(acceptedFillConfirmation.status, 303);
  assert.match(acceptedFillConfirmation.headers.get("location") ?? "", /notice=/);

  const missingKegConfirmation = await post(`/admin/kegs/${KEG_ID}/delete`, {
    reason: "QC delete",
  });
  assert.equal(missingKegConfirmation.status, 303);
  assert.match(missingKegConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(kegDeleteCalls.length, 0);

  const mismatchedKegConfirmation = await post(`/admin/kegs/${KEG_ID}/delete`, {
    confirmation: "Wrong visible label",
    reason: "QC delete",
  });
  assert.equal(mismatchedKegConfirmation.status, 303);
  assert.match(mismatchedKegConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(kegDeleteCalls.length, 1);

  const acceptedKegConfirmation = await post(`/admin/kegs/${KEG_ID}/delete`, {
    confirmation: "Keg 7 — QC Keg",
    reason: "QC delete",
  });
  assert.equal(acceptedKegConfirmation.status, 303);
  assert.match(acceptedKegConfirmation.headers.get("location") ?? "", /notice=/);

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
  assert.match(
    presentationResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/beverages/${LINKED_BEVERAGE_ID}\\?notice=`),
  );
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

  const recipeResponse = await post(`/admin/beverages/${CUSTOM_BEVERAGE_ID}/recipe`, {
    recipeJson: JSON.stringify(customRecipeForQc),
  });
  assert.equal(recipeResponse.status, 303);
  assert.match(
    recipeResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/beverages/${CUSTOM_BEVERAGE_ID}\\?notice=`),
  );
  assert.deepEqual(recipeCalls.at(-1), {
    id: CUSTOM_BEVERAGE_ID,
    input: { recipe: customRecipeForQc },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const deleteRecipeResponse = await post(`/admin/beverages/${CUSTOM_BEVERAGE_ID}/recipe`, {
    recipeJson: "null",
  });
  assert.equal(deleteRecipeResponse.status, 303);
  assert.deepEqual(recipeCalls.at(-1)?.input, { recipe: null });

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
  assert.match(
    tapUpdateResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/taps/${TAP_ID}\\?notice=`),
  );
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

  const tapAssignResponse = await post(`/admin/taps/${TAP_ID}/assign`, { fillId: FILL_ID });
  assert.equal(tapAssignResponse.status, 303);
  assert.match(
    tapAssignResponse.headers.get("location") ?? "",
    new RegExp(`^/admin/taps/${TAP_ID}\\?notice=`),
  );
  assert.deepEqual(tapAssignCalls.at(-1), {
    id: TAP_ID,
    input: { fillId: FILL_ID },
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

  const missingTapConfirmation = await post(`/admin/taps/${TAP_ID}/delete`, {
    reason: "QC delete",
  });
  assert.equal(missingTapConfirmation.status, 303);
  assert.match(missingTapConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(tapDeleteCalls.length, 0);

  const mismatchedTapConfirmation = await post(`/admin/taps/${TAP_ID}/delete`, {
    confirmation: "Wrong visible label",
    reason: "QC delete",
  });
  assert.equal(mismatchedTapConfirmation.status, 303);
  assert.match(mismatchedTapConfirmation.headers.get("location") ?? "", /error=/);
  assert.equal(tapDeleteCalls.length, 1);

  const acceptedTapConfirmation = await post(`/admin/taps/${TAP_ID}/delete`, {
    confirmation: "Tap 3 — QC Tap",
    reason: "QC delete",
  });
  assert.equal(acceptedTapConfirmation.status, 303);
  assert.match(acceptedTapConfirmation.headers.get("location") ?? "", /notice=/);
  assert.deepEqual(tapDeleteCalls.at(-1), {
    id: TAP_ID,
    confirmation: "Tap 3 — QC Tap",
    input: { reason: "QC delete" },
    actor: { actorType: "admin", sessionId: SESSION_ID },
  });

  const callCounts = [
    presentationCalls.length,
    fillCalls.length,
    tapAssignCalls.length,
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
    [
      presentationCalls.length,
      fillCalls.length,
      tapAssignCalls.length,
      tapUpdateCalls.length,
      tapCreateCalls.length,
    ],
    callCounts,
  );
});
