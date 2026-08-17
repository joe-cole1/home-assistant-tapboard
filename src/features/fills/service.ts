import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { appendDeletionAudit } from "../activity/deletion-audit.ts";
import {
  deleteBeverageForLastFillCascade,
  readBeverage,
  readBeverageLink,
  readBeverageSettings,
  readCustomProfile,
  readPresentationOverrides,
  readSourceProfile,
} from "../beverages/repository.ts";
import { resolveCustomPresentation, resolveLinkedPresentation } from "../beverages/presentation.ts";
import type { BeverageService } from "../beverages/service.ts";
import { findKegById } from "../kegs/repository.ts";
import {
  countActiveFillsByBeverageId,
  countFillsByBeverageId,
  countAdminFillPage,
  deleteFillById,
  endFill,
  findActiveFillByKegId,
  findFillById,
  getFillSettings,
  getMaxOnDeckOrder,
  insertFill,
  listFills as listFillRows,
  listAdminFillPage,
  listOnDeckFills,
  reorderOnDeck as reorderOnDeckRows,
  updateFillSettings,
  updateOnDeckOrder,
  type AdminFillProjectionRow,
} from "./repository.ts";
import { deriveFillState } from "./state.ts";
import type {
  AdminFillView,
  AdminFillPage,
  BrewfatherCompletionOutcome,
  CreateFillInput,
  Fill,
  FillActorOptions,
  FillAssignmentLifecyclePort,
  FillDeletionImpact,
  FillSettings,
  KickFillResult,
  PublicOnDeckItem,
} from "./types.ts";
import {
  validateCreateFillInput,
  adminFillPageSize,
  validateDeleteFillInput,
  validateFillSettingsInput,
  validateKickFillInput,
  validateListFillsQuery,
  validateReorderOnDeckInput,
  validateUuid,
  validateAdminFillPageQuery,
} from "./fill-validation.ts";

export class NullFillAssignmentLifecyclePort implements FillAssignmentLifecyclePort {
  hasActiveAssignment(_fillId: string): boolean {
    return false;
  }

  closeForFillEnd(_database: DatabaseExecutor, _fillId: string, _endedAt: string): void {
    // No-op for #70
  }
}

export interface FillServiceOptions {
  readonly beverageService?: BeverageService;
  readonly assignmentPort?: FillAssignmentLifecyclePort;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly fetchFn?: typeof fetch;
  readonly origin?: string;
}

function timestamp(nowFactory?: () => Date): string {
  const value = nowFactory ? nowFactory() : new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid clock in fill service");
  }
  return value.toISOString();
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Canonical visible label used by every permanent Filled Keg deletion confirmation. */
export function fillDeletionConfirmationLabel(
  fill: Pick<AdminFillView, "beverageName" | "kegNumber" | "kegLabel">,
): string {
  return `${fill.beverageName} — Keg ${fill.kegNumber}${fill.kegLabel ? ` — ${fill.kegLabel}` : ""}`;
}

export class FillService {
  readonly #database: DatabaseExecutor;
  readonly #beverageService?: BeverageService | undefined;
  readonly #assignmentPort: FillAssignmentLifecyclePort;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #fetchFn?: typeof fetch | undefined;
  readonly #origin?: string | undefined;

  constructor(database: DatabaseExecutor, options: FillServiceOptions = {}) {
    this.#database = database;
    this.#beverageService = options.beverageService;
    this.#assignmentPort = options.assignmentPort ?? new NullFillAssignmentLifecyclePort();
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#fetchFn = options.fetchFn;
    this.#origin = options.origin;
  }

