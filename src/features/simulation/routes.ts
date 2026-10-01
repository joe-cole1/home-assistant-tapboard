import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import { readFormBody } from "../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../infrastructure/http/html.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import {
  parseCsrfCookie,
  parseSessionCookie,
  serializeCsrfCookie,
} from "../../infrastructure/http/security/cookie.ts";
import type { Renderer } from "../../infrastructure/rendering/renderer.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { adminFailureMessage, reportFailure } from "../../shared/diagnostics.ts";
import type { Logger } from "../../shared/logging.ts";
import type { AuthService, AuthenticatedSession, SessionMaterial } from "../auth/service.ts";
import type { SimulationController, SimulationStatus } from "./ui-types.ts";

export interface SimulationRouteDependencies {
  readonly router: Router;
  readonly renderer: Renderer;
  readonly authService: AuthService;
  readonly canonicalOrigin?: string;
  readonly logger?: Logger;
  readonly controller: SimulationController;
}

interface AdminContext {
  readonly session: AuthenticatedSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

function adminContext(request: IncomingMessage, auth: AuthService): AdminContext | undefined {
  try {
    const sessionToken = parseSessionCookie(request.headers.cookie);
    if (sessionToken === undefined) return undefined;
    const session = auth.authenticateSession(sessionToken);
    if (session === undefined) return undefined;
    return {
      session,
      sessionToken,
      csrfToken: parseCsrfCookie(request.headers.cookie) ?? "",
    };
  } catch {
    return undefined;
  }
}

/** Project fields explicitly even if a controller implementation carries extra state. */
function projectStatus(controller: SimulationController): SimulationStatus {
  const current = controller.status();
  return {
    enabled: current.enabled,
    revision: current.revision,
    changing: current.changing,
    sensors: current.sensors.map((sensor) => ({
      tapId: sensor.tapId,
      tapNumber: sensor.tapNumber,
      label: sensor.label,
      remainingMl: sensor.remainingMl,
      temperatureC: sensor.temperatureC,
      online: sensor.online,
      noiseEnabled: sensor.noiseEnabled,
      pouring: sensor.pouring,
      status: sensor.status,
      error: sensor.error,
    })),
  };
}

function validation(message: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "simulation.invalid_form",
    clientMessage: message,
  });
}

function onlyFields(form: Readonly<Record<string, string>>, fields: readonly string[]): void {
  if (Object.keys(form).some((field) => field !== "_csrf" && !fields.includes(field))) {
    throw validation("The form contains an unsupported field. Reload and try again.");
  }
}

function booleanField(form: Readonly<Record<string, string>>, name: string): boolean {
  if (form[name] !== "true" && form[name] !== "false") {
    throw validation("Choose a valid sensor setting.");
  }
  return form[name] === "true";
}

function sensorId(form: Readonly<Record<string, string>>): string {
  const value = form.tapId;
  if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw validation("Choose a valid simulated tap.");
  }
  return value;
}

function requireRunning(controller: SimulationController): void {
  const status = controller.status();
  if (status.changing || !status.enabled) {
    throw new ApplicationError({
      category: "conflict",
      code: "simulation.not_running",
      clientMessage: status.changing
        ? "Simulation is changing. Wait a moment and try again."
        : "Enable simulation before changing a sensor.",
    });
  }
}

function messageLocation(path: string, kind: "notice" | "error", message: string): string {
  return `${path}?${kind}=${encodeURIComponent(message.slice(0, 240))}`;
}

function replaceSession(
  dependencies: SimulationRouteDependencies,
  response: ServerResponse,
  material: SessionMaterial,
): void {
  response.setHeader("set-cookie", [
    material.cookie,
    serializeCsrfCookie(material.csrfToken, material.absoluteExpiresAt, {
      secure: dependencies.canonicalOrigin?.startsWith("https://") === true,
    }),
  ]);
}

interface Action {
  readonly path: string;
  readonly fields: readonly string[];
  readonly notice: string;
  readonly returnPath?: string;
  readonly enhance?: boolean;
  readonly handle: (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    response: ServerResponse,
  ) => void | Promise<void>;
}

function registerAction(dependencies: SimulationRouteDependencies, action: Action): void {
  dependencies.router.post(action.path, async (request, response) => {
    const enhanced = action.enhance === true && request.headers.accept === "application/json";
    const context = adminContext(request, dependencies.authService);
    try {
      if (context === undefined)
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "The form could not be authorized. Reload and try again.",
        });
      const form = await readFormBody(request, { maxBytes: 1_024, maxFields: 4 });
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
          clientMessage: "The form could not be authorized. Reload and try again.",
        });
      }
      onlyFields(form, action.fields);
      await action.handle(form, context, response);
      if (enhanced) {
        sendJson(response, 200, {
          message: action.notice,
          state: projectStatus(dependencies.controller),
        });
      } else {
        redirect(
          response,
          messageLocation(action.returnPath ?? "/admin/simulator", "notice", action.notice),
        );
      }
    } catch (error) {
      if (response.headersSent) throw error;
      const failure = reportFailure(error, {
        operation: `admin.simulation:${action.path}`,
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      const message =
        context === undefined
          ? "The form could not be authorized. Reload and try again."
          : adminFailureMessage(
              failure,
              "The simulation change could not be completed. Try again.",
            );
      if (enhanced) {
        sendJson(response, failure.status, {
          message,
          code: failure.code,
          ...(failure.reference ? { reference: failure.reference } : {}),
        });
      } else {
        redirect(
          response,
          messageLocation(action.returnPath ?? "/admin/simulator", "error", message),
        );
      }
    }
  });
}

