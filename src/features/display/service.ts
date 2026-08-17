import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import {
  readDisplaySettings,
  readTapCardDisplayOverride,
  readTapCardDisplaySettings,
  deleteTapCardDisplayOverride,
  resolveTapCardDisplaySettings,
  updateDisplaySettings,
  updateTapCardDisplaySettings,
  upsertTapCardDisplayOverride,
  type TapCardDisplayOverrideUpdateResult,
} from "./repository.ts";
import type {
  DisplaySettings,
  EffectiveTapCardDisplaySettings,
  TapCardDisplayOverride,
  TapCardDisplaySettings,
} from "./types.ts";
import {
  validateTapCardDisplayOverridePatch,
  validateTapCardDisplaySettingsInput,
  validateTapCardId,
  validateUpdateDisplaySettingsInput,
} from "./display-validation.ts";
import { findTapById } from "../taps/repository.ts";
import { touchTapIfUpdatedAt } from "../taps/repository.ts";

export interface DisplayActorOptions {
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}
export interface DisplaySettingsService {
  getSettings(): DisplaySettings;
  updateSettings(input: unknown, actor?: DisplayActorOptions): DisplaySettings;
  getTapCardSettings(): TapCardDisplaySettings;
  updateTapCardSettings(input: unknown, actor?: DisplayActorOptions): TapCardDisplaySettings;
  getTapCardOverride(tapId: unknown): TapCardDisplayOverride | undefined;
  setTapCardOverride(
    tapId: unknown,
    input: unknown,
    actor?: DisplayActorOptions,
  ): TapCardDisplayOverride | undefined;
  clearTapCardOverride(tapId: unknown, actor?: DisplayActorOptions): boolean;
  getEffectiveTapCardSettings(tapId: unknown): EffectiveTapCardDisplaySettings;
  autosaveTapCardOverride(
    tapId: unknown,
    expectedUpdatedAt: string,
    input: unknown,
    actor?: DisplayActorOptions,
  ): {
    readonly current: EffectiveTapCardDisplaySettings;
    readonly updatedAt: string;
    readonly changed: boolean;
  };
}
function timestamp(now: (() => Date) | undefined): string {
  const value = now?.() ?? new Date();
  if (Number.isNaN(value.getTime())) throw new TypeError("Invalid clock in display service");
  return value.toISOString();
}
function equal(
  current: DisplaySettings,
  input: ReturnType<typeof validateUpdateDisplaySettingsInput>,
): boolean {
  return (
    current.tapboardName === input.tapboardName &&
    current.theme === input.theme &&
    current.font === input.font &&
    current.accent === input.accent &&
    current.unitSystem === input.unitSystem &&
    current.showServingTemperature === input.showServingTemperature &&
    current.layoutMode === input.layoutMode
  );
}
function conflict(): never {
  throw new ApplicationError({
    category: "conflict",
    code: "display.settings_changed",
    clientMessage: "Display settings changed concurrently.",
  });
}

function tapNotFound(tapId: string): never {
  throw new ApplicationError({
    category: "not_found",
    code: "display.tap_not_found",
    clientMessage: "The Tap was not found.",
    details: { tapId },
  });
}

function requireTap(database: DatabaseExecutor, value: unknown): string {
  const tapId = validateTapCardId(value);
  if (findTapById(database, tapId) === undefined) tapNotFound(tapId);
  return tapId;
}

function equalTapCardSettings(
  current: TapCardDisplaySettings,
  input: ReturnType<typeof validateTapCardDisplaySettingsInput>,
): boolean {
  return (
    current.showAbv === input.showAbv &&
    current.showIbu === input.showIbu &&
    current.showOg === input.showOg &&
    current.showFg === input.showFg &&
    current.showSrm === input.showSrm &&
    current.remainingMode === input.remainingMode
  );
}

function overridePatchValues(
  override: TapCardDisplayOverride | undefined,
): Record<"showAbv" | "showIbu" | "showOg" | "showFg" | "showSrm", boolean | null> {
  return {
    showAbv: override?.showAbv ?? null,
    showIbu: override?.showIbu ?? null,
    showOg: override?.showOg ?? null,
    showFg: override?.showFg ?? null,
    showSrm: override?.showSrm ?? null,
  };
}

function mergeTapCardOverride(
  current: TapCardDisplayOverride | undefined,
  patch: ReturnType<typeof validateTapCardDisplayOverridePatch>,
) {
  const values = overridePatchValues(current);
  for (const field of ["showAbv", "showIbu", "showOg", "showFg", "showSrm"] as const) {
    if (Object.hasOwn(patch, field)) values[field] = patch[field] ?? null;
  }
  return values;
}

