import { randomUUID } from "node:crypto";
import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { appendDeletionAudit } from "../activity/deletion-audit.ts";
import {
  findFillById,
  listOnDeckFills,
  reorderOnDeck,
  updateOnDeckOrder,
} from "../fills/repository.ts";
import {
  closeAssignmentLifecycle,
  countActiveAssignmentsByTapId,
  countHistoricalAssignmentsByTapId,
  deleteTapById,
  findActiveAssignmentByFillId,
  findActiveAssignmentByTapId,
  findAdminTapViewById,
  findTapById,
  findTapByNumber,
  insertAssignmentLifecycle,
  insertTap,
  listAdminTapViews,
  listPublicTapViews,
  registerTapFirstUse,
  updateTap,
} from "./repository.ts";
import {
  validateAssignTapInput,
  validateCreateTapInput,
  validateDeleteTapInput,
  validateFillId,
  validateMoveTapInput,
  validateRetireTapInput,
  validateTapId,
  validateUpdateTapInput,
} from "./tap-validation.ts";
import type {
  AdminTapView,
  AssignmentClosedContext,
  AssignmentOpenedContext,
  AssignmentOperationResult,
  FillAssignmentLifecyclePort,
  MoveOperationResult,
  PublicTapView,
  Tap,
  TapActorOptions,
  TapAssignmentExtensionPort,
  TapAssignmentLifecycle,
  TapCreatedContext,
  TapRetiredContext,
  TapDeletionImpact,
  UnassignOperationResult,
} from "./types.ts";

export class DefaultTapAssignmentExtensionPort implements TapAssignmentExtensionPort {
  onAssignmentOpened(_db: DatabaseExecutor, _context: AssignmentOpenedContext): void {}
  onAssignmentClosed(_db: DatabaseExecutor, _context: AssignmentClosedContext): void {}
  onTapCreated(_db: DatabaseExecutor, _tapId: string, _occurredAt: string): void {}
  onTapRetired(_db: DatabaseExecutor, _tapId: string, _occurredAt: string): void {}
}

export interface TapServiceOptions {
  readonly extensionPort?: TapAssignmentExtensionPort;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

function timestamp(nowFactory: () => Date): string {
  const value = nowFactory();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid clock in tap service");
  }
  return value.toISOString();
}

export class TapService {
  readonly #database: DatabaseExecutor;
  readonly #extensionPort: TapAssignmentExtensionPort;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(database: DatabaseExecutor, options: TapServiceOptions = {}) {
    this.#database = database;
    this.#extensionPort = options.extensionPort ?? new DefaultTapAssignmentExtensionPort();
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  createTap(input: unknown, options: TapActorOptions = {}): AdminTapView {
    const validated = validateCreateTapInput(input);
    const nowIso = timestamp(this.#now);
    const id = validated.id ?? this.#idFactory();
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existing = findTapByNumber(this.#database, validated.tapNumber);
      if (existing) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.number_conflict",
          clientMessage: `A tap with number ${validated.tapNumber} already exists.`,
          details: { tapNumber: validated.tapNumber, existingTapId: existing.id },
        });
      }

