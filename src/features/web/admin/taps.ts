import { ApplicationError } from "../../../shared/errors.ts";
import { getVesselDescriptor } from "../../story/vessels.ts";
import { type TapService } from "../../taps/service.ts";
import { mergeDetectorConfig } from "../../telemetry/detector-config.ts";
import { validateCompleteDetectorConfig } from "../../telemetry/detector-validation.ts";
import { adminTapPageQueryFromRequest, adminTapPageHref } from "./list-query.ts";
import { safeTapOverrideResource } from "../presenters/display.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import {
  fallbackAdminTapPage,
  safeDashboardTap,
  safeHealthOverview,
  tapRemainingLabel,
} from "./tap-presentation.ts";
import { renderAdmin } from "./layout.ts";
import { renderTapDetail } from "./tap-detail.ts";
import { nullable, nullableNumber, invalidForm } from "./forms.ts";
import { actor } from "./context.ts";
import { tapCardOverrideFromForm } from "./presentation-overrides.ts";
import { detectorOverrideFromForm, healthOverrideFromForm } from "./detector-presentation.ts";
import type {
  RegisterTapPagesDependencies,
  RegisterTapMutationsDependencies,
} from "../contracts.ts";

export function registerTapPages(dependencies: RegisterTapPagesDependencies): void {
  // Keep the static create path ahead of /:id so "new" can never be treated
  // as a Tap identifier by the small path router.
  registerAdminGet(dependencies, "/admin/taps", (request, response, context) => {
    const query = adminTapPageQueryFromRequest(request);
    const index = fallbackAdminTapPage(dependencies.tapService, query);
    const previousPage =
      index.page > 1
        ? adminTapPageHref({ q: index.query, state: index.state }, index.page - 1)
        : null;
    const nextPage =
      index.page < index.pageCount
        ? adminTapPageHref({ q: index.query, state: index.state }, index.page + 1)
        : null;
    const rows = index.items.map((item) => {
      const publicCard = safeDashboardTap(
        dependencies.dashboardService,
        item.id,
        dependencies.logger,
      );
      const health = safeHealthOverview(dependencies.healthService, item.id, dependencies.logger);
      return {
        ...item,
        assignmentLabel:
          item.assignment === null
            ? "Unassigned"
            : (item.assignment.beverageName ?? "Assigned fill"),
        kegLabel:
          item.assignment === null || item.assignment.kegNumber === null
            ? null
            : `Keg ${item.assignment.kegNumber}${item.assignment.kegLabel ? ` — ${item.assignment.kegLabel}` : ""}`,
        remaining: tapRemainingLabel(publicCard, item.assignment !== null),
        healthLabel:
          health.state === "healthy"
            ? "Healthy"
            : health.state === "degraded"
              ? "Degraded"
              : health.state === "not_configured"
                ? "Not configured"
                : health.state === "active"
                  ? "Active"
                  : "Unknown",
        statusLabel: item.isRetired ? "Retired" : item.enabled ? "Enabled" : "Disabled",
        publicCard:
          publicCard === null
            ? null
            : {
                ...publicCard,
                graphic: publicCard.graphic ?? getVesselDescriptor(publicCard.graphicId),
                title: publicCard.title ?? publicCard.beverageName ?? `Tap ${item.tapNumber}`,
                accessibleLabel:
                  publicCard.accessibleLabel ??
                  publicCard.beverageName ??
                  `Tap ${item.tapNumber} preview`,
              },
        health,
      };
    });
    renderAdmin(dependencies, response, request, context, "/admin/taps", "Taps", "/admin/taps", {
      taps: rows,
      query: index.query,
      state: index.state,
      pagination: {
        page: index.page,
        pageCount: index.pageCount,
        total: index.total,
        previousHref: previousPage,
        nextHref: nextPage,
      },
    });
  });

  registerAdminGet(dependencies, "/admin/taps/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-new",
      "New Tap",
      "/admin/taps/new",
    );
  });

  registerAdminGet(dependencies, "/admin/taps/:id", (request, response, context, params) => {
    renderTapDetail(dependencies, request, response, context, params);
  });
}

export function registerTapMutations(dependencies: RegisterTapMutationsDependencies): void {
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      if (isTapNameOnlyForm(form)) {
        dependencies.tapService.autosaveName(
          params.id!,
          form.updatedAt!,
          { name: nullable(form.name) },
          actor(context),
        );
        return;
      }
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
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", "name"]);
        const updated = dependencies.tapService.autosaveName(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          { name: nullable(fields.name) },
          actor(context),
        );
        return {
          resource: { name: updated.name },
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.tapService.getTap(params.id!);
        return {
          current: { name: current.name, updatedAt: current.updatedAt },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor(["updatedAt", "name"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/assign",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.tapService.assignFill(params.id!, { fillId: form.fillId }, actor(context));
    },
    "Fill assigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/mystery",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    "/admin/taps/:id/display",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.displayService.setTapCardOverride(
        params.id!,
        tapCardOverrideFromForm(form),
        actor(context),
      );
    },
    "Tap-card display override saved.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, [
          "updatedAt",
          "showAbv",
          "showIbu",
          "showOg",
          "showFg",
          "showSrm",
        ]);
        const updated = dependencies.displayService.autosaveTapCardOverride(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          tapCardOverrideFromForm(fields),
          actor(context),
        );
        return {
          resource: safeTapOverrideResource(
            dependencies.displayService.getEffectiveTapCardSettings(params.id!),
          ),
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.tapService.getTap(params.id!);
        return {
          current: {
            tapId: params.id,
            updatedAt: current.updatedAt,
            settings: dependencies.displayService.getEffectiveTapCardSettings(params.id!).settings,
          },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor([
        "updatedAt",
        "showAbv",
        "showIbu",
        "showOg",
        "showFg",
        "showSrm",
      ]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/unassign",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (_form, context, params) => {
      dependencies.tapService.unassign(params.id!, actor(context));
    },
    "Tap unassigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/move",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (_form, context, params) => {
      dependencies.detectorService.manualRebaseline(params.id!, actor(context));
    },
    "Tap rebaseline requested.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/maintenance",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
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
    "/admin/taps/:id/delete",
    "/admin/taps",
    (form, context, params) => {
      const confirmation = form.confirmation ?? "";
      if (confirmation.trim().length === 0) {
        invalidForm("Type the exact visible Tap label to confirm permanent deletion.");
      }
      const service = dependencies.tapService as TapService & {
        readonly deleteTapConfirmed?: (
          tapId: unknown,
          confirmation: unknown,
          input?: { readonly reason?: string | null },
          actor?: { readonly actorType?: "admin"; readonly sessionId?: string },
        ) => void;
      };
      if (typeof service.deleteTapConfirmed === "function") {
        const reason = nullable(form.reason);
        service.deleteTapConfirmed(
          params.id!,
          confirmation,
          reason === undefined ? {} : { reason },
          actor(context),
        );
        return;
      }
      // Compatibility for narrow service doubles; the production service
      // always takes the confirmed transactional path above.
      dependencies.tapService.deleteTap(
        params.id!,
        { confirmation, reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Tap deleted.",
  );
}

export function isTapNameOnlyForm(form: Readonly<Record<string, string>>): boolean {
  if (form.updatedAt === undefined || form.name === undefined) return false;
  return Object.keys(form).every(
    (field) => field === "_csrf" || field === "updatedAt" || field === "name",
  );
}
