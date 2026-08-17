import { randomUUID } from "node:crypto";

import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { appendDeletionAudit } from "../activity/deletion-audit.ts";
import {
  adminKegPageSize,
  validateCreateKegInput,
  validateDeleteKegInput,
  validateKegId,
  validateRecordMaintenanceInput,
  validateAdminKegPageQuery,
  validateUpdateKegInput,
} from "./keg-validation.ts";
import {
  countAdminKegPage,
  deleteKegById,
  findKegById,
  findKegByNumber,
  getKegDeletionImpact,
  insertKeg,
  insertMaintenanceRecord,
  insertTareHistory,
  listKegs as listKegRows,
  listAdminKegPage,
  listMaintenanceRecordsByKegId,
  listTareHistoryByKegId,
  updateKeg as updateKegRow,
  updateKegLabelIfUpdatedAt,
  type ListKegsOptions,
} from "./repository.ts";
import type {
  AdminKegPage,
  KegActorOptions,
  KegCorrectionHook,
  KegDeletionImpact,
  KegMaintenanceRecord,
  KegTareHistoryRecord,
  PhysicalKeg,
} from "./types.ts";

function timestamp(nowFactory: (() => Date) | undefined): string {
  const value = nowFactory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid clock in keg service");
  }
  return value.toISOString();
}

/** Canonical visible label used by every permanent Keg deletion confirmation. */
export function kegDeletionConfirmationLabel(
  keg: Pick<PhysicalKeg, "kegNumber" | "label">,
): string {
  return `Keg ${keg.kegNumber}${keg.label ? ` — ${keg.label}` : ""}`;
}

