import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../../infrastructure/http/error-mapper.ts";
import { readFormBody, type ReadFormOptions } from "../../../infrastructure/http/form.ts";
import { readJsonBody } from "../../../infrastructure/http/security/body.ts";
import { redirect, sendHtml } from "../../../infrastructure/http/html.ts";
import { ApplicationError, isApplicationError } from "../../../shared/errors.ts";
import { adminFailureMessage, reportFailure } from "../../../shared/diagnostics.ts";
import { type AdminContext, adminContext, requestUrl, messageLocation } from "./context.ts";
import { renderAdminNotFound } from "./not-found.ts";
import { adminNavItems } from "./layout.ts";
import type {
  RegisterAdminGetDependencies,
  RunAdminAutosaveDependencies,
  RegisterAdminActionDependencies,
} from "../contracts.ts";

export function registerAdminGet(
  dependencies: RegisterAdminGetDependencies,
  path: string,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => void | Promise<void>,
): void {
  dependencies.router.get(path, async (request, response, params) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }
    try {
      await handler(request, response, context, params);
    } catch (error) {
      if (response.headersSent) throw error;
      if (isApplicationError(error) && error.category === "not_found") {
        renderAdminNotFound(dependencies, response, request, context, requestUrl(request).pathname);
        return;
      }
      const failure = reportFailure(error, {
        operation: `admin.get:${path}`,
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      sendHtml(
        response,
        failure.status,
        dependencies.renderer.render("/admin/error", {
          page: {
            title: "Admin page unavailable",
            path,
            csrfToken: context.csrfToken,
            error: adminFailureMessage(failure, "The Admin page could not be loaded."),
          },
          navItems: adminNavItems(),
        }),
      );
    }
  });
}

export interface AdminAutosaveResult {
  /** Safe, server-authoritative values for the marked form controls. */
  readonly resource: Readonly<Record<string, unknown>>;
  readonly revision: string | number;
}

export type AutosaveValidationFields = (
  error: ApplicationError,
) => Readonly<Record<string, string>>;

export interface AdminAutosaveSpec {
  readonly handle: (
    body: Readonly<Record<string, unknown>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => AdminAutosaveResult | Promise<AdminAutosaveResult>;
  readonly current: (params: Readonly<Record<string, string>>) => {
    readonly current: unknown;
    readonly revision: string | number;
  };
  /** Maps service validation failures to safe, form-linked field names. */
  readonly validationFields?: AutosaveValidationFields;
}

export function oneRequestHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

export function acceptsJson(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(",").some((part) => {
    const [mediaType, ...parameters] = part.trim().toLowerCase().split(";");
    if (mediaType !== "application/json") return false;
    const quality = parameters.find((parameter) => /^q=/u.test(parameter.trim()));
    if (quality === undefined) return true;
    const parsed = Number(quality.trim().slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}

export function isAutosaveRequest(request: IncomingMessage): boolean {
  return (
    oneRequestHeader(request.headers["x-tapboard-enhancement"]) === "autosave" &&
    acceptsJson(oneRequestHeader(request.headers.accept)) &&
    ["application/json", "application/json; charset=utf-8"].includes(
      oneRequestHeader(request.headers["content-type"])?.trim().toLowerCase() ?? "",
    )
  );
}

export function autosaveBodyRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError({
      category: "validation",
      code: "http.invalid_json",
      clientMessage: "The request body must be a JSON object.",
    });
  }
  return value as Readonly<Record<string, unknown>>;
}

export function autosaveFieldStrings(
  body: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new ApplicationError({
          category: "validation",
          code: "validation.invalid_value",
          clientMessage: "Autosave fields must be strings.",
          details: { field, reason: "must be a string" },
        });
      }
      result[field] = value;
    }
  }
  return result;
}

export function requiredAutosaveField(
  fields: Readonly<Record<string, string>>,
  field: string,
): string {
  const value = fields[field];
  if (value === undefined || value.length === 0) {
    throw new ApplicationError({
      category: "validation",
      code: "validation.invalid_value",
      clientMessage: `${field} is required before saving.`,
      details: { field, reason: "required" },
    });
  }
  return value;
}

