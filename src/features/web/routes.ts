import type { IncomingMessage, ServerResponse } from "node:http";

import { APPLICATION_SCHEMA_VERSION } from "../../infrastructure/database/migrations.ts";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import { readFormBody } from "../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../infrastructure/http/html.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import {
  clearCsrfCookie,
  clearSessionCookie,
  parseCsrfCookie,
  parseSessionCookie,
  serializeCsrfCookie,
} from "../../infrastructure/http/security/cookie.ts";
import { requireMutationOrigin } from "../../infrastructure/http/security/origin.ts";
import type { Renderer } from "../../infrastructure/rendering/renderer.ts";
import { ApplicationError, isApplicationError } from "../../shared/errors.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { DashboardService } from "../dashboard/service.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import type { FillService } from "../fills/service.ts";
import type { HealthService } from "../health/service.ts";
import type { KegService } from "../kegs/service.ts";
import type { LiveUpdateService } from "../live/service.ts";
import type { PublicStoryService } from "../story/service.ts";
import { VESSEL_IDS } from "../story/index.ts";
import type { UpdateCustomBeverageInput } from "../beverages/types.ts";
import type { TapService } from "../taps/service.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  mergeDetectorConfig,
  type DetectorConfigOverride,
} from "../telemetry/detector-config.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import { validateCompleteDetectorConfig } from "../telemetry/detector-validation.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import { HEALTH_CHECK_IDS, type HealthConfigOverride } from "../health/types.ts";

const ADMIN_NAV = [
  ["Overview", "/admin/overview"],
  ["Integrations", "/admin/integrations"],
  ["Beverages", "/admin/beverages"],
  ["Kegs", "/admin/kegs"],
  ["Fills", "/admin/fills"],
  ["Taps", "/admin/taps"],
  ["Tap Wars", "/admin/tap-wars"],
  ["Display", "/admin/display"],
  ["System", "/admin/system"],
] as const;

export interface WebRouteDependencies {
  readonly router: Router;
  readonly renderer: Renderer;
  readonly canonicalOrigin?: string;
  readonly authService: AuthService;
  readonly dashboardService: DashboardService;
  readonly storyService: PublicStoryService;
  readonly displayService: DisplaySettingsService;
  readonly beverageService: BeverageService;
  readonly kegService: KegService;
  readonly fillService: FillService;
  readonly tapService: TapService;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly healthService: HealthService;
  readonly liveUpdates: LiveUpdateService;
}

interface AdminContext {
  readonly session: AuthenticatedSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

function cookieValue(
  request: IncomingMessage,
  parser: typeof parseSessionCookie,
): string | undefined {
  try {
    return request.headers.cookie === undefined ? undefined : parser(request.headers.cookie);
  } catch {
    return undefined;
  }
}

function adminContext(
  request: IncomingMessage,
  authService: AuthService,
): AdminContext | undefined {
  const sessionToken = cookieValue(request, parseSessionCookie);
  if (sessionToken === undefined) return undefined;
  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) return undefined;
  return {
    session,
    sessionToken,
    csrfToken: cookieValue(request, parseCsrfCookie) ?? "",
  };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://tapboard.local");
}

function pageMessage(request: IncomingMessage): {
  readonly notice?: string;
  readonly error?: string;
} {
  const url = requestUrl(request);
  const notice = url.searchParams.get("notice");
  const error = url.searchParams.get("error");
  return {
    ...(notice === null ? {} : { notice: notice.slice(0, 240) }),
    ...(error === null ? {} : { error: error.slice(0, 240) }),
  };
}

function messageLocation(path: string, kind: "notice" | "error", message: string): string {
  const value = encodeURIComponent(message.slice(0, 240));
  return `${path}?${kind}=${value}`;
}

function actor(context: AdminContext): { readonly actorType: "admin"; readonly sessionId: string } {
  return { actorType: "admin", sessionId: context.session.id };
}

function nullable(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value === "" ? null : value;
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

function safeSensoryOverride(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5
    ? value
    : null;
}

function nullableNumber(value: string | undefined): number | null | undefined {
  return value === undefined ? undefined : value === "" ? null : Number(value);
}

type PresentationField =
  "name" | "beverageType" | "style" | "abv" | "displayColor" | "description" | "fillGlass";
type PresentationOverride =
  { readonly inherit: true } | { readonly clear: true } | { readonly value: string | number };

function presentationOverridesFromForm(
  form: Readonly<Record<string, string>>,
): Record<PresentationField, PresentationOverride> {
  const result = {} as Record<PresentationField, PresentationOverride>;
  const fields: readonly PresentationField[] = [
    "name",
    "beverageType",
    "style",
    "abv",
    "displayColor",
    "description",
    "fillGlass",
  ];
  for (const field of fields) {
    const mode = form[`${field}Mode`];
    if (mode === "inherit") {
      result[field] = { inherit: true };
    } else if (mode === "clear" && field !== "name" && field !== "beverageType") {
      result[field] = { clear: true };
    } else {
      const value = form[field] ?? "";
      if (field === "fillGlass") {
        result[field] = { value: vesselFromForm(value) ?? "" };
      } else {
        result[field] = field === "abv" ? { value: Number(value) } : { value };
      }
    }
  }
  return result;
}

function invalidForm(message: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "request.invalid",
    clientMessage: message,
  });
}

