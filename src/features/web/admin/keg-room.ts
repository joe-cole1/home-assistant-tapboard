import { redirect } from "../../../infrastructure/http/html.ts";
import type { DashboardService } from "../../dashboard/service.ts";
import type { PublicTapCardView } from "../../dashboard/types.ts";
import { fillDeletionConfirmationLabel, type FillService } from "../../fills/service.ts";
import type { AdminFillPage, AdminFillView } from "../../fills/types.ts";
import { kegDeletionConfirmationLabel, type KegService } from "../../kegs/service.ts";
import type { AdminKegPage } from "../../kegs/types.ts";
import { getVesselDescriptor } from "../../story/vessels.ts";
import {
  adminFillPageQueryFromRequest,
  adminKegPageQueryFromRequest,
  adminFillPageHref,
  adminKegPageHref,
} from "./list-query.ts";
import {
  registerAdminGet,
  registerAdminAction,
  autosaveFieldStrings,
  requiredAutosaveField,
  validationFieldsFor,
} from "./http.ts";
import { safePublicTapCards } from "./tap-presentation.ts";
import { renderAdmin } from "./layout.ts";
import { capacityLabel, tareLabel } from "./presentation.ts";
import { nullable, optionalNumber, invalidForm } from "./forms.ts";
import { actor } from "./context.ts";
import {
  safeVesselForDisplay,
  safeColorForDisplay,
  boundedAdminString,
} from "./beverage-presentation.ts";
import type {
  RegisterKegRoomPagesDependencies,
  RegisterKegRoomMutationsDependencies,
} from "../contracts.ts";