export function validationFieldsFor(allowedFields: readonly string[]): AutosaveValidationFields {
  return (error) => {
    const field = error.details?.field;
    if (typeof field === "string" && allowedFields.includes(field)) {
      return { [field]: error.clientMessage };
    }
    const message = error.clientMessage.toLocaleLowerCase();
    const inferred = [...allowedFields]
      .sort((left, right) => right.length - left.length)
      .find(
        (candidate) =>
          message.includes(candidate.toLocaleLowerCase()) ||
          (candidate.endsWith("Mode") &&
            message.includes(candidate.slice(0, -"Mode".length).toLocaleLowerCase())),
      );
    return inferred === undefined
      ? { _form: error.clientMessage }
      : { [inferred]: error.clientMessage };
  };
}

export async function runAdminAutosave(
  dependencies: RunAdminAutosaveDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  params: Readonly<Record<string, string>>,
  spec: AdminAutosaveSpec,
): Promise<void> {
  const context = adminContext(request, dependencies.authService);
  if (context === undefined) {
    sendJson(response, 403, { message: "The autosave request could not be authorized." });
    return;
  }
  try {
    const body = autosaveBodyRecord(await readJsonBody(request));
    const authorized = dependencies.authService.authorizeCookieMutation({
      cookieHeader: request.headers.cookie,
      originHeader: request.headers.origin,
      csrfHeader: request.headers["x-csrf-token"],
      canonicalOrigin: dependencies.canonicalOrigin,
    });
    if (context === undefined || authorized?.id !== context.session.id) {
      sendJson(response, 403, { message: "The autosave request could not be authorized." });
      return;
    }
    const result = await spec.handle(body, context, params);
    sendJson(response, 200, { message: "Saved.", ...result });
  } catch (error) {
    if (response.headersSent) throw error;
    const failure = reportFailure(error, {
      operation: "admin.autosave",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    if (isApplicationError(error)) {
      if (error.category === "conflict") {
        let current: { readonly current: unknown; readonly revision: string | number } | undefined;
        try {
          current = spec.current(params);
        } catch {
          current = undefined;
        }
        sendJson(response, 409, {
          message: error.clientMessage,
          current: current?.current ?? null,
          revision: current?.revision ?? null,
        });
        return;
      }
      if (error.category === "validation") {
        const fields = spec.validationFields?.(error) ?? validationFieldsFor([])(error);
        sendJson(response, 422, {
          message: error.clientMessage,
          fields,
        });
        return;
      }
    }
    sendJson(response, failure.status, {
      message: adminFailureMessage(failure, "The autosave could not be completed."),
      code: failure.code,
      ...(failure.reference ? { reference: failure.reference } : {}),
    });
  }
}

export function registerAdminAction(
  dependencies: RegisterAdminActionDependencies,
  path: string,
  returnPath: string | ((params: Readonly<Record<string, string>>) => string),
  handler: (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) =>
    | void
    | string
    | { readonly notice: string }
    | Promise<void | string | { readonly notice: string }>,
  successMessage = "Saved.",
  readFormOptions: ReadFormOptions = {},
  autosave?: AdminAutosaveSpec,
): void {
  dependencies.router.post(path, async (request, response, params) => {
    const context = adminContext(request, dependencies.authService);
    try {
      if (autosave !== undefined && isAutosaveRequest(request)) {
        await runAdminAutosave(dependencies, request, response, params, autosave);
        return;
      }
      if (context === undefined)
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "The form could not be authorized. Reload and try again.",
        });
      const form = await readFormBody(request, readFormOptions);
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
      const handlerResult = await handler(form, context, params);
      const resolvedReturnPath = typeof returnPath === "function" ? returnPath(params) : returnPath;
      const destination = typeof handlerResult === "string" ? handlerResult : resolvedReturnPath;
      redirect(
        response,
        messageLocation(
          destination,
          "notice",
          typeof handlerResult === "object" ? handlerResult.notice : successMessage,
        ),
      );
    } catch (error) {
      if (response.headersSent) throw error;
      const failure = reportFailure(error, {
        operation: `admin.action:${path}`,
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
      const message =
        context === undefined
          ? "The form could not be authorized. Reload and try again."
          : adminFailureMessage(failure, "The change could not be completed.");
      const errorPath = typeof returnPath === "function" ? returnPath(params) : returnPath;
      redirect(response, messageLocation(errorPath, "error", message));
    }
  });
}
