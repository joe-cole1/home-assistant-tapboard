import type { ServerResponse } from "node:http";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import { readFormBody } from "../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../infrastructure/http/html.ts";
import { requireMutationOrigin } from "../../infrastructure/http/security/origin.ts";
import { ApplicationError, isApplicationError } from "../../shared/errors.ts";
import { errorStatus, reportFailure } from "../../shared/diagnostics.ts";
import { buildSensoryRadar } from "../story/index.ts";
import { adminContext, messageLocation } from "./admin/context.ts";
import { temperature, volume } from "./admin/presentation.ts";
import { acceptsJson, oneRequestHeader } from "./admin/http.ts";
import type {
  RegisterPublicRoutesDependencies,
  SendTapWarsVoteErrorDependencies,
} from "./contracts.ts";

export function registerPublicRoutes(dependencies: RegisterPublicRoutesDependencies): void {
  dependencies.router.get("/", (request, response) => {
    const isAdmin = adminContext(request, dependencies.authService) !== undefined;
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/dashboard", {
        ...dependencies.dashboardService.getDashboard(),
        adminPourPreview: isAdmin,
      }),
      { vary: "Cookie" },
    );
  });
  dependencies.router.get("/taps/:tapId/story", (request, response, params) => {
    const isAdmin = adminContext(request, dependencies.authService) !== undefined;
    const story = dependencies.storyService.getStory(params.tapId!);
    if (story === undefined) {
      sendHtml(
        response,
        404,
        dependencies.renderer.render("/public/story", {
          sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
          header: dependencies.dashboardService.getHeader(),
          story: undefined,
          isAdmin,
        }),
        { vary: "Cookie" },
      );
      return;
    }
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/story", {
        sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
        header: dependencies.dashboardService.getHeader(),
        ssePath: isAdmin ? "/api/admin/events" : "/api/public/events",
        tapId: params.tapId,
        isAdmin,
        sensoryRadar: buildSensoryRadar(story.sensory),
        temperature,
        volume,
        story,
      }),
      { vary: "Cookie" },
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
  dependencies.router.get("/api/public/tap-wars", (_request, response) => {
    sendJson(response, 200, { tapWars: dependencies.publicTapWarsService.getVisible() });
  });
  dependencies.router.post(
    "/api/public/tap-wars/:warId/votes",
    async (request, response, params) => {
      const wantsJson = acceptsJson(oneRequestHeader(request.headers.accept));
      try {
        requireMutationOrigin(request.headers.origin, dependencies.canonicalOrigin);
        const form = await readFormBody(request, { maxBytes: 256, maxFields: 1 });
        if (
          Object.keys(form).length !== 1 ||
          !Object.hasOwn(form, "side") ||
          (form.side !== "1" && form.side !== "2")
        ) {
          throw new ApplicationError({
            category: "validation",
            code: "tap_war.invalid_vote",
            clientMessage: "Choose one valid Tap War side.",
          });
        }
        dependencies.tapWarsService.vote(params.warId!, form.side === "1" ? 1 : 2);
        if (wantsJson) {
          sendJson(response, 200, { tapWars: dependencies.publicTapWarsService.getVisible() });
          return;
        }
        redirect(response, "/#tap-wars");
      } catch (error) {
        if (response.headersSent) throw error;
        reportFailure(error, {
          operation: "public.tap_war.vote",
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        });
        if (isApplicationError(error) && error.code === "tap_war.ineligible") {
          // vote() commits the pause before reporting this conflict, so it is a
          // real state change rather than a rejected attempt.
          dependencies.liveUpdates.publish({ name: "tap_wars.updated", target: "tap-wars" });
        }
        if (wantsJson) {
          sendTapWarsVoteError(dependencies, response, error);
          return;
        }
        const message = isApplicationError(error)
          ? error.clientMessage
          : "The vote could not be recorded.";
        redirect(response, `${messageLocation("/", "error", message)}#tap-wars`);
      }
    },
  );
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

export function sendTapWarsVoteError(
  dependencies: SendTapWarsVoteErrorDependencies,
  response: ServerResponse,
  error: unknown,
): void {
  if (isApplicationError(error)) {
    sendJson(response, errorStatus(error.category), {
      error: { code: error.code, message: error.clientMessage },
      tapWars: dependencies.publicTapWarsService.getVisible(),
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: "internal.unexpected", message: "The vote could not be recorded." },
    tapWars: dependencies.publicTapWarsService.getVisible(),
  });
}