function optionalRecipeNumber(
  value: string,
  minimum: number,
  maximum: number,
  field: string,
): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    invalidForm(`${field} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function recipeLineParts(line: string, kind: "ingredient" | "step", index: number): string[] {
  const parts = line.split("|").map((part) => part.trim());
  if (parts.length < 1 || parts.length > 4 || parts[0] === "") {
    invalidForm(`${kind} line ${index + 1} must use the documented pipe-separated format.`);
  }
  return parts;
}

function recipeFromForm(
  form: Readonly<Record<string, string>>,
): UpdateCustomBeverageInput["recipe"] {
  const notes = form.recipeNotes?.trim() ?? "";
  const ingredientText = form.recipeIngredients?.trim() ?? "";
  const stepText = form.recipeSteps?.trim() ?? "";
  if (notes === "" && ingredientText === "" && stepText === "") return null;

  const ingredients = ingredientText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      const parts = recipeLineParts(line, "ingredient", index);
      const name = parts[0];
      if (name === undefined || name === "")
        invalidForm(`Ingredient line ${index + 1} needs a name.`);
      const amount = parts[1] ?? "";
      const unit = parts[2] ?? "";
      const note = parts[3] ?? "";
      if (name.length > 160 || unit.length > 32 || note.length > 255) {
        invalidForm(`Ingredient line ${index + 1} is too long.`);
      }
      return {
        name,
        amount: optionalRecipeNumber(amount, 0, 1_000_000, `Ingredient ${index + 1} amount`),
        unit: unit || null,
        note: note || null,
      };
    });

  const steps = stepText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line, index) => {
      const parts = recipeLineParts(line, "step", index);
      const name = parts[0];
      if (name === undefined || name === "") invalidForm(`Step line ${index + 1} needs a name.`);
      const temperatureC = parts[1] ?? "";
      const timeMinutes = parts[2] ?? "";
      const note = parts[3] ?? "";
      if (name.length > 160 || note.length > 1000)
        invalidForm(`Step line ${index + 1} is too long.`);
      return {
        name,
        temperatureC: optionalRecipeNumber(temperatureC, -50, 150, `Step ${index + 1} temperature`),
        timeMinutes: optionalRecipeNumber(timeMinutes, 0, 100_000, `Step ${index + 1} time`),
        note: note || null,
      };
    });

  if (ingredients.length > 200 || steps.length > 100) invalidForm("Recipe is too large.");
  return { notes: notes || null, ingredients, steps };
}

function vesselFromForm(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!(VESSEL_IDS as readonly string[]).includes(trimmed)) {
    invalidForm("Fill Glass must be selected from the supported catalog.");
  }
  return trimmed;
}

function safeVesselForDisplay(value: unknown): string | null {
  return typeof value === "string" && (VESSEL_IDS as readonly string[]).includes(value)
    ? value
    : null;
}

function detectorOverrideFromForm(form: Readonly<Record<string, string>>): DetectorConfigOverride {
  return Object.fromEntries(
    DETECTOR_CONFIG_FIELDS.flatMap((field) => {
      const value = form[`detector.${field}`];
      return value === undefined || value === "" ? [] : [[field, Number(value)]];
    }),
  );
}

function healthOverrideFromForm(
  form: Readonly<Record<string, string>>,
  effective: ReturnType<HealthService["getEffectiveConfig"]>["effective"],
): HealthConfigOverride | null {
  const override: Record<string, Record<string, boolean | number>> = {};
  for (const checkId of HEALTH_CHECK_IDS) {
    for (const [field, inheritedValue] of Object.entries(effective[checkId])) {
      const raw = form[`health.${checkId}.${field}`];
      if (raw === undefined || raw === "") continue;
      const section = (override[checkId] ??= {});
      section[field] = typeof inheritedValue === "boolean" ? raw === "true" : Number(raw);
    }
  }
  return Object.keys(override).length === 0 ? null : override;
}

function renderAdmin(
  dependencies: WebRouteDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  view: string,
  title: string,
  path: string,
  data: Readonly<Record<string, unknown>> = {},
): void {
  const message = pageMessage(request);
  const page = {
    title,
    path,
    csrfToken: context.csrfToken,
    ...message,
  };
  sendHtml(
    response,
    200,
    dependencies.renderer.render(view, {
      page,
      navItems: ADMIN_NAV.map(([label, href]) => ({ label, href })),
      ...data,
    }),
  );
}

function registerAdminGet(
  dependencies: WebRouteDependencies,
  path: string,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    context: AdminContext,
  ) => void | Promise<void>,
): void {
  dependencies.router.get(path, async (request, response) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }
    await handler(request, response, context);
  });
}

function registerAdminAction(
  dependencies: WebRouteDependencies,
  path: string,
  returnPath: string,
  handler: (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => void | Promise<void>,
  successMessage = "Saved.",
): void {
  dependencies.router.post(path, async (request, response, params) => {
    try {
      const form = await readFormBody(request);
      const context = adminContext(request, dependencies.authService);
      const authorized = dependencies.authService.authorizeCookieMutation({
        cookieHeader: request.headers.cookie,
        originHeader: request.headers.origin,
        csrfHeader: form._csrf,
        canonicalOrigin: dependencies.canonicalOrigin,
      });
      if (
        context === undefined ||
        authorized === undefined ||
        authorized.id !== context.session.id
      ) {
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "The form could not be authorized. Reload and try again.",
        });
      }
      await handler(form, context, params);
      redirect(response, messageLocation(returnPath, "notice", successMessage));
    } catch (error) {
      const message = isApplicationError(error)
        ? error.clientMessage
        : "The change could not be completed.";
      redirect(response, messageLocation(returnPath, "error", message));
    }
  });
}

function registerPublicRoutes(dependencies: WebRouteDependencies): void {
  dependencies.router.get("/", (_request, response) => {
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/dashboard", {
        ...dependencies.dashboardService.getDashboard(),
      }),
    );
  });
  dependencies.router.get("/taps/:tapId/story", (_request, response, params) => {
    const story = dependencies.storyService.getStory(params.tapId!);
    if (story === undefined) {
      sendHtml(
        response,
        404,
        dependencies.renderer.render("/public/story", {
          sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
          header: dependencies.dashboardService.getHeader(),
          story: undefined,
        }),
      );
      return;
    }
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/story", {
        sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
        header: dependencies.dashboardService.getHeader(),
        story,
      }),
    );
  });
  dependencies.router.get("/api/public/dashboard", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getDashboard() });
  });
  dependencies.router.get("/api/public/dashboard/header", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getHeader() });
  });
  dependencies.router.get("/api/public/dashboard/display", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getDisplayDefaults() });
  });
  dependencies.router.get("/api/public/dashboard/on-deck", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getOnDeck() });
  });
  dependencies.router.get("/api/public/dashboard/taps/:tapId", (_request, response, params) => {
    const tap = dependencies.dashboardService.getTap(params.tapId!);
    if (tap === undefined) {
      sendJson(response, 404, { error: { code: "tap.not_public", message: "Tap not found." } });
      return;
    }
    sendJson(response, 200, { ...tap });
  });
  dependencies.router.get("/api/public/taps/:tapId/story", (_request, response, params) => {
    const story = dependencies.storyService.getStory(params.tapId!);
    if (story === undefined) {
      sendJson(response, 404, {
        error: { code: "tap.story_not_public", message: "Story not found." },
      });
      return;
    }
    sendJson(response, 200, { ...story });
  });
  dependencies.router.get("/api/public/events", (_request, response) => {
    dependencies.liveUpdates.connectPublic(response);
  });
}

function registerAuthenticationRoutes(dependencies: WebRouteDependencies): void {
  dependencies.router.get("/admin", (request, response) => {
    redirect(
      response,
      adminContext(request, dependencies.authService) === undefined
        ? "/admin/login"
        : "/admin/overview",
    );
  });
  dependencies.router.get("/admin/login", (request, response) => {
    if (adminContext(request, dependencies.authService) !== undefined) {
      redirect(response, "/admin/overview");
      return;
    }
    const page = { title: "Admin sign in", path: "/admin/login", ...pageMessage(request) };
    sendHtml(response, 200, dependencies.renderer.render("/admin/login", { page }));
  });
  dependencies.router.post("/admin/login", async (request, response) => {
    try {
      requireMutationOrigin(request.headers.origin, dependencies.canonicalOrigin);
      const form = await readFormBody(request, { maxFields: 4, maxBytes: 1_024 });
      const previous = cookieValue(request, parseSessionCookie);
      const result = await dependencies.authService.authenticate(form.pin, previous);
      if (
        !result.authenticated ||
        result.cookie === undefined ||
        result.csrfToken === undefined ||
        result.absoluteExpiresAt === undefined
      ) {
        redirect(response, messageLocation("/admin/login", "error", "Sign-in failed."));
        return;
      }
      const secure = dependencies.canonicalOrigin?.startsWith("https://") === true;
      response.setHeader("set-cookie", [
        result.cookie,
        serializeCsrfCookie(result.csrfToken, result.absoluteExpiresAt, { secure }),
      ]);
      redirect(response, "/admin/overview");
    } catch {
      redirect(response, messageLocation("/admin/login", "error", "Sign-in failed."));
    }
  });
  dependencies.router.post("/admin/logout", async (request, response) => {
    try {
      const form = await readFormBody(request, { maxFields: 4, maxBytes: 1_024 });
      const context = adminContext(request, dependencies.authService);
      const authorized = dependencies.authService.authorizeCookieMutation({
        cookieHeader: request.headers.cookie,
        originHeader: request.headers.origin,
        csrfHeader: form._csrf,
        canonicalOrigin: dependencies.canonicalOrigin,
      });
      if (context === undefined || authorized?.id !== context.session.id) {
        throw new Error("unauthorized");
      }
      dependencies.authService.revoke(context.sessionToken);
      const secure = dependencies.canonicalOrigin?.startsWith("https://") === true;
      response.setHeader("set-cookie", [
        clearSessionCookie({ secure }),
        clearCsrfCookie({ secure }),
      ]);
      redirect(response, messageLocation("/admin/login", "notice", "Signed out."));
    } catch {
      redirect(response, messageLocation("/admin/login", "error", "Sign-out failed."));
    }
  });
}

function registerAdminPages(dependencies: WebRouteDependencies): void {
  registerAdminGet(dependencies, "/admin/overview", (request, response, context) => {
    const taps = dependencies.tapService.listTaps();
    const fills = dependencies.fillService.listFills();
    const health = dependencies.healthService.listAdminOverview();
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const header = dependencies.dashboardService.getHeader();
    const telemetryConfigured = dependencies.telemetryService.listSources().length;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/overview",
      "Overview",
      "/admin/overview",
      {
        metrics: [
          {
            label: "Enabled taps",
            value: taps.filter((tap) => tap.enabled && !tap.isRetired).length,
          },
          { label: "Active fills", value: fills.filter((fill) => fill.state !== "ended").length },
          { label: "On deck", value: fills.filter((fill) => fill.state === "on_deck").length },
          {
            label: "Health warnings",
            value: health.filter(
              (item) =>
                item.aggregate.severity === "warning" || item.aggregate.severity === "critical",
            ).length,
          },
        ],
        taps: taps.map((tap) => ({
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          enabled: tap.enabled,
          beverageName: tap.activeAssignment?.beverageName ?? null,
        })),
        health: health.map((item) => ({
          tapNumber: taps.find((tap) => tap.id === item.tapId)?.tapNumber ?? null,
          state: item.aggregate.state,
          severity: item.aggregate.severity,
        })),
        connectivity: { state: header.connectivity, label: header.connectivityLabel },
        integrations: {
          telemetryConfigured,
          brewfatherConfigured: brewfather.configured,
          brewfatherEnabled: brewfather.account?.enabled ?? false,
          brewfatherApiKeyConfigured: brewfather.apiKeyConfigured,
          brewfatherLinkedBeverages: brewfather.totalLinkedBeverages,
        },
      },
    );
  });

  registerAdminGet(dependencies, "/admin/integrations", (request, response, context) => {
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const sources = dependencies.telemetryService.listSources();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations",
      "Integrations",
      "/admin/integrations",
      {
        integrations: [
          {
            name: "Telemetry",
            status:
              sources.length === 0
                ? "Not configured"
                : `${sources.length} source${sources.length === 1 ? "" : "s"}`,
          },
          {
            name: "Brewfather",
            status: !brewfather.configured
              ? "Not configured"
              : brewfather.apiKeyConfigured
                ? "Configured"
                : "API key required",
          },
        ],
        telemetrySources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          keyPublicId: source.currentMachineKey.publicId,
          keyCreatedAt: source.currentMachineKey.createdAt,
        })),
        brewfather: {
          configured: brewfather.configured,
          enabled: brewfather.account?.enabled ?? false,
          apiKeyConfigured: brewfather.apiKeyConfigured,
          linkedBeverages: brewfather.totalLinkedBeverages,
          candidates: brewfather.totalCandidates,
        },
      },
    );
  });

  registerAdminGet(dependencies, "/admin/beverages", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverages",
      "Beverages",
      "/admin/beverages",
      {
        beverages: dependencies.beverageService.listBeverages().map((item) => {
          const impact = dependencies.beverageService.getDeletionImpact(item.beverage.id);
          const detail = dependencies.beverageService.getBeverage(item.beverage.id);
          const guidance =
            typeof dependencies.storyService?.getBeverageGuidance === "function"
              ? dependencies.storyService.getBeverageGuidance(item.beverage.id)
              : undefined;
          const source = detail?.brewfatherSourceProfile;
          const sourceProjection =
            source === undefined
              ? {
                  name: item.effectivePresentation.name,
                  beverageType: item.effectivePresentation.beverageType,
                  style: item.effectivePresentation.style,
                  abv: item.effectivePresentation.abv,
                  displayColor: item.effectivePresentation.displayColor,
                  description: item.effectivePresentation.description,
                }
              : {
                  name: source.name,
                  beverageType: source.beverageType,
                  style: source.style,
                  abv: source.abv,
                  displayColor: source.displayColor,
                  description: source.description,
                };
          const overrides = detail?.presentationOverrides;
          return {
            id: item.beverage.id,
            ownershipType: item.beverage.ownershipType,
            name: item.effectivePresentation.name,
            beverageType: item.effectivePresentation.beverageType,
            style: item.effectivePresentation.style,
            abv: item.effectivePresentation.abv,
            displayColor: item.effectivePresentation.displayColor,
            description: item.effectivePresentation.description,
            deletionImpacts: impact.impacts,
            ...(item.beverage.ownershipType === "brewfather"
              ? {
                  brewfatherPresentation: {
                    source: sourceProjection,
                    overrides: {
                      overrideNamePresent: overrides?.overrideNamePresent ?? false,
                      name: overrides?.name ?? null,
                      overrideBeverageTypePresent: overrides?.overrideBeverageTypePresent ?? false,
                      beverageType: overrides?.beverageType ?? null,
                      overrideStylePresent: overrides?.overrideStylePresent ?? false,
                      style: overrides?.style ?? null,
                      overrideAbvPresent: overrides?.overrideAbvPresent ?? false,
                      abv: overrides?.abv ?? null,
                      overrideDisplayColorPresent: overrides?.overrideDisplayColorPresent ?? false,
                      displayColor: overrides?.displayColor ?? null,
                      overrideDescriptionPresent: overrides?.overrideDescriptionPresent ?? false,
                      description: overrides?.description ?? null,
                      overrideFillGlassPresent: overrides?.overrideFillGlassPresent ?? false,
                      fillGlass: safeVesselForDisplay(overrides?.fillGlass),
                    },
                  },
                }
              : {}),
            fillGlass: safeVesselForDisplay(item.effectivePresentation.fillGlass),
            sensoryOverrides: detail?.sensoryOverrides
              ? {
                  bitterness: safeSensoryOverride(detail.sensoryOverrides.bitterness),
                  sweetness: safeSensoryOverride(detail.sensoryOverrides.sweetness),
                  body: safeSensoryOverride(detail.sensoryOverrides.body),
                  roast: safeSensoryOverride(detail.sensoryOverrides.roast),
                  tartness: safeSensoryOverride(detail.sensoryOverrides.tartness),
                  alcohol: safeSensoryOverride(detail.sensoryOverrides.alcohol),
                }
              : null,
            guidance: guidance ?? null,
            customRecipe: detail?.customRecipe
              ? {
                  notes: detail.customRecipe.notes,
                  ingredients: detail.customRecipe.ingredients.map((ingredient) => ({
                    name: ingredient.name,
                    amount: ingredient.amount,
                    unit: ingredient.unit,
                    note: ingredient.note,
                  })),
                  steps: detail.customRecipe.steps.map((step) => ({
                    name: step.name,
                    temperatureC: step.temperatureC,
                    timeMinutes: step.timeMinutes,
                    note: step.note,
                  })),
                }
              : null,
          };
        }),
        brewfatherCandidates: dependencies.beverageService.listCandidates().map((candidate) => ({
          sourceBatchId: candidate.sourceBatchId,
          name: candidate.batchName ?? candidate.recipeName ?? "Unnamed Brewfather batch",
          number: candidate.batchNumber,
          status: candidate.status,
          style: candidate.style,
        })),
        availableKegs: dependencies.kegService
          .listKegs({ isActive: true })
          .filter(
            (keg) =>
              !dependencies.fillService
                .listFills({ kegId: keg.id })
                .some((fill) => fill.state !== "ended"),
          )
          .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label })),
        fillGlassIds: VESSEL_IDS,
      },
    );
  });

  registerAdminGet(dependencies, "/admin/kegs", (request, response, context) => {
    const fills = dependencies.fillService.listFills();
    renderAdmin(dependencies, response, request, context, "/admin/kegs", "Kegs", "/admin/kegs", {
      kegs: dependencies.kegService.listKegs().map((keg) => {
        const detail = dependencies.kegService.getKeg(keg.id);
        const impact = dependencies.kegService.getDeletionImpact(keg.id);
        return {
          id: keg.id,
          kegNumber: keg.kegNumber,
          label: keg.label,
          capacityMl: keg.capacityMl,
          currentTareG: keg.currentTareG,
          isActive: keg.isActive,
          currentFill:
            fills.find((fill) => fill.kegId === keg.id && fill.state !== "ended")?.beverageName ??
            null,
          fillHistory: dependencies.fillService.listFills({ kegId: keg.id }).map((fill) => ({
            beverageName: fill.beverageName,
            fillDate: fill.fillDate,
            state: fill.state,
            endedAt: fill.endedAt,
          })),
          tareHistory: detail.tareHistory.map((item) => ({
            previousTareG: item.previousTareG,
            newTareG: item.newTareG,
            recordedAt: item.recordedAt,
            reason: item.reason,
          })),
          maintenanceHistory: detail.maintenanceHistory.map((item) => ({
            maintenanceType: item.maintenanceType,
            recordedAt: item.recordedAt,
          })),
          deletionImpacts: impact.impacts,
        };
      }),
    });
  });

  registerAdminGet(dependencies, "/admin/fills", (request, response, context) => {
    renderAdmin(dependencies, response, request, context, "/admin/fills", "Fills", "/admin/fills", {
      fills: dependencies.fillService.listFills().map((fill) => ({
        id: fill.id,
        beverageId: fill.beverageId,
        beverageName: fill.beverageName,
        kegId: fill.kegId,
        kegNumber: fill.kegNumber,
        kegLabel: fill.kegLabel,
        fillDate: fill.fillDate,
        state: fill.state,
        onDeckOrder: fill.onDeckOrder,
        endedAt: fill.endedAt,
      })),
      beverages: dependencies.beverageService
        .listBeverages()
        .map((item) => ({ id: item.beverage.id, name: item.effectivePresentation.name })),
      kegs: dependencies.kegService
        .listKegs({ isActive: true })
        .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label })),
    });
  });

  registerAdminGet(dependencies, "/admin/taps", (request, response, context) => {
    const telemetrySources = dependencies.telemetryService
      .listSources()
      .map((source) => ({ id: source.id, name: source.name }));
    const sources = new Map(telemetrySources.map((source) => [source.id, source.name]));
    const allTaps = dependencies.tapService.listTaps();
    renderAdmin(dependencies, response, request, context, "/admin/taps", "Taps", "/admin/taps", {
      taps: allTaps.map((tap) => {
        const authority = dependencies.telemetryService.getTapAuthority(tap.id);
        const detectorGlobal = dependencies.detectorService.getGlobalConfig();
        const detectorOverride =
          dependencies.detectorService.getTapOverride(tap.id)?.override ?? {};
        const detectorEffective = mergeDetectorConfig(detectorGlobal.config, detectorOverride);
        const healthConfig = dependencies.healthService.getEffectiveConfig(tap.id);
        return {
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          enabled: tap.enabled,
          isRetired: tap.isRetired,
          gasType: tap.gasType,
          servingPressureKpa: tap.servingPressureKpa,
          lineLengthMm: tap.lineLengthMm,
          lineDiameterMm: tap.lineDiameterMm,
          notes: tap.notes,
          beverageName: tap.activeAssignment?.beverageName ?? null,
          mystery:
            tap.activeAssignment &&
            typeof dependencies.tapService.getAssignmentMystery === "function"
              ? dependencies.tapService.getAssignmentMystery(tap.id)
              : null,
          authority:
            authority === undefined
              ? "None"
              : (sources.get(authority.sourceId) ?? "Configured source"),
          authoritySourceId: authority?.sourceId ?? "",
          health: dependencies.healthService.getAdminOverview(tap.id).aggregate.state,
          detectorFields: DETECTOR_CONFIG_FIELDS.map((field) => ({
            name: field,
            effective: detectorEffective[field],
            override: detectorOverride[field] ?? null,
          })),
          healthSections: HEALTH_CHECK_IDS.map((checkId) => {
            const effectiveFields = Object.entries(
              healthConfig.effective[checkId],
            ) as readonly (readonly [string, boolean | number])[];
            const overrideFields = new Map(
              Object.entries(healthConfig.override?.[checkId] ?? {}) as readonly (readonly [
                string,
                boolean | number | null,
              ])[],
            );
            return {
              id: checkId,
              fields: effectiveFields.map(([field, value]) => ({
                name: field,
                effective: value,
                override: overrideFields.get(field) ?? null,
              })),
            };
          }),
          moveTargets: allTaps
            .filter((candidate) => candidate.id !== tap.id && !candidate.isRetired)
            .map((candidate) => ({ id: candidate.id, tapNumber: candidate.tapNumber })),
        };
      }),
      telemetrySources,
      fills: dependencies.fillService
        .listFills({ state: "available" })
        .map((fill) => ({ id: fill.id, label: `${fill.beverageName} — Keg ${fill.kegNumber}` })),
    });
  });

  registerAdminGet(dependencies, "/admin/tap-wars", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-wars",
      "Tap Wars",
      "/admin/tap-wars",
    );
  });
  registerAdminGet(dependencies, "/admin/display", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display",
      "Display",
      "/admin/display",
      { sharedDisplay: dependencies.displayService.getSettings() },
    );
  });
  registerAdminGet(dependencies, "/admin/system", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/system",
      "System",
      "/admin/system",
      {
        system: {
          schemaVersion: APPLICATION_SCHEMA_VERSION,
          liveClients: dependencies.liveUpdates.stats(),
        },
      },
    );
  });
  dependencies.router.get("/api/admin/events", (request, response) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    dependencies.liveUpdates.connectAdmin(response, context.sessionToken);
  });
}

function registerAdminMutations(dependencies: WebRouteDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/display/shared",
    "/admin/display",
    (form, context) => {
      dependencies.displayService.updateSettings(
        {
          expectedRevision: Number(form.expectedRevision),
          tapboardName: form.tapboardName,
          theme: form.theme,
          font: form.font,
          accent: form.accent,
          unitSystem: form.unitSystem,
          showServingTemperature: form.showServingTemperature === "true",
          layoutMode: form.layoutMode,
        },
        actor(context),
      );
    },
    "Shared display defaults saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/presentation",
    "/admin/beverages",
    (form, context, params) => {
      dependencies.beverageService.updatePresentationOverrides(
        params.id!,
        presentationOverridesFromForm(form),
        actor(context),
      );
    },
    "Brewfather presentation overrides saved.",
  );

  registerAdminAction(
    dependencies,
    "/admin/beverages/create",
    "/admin/beverages",
    (form, context) => {
      dependencies.beverageService.createCustomBeverage(
        {
          name: form.name,
          beverageType: form.beverageType || "beer",
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
        },
        actor(context),
      );
    },
    "Beverage created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/create-fill",
    "/admin/beverages",
    (form, context, params) => {
      dependencies.fillService.createFill(
        {
          beverageId: params.id!,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/update",
    "/admin/beverages",
    (form, context, params) => {
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        {
          name: form.name,
          beverageType: form.beverageType,
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
        },
        actor(context),
      );
    },
    "Beverage updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/delete",
    "/admin/beverages",
    (form, context, params) => {
      const reason = nullable(form.reason);
      dependencies.beverageService.deleteBeverage(
        params.id!,
        reason === undefined ? {} : { reason },
        actor(context),
      );
    },
    "Beverage deleted.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/sensory",
    "/admin/beverages",
    (form, context, params) => {
      dependencies.beverageService.updateSensoryOverrides(
        params.id!,
        {
          bitterness: nullableNumber(form.bitterness),
          sweetness: nullableNumber(form.sweetness),
          body: nullableNumber(form.body),
          roast: nullableNumber(form.roast),
          tartness: nullableNumber(form.tartness),
          alcohol: nullableNumber(form.alcohol),
        },
        actor(context),
      );
    },
    "Sensory guidance saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/recipe",
    "/admin/beverages",
    (form, context, params) => {
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        { recipe: recipeFromForm(form) },
        actor(context),
      );
    },
    "Custom recipe saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/unlink",
    "/admin/beverages",
    (_form, context, params) => {
      dependencies.beverageService.unlinkBeverage(params.id!, actor(context));
    },
    "Beverage unlinked from Brewfather and retained as a Custom Beverage.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/brewfather/link",
    "/admin/beverages",
    (form, context) => {
      dependencies.beverageService.linkBrewfatherCandidate(
        { sourceBatchId: form.sourceBatchId },
        actor(context),
      );
    },
    "Brewfather batch linked.",
  );

  registerAdminAction(
    dependencies,
    "/admin/kegs/create",
    "/admin/kegs",
    (form, context) => {
      dependencies.kegService.createKeg(
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: optionalNumber(form.currentTareG),
          isActive: form.isActive !== "false",
        },
        actor(context),
      );
    },
    "Keg created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/update",
    "/admin/kegs",
    (form, context, params) => {
      dependencies.kegService.updateKeg(
        params.id!,
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: Number(form.currentTareG),
          isActive: form.isActive === "true",
          reason: nullable(form.reason),
        },
        actor(context),
      );
    },
    "Keg updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/maintenance",
    "/admin/kegs",
    (form, context, params) => {
      dependencies.kegService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/delete",
    "/admin/kegs",
    (form, context, params) => {
      dependencies.kegService.deleteKeg(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Keg deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/fills/create",
    "/admin/fills",
    (form, context) => {
      dependencies.fillService.createFill(
        {
          beverageId: form.beverageId,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/on-deck",
    "/admin/fills",
    (_form, context, params) => {
      dependencies.fillService.markOnDeck(params.id!, actor(context));
    },
    "Fill placed On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/remove-on-deck",
    "/admin/fills",
    (_form, context, params) => {
      dependencies.fillService.removeFromOnDeck(params.id!, actor(context));
    },
    "Fill removed from On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/move",
    "/admin/fills",
    (form, context, params) => {
      const ids = dependencies.fillService.getPublicOnDeck().map((item) => item.fillId);
      const index = ids.indexOf(params.id!);
      const destination = form.direction === "up" ? index - 1 : index + 1;
      if (index < 0 || destination < 0 || destination >= ids.length) return;
      [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
      dependencies.fillService.reorderOnDeck({ fillIds: ids }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/kick",
    "/admin/fills",
    async (form, context, params) => {
      await dependencies.fillService.kickFill(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Fill ended.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/delete",
    "/admin/fills",
    (form, context, params) => {
      dependencies.fillService.deleteFill(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Fill deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/taps/create",
    "/admin/taps",
    (form, context) => {
      dependencies.tapService.createTap(
        {
          tapNumber: Number(form.tapNumber),
          name: nullable(form.name),
          enabled: form.enabled !== "false",
          gasType: nullable(form.gasType),
          servingPressureKpa: nullableNumber(form.servingPressureKpa),
          lineLengthMm: nullableNumber(form.lineLengthMm),
          lineDiameterMm: nullableNumber(form.lineDiameterMm),
          notes: nullable(form.notes),
        },
        actor(context),
      );
    },
    "Tap created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/update",
    "/admin/taps",
    (form, context, params) => {
      dependencies.tapService.updateTap(
        params.id!,
        {
          tapNumber: Number(form.tapNumber),
          name: nullable(form.name),
          enabled: form.enabled === "true",
          gasType: nullable(form.gasType),
          servingPressureKpa: nullableNumber(form.servingPressureKpa),
          lineLengthMm: nullableNumber(form.lineLengthMm),
          lineDiameterMm: nullableNumber(form.lineDiameterMm),
          notes: nullable(form.notes),
          acknowledgeTelemetryEndpointImpact: form.acknowledgeTelemetryEndpointImpact === "true",
        },
        actor(context),
      );
    },
    "Tap updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/assign",
    "/admin/taps",
    (form, context, params) => {
      dependencies.tapService.assignFill(params.id!, { fillId: form.fillId }, actor(context));
    },
    "Fill assigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/mystery",
    "/admin/taps",
    (form, context, params) => {
      dependencies.tapService.updateAssignmentMystery(
        params.id!,
        {
          enabled: form.enabled === "true",
          revealBeverageType: form.revealBeverageType === "true",
          revealStyle: form.revealStyle === "true",
          revealAbv: form.revealAbv === "true",
          revealIbu: form.revealIbu === "true",
          revealOg: form.revealOg === "true",
          revealFg: form.revealFg === "true",
          revealSrm: form.revealSrm === "true",
          revealDescription: form.revealDescription === "true",
          revealRecipe: form.revealRecipe === "true",
          revealSensory: form.revealSensory === "true",
          revealHistory: form.revealHistory === "true",
        },
        actor(context),
      );
    },
    "Mystery Tap settings saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/unassign",
    "/admin/taps",
    (_form, context, params) => {
      dependencies.tapService.unassign(params.id!, actor(context));
    },
    "Tap unassigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/move",
    "/admin/taps",
    (form, context, params) => {
      const tap = dependencies.tapService.getTap(params.id!);
      if (tap.activeAssignment === undefined || tap.activeAssignment === null) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.unassigned",
          clientMessage: "The Tap has no Fill to move.",
        });
      }
      dependencies.tapService.moveFill(
        { fillId: tap.activeAssignment.fillId },
        { targetTapId: form.targetTapId },
        actor(context),
      );
    },
    "Fill moved to the selected Tap.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/authority",
    "/admin/taps",
    (form, context, params) => {
      dependencies.telemetryService.setTapAuthority(
        params.id!,
        { sourceId: form.sourceId === "" ? null : form.sourceId },
        actor(context),
      );
    },
    "Telemetry authority updated; a fresh baseline is required.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/detector-config",
    "/admin/taps",
    (form, context, params) => {
      const override = detectorOverrideFromForm(form);
      if (Object.keys(override).length === 0) {
        dependencies.detectorService.clearTapOverride(params.id!, actor(context));
        return;
      }
      const effective = mergeDetectorConfig(
        dependencies.detectorService.getGlobalConfig().config,
        override,
      );
      validateCompleteDetectorConfig(effective);
      dependencies.detectorService.setTapOverride(params.id!, override, actor(context));
    },
    "Pour-detector override updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/health-config",
    "/admin/taps",
    (form, context, params) => {
      const effective = dependencies.healthService.getEffectiveConfig(params.id!).effective;
      const override = healthOverrideFromForm(form, effective);
      if (override === null) {
        dependencies.healthService.clearTapOverride(params.id!, actor(context));
        return;
      }
      dependencies.healthService.setTapOverride(params.id!, override, actor(context));
    },
    "Health override updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/rebaseline",
    "/admin/taps",
    (_form, context, params) => {
      dependencies.detectorService.manualRebaseline(params.id!, actor(context));
    },
    "Tap rebaseline requested.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/maintenance",
    "/admin/taps",
    (form, context, params) => {
      dependencies.healthService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Line maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/retire",
    "/admin/taps",
    (form, context, params) => {
      dependencies.tapService.retireTap(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Tap retired.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather",
    "/admin/integrations",
    (form, context) => {
      dependencies.beverageService.configureBrewfatherAccount(
        {
          userId: form.userId,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          enabled: form.enabled === "true",
        },
        actor(context),
      );
    },
    "Brewfather configuration saved. Stored secrets are never displayed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/sync",
    "/admin/integrations",
    async (_form, _context) => {
      await dependencies.beverageService.syncBrewfather();
    },
    "Brewfather refresh completed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/remove-key",
    "/admin/integrations",
    (_form, context) => {
      dependencies.beverageService.removeBrewfatherApiKey("default", actor(context));
    },
    "Brewfather API key removed.",
  );

  dependencies.router.post(
    "/admin/integrations/telemetry-sources/create",
    async (request, response) => {
      try {
        const form = await readFormBody(request);
        const context = adminContext(request, dependencies.authService);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new Error("unauthorized");
        const issued = dependencies.telemetryService.createSource(
          { name: form.name, ...(form.label ? { label: form.label } : {}) },
          actor(context),
        );
        sendHtml(
          response,
          200,
          dependencies.renderer.render("/admin/machine-key", {
            page: {
              title: "Telemetry key created",
              path: "/admin/integrations",
              csrfToken: context.csrfToken,
            },
            navItems: ADMIN_NAV.map(([label, href]) => ({ label, href })),
            source: { name: issued.source.name },
            machineKey: issued.initialToken,
          }),
        );
      } catch {
        redirect(
          response,
          messageLocation("/admin/integrations", "error", "Telemetry source could not be created."),
        );
      }
    },
  );
  dependencies.router.post(
    "/admin/integrations/telemetry-sources/:id/rotate",
    async (request, response, params) => {
      try {
        const form = await readFormBody(request);
        const context = adminContext(request, dependencies.authService);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new Error("unauthorized");
        const issued = dependencies.telemetryService.rotateSourceKey(
          params.id!,
          form.label ? { label: form.label } : {},
          actor(context),
        );
        sendHtml(
          response,
          200,
          dependencies.renderer.render("/admin/machine-key", {
            page: {
              title: "Telemetry key rotated",
              path: "/admin/integrations",
              csrfToken: context.csrfToken,
            },
            navItems: ADMIN_NAV.map(([label, href]) => ({ label, href })),
            source: { name: issued.source.name },
            machineKey: issued.replacementToken,
          }),
        );
      } catch {
        redirect(
          response,
          messageLocation("/admin/integrations", "error", "Telemetry key could not be rotated."),
        );
      }
    },
  );
}

export function registerWebRoutes(dependencies: WebRouteDependencies): void {
  registerPublicRoutes(dependencies);
  registerAuthenticationRoutes(dependencies);
  registerAdminPages(dependencies);
  registerAdminMutations(dependencies);
}
