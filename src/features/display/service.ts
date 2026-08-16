import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { readDisplaySettings, updateDisplaySettings } from "./repository.ts";
import type { DisplaySettings } from "./types.ts";
import { validateUpdateDisplaySettingsInput } from "./display-validation.ts";

export interface DisplayActorOptions {
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}
export interface DisplaySettingsService {
  getSettings(): DisplaySettings;
  updateSettings(input: unknown, actor?: DisplayActorOptions): DisplaySettings;
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
  };
}
