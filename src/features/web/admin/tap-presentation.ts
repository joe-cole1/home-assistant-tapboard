import { reportFailure } from "../../../shared/diagnostics.ts";
import type { Logger } from "../../../shared/logging.ts";
import type { DashboardService } from "../../dashboard/service.ts";
import type { PublicTapCardView } from "../../dashboard/types.ts";
import type { HealthService } from "../../health/service.ts";
import type { PublicTapCardMetricSettings } from "../../story/service.ts";
import { getVesselDescriptor } from "../../story/vessels.ts";
import { type TapService } from "../../taps/service.ts";
import type { AdminTapPage, AdminTapPageItem, AdminTapPageState } from "../../taps/types.ts";
import { humanizeAdminIdentifier, healthCheckPresentation } from "./detector-presentation.ts";

export function fallbackAdminTapPage(
  tapService: TapService,
  query: Readonly<{ readonly q: string; readonly state: AdminTapPageState; readonly page: number }>,
): AdminTapPage {
  const candidate = tapService as TapService & {
    readonly listAdminPage?: (input?: unknown) => AdminTapPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);

  const all = tapService.listTaps();
  const filtered = all
    .filter((tap) => {
      switch (query.state) {
        case "assigned":
          return tap.activeAssignment !== null && tap.activeAssignment !== undefined;
        case "unassigned":
          return tap.activeAssignment === null || tap.activeAssignment === undefined;
        case "disabled":
          return !tap.enabled;
        case "retired":
          return tap.isRetired;
        case "all":
          return true;
      }
    })
    .sort((left, right) => left.tapNumber - right.tapNumber || left.id.localeCompare(right.id));
  const needle = query.q.toLocaleLowerCase();
  const searched =
    needle.length === 0
      ? filtered
      : filtered.filter((tap) => {
          const assignment = tap.activeAssignment;
          const lifecycle = tap.isRetired ? "retired" : tap.enabled ? "enabled" : "disabled";
          const assignmentState =
            assignment === undefined || assignment === null ? "unassigned" : "assigned";
          return `${tap.tapNumber} ${tap.name ?? ""} ${assignment?.beverageName ?? ""} ${assignment?.kegNumber ?? ""} ${assignment?.kegLabel ?? ""} ${lifecycle} ${assignmentState}`
            .toLocaleLowerCase()
            .includes(needle);
        });
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(query.page, pageCount);
  const items: AdminTapPageItem[] = searched.slice((page - 1) * 25, page * 25).map((tap) => ({
    id: tap.id,
    tapNumber: tap.tapNumber,
    name: tap.name,
    enabled: tap.enabled,
    isRetired: tap.isRetired,
    firstUsedAt: tap.firstUsedAt,
    retiredAt: tap.retiredAt,
    assignment:
      tap.activeAssignment === null || tap.activeAssignment === undefined
        ? null
        : {
            id: tap.activeAssignment.id,
            fillId: tap.activeAssignment.fillId,
            beverageId: tap.activeAssignment.beverageId,
            beverageName: tap.activeAssignment.beverageName,
            kegId: tap.activeAssignment.kegId,
            kegNumber: tap.activeAssignment.kegNumber,
            kegLabel: tap.activeAssignment.kegLabel,
            assignedAt: tap.activeAssignment.assignedAt,
          },
    updatedAt: tap.updatedAt,
  }));
  return { items, total, page, pageSize: 25, pageCount, query: query.q, state: query.state };
}

export function safeDashboardTap(
  dashboardService: DashboardService,
  tapId: string,
  logger?: Logger,
): PublicTapCardView | null {
  const candidate = dashboardService as DashboardService & {
    readonly getTap?: (id: string) => PublicTapCardView | undefined;
  };
  if (typeof candidate.getTap !== "function") return null;
  try {
    const card = candidate.getTap(tapId);
    return card === undefined ? null : card;
  } catch (error) {
    reportFailure(error, {
      operation: "admin.projection.dashboard_tap",
      ...(logger ? { logger } : {}),
    });
    return null;
  }
}

export const ALL_TAP_CARD_METRICS: PublicTapCardMetricSettings = Object.freeze({
  showAbv: true,
  showIbu: true,
  showOg: true,
  showFg: true,
  showSrm: true,
});

export function safeDashboardTapPreview(
  dashboardService: DashboardService,
  tapId: string,
  settings?: PublicTapCardMetricSettings,
  logger?: Logger,
): PublicTapCardView | null {
  const candidate = dashboardService as DashboardService & {
    readonly getTapPreview?: (
      id: string,
      metricSettings: PublicTapCardMetricSettings,
    ) => PublicTapCardView | undefined;
  };
  if (settings !== undefined && typeof candidate.getTapPreview === "function") {
    try {
      const card = candidate.getTapPreview(tapId, settings);
      return card === undefined ? null : card;
    } catch (error) {
      reportFailure(error, {
        operation: "admin.projection.dashboard_preview",
        ...(logger ? { logger } : {}),
      });
      return null;
    }
  }
  return safeDashboardTap(dashboardService, tapId, logger);
}

export function previewMetricCatalog(
  card: PublicTapCardView | null,
): Readonly<Record<string, string>> {
  if (card === null) return {};
  const result: Record<string, string> = {};
  if (typeof card.abv === "number" && Number.isFinite(card.abv))
    result.abv = `${card.abv.toFixed(1)}%`;
  for (const metric of card.metrics) {
    if (["ibu", "og", "fg", "srm"].includes(metric.key)) result[metric.key] = metric.value;
  }
  return result;
}

