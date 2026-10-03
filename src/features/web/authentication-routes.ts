import { readFormBody } from "../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../infrastructure/http/html.ts";
import {
  clearCsrfCookie,
  clearSessionCookie,
  parseSessionCookie,
  serializeCsrfCookie,
} from "../../infrastructure/http/security/cookie.ts";
import { requireMutationOrigin } from "../../infrastructure/http/security/origin.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { reportFailure } from "../../shared/diagnostics.ts";
import { displayStylesheetHref } from "../display/palette.ts";
import { adminContext, pageMessage, cookieValue, messageLocation } from "./admin/context.ts";
import type { RegisterAuthenticationRoutesDependencies } from "./contracts.ts";

export function registerAuthenticationRoutes(
  dependencies: RegisterAuthenticationRoutesDependencies,
): void {
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
    const display = dependencies.displayService.getSettings();
    const page = {
      title: "Admin sign in",
      path: "/admin/login",
      siteName: display.tapboardName,
      adminAccent: display.accent,
      displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      ...pageMessage(request),
    };
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
    } catch (error) {
      if (response.headersSent) throw error;
      reportFailure(error, {
        operation: "auth.login",
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      redirect(response, messageLocation("/admin/login", "error", "Sign-in failed."));
    }
  });
  dependencies.router.post("/admin/logout", async (request, response) => {
    const context = adminContext(request, dependencies.authService);
    try {
      if (context === undefined)
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "Sign-out failed.",
        });
      const form = await readFormBody(request, { maxFields: 4, maxBytes: 1_024 });
      const authorized = dependencies.authService.authorizeCookieMutation({
        cookieHeader: request.headers.cookie,
        originHeader: request.headers.origin,
        csrfHeader: form._csrf,
        canonicalOrigin: dependencies.canonicalOrigin,
      });
      if (context === undefined || authorized?.id !== context.session.id) {
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "Sign-out failed.",
        });
      }
      dependencies.authService.revoke(context.sessionToken);
      const secure = dependencies.canonicalOrigin?.startsWith("https://") === true;
      response.setHeader("set-cookie", [
        clearSessionCookie({ secure }),
        clearCsrfCookie({ secure }),
      ]);
      redirect(response, messageLocation("/admin/login", "notice", "Signed out."));
    } catch (error) {
      if (response.headersSent) throw error;
      reportFailure(error, {
        operation: "auth.logout",
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      redirect(response, messageLocation("/admin/login", "error", "Sign-out failed."));
    }
  });
}
