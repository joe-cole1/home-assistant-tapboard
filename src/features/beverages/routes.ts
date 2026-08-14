import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import { readJsonBody } from "../../infrastructure/http/security/body.ts";
import { parseSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import { ApplicationError } from "../../shared/errors.ts";
import type { BeverageService, BeverageDetailResult, BeverageSummaryResult } from "./service.ts";

export interface BeverageRouteDependencies {
  readonly router: Router;
  readonly beverageService: BeverageService;
  readonly authService: AuthService;
}

function requireSession(request: IncomingMessage, authService: AuthService): AuthenticatedSession {
  let sessionToken: string | undefined;
  const cookieHeader = request.headers.cookie;
  if (cookieHeader !== undefined) {
    try {
      sessionToken = parseSessionCookie(cookieHeader);
    } catch {
      sessionToken = undefined;
    }
  }

  if (sessionToken === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication is required.",
    });
  }

  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication is required.",
    });
  }

  return session;
}

function requireMutationAuth(
  request: IncomingMessage,
  authService: AuthService,
): AuthenticatedSession {
  const session = authService.authorizeCookieMutation({
    cookieHeader: request.headers.cookie,
    originHeader: request.headers.origin,
    csrfHeader: request.headers["x-csrf-token"],
    canonicalOrigin: undefined,
  });

  if (session === undefined) {
    throw new ApplicationError({
      category: "unauthorized",
      code: "auth.unauthorized",
      clientMessage: "Authentication failed.",
    });
  }

  return session;
}

function toBeverageSummaryDto(summary: BeverageSummaryResult) {
  return {
    id: summary.beverage.id,
    ownershipType: summary.beverage.ownershipType,
    name: summary.effectivePresentation.name,
    beverageType: summary.effectivePresentation.beverageType,
    style: summary.effectivePresentation.style,
    abv: summary.effectivePresentation.abv,
    ibu: summary.effectivePresentation.ibu,
    og: summary.effectivePresentation.og,
    fg: summary.effectivePresentation.fg,
    srm: summary.effectivePresentation.srm,
    displayColor: summary.effectivePresentation.displayColor,
    description: summary.effectivePresentation.description,
    fillGlass: summary.effectivePresentation.fillGlass,
    density: {
      densityGPerMl: summary.density.densityGPerMl,
      specificGravity: summary.density.specificGravity,
      source: summary.density.source,
    },
    createdAt: summary.beverage.createdAt,
    updatedAt: summary.beverage.updatedAt,
  };
}

function toBeverageDetailDto(detail: BeverageDetailResult) {
  return {
    beverage: {
      id: detail.beverage.id,
      ownershipType: detail.beverage.ownershipType,
      createdAt: detail.beverage.createdAt,
      updatedAt: detail.beverage.updatedAt,
    },
    effectivePresentation: detail.effectivePresentation,
    density: {
      densityGPerMl: detail.density.densityGPerMl,
      specificGravity: detail.density.specificGravity,
      source: detail.density.source,
    },
    ...(detail.customProfile ? { customProfile: detail.customProfile } : {}),
    ...(detail.customRecipe ? { customRecipe: detail.customRecipe } : {}),
    ...(detail.brewfatherLink ? { brewfatherLink: detail.brewfatherLink } : {}),
    ...(detail.brewfatherSourceProfile
      ? { brewfatherSourceProfile: detail.brewfatherSourceProfile }
      : {}),
    ...(detail.presentationOverrides
      ? { presentationOverrides: detail.presentationOverrides }
      : {}),
    ...(detail.recipeSnapshot
      ? {
          recipeSnapshot: {
            id: detail.recipeSnapshot.id,
            sourceBatchId: detail.recipeSnapshot.sourceBatchId,
            sourceRecipeId: detail.recipeSnapshot.sourceRecipeId,
            state: detail.recipeSnapshot.state,
            version: detail.recipeSnapshot.version,
            recipe: JSON.parse(detail.recipeSnapshot.recipeJson) as unknown,
            fingerprint: detail.recipeSnapshot.recipeFingerprint,
            createdAt: detail.recipeSnapshot.createdAt,
          },
        }
      : {}),
    ...(detail.sensoryOverrides ? { sensoryOverrides: detail.sensoryOverrides } : {}),
  };
}

