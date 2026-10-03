import type { IncomingMessage, ServerResponse } from "node:http";
import { reportFailure } from "../../../shared/diagnostics.ts";
import type { HealthService } from "../../health/service.ts";
import { tapDeletionConfirmationLabel, type TapService } from "../../taps/service.ts";
import { DETECTOR_CONFIG_FIELDS, mergeDetectorConfig } from "../../telemetry/detector-config.ts";
import { HEALTH_CHECK_IDS } from "../../health/types.ts";
import { type AdminContext } from "./context.ts";
import {
  safeDashboardTap,
  safeMysteryPreview,
  safeDashboardTapPreview,
  ALL_TAP_CARD_METRICS,
  safeHealthOverview,
  previewMetricCatalog,
} from "./tap-presentation.ts";
import {
  DETECTOR_FIELD_PRESENTATION,
  formatAdminConfigValue,
  DETECTOR_GROUPS,
} from "./detector-presentation.ts";
import { HEALTH_SECTION_PRESENTATION } from "./health-presentation.ts";
import { renderAdmin } from "./layout.ts";
import { adminTimestampLabel } from "./presentation.ts";
import type { RenderTapDetailDependencies } from "../contracts.ts";

export function renderTapDetail(
  dependencies: RenderTapDetailDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  context: AdminContext,
  params: Readonly<Record<string, string>>,
) {
  const id = params.id ?? "";
  const tap = dependencies.tapService.getTap(id);
  const assignment = tap.activeAssignment ?? null;
  const publicCard = safeDashboardTap(dependencies.dashboardService, id, dependencies.logger);
  let mystery: ReturnType<TapService["getAssignmentMystery"]> | null = null;
  let mysteryLookupFailed = false;
  try {
    if (assignment !== null) mystery = dependencies.tapService.getAssignmentMystery(id);
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.mystery",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    mystery = null;
    mysteryLookupFailed = assignment !== null;
  }
  const preview = mysteryLookupFailed
    ? null
    : safeMysteryPreview(publicCard, mystery?.enabled === true);
  const previewCatalogCard = mysteryLookupFailed
    ? null
    : safeMysteryPreview(
        safeDashboardTapPreview(
          dependencies.dashboardService,
          id,
          ALL_TAP_CARD_METRICS,
          dependencies.logger,
        ),
        mystery?.enabled === true,
      );
  const telemetrySources = dependencies.telemetryService
    .listSources()
    .slice(0, 200)
    .map((source) => ({ id: source.id, name: source.name }));
  const sourceNames = new Map(telemetrySources.map((source) => [source.id, source.name]));

  let authoritySourceId = "";
  let authorityName = "None";
  try {
    const authority = dependencies.telemetryService.getTapAuthority(id);
    authoritySourceId = authority?.sourceId ?? "";
    authorityName =
      authority === undefined
        ? "None"
        : (sourceNames.get(authority.sourceId) ?? "Configured source");
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.authority",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    authorityName = "Unavailable";
  }

  let detectorFields: readonly Record<string, unknown>[] = [];
  try {
    const detectorGlobal = dependencies.detectorService.getGlobalConfig();
    const detectorOverride = dependencies.detectorService.getTapOverride(id)?.override ?? {};
    const detectorEffective = mergeDetectorConfig(detectorGlobal.config, detectorOverride);
    detectorFields = DETECTOR_CONFIG_FIELDS.map((field) => ({
      name: field,
      ...DETECTOR_FIELD_PRESENTATION[field],
      effective: detectorEffective[field],
      override: detectorOverride[field] ?? null,
      effectiveLabel: formatAdminConfigValue(
        detectorEffective[field],
        DETECTOR_FIELD_PRESENTATION[field].unit,
      ),
    }));
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.detector_config",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    detectorFields = [];
  }

  let healthConfig: {
    readonly effective: Record<string, unknown>;
    readonly override: Record<string, unknown> | null;
  } | null = null;
  try {
    const value = dependencies.healthService.getEffectiveConfig(id) as unknown as {
      readonly effective: Record<string, unknown>;
      readonly override?: Record<string, unknown> | null;
    };
    healthConfig = { effective: value.effective, override: value.override ?? null };
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.health_config",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    healthConfig = null;
  }
  const healthOverview = safeHealthOverview(dependencies.healthService, id, dependencies.logger);
  const healthSections =
    healthConfig === null
      ? []
      : HEALTH_CHECK_IDS.map((checkId) => {
          const presentation = HEALTH_SECTION_PRESENTATION[checkId];
          const effective = healthConfig?.effective[checkId];
          const effectiveFields =
            effective !== null && typeof effective === "object"
              ? Object.entries(effective as Record<string, unknown>)
              : [];
          const rawOverride = healthConfig?.override?.[checkId];
          const overrideFields =
            rawOverride !== null && typeof rawOverride === "object"
              ? new Map(Object.entries(rawOverride as Record<string, unknown>))
              : new Map<string, unknown>();
          return {
            id: checkId,
            title: presentation.title,
            description: presentation.description,
            fields: effectiveFields.map(([field, value]) => ({
              name: field,
              ...(presentation.fields[field] ?? {
                label: "Setting",
                help: "Tap-specific health setting.",
              }),
              effective: value,
              override: overrideFields.get(field) ?? null,
              effectiveLabel: formatAdminConfigValue(value, presentation.fields[field]?.unit),
            })),
          };
        });

  const detectorGroups = DETECTOR_GROUPS.map((group) => ({
    ...group,
    fields: detectorFields.filter((field) => field.group === group.id),
  })).filter((group) => group.fields.length > 0);

  let tapCard: Record<string, unknown> | null = null;
  try {
    const effective = dependencies.displayService.getEffectiveTapCardSettings?.(id);
    if (effective !== undefined)
      tapCard = {
        override: effective.override,
        effective: effective.settings,
        defaults: dependencies.displayService.getTapCardSettings(),
      };
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.tap_card",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    tapCard = null;
  }

  let maintenance: readonly Record<string, unknown>[] = [];
  try {
    const candidate = dependencies.healthService as HealthService & {
      readonly getAdminMaintenancePage?: (
        tapId: string,
        options?: unknown,
      ) => { readonly records: readonly Record<string, unknown>[] };
    };
    const page = candidate.getAdminMaintenancePage?.(id, { limit: 25 });
    maintenance = (page?.records ?? []) as unknown as readonly Record<string, unknown>[];
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.maintenance",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    maintenance = [];
  }

  let assignableFills: readonly Record<string, unknown>[] = [];
  try {
    const fillsById = new Map<
      string,
      ReturnType<typeof dependencies.fillService.listFills>[number]
    >();
    for (const fill of [
      ...dependencies.fillService.listFills({ state: "available" }),
      ...dependencies.fillService.listFills({ state: "on_deck" }),
    ]) {
      if (!fillsById.has(fill.id)) fillsById.set(fill.id, fill);
    }
    assignableFills = [...fillsById.values()]
      .sort((left, right) => {
        const stateOrder = (state: string): number => (state === "available" ? 0 : 1);
        const stateDifference = stateOrder(left.state) - stateOrder(right.state);
        if (stateDifference !== 0) return stateDifference;
        const leftQueueOrder = left.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
        const rightQueueOrder = right.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
        if (leftQueueOrder !== rightQueueOrder) return leftQueueOrder - rightQueueOrder;
        const dateDifference = left.fillDate.localeCompare(right.fillDate);
        return dateDifference !== 0 ? dateDifference : left.id.localeCompare(right.id);
      })
      .slice(0, 200)
      .map((fill) => ({
        id: fill.id,
        beverageName: fill.beverageName,
        kegNumber: fill.kegNumber,
        kegLabel: fill.kegLabel,
        label: `${fill.beverageName} — Keg ${fill.kegNumber}${fill.kegLabel ? ` — ${fill.kegLabel}` : ""}`,
      }));
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.assignable_fills",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    assignableFills = [];
  }

  const moveTargets = dependencies.tapService
    .listTaps()
    .filter((candidate) => candidate.id !== id && !candidate.isRetired)
    .slice(0, 200)
    .map((candidate) => ({
      id: candidate.id,
      tapNumber: candidate.tapNumber,
      name: candidate.name,
    }));
  let deletionImpact: ReturnType<TapService["getTapDeletionImpact"]> | null = null;
  try {
    deletionImpact = dependencies.tapService.getTapDeletionImpact(id);
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.deletion_impact",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    deletionImpact = null;
  }
  let displayDefaults: Record<string, unknown> = { unitSystem: "us", remainingMode: "percent" };
  try {
    displayDefaults = dependencies.dashboardService.getDisplayDefaults() as unknown as Record<
      string,
      unknown
    >;
  } catch (error) {
    reportFailure(error, {
      operation: "admin.tap.display_defaults",
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    });
    // Keep the deterministic preview fallback for small service doubles.
  }

  renderAdmin(
    dependencies,
    response,
    request,
    context,
    "/admin/tap-detail",
    `Tap ${tap.tapNumber}${tap.name ? ` — ${tap.name}` : ""}`,
    "/admin/taps",
    {
      tap: {
        identity: {
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          createdAt: tap.createdAt,
          updatedAt: tap.updatedAt,
          updatedAtLabel: adminTimestampLabel(tap.updatedAt),
          confirmationLabel: tapDeletionConfirmationLabel(tap),
        },
        lifecycle: {
          enabled: tap.enabled,
          isRetired: tap.isRetired,
          firstUsedAt: tap.firstUsedAt,
          firstUsedAtLabel: adminTimestampLabel(tap.firstUsedAt),
          retiredAt: tap.retiredAt,
        },
        configuration: {
          gasType: tap.gasType,
          servingPressureKpa: tap.servingPressureKpa,
          lineLengthMm: tap.lineLengthMm,
          lineDiameterMm: tap.lineDiameterMm,
          notes: tap.notes,
        },
        assignment: {
          active:
            assignment === null
              ? null
              : {
                  ...assignment,
                  assignedAtLabel: adminTimestampLabel(assignment.assignedAt),
                },
          mystery,
        },
        telemetry: { authorityName, authoritySourceId, sources: telemetrySources },
        detector: { fields: detectorFields, groups: detectorGroups },
        health: { overview: healthOverview, sections: healthSections },
        display: { tapCard },
        maintenance: { records: maintenance },
        assignableFills,
        moveTargets,
        deletionImpact,
        publicPreview: preview,
        previewMetricCatalog: previewMetricCatalog(previewCatalogCard),
        publicCard,
        displayDefaults,
      },
      includeDashboardStyles: true,
    },
  );
}
