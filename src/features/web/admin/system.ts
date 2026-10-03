import { APPLICATION_SCHEMA_VERSION } from "../../../infrastructure/database/migrations.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { APPLICATION_VERSION } from "../../../shared/version.ts";
import type { SystemService } from "../../system/index.ts";
import { registerAdminGet, registerAdminAction } from "./http.ts";
import { requestUrl, actor } from "./context.ts";
import { renderAdmin } from "./layout.ts";
import { humanizeAdminIdentifier } from "./detector-presentation.ts";
import { invalidForm } from "./forms.ts";
import type {
  RegisterSystemPagesDependencies,
  RegisterSystemMutationsDependencies,
  RequireSystemServiceDependencies,
} from "../contracts.ts";

export function registerSystemPages(dependencies: RegisterSystemPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/system", (request, response, context) => {
    const service = requireSystemService(dependencies);
    const url = requestUrl(request);
    const category = url.searchParams.get("category") ?? "";
    const activity = service.getActivityPage({
      ...(category === "" ? {} : { category }),
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
    });
    const nextQuery = new URLSearchParams();
    if (category !== "") nextQuery.set("category", category);
    if (activity.nextCursor !== null) nextQuery.set("cursor", activity.nextCursor);
    const diagnostics = service.getDiagnostics();
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
          version: APPLICATION_VERSION,
          ready: dependencies.isReady?.() ?? true,
          schemaVersion: APPLICATION_SCHEMA_VERSION,
          liveClients: dependencies.liveUpdates.stats(),
          connectivity: dependencies.dashboardService.getHeader().connectivityLabel,
          diagnostics,
          calculation: service.getCalculationSettings(),
          retention: service.getRetentionSettings(),
          sessionPolicy: dependencies.authService.getSessionPolicy(),
          sessions: dependencies.authService.listActiveSessions({
            currentSessionId: context.session.id,
          }),
          activity: {
            ...activity,
            category,
            hasCursor: url.searchParams.has("cursor"),
            items: activity.items.map((item) => ({
              ...item,
              actionLabel: humanizeAdminIdentifier(item.action.replaceAll(".", " ")),
              categoryLabel: humanizeAdminIdentifier(item.category),
              actorLabel: humanizeAdminIdentifier(item.actorType),
              entityLabel: `${humanizeAdminIdentifier(item.entityType, "—")}${item.entityId === null ? "" : ` ${item.entityId.slice(0, 8)}`}`,
              entityHref: systemActivityHref(item.entityType, item.entityId),
            })),
            nextHref: activity.nextCursor === null ? null : `/admin/system?${nextQuery}#activity`,
          },
        },
      },
    );
  });
}