export function registerKegRoomPages(dependencies: RegisterKegRoomPagesDependencies): void {
  // Canonical Keg Room index. Ended fills are deliberately omitted unless the
  // operator asks for history through the validated state filter.
  registerAdminGet(dependencies, "/admin/keg-room", (request, response, context) => {
    const requested = adminFillPageQueryFromRequest(request);
    const page = fallbackAdminFillPage(dependencies.fillService, requested);
    const publicCards = safePublicTapCards(dependencies.dashboardService, dependencies.logger);
    const fills = page.items.map((fill) =>
      safeFillCard(fill, dependencies.dashboardService, publicCards),
    );
    const section = (state: "available" | "on_deck" | "on_tap" | "ended") =>
      fills.filter((fill) => fill.state === state);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room",
      "Keg Room",
      "/admin/keg-room",
      {
        fills,
        sections: [
          { id: "available", title: "Available", items: section("available") },
          { id: "on-deck", title: "On Deck", items: section("on_deck") },
          { id: "on-tap", title: "On Tap", items: section("on_tap") },
          ...(page.state === "ended" || page.state === "all"
            ? [{ id: "history", title: "History", items: section("ended") }]
            : []),
        ],
        query: requested,
        pagination: {
          page: page.page,
          pageCount: page.pageCount,
          total: page.total,
          previousHref: page.page > 1 ? adminFillPageHref(requested, page.page - 1) : null,
          nextHref: page.page < page.pageCount ? adminFillPageHref(requested, page.page + 1) : null,
        },
        historyHref: "/admin/keg-room?state=ended",
        inventoryHref: "/admin/keg-room/kegs",
        newFillHref: "/admin/keg-room/fills/new",
        kegRoomNav: {
          fillHref: "/admin/keg-room/fills/new",
          kegsHref: "/admin/keg-room/kegs",
          historyHref: "/admin/keg-room?state=ended",
          current: requested.state === "ended" ? "history" : null,
        },
      },
    );
  });

  // Secondary physical inventory tab. The repository owns search/filter/page
  // SQL; the bounded per-keg history is an explicitly requested detail rail.
  registerAdminGet(dependencies, "/admin/keg-room/kegs", (request, response, context) => {
    const requested = adminKegPageQueryFromRequest(request);
    const page = fallbackAdminKegPage(dependencies.kegService, requested);
    const displaySettings = dependencies.displayService.getSettings();
    const unitSystem = displaySettings.unitSystem === "metric" ? "metric" : "us";
    const fillsFor = (kegId: string) => dependencies.fillService.listFills({ kegId });
    const kegs = page.items.map((keg) => {
      const detail = dependencies.kegService.getKeg(keg.id);
      const detailRecord = detail as unknown as {
        readonly keg?: typeof keg;
        readonly tareHistory?: readonly {
          readonly previousTareG: number | null;
          readonly newTareG: number;
          readonly recordedAt: string;
          readonly reason: string | null;
        }[];
        readonly maintenanceHistory?: readonly {
          readonly maintenanceType: string;
          readonly recordedAt: string;
        }[];
      };
      const impact = dependencies.kegService.getDeletionImpact(keg.id);
      const fillHistory = fillsFor(keg.id).map((fill) => ({
        id: fill.id,
        beverageName: fill.beverageName,
        fillDate: fill.fillDate,
        state: fill.state,
        endedAt: fill.endedAt,
      }));
      const currentFill = fillHistory.find((fill) => fill.state !== "ended") ?? null;
      const recentFill = fillHistory[0] ?? null;
      return {
        id: keg.id,
        kegNumber: keg.kegNumber,
        label: keg.label,
        capacityMl: keg.capacityMl,
        currentTareG: keg.currentTareG,
        capacityLabel: capacityLabel(keg.capacityMl, unitSystem),
        tareLabel: tareLabel(keg.currentTareG, unitSystem),
        isActive: keg.isActive,
        updatedAt: keg.updatedAt,
        currentFill: currentFill?.beverageName ?? null,
        currentFillId: currentFill?.id ?? null,
        currentFillRecord: currentFill,
        recentFillRecord: recentFill,
        fillHistorySummary:
          fillHistory.length === 0
            ? "No fills recorded"
            : `${fillHistory.length} fill record${fillHistory.length === 1 ? "" : "s"} · ${recentFill?.beverageName ?? "History available"}`,
        fillHistory,
        tareHistory: (detailRecord.tareHistory ?? []).map((item) => ({
          previousTareG: item.previousTareG,
          newTareG: item.newTareG,
          recordedAt: item.recordedAt,
          reason: item.reason,
        })),
        maintenanceHistory: (detailRecord.maintenanceHistory ?? []).map((item) => ({
          maintenanceType: item.maintenanceType,
          recordedAt: item.recordedAt,
        })),
        deletionImpacts: impact.impacts,
      };
    });
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-kegs",
      "Kegs",
      "/admin/keg-room/kegs",
      {
        kegs,
        query: requested,
        pagination: {
          page: page.page,
          pageCount: page.pageCount,
          total: page.total,
          previousHref: page.page > 1 ? adminKegPageHref(requested, page.page - 1) : null,
          nextHref: page.page < page.pageCount ? adminKegPageHref(requested, page.page + 1) : null,
        },
        newKegHref: "/admin/keg-room/kegs/new",
        kegRoomNav: {
          fillHref: "/admin/keg-room/fills/new",
          kegsHref: "/admin/keg-room/kegs",
          historyHref: "/admin/keg-room?state=ended",
          current: "kegs",
        },
      },
    );
  });

  // Static create path must be registered before /:id for the small path router.
  registerAdminGet(dependencies, "/admin/keg-room/kegs/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-keg-new",
      "New Keg",
      "/admin/keg-room/kegs/new",
      {},
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/kegs/:id",
    (request, response, context, params) => {
      const detail = dependencies.kegService.getKeg(params.id ?? "");
      const detailRecord = detail as unknown as {
        readonly keg?: typeof detail.keg;
        readonly tareHistory?: typeof detail.tareHistory;
        readonly maintenanceHistory?: typeof detail.maintenanceHistory;
      };
      const physical = detailRecord.keg ?? (detail as unknown as typeof detail.keg);
      const tareHistory = detailRecord.tareHistory ?? [];
      const maintenanceHistory = detailRecord.maintenanceHistory ?? [];
      const impact = dependencies.kegService.getDeletionImpact(params.id ?? "");
      const fillHistory = dependencies.fillService
        .listFills({ kegId: physical.id })
        .map((fill) => ({
          id: fill.id,
          beverageName: fill.beverageName,
          fillDate: fill.fillDate,
          state: fill.state,
          endedAt: fill.endedAt,
        }));
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-keg-detail",
        `Keg ${physical.kegNumber}`,
        "/admin/keg-room/kegs",
        {
          keg: {
            ...physical,
            confirmationLabel: kegDeletionConfirmationLabel(physical),
            tareHistory,
            maintenanceHistory,
            deletionImpacts: impact.impacts,
            fillHistory,
          },
          roomHref: "/admin/keg-room",
          inventoryHref: "/admin/keg-room/kegs",
        },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/keg-room/fills/new", (request, response, context) => {
    const activeKegs = dependencies.kegService.listKegs({ isActive: true });
    const occupiedKegIds = new Set(
      dependencies.fillService
        .listFills()
        .filter((fill) => fill.state !== "ended")
        .map((fill) => fill.kegId),
    );
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-fill",
      "Fill a Keg",
      "/admin/keg-room/fills/new",
      {
        beverages: dependencies.beverageService
          .listBeverages()
          .map((item) => ({ id: item.beverage.id, name: item.effectivePresentation.name })),
        kegs: activeKegs
          .filter((keg) => !occupiedKegIds.has(keg.id))
          .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label })),
        roomHref: "/admin/keg-room",
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/fills/:id",
    (request, response, context, params) => {
      const fill = dependencies.fillService.getFill(params.id ?? "");
      const taps = dependencies.tapService.listTaps();
      const activeTap = taps.find((tap) => tap.activeAssignment?.fillId === fill.id) ?? null;
      const availableTaps = taps
        .filter((tap) => !tap.isRetired && !tap.isOccupied)
        .map((tap) => ({ id: tap.id, tapNumber: tap.tapNumber, name: tap.name }));
      const publicCards = safePublicTapCards(dependencies.dashboardService, dependencies.logger);
      const card = safeFillCard(fill, dependencies.dashboardService, publicCards);
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-fill",
        "Filled Keg",
        "/admin/keg-room",
        {
          fill: card,
          fillRecord: fill,
          activeTap,
          availableTaps,
          roomHref: "/admin/keg-room",
        },
      );
    },
  );
  registerAdminGet(dependencies, "/admin/keg-room/fill", (_request, response) => {
    redirect(response, "/admin/keg-room/fills/new");
  });
  registerAdminGet(
    dependencies,
    "/admin/keg-room/fill/:id",
    (_request, response, _context, params) => {
      redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
    },
  );

  // Legacy authenticated GET entry points remain redirects only.
  registerAdminGet(dependencies, "/admin/fills", (_request, response) => {
    redirect(response, "/admin/keg-room");
  });
  registerAdminGet(dependencies, "/admin/kegs", (_request, response) => {
    redirect(response, "/admin/keg-room/kegs");
  });
  registerAdminGet(dependencies, "/admin/kegs/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/kegs/${encodeURIComponent(params.id ?? "")}`);
  });
  registerAdminGet(dependencies, "/admin/fills/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
  });
}