export function registerBeverageRoutes(dependencies: BeverageRouteDependencies): void {
  const { router, beverageService, authService } = dependencies;

  // GET /api/admin/beverages
  router.get("/api/admin/beverages", (request: IncomingMessage, response: ServerResponse) => {
    requireSession(request, authService);
    const beverages = beverageService.listBeverages();
    sendJson(response, 200, {
      beverages: beverages.map(toBeverageSummaryDto),
    });
  });

  // POST /api/admin/beverages
  router.post(
    "/api/admin/beverages",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);

      // If sourceBatchId is present, it's a Brewfather linking request; otherwise Custom creation
      let result: BeverageDetailResult;
      if (typeof (body as Record<string, unknown>).sourceBatchId === "string") {
        result = beverageService.linkBrewfatherCandidate(body, {
          actorType: "admin",
          sessionId: session.id,
        });
      } else {
        result = beverageService.createCustomBeverage(body, {
          actorType: "admin",
          sessionId: session.id,
        });
      }

      sendJson(response, 201, {
        beverage: toBeverageDetailDto(result),
      });
    },
  );

  // GET /api/admin/beverages/settings
  router.get(
    "/api/admin/beverages/settings",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const settings = beverageService.getSettings();
      sendJson(response, 200, { settings });
    },
  );

  // PATCH /api/admin/beverages/settings
  router.patch(
    "/api/admin/beverages/settings",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const updated = beverageService.updateSettings(body, {
        actorType: "admin",
        sessionId: session.id,
      });
      sendJson(response, 200, { settings: updated });
    },
  );

  // GET /api/admin/beverages/brewfather/status
  router.get(
    "/api/admin/beverages/brewfather/status",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const status = beverageService.getBrewfatherStatus();
      sendJson(response, 200, { status });
    },
  );

  // PUT /api/admin/beverages/brewfather/config
  router.put(
    "/api/admin/beverages/brewfather/config",
    async (request: IncomingMessage, response: ServerResponse) => {
      const session = requireMutationAuth(request, authService);
      const body = await readJsonBody(request);
      const account = beverageService.configureBrewfatherAccount(body, {
        actorType: "admin",
        sessionId: session.id,
      });
      sendJson(response, 200, { account });
    },
  );

  // GET /api/admin/beverages/brewfather/candidates
  router.get(
    "/api/admin/beverages/brewfather/candidates",
    (request: IncomingMessage, response: ServerResponse) => {
      requireSession(request, authService);
      const candidates = beverageService.listCandidates();
      sendJson(response, 200, { candidates });
    },
  );

  // POST /api/admin/beverages/brewfather/sync
  router.post(
    "/api/admin/beverages/brewfather/sync",
    async (request: IncomingMessage, response: ServerResponse) => {
      requireMutationAuth(request, authService);
      const results = await beverageService.syncBrewfather();
      sendJson(response, 200, { results });
    },
  );

  // GET /api/admin/beverages/:id
  router.get(
    "/api/admin/beverages/:id",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id ?? "";
      const detail = beverageService.getBeverage(id);
      sendJson(response, 200, {
        beverage: toBeverageDetailDto(detail),
      });
    },
  );

  // PATCH /api/admin/beverages/:id
  router.patch(
    "/api/admin/beverages/:id",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id ?? "";
      const body = await readJsonBody(request);

      const beverage = beverageService.getBeverage(id);
      let updated: BeverageDetailResult;
      if (beverage.beverage.ownershipType === "custom") {
        updated = beverageService.updateCustomBeverage(id, body, {
          actorType: "admin",
          sessionId: session.id,
        });
      } else {
        // Brewfather linked: apply presentation overrides
        updated = beverageService.updatePresentationOverrides(id, body, {
          actorType: "admin",
          sessionId: session.id,
        });
      }

      sendJson(response, 200, {
        beverage: toBeverageDetailDto(updated),
      });
    },
  );

  // POST /api/admin/beverages/:id/unlink
  router.post(
    "/api/admin/beverages/:id/unlink",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id ?? "";

      const result = beverageService.unlinkBeverage(id, {
        actorType: "admin",
        sessionId: session.id,
      });

      sendJson(response, 200, {
        beverage: toBeverageDetailDto(result),
      });
    },
  );

  // GET /api/admin/beverages/:id/deletion-impact
  router.get(
    "/api/admin/beverages/:id/deletion-impact",
    (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      requireSession(request, authService);
      const id = params.id ?? "";
      const impact = beverageService.getDeletionImpact(id);
      sendJson(response, 200, { impact });
    },
  );

  // DELETE /api/admin/beverages/:id
  router.delete(
    "/api/admin/beverages/:id",
    async (
      request: IncomingMessage,
      response: ServerResponse,
      params: Readonly<Record<string, string>>,
    ) => {
      const session = requireMutationAuth(request, authService);
      const id = params.id ?? "";
      let body: Record<string, unknown> = {};
      try {
        body = await readJsonBody(request);
      } catch {
        body = {};
      }

      const impact = beverageService.deleteBeverage(
        id,
        { ...(typeof body.reason === "string" ? { reason: body.reason } : {}) },
        {
          actorType: "admin",
          sessionId: session.id,
        },
      );

      sendJson(response, 200, {
        status: "deleted",
        impact,
      });
    },
  );
}