function logTapCardActivity(
  database: DatabaseExecutor,
  entityId: string,
  details: Record<string, string | number | boolean | null>,
  actor: DisplayActorOptions,
  at: string,
): void {
  appendActivity(database, {
    category: "admin",
    action: "configuration_changed",
    actorType: "admin",
    ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
    ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
    entityType: entityId === "1" ? "tap_card_display_settings" : "tap_card_display_override",
    entityId,
    details,
    occurredAt: at,
  });
}

export function createDisplaySettingsService(database: DatabaseExecutor): DisplaySettingsService {
  return {
    getSettings: () => readDisplaySettings(database),
    updateSettings(input, actor = {}) {
      const parsed = validateUpdateDisplaySettingsInput(input);
      return database.withTransaction(() => {
        const current = readDisplaySettings(database);
        if (current.revision !== parsed.expectedRevision) conflict();
        if (equal(current, parsed)) return current;
        const at = timestamp(actor.now);
        if (!updateDisplaySettings(database, parsed, at)) conflict();
        const updated = readDisplaySettings(database);
        appendActivity(database, {
          category: "admin",
          action: "configuration_changed",
          actorType: "admin",
          ...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
          ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }),
          entityType: "display_settings",
          entityId: "1",
          details: { revision: updated.revision },
          occurredAt: at,
        });
        return updated;
      });
    },
    getTapCardSettings: () => readTapCardDisplaySettings(database),
    updateTapCardSettings(input, actor = {}) {
      const parsed = validateTapCardDisplaySettingsInput(input);
      return database.withTransaction(() => {
        const current = readTapCardDisplaySettings(database);
        if (current.revision !== parsed.expectedRevision) conflict();
        if (equalTapCardSettings(current, parsed)) return current;
        const at = timestamp(actor.now);
        if (!updateTapCardDisplaySettings(database, parsed, at)) conflict();
        const updated = readTapCardDisplaySettings(database);
        logTapCardActivity(database, "1", { revision: updated.revision }, actor, at);
        return updated;
      });
    },
    getTapCardOverride(tapIdValue) {
      return readTapCardDisplayOverride(database, validateTapCardId(tapIdValue));
    },
    setTapCardOverride(tapIdValue, input, actor = {}) {
      const tapId = requireTap(database, tapIdValue);
      const patch = validateTapCardDisplayOverridePatch(input);
      return database.withTransaction(() => {
        const current = readTapCardDisplayOverride(database, tapId);
        const merged = mergeTapCardOverride(current, patch);
        const at = timestamp(actor.now);
        const result: TapCardDisplayOverrideUpdateResult = upsertTapCardDisplayOverride(
          database,
          tapId,
          merged,
          at,
        );
        if (result.changed) {
          logTapCardActivity(database, tapId, { tap_id: tapId }, actor, at);
        }
        return result.current;
      });
    },
    autosaveTapCardOverride(tapIdValue, expectedUpdatedAt, input, actor = {}) {
      const tapId = requireTap(database, tapIdValue);
      const patch = validateTapCardDisplayOverridePatch(input);
      return database.withTransaction(() => {
        const currentTap = findTapById(database, tapId);
        if (currentTap === undefined) tapNotFound(tapId);
        if (currentTap.updatedAt !== expectedUpdatedAt) {
          conflict();
        }
        const currentOverride = readTapCardDisplayOverride(database, tapId);
        const merged = mergeTapCardOverride(currentOverride, patch);
        const unchanged =
          currentOverride?.showAbv === merged.showAbv &&
          currentOverride?.showIbu === merged.showIbu &&
          currentOverride?.showOg === merged.showOg &&
          currentOverride?.showFg === merged.showFg &&
          currentOverride?.showSrm === merged.showSrm;
        if (unchanged) {
          return {
            current: resolveTapCardDisplaySettings(database, tapId),
            updatedAt: currentTap.updatedAt,
            changed: false,
          };
        }
        const at = timestamp(actor.now);
        if (!touchTapIfUpdatedAt(database, tapId, expectedUpdatedAt, at)) conflict();
        const result = upsertTapCardDisplayOverride(database, tapId, merged, at);
        if (result.changed) logTapCardActivity(database, tapId, { tap_id: tapId }, actor, at);
        return {
          current: resolveTapCardDisplaySettings(database, tapId),
          updatedAt: at,
          changed: true,
        };
      });
    },
    clearTapCardOverride(tapIdValue, actor = {}) {
      const tapId = requireTap(database, tapIdValue);
      return database.withTransaction(() => {
        const current = readTapCardDisplayOverride(database, tapId);
        if (current === undefined) return false;
        const at = timestamp(actor.now);
        deleteTapCardDisplayOverride(database, tapId);
        logTapCardActivity(database, tapId, { tap_id: tapId, cleared: true }, actor, at);
        return true;
      });
    },
    getEffectiveTapCardSettings(tapIdValue) {
      const tapId = validateTapCardId(tapIdValue);
      return resolveTapCardDisplaySettings(database, tapId);
    },
  };
}