export function previewSampleCard(metricSettings: PublicTapCardMetricSettings): PublicTapCardView {
  const metrics = [
    ["abv", "ABV", "5.0%"],
    ["ibu", "IBU", "42"],
    ["og", "OG", "1.054"],
    ["fg", "FG", "1.012"],
    ["srm", "SRM", "4.0"],
  ] as const;
  const visibility = {
    abv: metricSettings.showAbv,
    ibu: metricSettings.showIbu,
    og: metricSettings.showOg,
    fg: metricSettings.showFg,
    srm: metricSettings.showSrm,
  } as const;
  return {
    id: "preview-tap",
    tapNumber: 1,
    tapName: "Preview Tap",
    graphicId: "pint_glass",
    graphic: getVesselDescriptor("pint_glass"),
    displayColor: "#D97706",
    beverageName: "Northbound Pale Ale",
    style: "American Pale Ale",
    abv: 5,
    metrics: metrics
      .filter(([key]) => visibility[key])
      .map(([key, label, value]) => ({ key, label, value })),
    description: "Citrus peel, soft pine, and a crisp finish.",
    title: "Northbound Pale Ale",
    accessibleLabel: "Tap 1, Northbound Pale Ale",
    storyPath: null,
    fillId: null,
    fillPercent: 62,
    remainingVolumeMl: 12000,
    capacityMl: 19400,
    servingsRemaining: 25,
    daysRemaining: 4,
    temperatureC: 4,
    waitingForMeasurement: false,
    health: "healthy",
    badges: [],
  };
}

export function safeHealthOverview(
  healthService: HealthService,
  tapId: string,
  logger?: Logger,
): Record<string, unknown> {
  try {
    const overview = healthService.getAdminOverview(tapId) as unknown as Record<string, unknown>;
    const aggregate = overview.aggregate as Record<string, unknown> | undefined;
    const state = typeof aggregate?.state === "string" ? aggregate.state : "unknown";
    const severity = typeof aggregate?.severity === "string" ? aggregate.severity : "none";
    return {
      state,
      stateLabel: humanizeAdminIdentifier(state),
      severity,
      severityLabel: humanizeAdminIdentifier(severity),
      activeIncidentCount:
        typeof overview.activeIncidentCount === "number" ? overview.activeIncidentCount : 0,
      checks: Array.isArray(overview.checks)
        ? overview.checks.map((check) => {
            const value = check as Record<string, unknown>;
            const id = typeof value.checkId === "string" ? value.checkId : "unknown";
            const state = typeof value.state === "string" ? value.state : "unknown";
            const severity = typeof value.severity === "string" ? value.severity : "none";
            const reason = typeof value.reason === "string" ? value.reason : null;
            return {
              id,
              label: healthCheckPresentation(id).title,
              state,
              stateLabel: humanizeAdminIdentifier(state),
              severity,
              severityLabel: humanizeAdminIdentifier(severity),
              reason,
              reasonLabel: reason === null ? null : humanizeAdminIdentifier(reason),
            };
          })
        : [],
      lineCleaning: overview.lineCleaning ?? null,
    };
  } catch (error) {
    reportFailure(error, {
      operation: "admin.projection.health_overview",
      ...(logger ? { logger } : {}),
    });
    return {
      state: "unknown",
      stateLabel: "Unknown",
      severity: "none",
      severityLabel: "None",
      activeIncidentCount: 0,
      checks: [],
      lineCleaning: null,
    };
  }
}

export function tapRemainingLabel(card: PublicTapCardView | null, assigned: boolean): string {
  if (card?.waitingForMeasurement === true) return "Waiting for measurement";
  if (typeof card?.fillPercent === "number" && Number.isFinite(card.fillPercent)) {
    return `${Math.round(Math.min(100, Math.max(0, card.fillPercent)))}% remaining`;
  }
  if (assigned) return "Measurement unavailable";
  return "Not assigned";
}

export function safeMysteryPreview(
  card: PublicTapCardView | null,
  isMystery: boolean,
): PublicTapCardView | null {
  if (card === null) return null;
  if (!isMystery) return card;
  // The public projection is authoritative, but its normal dashboard identity
  // attributes are not appropriate inside the privileged page's Mystery
  // preview. Preserve only the public Mystery-safe content and exemptions.
  return {
    ...card,
    id: "",
    tapName: null,
    beverageName: null,
    fillId: null,
    storyPath: null,
    title: "Mystery Tap",
    accessibleLabel: `Tap ${card.tapNumber}, Mystery Tap`,
  };
}

export function safePublicTapCards(
  dashboardService: DashboardService,
  logger?: Logger,
): readonly PublicTapCardView[] {
  const candidate = dashboardService as DashboardService & {
    readonly listTaps?: () => readonly PublicTapCardView[];
  };
  if (typeof candidate.listTaps !== "function") return [];
  try {
    const cards = candidate.listTaps();
    return [...cards].slice(0, 1_000);
  } catch (error) {
    reportFailure(error, {
      operation: "admin.projection.public_cards",
      ...(logger ? { logger } : {}),
    });
    // The privileged Admin projection remains usable if a public preview is
    // unavailable. Public card data is enhancement-only here.
    return [];
  }
}