  #resolveBeveragePresentation(beverageId: string): {
    readonly name: string;
    readonly type: string;
    readonly style: string | null;
    readonly abv: number | null;
    readonly fillGlass: string | null;
    readonly displayColor: string | null;
  } {
    const beverage = readBeverage(this.#database, beverageId);
    if (!beverage) {
      return {
        name: "Unknown Beverage",
        type: "other",
        style: null,
        abv: null,
        fillGlass: null,
        displayColor: null,
      };
    }

    if (beverage.ownershipType === "custom") {
      const profile = readCustomProfile(this.#database, beverageId);
      if (profile) {
        const pres = resolveCustomPresentation(profile);
        return {
          name: pres.name,
          type: pres.beverageType,
          style: pres.style,
          abv: pres.abv,
          fillGlass: pres.fillGlass,
          displayColor: pres.displayColor,
        };
      }
    } else {
      const sourceProfile = readSourceProfile(this.#database, beverageId);
      const overrides = readPresentationOverrides(this.#database, beverageId);
      if (sourceProfile) {
        const pres = resolveLinkedPresentation(sourceProfile, overrides);
        return {
          name: pres.name,
          type: pres.beverageType,
          style: pres.style,
          abv: pres.abv,
          fillGlass: pres.fillGlass,
          displayColor: pres.displayColor,
        };
      }
    }

    return {
      name: "Unknown Beverage",
      type: "other",
      style: null,
      abv: null,
      fillGlass: null,
      displayColor: null,
    };
  }

  #mapToAdminFillView(fill: Fill): AdminFillView {
    const beveragePres = this.#resolveBeveragePresentation(fill.beverageId);
    const keg = findKegById(this.#database, fill.kegId);
    const hasActiveAssignment = this.#assignmentPort.hasActiveAssignment(fill.id);
    const state = deriveFillState({
      endedAt: fill.endedAt,
      hasActiveAssignment,
      onDeckOrder: fill.onDeckOrder,
    });

    return {
      id: fill.id,
      beverageId: fill.beverageId,
      beverageName: beveragePres.name,
      beverageType: beveragePres.type,
      beverageStyle: beveragePres.style,
      beverageAbv: beveragePres.abv,
      fillGlass: beveragePres.fillGlass,
      displayColor: beveragePres.displayColor,
      kegId: fill.kegId,
      kegNumber: keg ? keg.kegNumber : 0,
      kegLabel: keg ? keg.label : null,
      fillDate: fill.fillDate,
      state,
      onDeckOrder: fill.onDeckOrder,
      endedAt: fill.endedAt,
      endReason: fill.endReason,
      createdAt: fill.createdAt,
      updatedAt: fill.updatedAt,
    };
  }

  #mapAdminFillProjectionRow(row: AdminFillProjectionRow): AdminFillView {
    return {
      id: row.id,
      beverageId: row.beverage_id,
      beverageName: row.beverage_name ?? "Unknown Beverage",
      beverageType: row.beverage_type ?? "other",
      beverageStyle: row.beverage_style,
      beverageAbv: row.beverage_abv,
      fillGlass: row.fill_glass,
      displayColor: row.display_color,
      kegId: row.keg_id,
      kegNumber: row.keg_number,
      kegLabel: row.keg_label,
      tapId: row.tap_id,
      tapNumber: row.tap_number,
      fillDate: row.fill_date,
      state: row.state as AdminFillView["state"],
      onDeckOrder: row.on_deck_order,
      endedAt: row.ended_at,
      endReason: row.end_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createFill(input: unknown, options: FillActorOptions = {}): AdminFillView {
    const validated: CreateFillInput = validateCreateFillInput(input);
    const nowFactory = options.now ?? this.#now;
    const nowIso = timestamp(nowFactory);
    const idFactory = options.idFactory ?? this.#idFactory;
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      // Validate beverage exists
      const beverage = readBeverage(this.#database, validated.beverageId);
      if (!beverage) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
          details: { beverageId: validated.beverageId },
        });
      }

      // Validate keg exists and is active
      const keg = findKegById(this.#database, validated.kegId);
      if (!keg) {
        throw new ApplicationError({
          category: "not_found",
          code: "keg.not_found",
          clientMessage: "Physical keg was not found.",
          details: { kegId: validated.kegId },
        });
      }

      if (!keg.isActive) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.keg_inactive",
          clientMessage: "Physical keg is inactive and cannot receive new fills.",
          details: { kegId: validated.kegId, kegNumber: keg.kegNumber },
        });
      }

      // Validate keg does not already have an active fill
      const activeFill = findActiveFillByKegId(this.#database, validated.kegId);
      if (activeFill) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.keg_occupied",
          clientMessage: "Physical keg already has an active fill.",
          details: { kegId: validated.kegId, existingFillId: activeFill.id },
        });
      }

      const fillDate = validated.fillDate ?? formatDate(nowFactory());
      const id = validated.id ?? idFactory();

      const fill: Fill = {
        id,
        beverageId: validated.beverageId,
        kegId: validated.kegId,
        fillDate,
        onDeckOrder: null,
        endedAt: null,
        endReason: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      insertFill(this.#database, fill);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        entityId: id,
        details: {
          change: "created",
          beverage_id: fill.beverageId,
          keg_id: fill.kegId,
          fill_date: fillDate,
        },
        occurredAt: nowIso,
      });

      return this.#mapToAdminFillView(fill);
    });
  }

  getFill(id: unknown): AdminFillView {
    const fillId = validateUuid(id, "id");
    const fill = findFillById(this.#database, fillId);
    if (!fill) {
      throw new ApplicationError({
        category: "not_found",
        code: "fill.not_found",
        clientMessage: "Fill was not found.",
        details: { id: fillId },
      });
    }
    return this.#mapToAdminFillView(fill);
  }

  listFills(query?: unknown): AdminFillView[] {
    const validatedQuery = validateListFillsQuery(query);
    const fills = listFillRows(this.#database, {
      ...(validatedQuery.beverageId ? { beverageId: validatedQuery.beverageId } : {}),
      ...(validatedQuery.kegId ? { kegId: validatedQuery.kegId } : {}),
    });

    const views = fills.map((fill) => this.#mapToAdminFillView(fill));

    if (validatedQuery.state !== undefined) {
      return views.filter((v) => v.state === validatedQuery.state);
    }

    return views;
  }

  /**
   * Return the bounded Keg Room projection. Search, filtering, sorting, and
   * page windows are normalized before the repository executes SQL; no
   * load-all filtering is used for the authenticated admin list.
   */
  listAdminPage(query: unknown = {}): AdminFillPage {
    const validated = validateAdminFillPageQuery(query);
    const total = countAdminFillPage(this.#database, validated);
    const pageCount = Math.max(1, Math.ceil(total / adminFillPageSize()));
    const page = Math.min(validated.page, pageCount);
    const records = listAdminFillPage(this.#database, { ...validated, page });
    return {
      items: records.map((record) => this.#mapAdminFillProjectionRow(record)),
      total,
      page,
      pageSize: adminFillPageSize(),
      pageCount,
      query: validated.q,
      state: validated.state,
      sort: validated.sort,
    };
  }

  markOnDeck(id: unknown, options: FillActorOptions = {}): AdminFillView {
    const fillId = validateUuid(id, "id");
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const fill = findFillById(this.#database, fillId);
      if (!fill) {
        throw new ApplicationError({
          category: "not_found",
          code: "fill.not_found",
          clientMessage: "Fill was not found.",
          details: { id: fillId },
        });
      }

      if (fill.endedAt !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.already_ended",
          clientMessage: "Ended fill cannot be placed on deck.",
          details: { id: fillId },
        });
      }

      if (this.#assignmentPort.hasActiveAssignment(fill.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.assigned",
          clientMessage: "Assigned fill cannot be placed on deck.",
          details: { id: fillId },
        });
      }

      if (fill.onDeckOrder !== null) {
        return this.#mapToAdminFillView(fill);
      }

      const nextOrder = getMaxOnDeckOrder(this.#database) + 1;
      updateOnDeckOrder(this.#database, fill.id, nextOrder, nowIso);

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        entityId: fill.id,
        details: {
          transition: "marked_on_deck",
          on_deck_order: nextOrder,
        },
        occurredAt: nowIso,
      });

      const updatedFill = findFillById(this.#database, fill.id)!;
      return this.#mapToAdminFillView(updatedFill);
    });
  }

  removeFromOnDeck(id: unknown, options: FillActorOptions = {}): AdminFillView {
    const fillId = validateUuid(id, "id");
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const fill = findFillById(this.#database, fillId);
      if (!fill) {
        throw new ApplicationError({
          category: "not_found",
          code: "fill.not_found",
          clientMessage: "Fill was not found.",
          details: { id: fillId },
        });
      }

      if (fill.onDeckOrder === null) {
        return this.#mapToAdminFillView(fill);
      }

      updateOnDeckOrder(this.#database, fill.id, null, nowIso);

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        entityId: fill.id,
        details: {
          transition: "removed_from_on_deck",
        },
        occurredAt: nowIso,
      });

      const updatedFill = findFillById(this.#database, fill.id)!;
      return this.#mapToAdminFillView(updatedFill);
    });
  }

  reorderOnDeck(input: unknown, options: FillActorOptions = {}): AdminFillView[] {
    const validated = validateReorderOnDeckInput(input);
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const currentOnDeck = listOnDeckFills(this.#database);
      const currentIds = new Set(currentOnDeck.map((f) => f.id));

      if (validated.fillIds.length !== currentOnDeck.length) {
        throw new ApplicationError({
          category: "validation",
          code: "validation.invalid_value",
          clientMessage:
            "Reorder list must contain all currently On Deck fills without omissions or additions.",
          details: {
            providedCount: validated.fillIds.length,
            expectedCount: currentOnDeck.length,
          },
        });
      }

      for (const id of validated.fillIds) {
        if (!currentIds.has(id)) {
          throw new ApplicationError({
            category: "validation",
            code: "validation.invalid_value",
            clientMessage: `Fill with ID ${id} is not currently On Deck.`,
            details: { fillId: id },
          });
        }
      }

      reorderOnDeckRows(this.#database, validated.fillIds, nowIso);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        details: {
          change: "on_deck_reordered",
          count: validated.fillIds.length,
        },
        occurredAt: nowIso,
      });

      const updatedOnDeck = listOnDeckFills(this.#database);
      return updatedOnDeck.map((f) => this.#mapToAdminFillView(f));
    });
  }

  getPublicOnDeck(): PublicOnDeckItem[] {
    const onDeckFills = listOnDeckFills(this.#database);
    const publicItems: PublicOnDeckItem[] = [];

    for (const fill of onDeckFills) {
      if (this.#assignmentPort.hasActiveAssignment(fill.id)) {
        continue;
      }
      const pres = this.#resolveBeveragePresentation(fill.beverageId);
      publicItems.push({
        fillId: fill.id,
        order: fill.onDeckOrder ?? 0,
        name: pres.name,
        style: pres.style,
      });
    }

    return publicItems;
  }

  async kickFill(
    id: unknown,
    input?: unknown,
    options: FillActorOptions & { readonly fetchFn?: typeof fetch; readonly origin?: string } = {},
  ): Promise<KickFillResult> {
    const fillId = validateUuid(id, "id");
    const validated = validateKickFillInput(input);
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    let wasLastActiveFill = false;
    let beverageId = "";

    const updatedFill = this.#database.withTransaction(() => {
      const fill = findFillById(this.#database, fillId);
      if (!fill) {
        throw new ApplicationError({
          category: "not_found",
          code: "fill.not_found",
          clientMessage: "Fill was not found.",
          details: { id: fillId },
        });
      }

      if (fill.endedAt !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.already_ended",
          clientMessage: "Fill is already ended.",
          details: { id: fillId },
        });
      }

      beverageId = fill.beverageId;
      wasLastActiveFill = countActiveFillsByBeverageId(this.#database, beverageId) === 1;

      // Close assignment through lifecycle port inside transaction
      this.#assignmentPort.closeForFillEnd(this.#database, fill.id, nowIso);

      // End fill (sets ended_at, end_reason, on_deck_order = NULL)
      endFill(this.#database, fill.id, nowIso, validated.reason ?? null, nowIso);

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        entityId: fill.id,
        details: {
          transition: "kicked",
          was_last_active_fill: wasLastActiveFill,
          ...(validated.reason ? { reason: validated.reason } : {}),
        },
        occurredAt: nowIso,
      });

      return findFillById(this.#database, fill.id)!;
    });

    // Post-commit: Brewfather completion policy coordination (strictly outside SQLite transaction)
    let brewfatherOutcome: BrewfatherCompletionOutcome = "not_applicable";
    let brewfatherMessage: string | undefined;

    const bevSettings = readBeverageSettings(this.#database);
    const link = readBeverageLink(this.#database, beverageId);

    if (wasLastActiveFill && link !== undefined) {
      if (bevSettings.brewfatherCompletionPolicy === "never") {
        brewfatherOutcome = "not_requested";
      } else if (bevSettings.brewfatherCompletionPolicy === "ask") {
        brewfatherOutcome = "confirmation_required";
      } else if (bevSettings.brewfatherCompletionPolicy === "completed") {
        if (this.#beverageService) {
          try {
            const fetchFn = options.fetchFn ?? this.#fetchFn;
            const origin = options.origin ?? this.#origin;
            const res = await this.#beverageService.completeBrewfatherBatch(beverageId, {
              ...(fetchFn !== undefined ? { fetchFn } : {}),
              ...(origin !== undefined ? { origin } : {}),
            });
            brewfatherOutcome = res.outcome;
            brewfatherMessage = res.message;
          } catch (err) {
            brewfatherOutcome = "failed";
            brewfatherMessage = err instanceof Error ? err.message : "Brewfather completion failed";
          }
        } else {
          brewfatherOutcome = "failed";
          brewfatherMessage = "BeverageService unavailable for Brewfather completion";
        }
      }
    }

    return {
      fill: this.#mapToAdminFillView(updatedFill),
      brewfatherOutcome,
      ...(brewfatherMessage !== undefined ? { brewfatherMessage } : {}),
    };
  }

  async completeBrewfatherBatch(
    id: unknown,
    options: { readonly fetchFn?: typeof fetch; readonly origin?: string } = {},
  ): Promise<{ readonly outcome: BrewfatherCompletionOutcome; readonly message?: string }> {
    const fillId = validateUuid(id, "id");
    const fill = findFillById(this.#database, fillId);
    if (!fill) {
      throw new ApplicationError({
        category: "not_found",
        code: "fill.not_found",
        clientMessage: "Fill was not found.",
        details: { id: fillId },
      });
    }

    if (fill.endedAt === null) {
      throw new ApplicationError({
        category: "conflict",
        code: "fill.not_ended",
        clientMessage: "Fill must be ended before completing Brewfather batch.",
        details: { id: fillId },
      });
    }

    const link = readBeverageLink(this.#database, fill.beverageId);
    if (!link) {
      throw new ApplicationError({
        category: "conflict",
        code: "beverage.not_linked",
        clientMessage: "Beverage is not linked to Brewfather.",
        details: { beverageId: fill.beverageId },
      });
    }

    const activeCount = countActiveFillsByBeverageId(this.#database, fill.beverageId);
    if (activeCount > 0) {
      throw new ApplicationError({
        category: "conflict",
        code: "beverage.has_active_fills",
        clientMessage: "Beverage still has other active fills.",
        details: { beverageId: fill.beverageId, activeCount },
      });
    }

    if (!this.#beverageService) {
      return {
        outcome: "failed",
        message: "BeverageService unavailable for Brewfather completion",
      };
    }

    const fetchFn = options.fetchFn ?? this.#fetchFn;
    const origin = options.origin ?? this.#origin;
    return this.#beverageService.completeBrewfatherBatch(fill.beverageId, {
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      ...(origin !== undefined ? { origin } : {}),
    });
  }

  getDeletionImpact(id: unknown): FillDeletionImpact {
    const fillId = validateUuid(id, "id");
    const fill = findFillById(this.#database, fillId);
    if (!fill) {
      throw new ApplicationError({
        category: "not_found",
        code: "fill.not_found",
        clientMessage: "Fill was not found.",
        details: { id: fillId },
      });
    }

    const fillSettings = getFillSettings(this.#database);
    const totalFills = countFillsByBeverageId(this.#database, fill.beverageId);
    const isLastFill = totalFills === 1;
    const beverageAutoDeleted = isLastFill && fillSettings.autoDeleteBeverageOnLastFill;

    const impacts: { readonly code: string; readonly count: number }[] = [
      { code: "fills", count: 1 },
    ];
    if (beverageAutoDeleted) {
      impacts.push({ code: "beverages", count: 1 });
    }

    return {
      fillId: fill.id,
      fills: 1,
      isLastFillForBeverage: isLastFill,
      beverageAutoDeleted,
      beverageId: fill.beverageId,
      kegId: fill.kegId,
      impacts,
    };
  }

  deleteFill(id: unknown, input?: unknown, options: FillActorOptions = {}): FillDeletionImpact {
    const fillId = validateUuid(id, "id");
    const validated = validateDeleteFillInput(input);
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const fill = findFillById(this.#database, fillId);
      if (!fill) {
        throw new ApplicationError({
          category: "not_found",
          code: "fill.not_found",
          clientMessage: "Fill was not found.",
          details: { id: fillId },
        });
      }

      const expected = fillDeletionConfirmationLabel(this.#mapToAdminFillView(fill));
      if (
        validated.confirmation === undefined ||
        validated.confirmation === null ||
        validated.confirmation.length === 0
      ) {
        throw new ApplicationError({
          category: "validation",
          code: "fill.confirmation_required",
          clientMessage: "Type the exact visible Filled Keg label to confirm permanent deletion.",
        });
      }
      if (validated.confirmation !== expected) {
        throw new ApplicationError({
          category: "validation",
          code: "fill.confirmation_mismatch",
          clientMessage: "Type the exact visible Filled Keg label to confirm permanent deletion.",
          details: { expected },
        });
      }

      const impact = this.getDeletionImpact(fillId);

      appendDeletionAudit(this.#database, {
        entityType: "fill",
        entityId: fillId,
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        reason: validated.reason ?? "Administrative deletion",
        impacts: impact.impacts,
        deletedAt: nowIso,
      });

      deleteFillById(this.#database, fillId);

      appendActivity(this.#database, {
        category: "domain",
        action: "deletion",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill",
        entityId: fillId,
        details: {
          beverage_id: fill.beverageId,
          keg_id: fill.kegId,
          fill_date: fill.fillDate,
        },
        occurredAt: nowIso,
      });

      if (impact.beverageAutoDeleted) {
        deleteBeverageForLastFillCascade(this.#database, fill.beverageId, {
          actorType,
          ...(actorId !== undefined ? { actorId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          now: () => new Date(nowIso),
        });
      }

      return impact;
    });
  }

  getSettings(): FillSettings {
    return getFillSettings(this.#database);
  }

  updateSettings(input: unknown, options: FillActorOptions = {}): FillSettings {
    const validated = validateFillSettingsInput(input);
    const nowIso = timestamp(options.now ?? this.#now);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      updateFillSettings(this.#database, validated.autoDeleteBeverageOnLastFill, nowIso);

      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "fill_settings",
        entityId: "1",
        details: {
          auto_delete_beverage_on_last_fill: validated.autoDeleteBeverageOnLastFill,
        },
        occurredAt: nowIso,
      });

      return getFillSettings(this.#database);
    });
  }
}

export function createFillService(
  database: DatabaseExecutor,
  options: FillServiceOptions = {},
): FillService {
  return new FillService(database, options);
}
