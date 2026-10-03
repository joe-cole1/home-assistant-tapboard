import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHtml } from "../../../infrastructure/http/html.ts";
import { displayStylesheetHref } from "../../display/palette.ts";
import { type AdminContext, pageMessage } from "./context.ts";
import type { RenderAdminDependencies } from "../contracts.ts";

export const ADMIN_NAV = [
  {
    key: "overview",
    label: "Overview",
    href: "/admin/overview",
    group: "Overview",
    mark: "O",
    activePaths: ["/admin/overview"],
  },
  {
    key: "keg-room",
    label: "Keg Room",
    href: "/admin/keg-room",
    group: "Manage",
    mark: "K",
    activePaths: ["/admin/fills", "/admin/kegs", "/admin/keg-room"],
  },
  {
    key: "taps",
    label: "Taps",
    href: "/admin/taps",
    group: "Manage",
    mark: "T",
    activePaths: ["/admin/taps"],
  },
  {
    key: "beverages",
    label: "Beverages",
    href: "/admin/beverages",
    group: "Manage",
    mark: "B",
    activePaths: ["/admin/beverages"],
  },
  {
    key: "integrations",
    label: "Integrations",
    href: "/admin/integrations",
    group: "Configure",
    mark: "I",
    activePaths: ["/admin/integrations"],
  },
  {
    key: "display",
    label: "Display",
    href: "/admin/display",
    group: "Configure",
    mark: "D",
    activePaths: ["/admin/display"],
  },
  {
    key: "tap-wars",
    label: "Tap Wars",
    href: "/admin/tap-wars",
    group: "Manage",
    mark: "W",
    activePaths: ["/admin/tap-wars"],
  },
  {
    key: "system",
    label: "System",
    href: "/admin/system",
    group: "Future",
    mark: "S",
    activePaths: ["/admin/system"],
  },
] as const;

export function adminNavItems(): readonly (typeof ADMIN_NAV)[number][] {
  return ADMIN_NAV;
}

export function renderAdmin(
  dependencies: RenderAdminDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  view: string,
  title: string,
  path: string,
  data: Readonly<Record<string, unknown>> = {},
): void {
  const message = pageMessage(request);
  const display = dependencies.displayService.getSettings();
  const {
    includeDashboardStyles: requestedDashboardStyles,
    displayStylesheetHref: requestedDisplayStylesheetHref,
    ...viewData
  } = data;
  const page = {
    title,
    path,
    csrfToken: context.csrfToken,
    siteName: display.tapboardName,
    adminAccent: display.accent,
    ...(requestedDashboardStyles === true ? { includeDashboardStyles: true } : {}),
    // Every authenticated Admin page receives the configured external display
    // stylesheet. Dedicated preview pages may explicitly request a different
    // font set (the shared preview uses `all`); ordinary pages never do.
    displayStylesheetHref:
      requestedDisplayStylesheetHref ??
      displayStylesheetHref(display.theme, display.accent, display.font),
    ...message,
  };
  sendHtml(
    response,
    200,
    dependencies.renderer.render(view, {
      page,
      navItems: adminNavItems(),
      ...viewData,
    }),
  );
}