export function registerSimulationRoutes(dependencies: SimulationRouteDependencies): void {
  const { controller, router } = dependencies;
  router.get("/admin/simulator", (request, response) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }
    try {
      const query = new URL(request.url ?? "/", "http://tapboard.local").searchParams;
      const state = projectStatus(controller);
      const workspace = {
        enabled: state.enabled,
        revision: state.revision,
        changing: state.changing,
      };
      sendHtml(
        response,
        200,
        dependencies.renderer.render("/admin/simulator", {
          page: {
            title: "Simulator",
            path: "/admin/simulator",
            csrfToken: context.csrfToken,
            workspace,
            notice: query.get("notice")?.slice(0, 240),
            error: query.get("error")?.slice(0, 240),
          },
          workspace,
          simulation: state,
        }),
      );
    } catch (error) {
      if (response.headersSent) throw error;
      const failure = reportFailure(error, {
        operation: "admin.simulation.page",
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      sendHtml(
        response,
        failure.status,
        dependencies.renderer.render("/admin/error", {
          page: {
            title: "Simulator unavailable",
            path: "/admin/simulator",
            csrfToken: context.csrfToken,
            error: adminFailureMessage(failure, "The Simulator could not be loaded."),
          },
        }),
      );
    }
  });

  router.get("/api/admin/simulation", (request, response) => {
    if (adminContext(request, dependencies.authService) === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Sign in to view the Simulator." },
      });
      return;
    }
    try {
      sendJson(response, 200, { ...projectStatus(controller) });
    } catch (error) {
      if (response.headersSent) throw error;
      const failure = reportFailure(error, {
        operation: "admin.simulation.status",
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      sendJson(response, failure.status, {
        error: {
          code: failure.code,
          message: adminFailureMessage(failure, "The Simulator status could not be loaded."),
          ...(failure.reference ? { reference: failure.reference } : {}),
        },
      });
    }
  });

  registerAction(dependencies, {
    path: "/admin/simulation/enable",
    fields: [],
    notice: "Simulation enabled. Your saved sample workspace is ready.",
    handle: async (_form, context, response) => {
      replaceSession(
        dependencies,
        response,
        await controller.setEnabled(true, context.sessionToken),
      );
    },
  });
  registerAction(dependencies, {
    path: "/admin/simulation/disable",
    fields: [],
    notice: "Simulation ended. Your sample workspace is saved for next time.",
    returnPath: "/admin/system",
    handle: async (_form, context, response) => {
      replaceSession(
        dependencies,
        response,
        await controller.setEnabled(false, context.sessionToken),
      );
    },
  });
  registerAction(dependencies, {
    path: "/admin/simulation/reset",
    fields: ["confirm"],
    notice: "Simulation reset. The original sample taps are ready.",
    handle: async (form, context, response) => {
      requireRunning(controller);
      if (form.confirm !== "yes") {
        throw validation("Confirm that you want to replace your simulation and its history.");
      }
      replaceSession(dependencies, response, await controller.reset(context.sessionToken));
    },
  });
  registerAction(dependencies, {
    path: "/admin/simulation/pour",
    fields: ["tapId", "ounces"],
    notice: "Pour started. Watch the remaining beer change on the dashboard.",
    enhance: true,
    handle: (form) => {
      requireRunning(controller);
      const raw = form.ounces;
      if (raw === undefined || !/^\d{1,2}(?:\.\d{1,2})?$/u.test(raw)) {
        throw validation("Enter a pour from 1 to 32 US fl oz.");
      }
      const ounces = Number(raw);
      if (ounces < 1 || ounces > 32) throw validation("Enter a pour from 1 to 32 US fl oz.");
      controller.pour(sensorId(form), ounces);
    },
  });
  registerAction(dependencies, {
    path: "/admin/simulation/sensor",
    fields: ["tapId", "online"],
    notice: "Sensor updated.",
    enhance: true,
    handle: (form) => {
      requireRunning(controller);
      controller.setOnline(sensorId(form), booleanField(form, "online"));
    },
  });
  registerAction(dependencies, {
    path: "/admin/simulation/noise",
    fields: ["tapId", "enabled"],
    notice: "Reading noise updated.",
    enhance: true,
    handle: (form) => {
      requireRunning(controller);
      controller.setNoise(sensorId(form), booleanField(form, "enabled"));
    },
  });
}