export function registerKegRoomMutations(dependencies: RegisterKegRoomMutationsDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/kegs/create",
    "/admin/keg-room/kegs",
    (form, context) => {
      dependencies.kegService.createKeg(
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: optionalNumber(form.currentTareG),
          isActive: form.isActive !== "false",
        },
        actor(context),
      );
    },
    "Keg created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/update",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      dependencies.kegService.updateKeg(
        params.id!,
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: Number(form.currentTareG),
          isActive: form.isActive === "true",
          reason: nullable(form.reason),
        },
        actor(context),
      );
    },
    "Keg updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", "label"]);
        const updated = dependencies.kegService.autosaveLabel(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          { label: nullable(fields.label) },
          actor(context),
        );
        return {
          resource: { label: updated.label },
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.kegService.getKeg(params.id!).keg;
        return {
          current: { label: current.label, updatedAt: current.updatedAt },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor(["updatedAt", "label"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/maintenance",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      dependencies.kegService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/delete",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Keg number and label to confirm permanent deletion.");
      }
      dependencies.kegService.deleteKeg(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
    },
    "Keg deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/fills/create",
    "/admin/keg-room",
    (form, context) => {
      dependencies.fillService.createFill(
        {
          beverageId: form.beverageId,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  // Static queue reorder path is registered before /:id action paths. The
  // browser enhancement submits the complete ordered list; the service
  // validates membership and remains the sole owner of queue state.
  registerAdminAction(
    dependencies,
    "/admin/fills/reorder-on-deck",
    "/admin/keg-room",
    (form, context) => {
      const fillIds = (form.fillIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (
        fillIds.length === 0 ||
        fillIds.length > 200 ||
        new Set(fillIds).size !== fillIds.length
      ) {
        invalidForm("On Deck order must contain each Filled Keg exactly once.");
      }
      dependencies.fillService.reorderOnDeck({ fillIds }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.markOnDeck(params.id!, actor(context));
    },
    "Fill placed On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/remove-on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.removeFromOnDeck(params.id!, actor(context));
    },
    "Fill removed from On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/move",
    "/admin/keg-room",
    (form, context, params) => {
      const ids = dependencies.fillService.getPublicOnDeck().map((item) => item.fillId);
      const index = ids.indexOf(params.id!);
      const destination = form.direction === "up" ? index - 1 : index + 1;
      if (index < 0 || destination < 0 || destination >= ids.length) return;
      [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
      dependencies.fillService.reorderOnDeck({ fillIds: ids }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/kick",
    "/admin/keg-room",
    async (form, context, params) => {
      if (form.confirmKick !== "true") {
        invalidForm("Confirm ending this fill before kicking the keg.");
      }
      await dependencies.fillService.kickFill(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Fill ended.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/featured",
    (params) => `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      if (form.featured !== "true" && form.featured !== "false") {
        invalidForm("Choose On or Off for the Featured setting.");
      }
      dependencies.fillService.setFeatured(
        params.id!,
        { featured: form.featured === "true" },
        actor(context),
      );
    },
    "Featured setting updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/delete",
    "/admin/keg-room",
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Filled Keg label to confirm permanent deletion.");
      }
      dependencies.fillService.deleteFill(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
    },
    "Fill deleted.",
  );
}

export function fallbackAdminFillPage(
  fillService: FillService,
  query: Readonly<Record<string, unknown>>,
): AdminFillPage {
  const candidate = fillService as FillService & {
    readonly listAdminPage?: (input?: unknown) => AdminFillPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedState = typeof query.state === "string" ? query.state : "active";
  const all = fillService.listFills();
  const filtered = all.filter((fill) => {
    if (requestedState === "active") return fill.state !== "ended";
    if (requestedState === "all") return true;
    return fill.state === requestedState;
  });
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((fill) =>
          `${fill.beverageName} ${fill.kegNumber} ${fill.kegLabel ?? ""}`
            .toLocaleLowerCase()
            .includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    state: requestedState as AdminFillPage["state"],
    sort: (typeof query.sort === "string" ? query.sort : "state") as AdminFillPage["sort"],
  };
}

export function fallbackAdminKegPage(
  kegService: KegService,
  query: Readonly<Record<string, unknown>>,
): AdminKegPage {
  const candidate = kegService as KegService & {
    readonly listAdminPage?: (input?: unknown) => AdminKegPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedStatus = typeof query.status === "string" ? query.status : "active";
  const all = kegService.listKegs();
  const filtered = all.filter(
    (keg) =>
      requestedStatus === "all" || (requestedStatus === "active" ? keg.isActive : !keg.isActive),
  );
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((keg) =>
          `keg ${keg.kegNumber} ${keg.label ?? ""}`.toLocaleLowerCase().includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    status: requestedStatus as AdminKegPage["status"],
    sort: (typeof query.sort === "string" ? query.sort : "number") as AdminKegPage["sort"],
  };
}

export function boundedFillPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function boundedRemainingMetric(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 1_000_000);
}

export function safeRemainingEstimate(
  state: AdminFillView["state"],
  publicCard: PublicTapCardView | null,
  fillPercent: number,
  servingsRemaining: number | null,
  daysRemaining: number | null,
): string {
  if (publicCard?.waitingForMeasurement === true) return "Waiting for measurement";
  if (servingsRemaining !== null) return `${Math.floor(servingsRemaining)} servings estimated`;
  if (daysRemaining !== null) return `${Math.round(daysRemaining * 10) / 10} days estimated`;
  if (publicCard?.fillPercent !== null && publicCard?.fillPercent !== undefined) {
    return `${fillPercent}% remaining`;
  }
  if (state === "on_tap") return "Estimate unavailable";
  if (state === "ended") return "Ended";
  return "Not on tap";
}

export function safeFillCard(
  fill: AdminFillView,
  dashboardService: DashboardService,
  publicCards: readonly PublicTapCardView[] = safePublicTapCards(dashboardService),
): Record<string, unknown> {
  // Match only by the non-Mystery public fillId. Public projections may hide
  // identity for Mystery Taps; their runtime metrics must not cross that
  // visibility boundary into this privileged Admin card.
  const publicCard = publicCards.find((candidate) => candidate.fillId === fill.id) ?? null;
  const publicPercent = boundedFillPercent(publicCard?.fillPercent);
  const fallbackPercent =
    fill.state === "ended" ? 0 : fill.state === "available" || fill.state === "on_deck" ? 100 : 0;
  const fillPercent = publicPercent ?? fallbackPercent;
  const servingsRemaining = boundedRemainingMetric(publicCard?.servingsRemaining);
  const daysRemaining = boundedRemainingMetric(publicCard?.daysRemaining);
  const authoritativeTapId = fill.tapId ?? publicCard?.id ?? null;
  const authoritativeTapNumber = fill.tapNumber ?? publicCard?.tapNumber ?? null;
  const fillGlass = safeVesselForDisplay(fill.fillGlass);
  const displayColor = safeColorForDisplay(fill.displayColor);
  const graphicId = fillGlass ?? "pint_glass";
  return {
    id: fill.id,
    beverageName: boundedAdminString(fill.beverageName, 160) ?? "Unknown Beverage",
    beverageType: boundedAdminString(fill.beverageType, 32) ?? "other",
    beverageStyle: boundedAdminString(fill.beverageStyle, 120),
    beverageAbv: Number.isFinite(fill.beverageAbv) ? fill.beverageAbv : null,
    kegId: fill.kegId,
    kegNumber: fill.kegNumber,
    kegLabel: boundedAdminString(fill.kegLabel, 120),
    confirmationLabel: fillDeletionConfirmationLabel(fill),
    fillDate: fill.fillDate,
    state: fill.state,
    stateLabel:
      fill.state === "on_deck"
        ? "On Deck"
        : fill.state === "on_tap"
          ? "On Tap"
          : fill.state === "ended"
            ? "Ended"
            : "Available",
    onDeckOrder: fill.onDeckOrder,
    tapNumber: authoritativeTapNumber,
    tapId: authoritativeTapId,
    queuePosition: fill.onDeckOrder,
    fillPercent,
    servingsRemaining,
    daysRemaining,
    waitingForMeasurement: publicCard?.waitingForMeasurement ?? false,
    remainingEstimate: safeRemainingEstimate(
      fill.state,
      publicCard,
      fillPercent,
      servingsRemaining,
      daysRemaining,
    ),
    fillGlass: fillGlass ?? "pint_glass",
    displayColor: displayColor ?? "#D97706",
    featured: fill.featured === true,
    graphic: getVesselDescriptor(graphicId),
    updatedAt: fill.updatedAt,
  };
}