export interface KegServiceOptions {
  readonly onKegCorrection?: KegCorrectionHook;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class KegService {
  readonly #database: DatabaseExecutor;
  readonly #correctionHook?: KegCorrectionHook | undefined;
  readonly #idFactory: () => string;
  readonly #nowFactory?: (() => Date) | undefined;

  constructor(database: DatabaseExecutor, options: KegServiceOptions = {}) {
    this.#database = database;
    this.#correctionHook = options.onKegCorrection;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#nowFactory = options.now;
  }

  createKeg(input: unknown, options: KegActorOptions = {}): PhysicalKeg {
    const validated = validateCreateKegInput(input);
    const now = timestamp(options.now ?? this.#nowFactory);
    const idFactory = options.idFactory ?? this.#idFactory;
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existingWithNumber = findKegByNumber(this.#database, validated.kegNumber);
      if (existingWithNumber !== undefined) {
        throw new ApplicationError({
          category: "conflict",
          code: "keg.keg_number_in_use",
          clientMessage: "A physical keg with this keg number already exists.",
          details: { kegNumber: validated.kegNumber },
        });
      }

      const id = validated.id ?? idFactory();
      const keg: PhysicalKeg = {
        id,
        kegNumber: validated.kegNumber,
        label: validated.label ?? null,
        capacityMl: validated.capacityMl,
        currentTareG: validated.currentTareG ?? 0,
        isActive: validated.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      };

      insertKeg(this.#database, keg);

      const initialTareRecord: KegTareHistoryRecord = {
        id: idFactory(),
        kegId: id,
        previousTareG: null,
        newTareG: keg.currentTareG,
        recordedAt: now,
        reason: "initial_creation",
        actorType,
        actorId: actorId ?? null,
      };

      insertTareHistory(this.#database, initialTareRecord);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "keg",
        entityId: id,
        details: {
          change: "created",
          keg_number: keg.kegNumber,
          capacity_ml: keg.capacityMl,
          tare_weight_g: keg.currentTareG,
        },
        occurredAt: now,
      });

      return keg;
    });
  }

  updateKeg(id: unknown, input: unknown, options: KegActorOptions = {}): PhysicalKeg {
    const kegId = validateKegId(id);
    const validated = validateUpdateKegInput(input);
    const now = timestamp(options.now ?? this.#nowFactory);
    const idFactory = options.idFactory ?? this.#idFactory;
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existing = findKegById(this.#database, kegId);
      if (existing === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "keg.not_found",
          clientMessage: "Physical keg not found.",
          details: { id: kegId },
        });
      }

      const nextKegNumber = validated.kegNumber ?? existing.kegNumber;
      if (nextKegNumber !== existing.kegNumber) {
        const conflict = findKegByNumber(this.#database, nextKegNumber);
        if (conflict !== undefined && conflict.id !== existing.id) {
          throw new ApplicationError({
            category: "conflict",
            code: "keg.keg_number_in_use",
            clientMessage: "A physical keg with this keg number already exists.",
            details: { kegNumber: nextKegNumber },
          });
        }
      }

      const nextLabel = validated.label !== undefined ? validated.label : existing.label;
      const nextCapacityMl = validated.capacityMl ?? existing.capacityMl;
      const nextCurrentTareG = validated.currentTareG ?? existing.currentTareG;
      const nextIsActive =
        validated.isActive !== undefined ? validated.isActive : existing.isActive;

      const updatedKeg: PhysicalKeg = {
        id: existing.id,
        kegNumber: nextKegNumber,
        label: nextLabel,
        capacityMl: nextCapacityMl,
        currentTareG: nextCurrentTareG,
        isActive: nextIsActive,
        createdAt: existing.createdAt,
        updatedAt: now,
      };

      updateKegRow(this.#database, updatedKeg);

      const tareChanged = nextCurrentTareG !== existing.currentTareG;
      if (tareChanged) {
        const tareHistoryRecord: KegTareHistoryRecord = {
          id: idFactory(),
          kegId: existing.id,
          previousTareG: existing.currentTareG,
          newTareG: nextCurrentTareG,
          recordedAt: now,
          reason: validated.reason ?? null,
          actorType,
          actorId: actorId ?? null,
        };
        insertTareHistory(this.#database, tareHistoryRecord);
      }

      const capacityChanged = nextCapacityMl !== existing.capacityMl;
      if (capacityChanged || tareChanged) {
        assertSynchronousCompletion(
          this.#correctionHook?.(this.#database, {
            kegId: existing.id,
            previousCapacityMl: existing.capacityMl,
            newCapacityMl: nextCapacityMl,
            previousTareG: existing.currentTareG,
            newTareG: nextCurrentTareG,
            changedAt: now,
          }),
          "Keg correction extensions",
        );
      }

      if (nextIsActive !== existing.isActive) {
        appendActivity(this.#database, {
          category: "domain",
          action: "transition",
          actorType,
          ...(actorId !== undefined ? { actorId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          entityType: "keg",
          entityId: existing.id,
          details: {
            from: existing.isActive ? "active" : "inactive",
            to: nextIsActive ? "active" : "inactive",
            keg_number: nextKegNumber,
          },
          occurredAt: now,
        });
      }

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "keg",
        entityId: existing.id,
        details: {
          change: "updated",
          keg_number: nextKegNumber,
          capacity_ml: nextCapacityMl,
          tare_weight_g: nextCurrentTareG,
        },
        occurredAt: now,
      });

      return updatedKeg;
    });
  }

  /** Autosave only the human-facing Keg label; hardware and lifecycle remain explicit. */
  autosaveLabel(
    id: unknown,
    expectedUpdatedAt: string,
    input: unknown,
    options: KegActorOptions = {},
  ): PhysicalKeg {
    const kegId = validateKegId(id);
    const validated = validateUpdateKegInput(input);
    if (
      validated.kegNumber !== undefined ||
      validated.capacityMl !== undefined ||
      validated.currentTareG !== undefined ||
      validated.tareWeightG !== undefined ||
      validated.isActive !== undefined ||
      validated.reason !== undefined
    ) {
      throw new ApplicationError({
        category: "validation",
        code: "keg.autosave_unsafe_field",
        clientMessage: "Only the visible Keg label can be autosaved.",
      });
    }
    const now = timestamp(options.now ?? this.#nowFactory);
    const actorType = options.actorType ?? "admin";
    return this.#database.withTransaction(() => {
      const existing = findKegById(this.#database, kegId);
      if (existing === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "keg.not_found",
          clientMessage: "Physical keg not found.",
        });
      }
      if (existing.updatedAt !== expectedUpdatedAt) {
        throw new ApplicationError({
          category: "conflict",
          code: "keg.changed",
          clientMessage: "This Keg changed elsewhere. Reload before saving again.",
        });
      }
      const label = validated.label !== undefined ? validated.label : existing.label;
      if (label === existing.label) return existing;
      if (!updateKegLabelIfUpdatedAt(this.#database, kegId, label, expectedUpdatedAt, now)) {
        throw new ApplicationError({
          category: "conflict",
          code: "keg.changed",
          clientMessage: "This Keg changed elsewhere. Reload before saving again.",
        });
      }
      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        entityType: "keg",
        entityId: kegId,
        details: { change: "label_autosaved", keg_number: existing.kegNumber },
        occurredAt: now,
      });
      return { ...existing, label, updatedAt: now };
    });
  }

  recordMaintenance(
    kegId: unknown,
    input: unknown,
    options: KegActorOptions = {},
  ): KegMaintenanceRecord {
    const id = validateKegId(kegId);
    const validated = validateRecordMaintenanceInput(input);
    const now = timestamp(options.now ?? this.#nowFactory);
    const idFactory = options.idFactory ?? this.#idFactory;
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existing = findKegById(this.#database, id);
      if (existing === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "keg.not_found",
          clientMessage: "Physical keg not found.",
          details: { id },
        });
      }

      const record: KegMaintenanceRecord = {
        id: idFactory(),
        kegId: id,
        maintenanceType: validated.maintenanceType,
        notes: validated.notes ?? null,
        recordedAt: validated.recordedAt ?? now,
        actorType,
        actorId: actorId ?? null,
      };

      insertMaintenanceRecord(this.#database, record);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "keg",
        entityId: id,
        details: {
          change: "maintenance_recorded",
          maintenance_type: validated.maintenanceType,
          keg_number: existing.kegNumber,
        },
        occurredAt: now,
      });

      return record;
    });
  }

  getDeletionImpact(id: unknown): KegDeletionImpact {
    const kegId = validateKegId(id);
    const impact = getKegDeletionImpact(this.#database, kegId);
    if (impact === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "keg.not_found",
        clientMessage: "Physical keg not found.",
        details: { id: kegId },
      });
    }
    return impact;
  }

  deleteKeg(id: unknown, input?: unknown, options: KegActorOptions = {}): KegDeletionImpact {
    const kegId = validateKegId(id);
    const validated = validateDeleteKegInput(input);
    const now = timestamp(options.now ?? this.#nowFactory);
    const actorType = options.actorType ?? "admin";
    const actorId = options.actorId;
    const sessionId = options.sessionId;

    return this.#database.withTransaction(() => {
      const existing = findKegById(this.#database, kegId);
      const impact = getKegDeletionImpact(this.#database, kegId);
      if (existing === undefined || impact === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "keg.not_found",
          clientMessage: "Physical keg not found.",
          details: { id: kegId },
        });
      }

      const expected = kegDeletionConfirmationLabel(existing);
      if (
        validated.confirmation === undefined ||
        validated.confirmation === null ||
        validated.confirmation.length === 0
      ) {
        throw new ApplicationError({
          category: "validation",
          code: "keg.confirmation_required",
          clientMessage:
            "Type the exact visible Keg number and label to confirm permanent deletion.",
        });
      }
      if (validated.confirmation !== expected) {
        throw new ApplicationError({
          category: "validation",
          code: "keg.confirmation_mismatch",
          clientMessage:
            "Type the exact visible Keg number and label to confirm permanent deletion.",
          details: { expected },
        });
      }

      appendDeletionAudit(this.#database, {
        entityType: "keg",
        entityId: kegId,
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(validated.reason ? { reason: validated.reason } : {}),
        impacts: impact.impacts,
        deletedAt: now,
      });

      deleteKegById(this.#database, kegId);

      appendActivity(this.#database, {
        category: "domain",
        action: "deletion",
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        entityType: "keg",
        entityId: kegId,
        details: {
          keg_number: existing.kegNumber,
          tare_records_deleted: impact.tareHistoryRecords,
          maintenance_records_deleted: impact.maintenanceRecords,
        },
        occurredAt: now,
      });

      return impact;
    });
  }

  getKeg(id: unknown): {
    readonly keg: PhysicalKeg;
    readonly tareHistory: readonly KegTareHistoryRecord[];
    readonly maintenanceHistory: readonly KegMaintenanceRecord[];
  } {
    const kegId = validateKegId(id);
    const keg = findKegById(this.#database, kegId);
    if (keg === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "keg.not_found",
        clientMessage: "Physical keg not found.",
        details: { id: kegId },
      });
    }

    const tareHistory = listTareHistoryByKegId(this.#database, kegId);
    const maintenanceHistory = listMaintenanceRecordsByKegId(this.#database, kegId);

    return {
      keg,
      tareHistory,
      maintenanceHistory,
    };
  }

  listKegs(options: ListKegsOptions = {}): PhysicalKeg[] {
    return listKegRows(this.#database, options);
  }

  /** Return the bounded, SQL-backed physical Keg inventory projection. */
  listAdminPage(query: unknown = {}): AdminKegPage {
    const validated = validateAdminKegPageQuery(query);
    const total = countAdminKegPage(this.#database, validated);
    const pageCount = Math.max(1, Math.ceil(total / adminKegPageSize()));
    const page = Math.min(validated.page, pageCount);
    const items = listAdminKegPage(this.#database, { ...validated, page });
    return {
      items,
      total,
      page,
      pageSize: adminKegPageSize(),
      pageCount,
      query: validated.q,
      status: validated.status,
      sort: validated.sort,
    };
  }
}

export function createKegService(
  database: DatabaseExecutor,
  options?: KegServiceOptions,
): KegService {
  return new KegService(database, options);
}