export function registerSystemMutations(dependencies: RegisterSystemMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/system/calculation",
    "/admin/system",
    (form, context) => {
      systemFormFields(form, ["fallbackFg", "servingSizeMl"]);
      requireSystemService(dependencies).updateCalculationSettings(
        {
          fallbackFg: systemFormNumber(form, "fallbackFg"),
          servingSizeMl: systemFormNumber(form, "servingSizeMl"),
        },
        { sessionId: context.session.id },
      );
    },
    "Calculation defaults saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/system/retention",
    "/admin/system",
    (form, context) => {
      systemFormFields(form, [
        "activityDays",
        "rawSeconds",
        "receiptSeconds",
        "reconnectSeconds",
        "outboxDays",
      ]);
      requireSystemService(dependencies).updateRetentionSettings(
        {
          activity: { retentionDays: systemFormNumber(form, "activityDays") },
          telemetry: {
            rawRetentionSeconds: systemFormNumber(form, "rawSeconds"),
            receiptRetentionSeconds: systemFormNumber(form, "receiptSeconds"),
            reconnectHorizonSeconds: systemFormNumber(form, "reconnectSeconds"),
          },
          outbox: { retentionDays: systemFormNumber(form, "outboxDays") },
        },
        { sessionId: context.session.id },
      );
    },
    "Retention settings saved. Pruning runs automatically in bounded batches.",
  );
  registerAdminAction(
    dependencies,
    "/admin/system/session-policy",
    "/admin/system",
    (form, context) => {
      systemFormFields(form, ["inactivityMinutes", "absoluteMinutes", "expectedRevision"]);
      dependencies.authService.updateSessionPolicy(
        {
          inactivityMs: systemDurationMinutes(form, "inactivityMinutes"),
          absoluteMs: systemDurationMinutes(form, "absoluteMinutes"),
          expectedRevision: systemFormNumber(form, "expectedRevision"),
        },
        actor(context),
      );
    },
    "Session lifetimes saved. Shorter limits apply to existing sessions immediately.",
  );
  registerAdminAction(
    dependencies,
    "/admin/system/sessions/:id/revoke",
    "/admin/system",
    (form, context, params) => {
      systemFormFields(form, ["confirm"]);
      if (form.confirm !== "revoke") invalidForm("Confirm the session revocation.");
      dependencies.authService.revokeSessionById(params.id, actor(context));
      return params.id === context.session.id ? "/admin/login" : "/admin/system";
    },
    "Session revoked.",
  );
  registerAdminAction(
    dependencies,
    "/admin/system/pin",
    "/admin/system",
    async (form, context) => {
      systemFormFields(form, ["currentPin", "newPin", "confirmPin"]);
      if (form.newPin !== form.confirmPin) invalidForm("The new PINs must match.");
      if (!/^\d{4}$/u.test(form.newPin ?? "")) invalidForm("Use exactly four ASCII digits.");
      await dependencies.authService.changePin(form.currentPin, form.newPin, actor(context));
      return "/admin/login";
    },
    "PIN changed. Sign in again; all previous sessions were revoked.",
  );
}

export function requireSystemService(
  dependencies: RequireSystemServiceDependencies,
): SystemService {
  if (dependencies.systemService === undefined) {
    throw new ApplicationError({
      category: "unavailable",
      code: "system.unavailable",
      clientMessage: "System administration is unavailable.",
    });
  }
  return dependencies.systemService;
}

export function systemFormFields(
  form: Readonly<Record<string, string>>,
  fields: readonly string[],
): void {
  if (Object.keys(form).some((key) => key !== "_csrf" && !fields.includes(key))) {
    invalidForm("The System form contains an unsupported field.");
  }
  if (fields.some((field) => form[field] === undefined || form[field] === "")) {
    invalidForm("Complete all fields before saving.");
  }
}

export function systemFormNumber(form: Readonly<Record<string, string>>, field: string): number {
  const value = form[field];
  if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) {
    invalidForm("Enter a valid number.", field);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) invalidForm("Enter a valid number.", field);
  return parsed;
}

export function systemActivityHref(
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (entityType === null || entityId === null) return null;
  const paths: Readonly<Record<string, string>> = {
    beverage: "/admin/beverages",
    keg: "/admin/kegs",
    fill: "/admin/fills",
    tap: "/admin/taps",
  };
  const path = paths[entityType];
  return path === undefined ? null : `${path}/${encodeURIComponent(entityId)}`;
}

export function systemDurationMinutes(
  form: Readonly<Record<string, string>>,
  field: string,
): number {
  const milliseconds = systemFormNumber(form, field) * 60_000;
  const rounded = Math.round(milliseconds);
  // Displayed integer milliseconds can acquire a few floating-point bits
  // when converted to minutes and back. Preserve that valid round trip while
  // rejecting durations that genuinely specify fractional milliseconds.
  const tolerance = Math.max(1, Math.abs(milliseconds)) * Number.EPSILON * 4;
  if (!Number.isSafeInteger(rounded) || Math.abs(milliseconds - rounded) > tolerance) {
    invalidForm("Session lifetimes must resolve to whole milliseconds.", field);
  }
  return rounded;
}