      const tap: Tap = {
        id,
        tapNumber: validated.tapNumber,
        name: validated.name ?? null,
        enabled: validated.enabled ?? true,
        firstUsedAt: null,
        retiredAt: null,
        gasType: validated.gasType ?? null,
        servingPressureKpa: validated.servingPressureKpa ?? null,
        lineLengthMm: validated.lineLengthMm ?? null,
        lineDiameterMm: validated.lineDiameterMm ?? null,
        notes: validated.notes ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      insertTap(this.#database, tap);
      const createdContext: TapCreatedContext = { tapId: tap.id, occurredAt: nowIso };

      assertSynchronousCompletion(
        this.#extensionPort.onTapCreated?.(
          this.#database,
          createdContext.tapId,
          createdContext.occurredAt,
        ),
        "Tap lifecycle extensions",
      );

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: id,
        details: {
          change: "created",
          tap_number: tap.tapNumber,
          name: tap.name,
          enabled: tap.enabled,
        },
        occurredAt: nowIso,
      });

      const view = findAdminTapViewById(this.#database, id);
      if (!view) {
        throw new ApplicationError({
          category: "internal",
          code: "tap.create_failed",
          clientMessage: "Failed to load created tap view.",
        });
      }
      return view;
    });
  }

  updateTap(tapId: unknown, input: unknown, options: TapActorOptions = {}): AdminTapView {
    const validatedTapId = validateTapId(tapId);
    const validated = validateUpdateTapInput(input);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existing = findTapById(this.#database, validatedTapId);
      if (!existing) {
        throw new ApplicationError({
          category: "not_found",
          code: "tap.not_found",
          clientMessage: "Tap was not found.",
          details: { id: validatedTapId },
        });
      }

      if (validated.tapNumber !== undefined && validated.tapNumber !== existing.tapNumber) {
        if (existing.retiredAt !== null) {
          throw new ApplicationError({
            category: "conflict",
            code: "tap.retired_renumber_prohibited",
            clientMessage: "Cannot change the tap number of a retired tap.",
            details: { tapId: validatedTapId, tapNumber: existing.tapNumber },
          });
        }

        if (validated.acknowledgeTelemetryEndpointImpact !== true) {
          throw new ApplicationError({
            category: "validation",
            code: "validation.telemetry_impact_acknowledgement_required",
            clientMessage:
              "Changing tap number alters the telemetry endpoint path (/api/v1/telemetry/taps/{tapNumber}). Set acknowledgeTelemetryEndpointImpact to true to confirm.",
            details: {
              field: "acknowledgeTelemetryEndpointImpact",
              currentTapNumber: existing.tapNumber,
              requestedTapNumber: validated.tapNumber,
            },
          });
        }

        const conflicting = findTapByNumber(this.#database, validated.tapNumber);
        if (conflicting && conflicting.id !== existing.id) {
          throw new ApplicationError({
            category: "conflict",
            code: "tap.number_conflict",
            clientMessage: `A tap with number ${validated.tapNumber} already exists.`,
            details: { tapNumber: validated.tapNumber, existingTapId: conflicting.id },
          });
        }
      }

      const updatedTap: Tap = {
        id: existing.id,
        tapNumber: validated.tapNumber !== undefined ? validated.tapNumber : existing.tapNumber,
        name: validated.name !== undefined ? validated.name : existing.name,
        enabled: validated.enabled !== undefined ? validated.enabled : existing.enabled,
        firstUsedAt: existing.firstUsedAt,
        retiredAt: existing.retiredAt,
        gasType: validated.gasType !== undefined ? validated.gasType : existing.gasType,
        servingPressureKpa:
          validated.servingPressureKpa !== undefined
            ? validated.servingPressureKpa
            : existing.servingPressureKpa,
        lineLengthMm:
          validated.lineLengthMm !== undefined ? validated.lineLengthMm : existing.lineLengthMm,
        lineDiameterMm:
          validated.lineDiameterMm !== undefined
            ? validated.lineDiameterMm
            : existing.lineDiameterMm,
        notes: validated.notes !== undefined ? validated.notes : existing.notes,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
      };

      updateTap(this.#database, updatedTap);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: existing.id,
        details: {
          change: "updated",
          tap_number: updatedTap.tapNumber,
          enabled: updatedTap.enabled,
        },
        occurredAt: nowIso,
      });

      const view = findAdminTapViewById(this.#database, existing.id);
      if (!view) {
        throw new ApplicationError({
          category: "internal",
          code: "tap.update_failed",
          clientMessage: "Failed to load updated tap view.",
        });
      }
      return view;
    });
  }

  getTap(tapId: unknown): AdminTapView {
    const validatedTapId = validateTapId(tapId);
    const view = findAdminTapViewById(this.#database, validatedTapId);
    if (!view) {
      throw new ApplicationError({
        category: "not_found",
        code: "tap.not_found",
        clientMessage: "Tap was not found.",
        details: { id: validatedTapId },
      });
    }
    return view;
  }

  listTaps(): readonly AdminTapView[] {
    return listAdminTapViews(this.#database);
  }

  listPublicTaps(): readonly PublicTapView[] {
    return listPublicTapViews(this.#database);
  }

  assignFill(
    tapId: unknown,
    input: unknown,
    options: TapActorOptions = {},
  ): AssignmentOperationResult {
    const validatedTapId = validateTapId(tapId);
    const validated = validateAssignTapInput(input);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const tap = findTapById(this.#database, validatedTapId);
      if (!tap) {
        throw new ApplicationError({
          category: "not_found",
          code: "tap.not_found",
          clientMessage: "Tap was not found.",
          details: { id: validatedTapId },
        });
      }

      if (tap.retiredAt !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.retired",
          clientMessage: "Cannot assign a fill to a retired tap.",
          details: { tapId: validatedTapId, retiredAt: tap.retiredAt },
        });
      }

      const activeTapAssignment = findActiveAssignmentByTapId(this.#database, validatedTapId);
      if (activeTapAssignment) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.occupied",
          clientMessage: "Tap is already occupied by an active fill.",
          details: {
            tapId: validatedTapId,
            occupiedByAssignmentId: activeTapAssignment.id,
            occupiedByFillId: activeTapAssignment.fillId,
          },
        });
      }

      const fill = findFillById(this.#database, validated.fillId);
      if (!fill) {
        throw new ApplicationError({
          category: "not_found",
          code: "fill.not_found",
          clientMessage: "Fill was not found.",
          details: { fillId: validated.fillId },
        });
      }

      if (fill.endedAt !== null) {
        const endedAt = fill.endedAt;
        throw new ApplicationError({
          category: "conflict",
          code: "fill.already_ended",
          clientMessage: "Cannot assign a fill that has already ended.",
          details: { fillId: validated.fillId, endedAt },
        });
      }

      const activeFillAssignment = findActiveAssignmentByFillId(this.#database, validated.fillId);
      if (activeFillAssignment) {
        throw new ApplicationError({
          category: "conflict",
          code: "fill.already_assigned",
          clientMessage: "Fill is already assigned to a tap.",
          details: {
            fillId: validated.fillId,
            assignedToTapId: activeFillAssignment.tapId,
            assignmentId: activeFillAssignment.id,
          },
        });
      }

      if (fill.onDeckOrder !== null) {
        updateOnDeckOrder(this.#database, fill.id, null, nowIso);
        const remainingOnDeck = listOnDeckFills(this.#database);
        reorderOnDeck(
          this.#database,
          remainingOnDeck.map((f) => f.id),
          nowIso,
        );
      }

      const assignmentId = this.#idFactory();
      const lifecycle: TapAssignmentLifecycle = {
        id: assignmentId,
        tapId: validatedTapId,
        fillId: validated.fillId,
        assignedAt: nowIso,
        endedAt: null,
        endReason: null,
        createdAt: nowIso,
      };

      insertAssignmentLifecycle(this.#database, lifecycle);
      registerTapFirstUse(this.#database, validatedTapId, nowIso);

      assertSynchronousCompletion(
        this.#extensionPort.onAssignmentOpened(this.#database, {
          assignmentId,
          tapId: validatedTapId,
          fillId: validated.fillId,
          occurredAt: nowIso,
          reason: "assigned",
        }),
        "Tap assignment extensions",
      );

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: validatedTapId,
        details: {
          transition: "assigned",
          assignment_id: assignmentId,
          fill_id: validated.fillId,
        },
        occurredAt: nowIso,
      });

      const view = findAdminTapViewById(this.#database, validatedTapId)!;
      return {
        tap: view,
        assignment: lifecycle,
        requiresFreshBaseline: true,
      };
    });
  }

  unassign(tapId: unknown, options: TapActorOptions = {}): UnassignOperationResult {
    const validatedTapId = validateTapId(tapId);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const tap = findTapById(this.#database, validatedTapId);
      if (!tap) {
        throw new ApplicationError({
          category: "not_found",
          code: "tap.not_found",
          clientMessage: "Tap was not found.",
          details: { id: validatedTapId },
        });
      }

      const activeAssignment = findActiveAssignmentByTapId(this.#database, validatedTapId);
      if (!activeAssignment) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.not_assigned",
          clientMessage: "Tap is not currently assigned to any fill.",
          details: { tapId: validatedTapId },
        });
      }

      closeAssignmentLifecycle(this.#database, activeAssignment.id, nowIso, "unassigned");

      assertSynchronousCompletion(
        this.#extensionPort.onAssignmentClosed(this.#database, {
          assignmentId: activeAssignment.id,
          tapId: validatedTapId,
          fillId: activeAssignment.fillId,
          occurredAt: nowIso,
          reason: "unassigned",
        }),
        "Tap assignment extensions",
      );

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: validatedTapId,
        details: {
          transition: "unassigned",
          assignment_id: activeAssignment.id,
          fill_id: activeAssignment.fillId,
        },
        occurredAt: nowIso,
      });

      const view = findAdminTapViewById(this.#database, validatedTapId)!;
      const closedAssignment: TapAssignmentLifecycle = {
        ...activeAssignment,
        endedAt: nowIso,
        endReason: "unassigned",
      };

      return {
        tap: view,
        closedAssignment,
      };
    });
  }

  moveFill(
    source: { readonly tapId?: unknown; readonly fillId?: unknown },
    input: unknown,
    options: TapActorOptions = {},
  ): MoveOperationResult {
    const validated = validateMoveTapInput(input);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      let sourceAssignment: TapAssignmentLifecycle | undefined;

      if (source.tapId !== undefined) {
        const sourceTapId = validateTapId(source.tapId, "sourceTapId");
        sourceAssignment = findActiveAssignmentByTapId(this.#database, sourceTapId);
        if (!sourceAssignment) {
          throw new ApplicationError({
            category: "conflict",
            code: "tap.not_assigned",
            clientMessage: "Source tap has no active assignment to move.",
            details: { tapId: sourceTapId },
          });
        }
      } else if (source.fillId !== undefined) {
        const sourceFillId = validateFillId(source.fillId, "sourceFillId");
        sourceAssignment = findActiveAssignmentByFillId(this.#database, sourceFillId);
        if (!sourceAssignment) {
          throw new ApplicationError({
            category: "conflict",
            code: "fill.not_assigned",
            clientMessage: "Source fill is not currently assigned to any tap.",
            details: { fillId: sourceFillId },
          });
        }
      } else {
        throw new ApplicationError({
          category: "validation",
          code: "validation.invalid_value",
          clientMessage: "Either tapId or fillId must be specified to move.",
        });
      }

      const sourceTapId = sourceAssignment.tapId;
      const fillId = sourceAssignment.fillId;

      if (sourceTapId === validated.targetTapId) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.move_same_tap",
          clientMessage: "Target tap must be different from the source tap.",
          details: { tapId: sourceTapId },
        });
      }

      const targetTap = findTapById(this.#database, validated.targetTapId);
      if (!targetTap) {
        throw new ApplicationError({
          category: "not_found",
          code: "tap.not_found",
          clientMessage: "Target tap was not found.",
          details: { targetTapId: validated.targetTapId },
        });
      }

      if (targetTap.retiredAt !== null) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.retired",
          clientMessage: "Cannot move fill to a retired tap.",
          details: { targetTapId: validated.targetTapId, retiredAt: targetTap.retiredAt },
        });
      }

      const targetActive = findActiveAssignmentByTapId(this.#database, validated.targetTapId);
      if (targetActive) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.occupied",
          clientMessage: "Target tap is already occupied by an active fill.",
          details: {
            targetTapId: validated.targetTapId,
            occupiedByAssignmentId: targetActive.id,
            occupiedByFillId: targetActive.fillId,
          },
        });
      }

      closeAssignmentLifecycle(this.#database, sourceAssignment.id, nowIso, "moved");

      assertSynchronousCompletion(
        this.#extensionPort.onAssignmentClosed(this.#database, {
          assignmentId: sourceAssignment.id,
          tapId: sourceTapId,
          fillId,
          occurredAt: nowIso,
          reason: "moved",
        }),
        "Tap assignment extensions",
      );

      const newAssignmentId = this.#idFactory();
      const newLifecycle: TapAssignmentLifecycle = {
        id: newAssignmentId,
        tapId: validated.targetTapId,
        fillId,
        assignedAt: nowIso,
        endedAt: null,
        endReason: null,
        createdAt: nowIso,
      };

      insertAssignmentLifecycle(this.#database, newLifecycle);
      registerTapFirstUse(this.#database, validated.targetTapId, nowIso);

      assertSynchronousCompletion(
        this.#extensionPort.onAssignmentOpened(this.#database, {
          assignmentId: newAssignmentId,
          tapId: validated.targetTapId,
          fillId,
          occurredAt: nowIso,
          reason: "moved",
        }),
        "Tap assignment extensions",
      );

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: sourceTapId,
        details: {
          transition: "moved",
          source_tap_id: sourceTapId,
          target_tap_id: validated.targetTapId,
          fill_id: fillId,
          closed_assignment_id: sourceAssignment.id,
          new_assignment_id: newAssignmentId,
        },
        occurredAt: nowIso,
      });

      const sourceView = findAdminTapViewById(this.#database, sourceTapId)!;
      const targetView = findAdminTapViewById(this.#database, validated.targetTapId)!;
      const closedAssignment: TapAssignmentLifecycle = {
        ...sourceAssignment,
        endedAt: nowIso,
        endReason: "moved",
      };

      return {
        sourceTap: sourceView,
        targetTap: targetView,
        closedAssignment,
        newAssignment: newLifecycle,
        requiresFreshBaseline: true,
      };
    });
  }

  retireTap(tapId: unknown, input?: unknown, options: TapActorOptions = {}): AdminTapView {
    const validatedTapId = validateTapId(tapId);
    const validated = validateRetireTapInput(input);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const tap = findTapById(this.#database, validatedTapId);
      if (!tap) {
        throw new ApplicationError({
          category: "not_found",
          code: "tap.not_found",
          clientMessage: "Tap was not found.",
          details: { id: validatedTapId },
        });
      }

      if (tap.retiredAt !== null) {
        return findAdminTapViewById(this.#database, validatedTapId)!;
      }

      const activeAssignment = findActiveAssignmentByTapId(this.#database, validatedTapId);
      if (activeAssignment) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.occupied",
          clientMessage: "Cannot retire an occupied tap. Unassign or kick the active fill first.",
          details: {
            tapId: validatedTapId,
            currentAssignmentId: activeAssignment.id,
            currentFillId: activeAssignment.fillId,
          },
        });
      }

      const updatedTap: Tap = {
        ...tap,
        retiredAt: nowIso,
        updatedAt: nowIso,
      };

      updateTap(this.#database, updatedTap);
      const retiredContext: TapRetiredContext = {
        tapId: validatedTapId,
        occurredAt: nowIso,
      };

      assertSynchronousCompletion(
        this.#extensionPort.onTapRetired?.(
          this.#database,
          retiredContext.tapId,
          retiredContext.occurredAt,
        ),
        "Tap lifecycle extensions",
      );

      appendActivity(this.#database, {
        category: "domain",
        action: "transition",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: validatedTapId,
        details: {
          transition: "retired",
          tap_number: tap.tapNumber,
          ...(validated.reason ? { reason: validated.reason } : {}),
        },
        occurredAt: nowIso,
      });

      return findAdminTapViewById(this.#database, validatedTapId)!;
    });
  }

  getTapDeletionImpact(tapId: unknown): TapDeletionImpact {
    const validatedTapId = validateTapId(tapId);
    const tap = findTapById(this.#database, validatedTapId);
    if (!tap) {
      throw new ApplicationError({
        category: "not_found",
        code: "tap.not_found",
        clientMessage: "Tap was not found.",
        details: { id: validatedTapId },
      });
    }

    const activeCount = countActiveAssignmentsByTapId(this.#database, validatedTapId);
    const historicalCount = countHistoricalAssignmentsByTapId(this.#database, validatedTapId);

    const reasons: string[] = [];
    if (tap.firstUsedAt !== null) {
      reasons.push("Tap has historically served beverages and cannot be deleted.");
    }
    if (tap.retiredAt !== null) {
      reasons.push("Retired taps cannot be deleted.");
    }
    if (activeCount > 0) {
      reasons.push("Tap currently has an active fill assignment.");
    }
    if (historicalCount > 0) {
      reasons.push("Tap has historical assignment lifecycles.");
    }

    const canDelete = reasons.length === 0;
    const impacts = [{ code: "taps", count: 1 }];

    return {
      tapId: tap.id,
      tapNumber: tap.tapNumber,
      canDelete,
      reasonsCannotDelete: reasons,
      firstUsedAt: tap.firstUsedAt,
      retiredAt: tap.retiredAt,
      activeAssignmentCount: activeCount,
      historicalAssignmentCount: historicalCount,
      impacts,
    };
  }

  deleteTap(tapId: unknown, input?: unknown, options: TapActorOptions = {}): void {
    const validatedTapId = validateTapId(tapId);
    const validated = validateDeleteTapInput(input);
    const nowIso = timestamp(this.#now);
    const actorType = options.actorType ?? "operator";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    this.#database.withTransaction(() => {
      const impact = this.getTapDeletionImpact(validatedTapId);
      if (!impact.canDelete) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.cannot_delete",
          clientMessage: "This tap cannot be deleted.",
          details: {
            tapId: validatedTapId,
            reason: impact.reasonsCannotDelete[0] ?? "Tap is not eligible for deletion.",
          },
        });
      }

      appendDeletionAudit(this.#database, {
        entityType: "tap",
        entityId: validatedTapId,
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(validated.reason ? { reason: validated.reason } : {}),
        impacts: impact.impacts,
        deletedAt: nowIso,
      });

      deleteTapById(this.#database, validatedTapId);

      appendActivity(this.#database, {
        category: "domain",
        action: "deletion",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "tap",
        entityId: validatedTapId,
        details: {
          tapNumber: impact.tapNumber,
        },
        occurredAt: nowIso,
      });
    });
  }

  asFillAssignmentPort(): FillAssignmentLifecyclePort {
    return {
      hasActiveAssignment: (fillId: string): boolean => {
        return findActiveAssignmentByFillId(this.#database, fillId) !== undefined;
      },
      closeForFillEnd: (database: DatabaseExecutor, fillId: string, endedAt: string): void => {
        const assignment = findActiveAssignmentByFillId(database, fillId);
        if (assignment) {
          closeAssignmentLifecycle(database, assignment.id, endedAt, "fill_ended");
          assertSynchronousCompletion(
            this.#extensionPort.onAssignmentClosed(database, {
              assignmentId: assignment.id,
              tapId: assignment.tapId,
              fillId,
              occurredAt: endedAt,
              reason: "fill_ended",
            }),
            "Tap assignment extensions",
          );
        }
      },
    };
  }
}

export function createTapService(
  database: DatabaseExecutor,
  options: TapServiceOptions = {},
): TapService {
  return new TapService(database, options);
}
