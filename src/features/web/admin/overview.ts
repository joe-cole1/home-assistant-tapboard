import { sendJson } from "../../../infrastructure/http/error-mapper.ts";
import { searchAdminDestinations } from "../admin-search.ts";
import { registerAdminGet } from "./http.ts";
import { isActionableHealth } from "./presentation.ts";
import { renderAdmin, adminNavItems } from "./layout.ts";
import { humanizeAdminIdentifier, healthCheckPresentation } from "./detector-presentation.ts";
import { requestUrl, adminContext } from "./context.ts";
import type {
  RegisterOverviewPagesDependencies,
  RegisterAdminEventRoutesDependencies,
} from "../contracts.ts";

export function registerOverviewPages(dependencies: RegisterOverviewPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/overview", (request, response, context) => {
    const taps = dependencies.tapService.listTaps();
    const fills = dependencies.fillService.listFills();
    const health = dependencies.healthService.listAdminOverview();
    const actionableHealth = health.filter((item) =>
      isActionableHealth(item.aggregate.state, item.aggregate.severity),
    );
    const kegs = dependencies.kegService.listKegs();
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
            value: actionableHealth.length,
          },
        ],
        taps: taps.map((tap) => ({
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          enabled: tap.enabled,
          isRetired: tap.isRetired,
          beverageName: tap.activeAssignment?.beverageName ?? null,
          href: `/admin/taps/${encodeURIComponent(tap.id)}`,
        })),
        health: actionableHealth.map((item) => ({
          tapId: item.tapId,
          tapNumber: taps.find((tap) => tap.id === item.tapId)?.tapNumber ?? null,
          tapName: item.name,
          href: `/admin/taps/${encodeURIComponent(item.tapId)}`,
          state: item.aggregate.state,
          stateLabel: humanizeAdminIdentifier(item.aggregate.state),
          severity: item.aggregate.severity,
          severityLabel: humanizeAdminIdentifier(item.aggregate.severity),
          checks: (item.checks ?? [])
            .filter((check) => isActionableHealth(check.state, check.severity))
            .map((check) => ({
              id: check.checkId,
              label: healthCheckPresentation(check.checkId).title,
              state: check.state,
              stateLabel: humanizeAdminIdentifier(check.state),
              severity: check.severity,
              severityLabel: humanizeAdminIdentifier(check.severity),
              reason: check.reason,
              reasonLabel: check.reason === null ? null : humanizeAdminIdentifier(check.reason),
            })),
        })),
        kegRoom: {
          activeKegs: kegs.filter((keg) => keg.isActive).length,
          onTap: fills.filter((fill) => fill.state === "on_tap").length,
          onDeck: fills.filter((fill) => fill.state === "on_deck").length,
          available: fills.filter((fill) => fill.state === "available").length,
          href: "/admin/keg-room",
        },
        connectivity: { state: header.connectivity, label: header.connectivityLabel },
        integrations: {
          telemetryConfigured,
          brewfatherConfigured: brewfather.configured,
          brewfatherEnabled: brewfather.account?.enabled ?? false,
          brewfatherApiKeyConfigured: brewfather.apiKeyConfigured,
          brewfatherLinkedBeverages: brewfather.totalLinkedBeverages,
        },
        quickLinks: [
          { label: "Manage Taps", href: "/admin/taps" },
          { label: "Open Keg Room", href: "/admin/keg-room" },
          { label: "Manage Beverages", href: "/admin/beverages" },
          { label: "Configure Integrations", href: "/admin/integrations" },
          { label: "Adjust Display", href: "/admin/display" },
        ],
      },
    );
  });

  registerAdminGet(dependencies, "/admin/jump", (request, response, context) => {
    const rawQuery = requestUrl(request).searchParams.get("q") ?? "";
    const jump = searchAdminDestinations({
      query: rawQuery,
      destinations: adminNavItems(),
      services: {
        taps: dependencies.tapService,
        beverages: dependencies.beverageService,
        fills: dependencies.fillService,
        kegs: dependencies.kegService,
        telemetry: dependencies.telemetryService,
      },
    });
    renderAdmin(dependencies, response, request, context, "/admin/jump", "Jump", "/admin/jump", {
      jump,
    });
  });
}

export function registerAdminEventRoutes(dependencies: RegisterAdminEventRoutesDependencies): void {
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
