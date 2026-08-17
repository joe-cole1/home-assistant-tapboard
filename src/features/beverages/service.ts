import { randomUUID } from "node:crypto";
import {
  assertSynchronousCompletion,
  type DatabaseExecutor,
} from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import type { SecretsService } from "../secrets/service.ts";
import { resolveBeverageDensity } from "./density.ts";
import { resolveCustomPresentation, resolveLinkedPresentation } from "./presentation.ts";
import {
  calculateBeverageDeletionImpact,
  countBeverages,
  deleteBeverageWithAudit,
  deleteCustomRecipe,
  insertBeverage,
  insertBeverageLink,
  insertCustomProfile,
  listBeverageLinks,
  listBeveragePage,
  listBeverages,
  listCandidates,
  readBeverage,
  readBeverageLink,
  readBeverageLinkByBatch,
  readBeverageUsage,
  readCurrentBeverageFills,
  readBeverageSettings,
  readBrewfatherAccount,
  readCandidate,
  readCurrentRecipeSnapshot,
  readCustomProfile,
  readCustomRecipe,
  readPresentationOverrides,
  readRecipeSnapshots,
  readSensoryOverrides,
  readSourceProfile,
  saveCustomRecipe,
  touchBeverage,
  touchBeverageIfUpdatedAt,
  unlinkBeverageTransaction,
  updateBeverageSettings,
  updateCustomProfile,
  upsertBrewfatherAccount,
  upsertPresentationOverrides,
  upsertSensoryOverrides,
  upsertSourceProfile,
} from "./repository.ts";
import {
  validateConfigureBrewfatherAccountInput,
  validateCreateCustomBeverageInput,
  validateDeleteBeverageInput,
  validateLinkBrewfatherCandidateInput,
  validateUpdateBeverageSettingsInput,
  validateUpdateCustomBeverageInput,
  validateUpdateBeverageSensoryOverridesInput,
  validateUpdatePresentationOverridesInput,
} from "./beverage-validation.ts";
import { BrewfatherSyncCoordinator, type SyncOptions, type SyncResult } from "./brewfather/sync.ts";
import { BEVERAGE_SENSORY_AXES, BEVERAGE_TYPES } from "./types.ts";
import type {
  Beverage,
  BeverageActorOptions,
  BeverageDensityExtensionPort,
  BeverageDeletionImpact,
  BeverageListPage,
  BeverageListQuery,
  BeverageUsage,
  BeverageCurrentFill,
  DeleteBeverageInput,
  BeverageSensoryOverrides,
  BeverageSettings,
  BeverageSourceRecipeSnapshot,
  BeverageType,
  BrewfatherAccount,
  BrewfatherBeverageLink,
  BrewfatherCandidate,
  BrewfatherPresentationOverrides,
  BrewfatherSourceProfile,
  CustomBeverageProfile,
  CustomRecipe,
  DensityResolution,
  EffectiveBeveragePresentation,
  UpdateBeverageSensoryOverridesResult,
  UpdatePresentationOverridesInput,
} from "./types.ts";

export interface BeverageDetailResult {
  readonly beverage: Beverage;
  readonly effectivePresentation: EffectiveBeveragePresentation;
  readonly density: DensityResolution;
  readonly customProfile?: CustomBeverageProfile | undefined;
  readonly customRecipe?: CustomRecipe | undefined;
  readonly brewfatherLink?: BrewfatherBeverageLink | undefined;
  readonly brewfatherSourceProfile?: BrewfatherSourceProfile | undefined;
  readonly presentationOverrides?: BrewfatherPresentationOverrides | undefined;
  readonly recipeSnapshot?: BeverageSourceRecipeSnapshot | undefined;
  readonly sensoryOverrides?: BeverageSensoryOverrides | undefined;
}

export interface BeverageSummaryResult {
  readonly beverage: Beverage;
  readonly effectivePresentation: EffectiveBeveragePresentation;
  readonly density: DensityResolution;
}

export interface BeverageServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly secretsService?: SecretsService;
  readonly syncCoordinator?: BrewfatherSyncCoordinator;
  readonly densityExtensionPort?: BeverageDensityExtensionPort;
  /** Runs after a Brewfather synchronization has completed all database work. */
  readonly onSyncCompleted?: (results: readonly SyncResult[]) => void;
}

function mergeOverrideField<T>(
  fieldInput:
    | {
        readonly inherit?: boolean;
        readonly clear?: boolean;
        readonly value?: T | null;
      }
    | undefined,
  currentPresent: boolean | undefined,
  currentValue: T | null | undefined,
): { readonly present: boolean; readonly value: T | null } {
  if (fieldInput === undefined) {
    return {
      present: currentPresent ?? false,
      value: currentValue ?? null,
    };
  }
  if (fieldInput.inherit) {
    return { present: false, value: null };
  }
  return {
    present: true,
    value: fieldInput.value ?? null,
  };
}

function sameSensoryOverrides(
  left: BeverageSensoryOverrides,
  right: BeverageSensoryOverrides,
): boolean {
  return BEVERAGE_SENSORY_AXES.every((axis) => left[axis] === right[axis]);
}

export class BeverageService {
  readonly #database: DatabaseExecutor;
  readonly #secretsService?: SecretsService | undefined;
  readonly #syncCoordinator: BrewfatherSyncCoordinator;
  readonly #densityExtensionPort: BeverageDensityExtensionPort;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #onSyncCompleted?: ((results: readonly SyncResult[]) => void) | undefined;
  #startupTimer?: NodeJS.Timeout | undefined;
  #periodicTimer?: NodeJS.Timeout | undefined;

  constructor(database: DatabaseExecutor, options: BeverageServiceOptions = {}) {
    this.#database = database;
    this.#secretsService = options.secretsService;
    this.#syncCoordinator = options.syncCoordinator ?? new BrewfatherSyncCoordinator();
    this.#densityExtensionPort = options.densityExtensionPort ?? {
      onEffectiveDensityChanged: () => undefined,
    };
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onSyncCompleted = options.onSyncCompleted;
  }

  startPeriodicSync(
    options: {
      readonly intervalMs?: number;
      readonly initialDelayMs?: number;
    } = {},
  ): void {
    this.stopPeriodicSync();
    const initialDelay = options.initialDelayMs ?? 1_000;
    const interval = options.intervalMs ?? 3_600_000;

    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = undefined;
      void this.syncBrewfather().catch(() => undefined);
    }, initialDelay);

    this.#periodicTimer = setInterval(() => {
      void this.syncBrewfather().catch(() => undefined);
    }, interval);
  }

  stopPeriodicSync(): void {
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
    if (this.#periodicTimer !== undefined) {
      clearInterval(this.#periodicTimer);
      this.#periodicTimer = undefined;
    }
  }

  getSettings(): BeverageSettings {
    return readBeverageSettings(this.#database);
  }

  updateSettings(input: unknown, actorOptions: BeverageActorOptions = {}): BeverageSettings {
    const validated = validateUpdateBeverageSettingsInput(input);
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const previousSettings = readBeverageSettings(this.#database);
      const previousDensities = this.#effectiveDensities(previousSettings.fallbackFg);
      const updated = updateBeverageSettings(this.#database, validated, now);

      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage_settings",
        entityId: "1",
        details: {
          change: "updated",
          fallback_fg: updated.fallbackFg,
          brewfather_completion_policy: updated.brewfatherCompletionPolicy,
        },
        occurredAt: now,
      });

      for (const [beverageId, previousDensity] of previousDensities) {
        const nextDensity = this.#resolveDensityForBeverage(beverageId, updated.fallbackFg);
        if (nextDensity !== undefined)
          this.#notifyDensityChanged(beverageId, previousDensity, nextDensity, now);
      }

      return updated;
    });
  }

  createCustomBeverage(
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateCreateCustomBeverageInput(input);
    const id = validated.id ?? this.#idFactory();
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const beverage: Beverage = {
        id,
        ownershipType: "custom",
        createdAt: now,
        updatedAt: now,
      };
      insertBeverage(this.#database, beverage);

      const customProfile: CustomBeverageProfile = {
        beverageId: id,
        name: validated.name,
        beverageType: validated.beverageType ?? "beer",
        style: validated.style ?? null,
        abv: validated.abv ?? null,
        ibu: validated.ibu ?? null,
        og: validated.og ?? null,
        fg: validated.fg ?? null,
        srm: validated.srm ?? null,
        displayColor: validated.displayColor ?? null,
        description: validated.description ?? null,
        fillGlass: validated.fillGlass ?? null,
        manualDensityOverride: validated.manualDensityOverride ?? null,
        createdAt: now,
        updatedAt: now,
      };
      insertCustomProfile(this.#database, customProfile);

      let customRecipe: CustomRecipe | undefined;
      if (validated.recipe) {
        customRecipe = saveCustomRecipe(this.#database, id, validated.recipe, now, this.#idFactory);
      }

      let sensoryOverrides: BeverageSensoryOverrides | undefined;
      if (validated.sensoryOverrides) {
        sensoryOverrides = upsertSensoryOverrides(
          this.#database,
          id,
          validated.sensoryOverrides,
          now,
        );
      }

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage",
        entityId: id,
        details: {
          change: "created",
          name: customProfile.name,
          ownershipType: "custom",
        },
        occurredAt: now,
      });

      const settings = readBeverageSettings(this.#database);
      const effectivePresentation = resolveCustomPresentation(customProfile);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

      return {
        beverage,
        effectivePresentation,
        density,
        customProfile,
        ...(customRecipe ? { customRecipe } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    });
  }

  updateCustomBeverage(
    id: string,
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateUpdateCustomBeverageInput(input);
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, id);
      if (beverage === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }

      if (beverage.ownershipType !== "custom") {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.not_custom",
          clientMessage: "Cannot modify custom profile on a Brewfather-linked beverage.",
        });
      }

      const settings = readBeverageSettings(this.#database);
      const previousProfile = readCustomProfile(this.#database, id);
      if (previousProfile === undefined) {
        throw new ApplicationError({
          category: "internal",
          code: "beverage.corrupted",
          clientMessage: "Custom beverage profile is missing.",
        });
      }
      const previousDensity = resolveBeverageDensity(
        resolveCustomPresentation(previousProfile),
        settings.fallbackFg,
      );
      const customProfile = updateCustomProfile(this.#database, id, validated, now);

      let customRecipe: CustomRecipe | undefined = readCustomRecipe(this.#database, id);
      if (validated.recipe !== undefined) {
        if (validated.recipe === null) {
          deleteCustomRecipe(this.#database, id);
          customRecipe = undefined;
        } else {
          customRecipe = saveCustomRecipe(
            this.#database,
            id,
            validated.recipe,
            now,
            this.#idFactory,
          );
        }
      }

      let sensoryOverrides: BeverageSensoryOverrides | undefined = readSensoryOverrides(
        this.#database,
        id,
      );
      if (validated.sensoryOverrides !== undefined) {
        if (validated.sensoryOverrides === null) {
          sensoryOverrides = upsertSensoryOverrides(
            this.#database,
            id,
            {
              bitterness: null,
              sweetness: null,
              body: null,
              roast: null,
              tartness: null,
              alcohol: null,
            },
            now,
          );
        } else {
          sensoryOverrides = upsertSensoryOverrides(
            this.#database,
            id,
            validated.sensoryOverrides,
            now,
          );
        }
      }

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage",
        entityId: id,
        details: { change: "updated", name: customProfile.name },
        occurredAt: now,
      });

      const effectivePresentation = resolveCustomPresentation(customProfile);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

      touchBeverage(this.#database, id, now);
      this.#notifyDensityChanged(id, previousDensity, density, now);

      return {
        beverage: { ...beverage, updatedAt: now },
        effectivePresentation,
        density,
        customProfile,
        ...(customRecipe ? { customRecipe } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    });
  }

  updateSensoryOverrides(
    beverageId: string,
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): UpdateBeverageSensoryOverridesResult {
    const validated = validateUpdateBeverageSensoryOverridesInput(input);
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, beverageId);
      if (beverage === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }

      const current =
        readSensoryOverrides(this.#database, beverageId) ??
        ({
          beverageId,
          bitterness: null,
          sweetness: null,
          body: null,
          roast: null,
          tartness: null,
          alcohol: null,
          updatedAt: beverage.updatedAt,
        } satisfies BeverageSensoryOverrides);
      const desired: BeverageSensoryOverrides = {
        ...current,
        ...validated,
      };

      if (sameSensoryOverrides(current, desired)) {
        return { sensoryOverrides: current, changed: false };
      }

      const sensoryOverrides = upsertSensoryOverrides(this.#database, beverageId, validated, now);
      touchBeverage(this.#database, beverageId, now);
      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage",
        entityId: beverageId,
        details: { change: "sensory_overrides_updated" },
        occurredAt: now,
      });

      return { sensoryOverrides, changed: true };
    });
  }

  linkBrewfatherCandidate(
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateLinkBrewfatherCandidateInput(input);
    const accountId = validated.accountId ?? "default";
    const id = validated.id ?? this.#idFactory();
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      // 1. Verify candidate exists in cache
      const candidate = readCandidate(this.#database, accountId, validated.sourceBatchId);
      if (candidate === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "brewfather.candidate_not_found",
          clientMessage:
            "Brewfather candidate batch was not found in cache. Refresh candidates first.",
        });
      }

      // 2. Verify account/sourceBatchId is not already linked to another beverage
      const existingLink = readBeverageLinkByBatch(
        this.#database,
        accountId,
        validated.sourceBatchId,
      );
      if (existingLink !== undefined) {
        throw new ApplicationError({
          category: "conflict",
          code: "brewfather.already_linked",
          clientMessage: `Brewfather batch '${validated.sourceBatchId}' is already linked to another beverage.`,
        });
      }

      // 3. Create core Beverage row
      const beverage: Beverage = {
        id,
        ownershipType: "brewfather",
        createdAt: now,
        updatedAt: now,
      };
      insertBeverage(this.#database, beverage);

      // 4. Create link with pending state and null lastSyncedAt
      const link: BrewfatherBeverageLink = {
        beverageId: id,
        accountId,
        sourceBatchId: validated.sourceBatchId,
        syncState: "pending",
        lastSyncedAt: null,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      insertBeverageLink(this.#database, link);

      // 5. Populate initial source profile directly from candidate summary
      let parsedSummary: Record<string, unknown> = {};
      if (candidate.rawSummaryJson) {
        try {
          const parsed: unknown = JSON.parse(candidate.rawSummaryJson);
          if (parsed !== null && typeof parsed === "object") {
            parsedSummary = parsed as Record<string, unknown>;
          }
        } catch {
          parsedSummary = {};
        }
      }
      const rawType =
        typeof parsedSummary.beverageType === "string" ? parsedSummary.beverageType : "beer";
      const beverageType: BeverageType = (BEVERAGE_TYPES as readonly string[]).includes(rawType)
        ? (rawType as BeverageType)
        : "beer";

      const sourceProfile: BrewfatherSourceProfile = {
        beverageId: id,
        name: candidate.batchName || candidate.recipeName || "Brewfather Batch",
        beverageType,
        style: candidate.style,
        abv: candidate.estimatedAbv,
        ibu: candidate.estimatedIbu,
        og: candidate.estimatedOg,
        fg: candidate.estimatedFg,
        srm: candidate.estimatedSrm,
        displayColor: null,
        description:
          typeof parsedSummary.description === "string" ? parsedSummary.description : null,
        rawSourceJson: candidate.rawSummaryJson,
        sourceFingerprint: candidate.summaryFingerprint,
        updatedAt: now,
      };
      upsertSourceProfile(this.#database, sourceProfile);

      // 6. Handle optional initial presentation overrides
      let presentationOverrides: BrewfatherPresentationOverrides | undefined;
      if (validated.overrides) {
        presentationOverrides = this.#applyOverridesToDatabase(id, validated.overrides, now);
      }

      // 7. Handle optional sensory overrides
      let sensoryOverrides: BeverageSensoryOverrides | undefined;
      if (validated.sensoryOverrides) {
        sensoryOverrides = upsertSensoryOverrides(
          this.#database,
          id,
          validated.sensoryOverrides,
          now,
        );
      }

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage",
        entityId: id,
        details: {
          change: "linked",
          name: sourceProfile.name,
          ownershipType: "brewfather",
          source_batch_id: validated.sourceBatchId,
        },
        occurredAt: now,
      });

      const settings = readBeverageSettings(this.#database);
      const effectivePresentation = resolveLinkedPresentation(sourceProfile, presentationOverrides);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

      return {
        beverage,
        effectivePresentation,
        density,
        brewfatherLink: link,
        brewfatherSourceProfile: sourceProfile,
        ...(presentationOverrides ? { presentationOverrides } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    });
  }

  updatePresentationOverrides(
    beverageId: string,
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateUpdatePresentationOverridesInput(input);
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, beverageId);
      if (beverage === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }

      if (beverage.ownershipType !== "brewfather") {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.not_linked",
          clientMessage: "Cannot modify presentation overrides on a Custom beverage.",
        });
      }

      const sourceProfile = readSourceProfile(this.#database, beverageId);
      if (sourceProfile === undefined) {
        throw new ApplicationError({
          category: "internal",
          code: "beverage.corrupted",
          clientMessage: "Linked source profile is missing.",
        });
      }
      const settings = readBeverageSettings(this.#database);
      const previousDensity = resolveBeverageDensity(
        resolveLinkedPresentation(
          sourceProfile,
          readPresentationOverrides(this.#database, beverageId),
        ),
        settings.fallbackFg,
      );
      const overrides = this.#applyOverridesToDatabase(beverageId, validated, now);

      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "beverage",
        entityId: beverageId,
        details: { change: "overrides_updated", beverage_id: beverageId },
        occurredAt: now,
      });

      const effectivePresentation = resolveLinkedPresentation(sourceProfile, overrides);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);
      const link = readBeverageLink(this.#database, beverageId);
      const recipeSnapshot = readCurrentRecipeSnapshot(this.#database, beverageId);
      const sensoryOverrides = readSensoryOverrides(this.#database, beverageId);

      touchBeverage(this.#database, beverageId, now);
      this.#notifyDensityChanged(beverageId, previousDensity, density, now);

      return {
        beverage: { ...beverage, updatedAt: now },
        effectivePresentation,
        density,
        brewfatherLink: link,
        brewfatherSourceProfile: sourceProfile,
        presentationOverrides: overrides,
        ...(recipeSnapshot ? { recipeSnapshot } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    });
  }

  /**
   * Autosave the safe public presentation fields for a Custom Beverage.  The
   * caller supplies the whole resource revision that was rendered in the
   * form; no recipe, sensory, density, lifecycle, or assignment field is
   * accepted here.
   */
  autosaveCustomPresentation(
    beverageId: string,
    expectedUpdatedAt: string,
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateUpdateCustomBeverageInput(input);
    if (
      validated.manualDensityOverride !== undefined ||
      validated.recipe !== undefined ||
      validated.sensoryOverrides !== undefined
    ) {
      throw new ApplicationError({
        category: "validation",
        code: "beverage.autosave_unsafe_field",
        clientMessage: "Only public presentation fields can be autosaved.",
      });
    }
    const now = (actorOptions.now ?? this.#now)().toISOString();
    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, beverageId);
      const current = readCustomProfile(this.#database, beverageId);
      if (beverage === undefined || current === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }
      if (beverage.ownershipType !== "custom") {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.not_custom",
          clientMessage: "Only Custom Beverages support direct presentation autosave.",
        });
      }
      if (beverage.updatedAt !== expectedUpdatedAt) {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.settings_changed",
          clientMessage: "This Beverage changed elsewhere. Reload before saving again.",
        });
      }
      const desired = {
        name: validated.name ?? current.name,
        beverageType: validated.beverageType ?? current.beverageType,
        style: validated.style !== undefined ? validated.style : current.style,
        abv: validated.abv !== undefined ? validated.abv : current.abv,
        ibu: validated.ibu !== undefined ? validated.ibu : current.ibu,
        og: validated.og !== undefined ? validated.og : current.og,
        fg: validated.fg !== undefined ? validated.fg : current.fg,
        srm: validated.srm !== undefined ? validated.srm : current.srm,
        displayColor:
          validated.displayColor !== undefined ? validated.displayColor : current.displayColor,
        description:
          validated.description !== undefined ? validated.description : current.description,
        fillGlass: validated.fillGlass !== undefined ? validated.fillGlass : current.fillGlass,
      };
      const changed = (
        [
          "name",
          "beverageType",
          "style",
          "abv",
          "ibu",
          "og",
          "fg",
          "srm",
          "displayColor",
          "description",
          "fillGlass",
        ] as const
      ).some((field) => desired[field] !== current[field]);
      if (!changed) return this.getBeverage(beverageId);
      if (!touchBeverageIfUpdatedAt(this.#database, beverageId, expectedUpdatedAt, now)) {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.settings_changed",
          clientMessage: "This Beverage changed elsewhere. Reload before saving again.",
        });
      }
      const previousDensity = resolveBeverageDensity(
        resolveCustomPresentation(current),
        readBeverageSettings(this.#database).fallbackFg,
      );
      const profile = updateCustomProfile(this.#database, beverageId, desired, now);
      const settings = readBeverageSettings(this.#database);
      const effectivePresentation = resolveCustomPresentation(profile);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);
      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId === undefined ? {} : { actorId: actorOptions.actorId }),
        ...(actorOptions.sessionId === undefined ? {} : { sessionId: actorOptions.sessionId }),
        entityType: "beverage",
        entityId: beverageId,
        details: { change: "presentation_autosaved", name: profile.name },
        occurredAt: now,
      });
      this.#notifyDensityChanged(beverageId, previousDensity, density, now);
      return {
        beverage: { ...beverage, updatedAt: now },
        effectivePresentation,
        density,
        customProfile: profile,
        ...(readCustomRecipe(this.#database, beverageId)
          ? { customRecipe: readCustomRecipe(this.#database, beverageId) }
          : {}),
        ...(readSensoryOverrides(this.#database, beverageId)
          ? { sensoryOverrides: readSensoryOverrides(this.#database, beverageId) }
          : {}),
      };
    });
  }

  /** Autosave the safe Brewfather override fields with a parent CAS. */
  autosavePresentationOverrides(
    beverageId: string,
    expectedUpdatedAt: string,
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const validated = validateUpdatePresentationOverridesInput(input);
    if (validated.manualDensityOverride !== undefined) {
      throw new ApplicationError({
        category: "validation",
        code: "beverage.autosave_unsafe_field",
        clientMessage: "Density overrides require an explicit Save action.",
      });
    }
    const now = (actorOptions.now ?? this.#now)().toISOString();
    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, beverageId);
      const sourceProfile = readSourceProfile(this.#database, beverageId);
      if (beverage === undefined || sourceProfile === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }
      if (beverage.ownershipType !== "brewfather") {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.not_linked",
          clientMessage: "Only Brewfather-linked Beverages support override autosave.",
        });
      }
      if (beverage.updatedAt !== expectedUpdatedAt) {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.settings_changed",
          clientMessage: "This Beverage changed elsewhere. Reload before saving again.",
        });
      }
      const current = readPresentationOverrides(this.#database, beverageId);
      const settings = readBeverageSettings(this.#database);
      const previousDensity = resolveBeverageDensity(
        resolveLinkedPresentation(sourceProfile, current),
        settings.fallbackFg,
      );
      const fieldNames = [
        "name",
        "beverageType",
        "style",
        "abv",
        "ibu",
        "og",
        "fg",
        "srm",
        "displayColor",
        "description",
        "fillGlass",
        "manualDensityOverride",
      ] as const;
      const desiredFields = Object.fromEntries(
        fieldNames.map((field) => [
          field,
          mergeOverrideField(
            validated[field],
            current?.[
              `override${field[0]!.toUpperCase()}${field.slice(1)}Present` as keyof typeof current
            ] as boolean | undefined,
            current?.[field as keyof typeof current] as string | number | null | undefined,
          ),
        ]),
      ) as Record<(typeof fieldNames)[number], { present: boolean; value: string | number | null }>;
      const changed = fieldNames.some((field) => {
        const presentKey =
          `override${field[0]!.toUpperCase()}${field.slice(1)}Present` as keyof typeof current;
        return (
          desiredFields[field].present !== Boolean(current?.[presentKey]) ||
          desiredFields[field].value !== (current?.[field as keyof typeof current] ?? null)
        );
      });
      if (!changed) return this.getBeverage(beverageId);
      if (!touchBeverageIfUpdatedAt(this.#database, beverageId, expectedUpdatedAt, now)) {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.settings_changed",
          clientMessage: "This Beverage changed elsewhere. Reload before saving again.",
        });
      }
      const overrides = {
        beverageId,
        overrideNamePresent: desiredFields.name.present,
        name: desiredFields.name.value as string | null,
        overrideBeverageTypePresent: desiredFields.beverageType.present,
        beverageType: desiredFields.beverageType.value as BeverageType | null,
        overrideStylePresent: desiredFields.style.present,
        style: desiredFields.style.value as string | null,
        overrideAbvPresent: desiredFields.abv.present,
        abv: desiredFields.abv.value as number | null,
        overrideIbuPresent: desiredFields.ibu.present,
        ibu: desiredFields.ibu.value as number | null,
        overrideOgPresent: desiredFields.og.present,
        og: desiredFields.og.value as number | null,
        overrideFgPresent: desiredFields.fg.present,
        fg: desiredFields.fg.value as number | null,
        overrideSrmPresent: desiredFields.srm.present,
        srm: desiredFields.srm.value as number | null,
        overrideDisplayColorPresent: desiredFields.displayColor.present,
        displayColor: desiredFields.displayColor.value as string | null,
        overrideDescriptionPresent: desiredFields.description.present,
        description: desiredFields.description.value as string | null,
        overrideFillGlassPresent: desiredFields.fillGlass.present,
        fillGlass: desiredFields.fillGlass.value as string | null,
        overrideManualDensityOverridePresent: desiredFields.manualDensityOverride.present,
        manualDensityOverride: desiredFields.manualDensityOverride.value as number | null,
        updatedAt: now,
      } satisfies BrewfatherPresentationOverrides;
      upsertPresentationOverrides(this.#database, overrides);
      appendActivity(this.#database, {
        category: "domain",
        action: "entity_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId === undefined ? {} : { actorId: actorOptions.actorId }),
        ...(actorOptions.sessionId === undefined ? {} : { sessionId: actorOptions.sessionId }),
        entityType: "beverage",
        entityId: beverageId,
        details: { change: "presentation_override_autosaved" },
        occurredAt: now,
      });
      const effectivePresentation = resolveLinkedPresentation(sourceProfile, overrides);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);
      this.#notifyDensityChanged(beverageId, previousDensity, density, now);
      return {
        beverage: { ...beverage, updatedAt: now },
        effectivePresentation,
        density,
        brewfatherLink: readBeverageLink(this.#database, beverageId),
        brewfatherSourceProfile: sourceProfile,
        presentationOverrides: overrides,
        ...(readCurrentRecipeSnapshot(this.#database, beverageId)
          ? { recipeSnapshot: readCurrentRecipeSnapshot(this.#database, beverageId) }
          : {}),
        ...(readSensoryOverrides(this.#database, beverageId)
          ? { sensoryOverrides: readSensoryOverrides(this.#database, beverageId) }
          : {}),
      };
    });
  }

  #applyOverridesToDatabase(
    beverageId: string,
    input: UpdatePresentationOverridesInput,
    now: string,
  ): BrewfatherPresentationOverrides {
    const current = readPresentationOverrides(this.#database, beverageId);

    const nameField = mergeOverrideField(input.name, current?.overrideNamePresent, current?.name);
    const beverageTypeField = mergeOverrideField(
      input.beverageType,
      current?.overrideBeverageTypePresent,
      current?.beverageType,
    );
    const styleField = mergeOverrideField(
      input.style,
      current?.overrideStylePresent,
      current?.style,
    );
    const abvField = mergeOverrideField(input.abv, current?.overrideAbvPresent, current?.abv);
    const ibuField = mergeOverrideField(input.ibu, current?.overrideIbuPresent, current?.ibu);
    const ogField = mergeOverrideField(input.og, current?.overrideOgPresent, current?.og);
    const fgField = mergeOverrideField(input.fg, current?.overrideFgPresent, current?.fg);
    const srmField = mergeOverrideField(input.srm, current?.overrideSrmPresent, current?.srm);
    const displayColorField = mergeOverrideField(
      input.displayColor,
      current?.overrideDisplayColorPresent,
      current?.displayColor,
    );
    const descriptionField = mergeOverrideField(
      input.description,
      current?.overrideDescriptionPresent,
      current?.description,
    );
    const fillGlassField = mergeOverrideField(
      input.fillGlass,
      current?.overrideFillGlassPresent,
      current?.fillGlass,
    );
    const manualDensityOverrideField = mergeOverrideField(
      input.manualDensityOverride,
      current?.overrideManualDensityOverridePresent,
      current?.manualDensityOverride,
    );

    const overrides: BrewfatherPresentationOverrides = {
      beverageId,
      overrideNamePresent: nameField.present,
      name: nameField.value,
      overrideBeverageTypePresent: beverageTypeField.present,
      beverageType: beverageTypeField.value,
      overrideStylePresent: styleField.present,
      style: styleField.value,
      overrideAbvPresent: abvField.present,
      abv: abvField.value,
      overrideIbuPresent: ibuField.present,
      ibu: ibuField.value,
      overrideOgPresent: ogField.present,
      og: ogField.value,
      overrideFgPresent: fgField.present,
      fg: fgField.value,
      overrideSrmPresent: srmField.present,
      srm: srmField.value,
      overrideDisplayColorPresent: displayColorField.present,
      displayColor: displayColorField.value,
      overrideDescriptionPresent: descriptionField.present,
      description: descriptionField.value,
      overrideFillGlassPresent: fillGlassField.present,
      fillGlass: fillGlassField.value,
      overrideManualDensityOverridePresent: manualDensityOverrideField.present,
      manualDensityOverride: manualDensityOverrideField.value,
      updatedAt: now,
    };

    upsertPresentationOverrides(this.#database, overrides);
    return overrides;
  }

  #notifyDensityChanged(
    beverageId: string,
    previousDensity: DensityResolution,
    newDensity: DensityResolution,
    changedAt: string,
  ): void {
    if (previousDensity.densityGPerMl === newDensity.densityGPerMl) return;
    assertSynchronousCompletion(
      this.#densityExtensionPort.onEffectiveDensityChanged(this.#database, {
        beverageId,
        previousDensity,
        newDensity,
        changedAt,
      }),
      "Beverage density extensions",
    );
  }

  #resolveDensityForBeverage(
    beverageId: string,
    fallbackFg: number,
  ): DensityResolution | undefined {
    const beverage = readBeverage(this.#database, beverageId);
    if (beverage?.ownershipType === "custom") {
      const profile = readCustomProfile(this.#database, beverageId);
      return profile
        ? resolveBeverageDensity(resolveCustomPresentation(profile), fallbackFg)
        : undefined;
    }
    if (beverage?.ownershipType === "brewfather") {
      const source = readSourceProfile(this.#database, beverageId);
      return source
        ? resolveBeverageDensity(
            resolveLinkedPresentation(
              source,
              readPresentationOverrides(this.#database, beverageId),
            ),
            fallbackFg,
          )
        : undefined;
    }
    return undefined;
  }

  #effectiveDensities(fallbackFg: number): ReadonlyMap<string, DensityResolution> {
    const densities = new Map<string, DensityResolution>();
    for (const beverage of listBeverages(this.#database)) {
      const density = this.#resolveDensityForBeverage(beverage.id, fallbackFg);
      if (density !== undefined) densities.set(beverage.id, density);
    }
    return densities;
  }

  unlinkBeverage(
    beverageId: string,
    actorOptions: BeverageActorOptions = {},
  ): BeverageDetailResult {
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const beverage = readBeverage(this.#database, beverageId);
      if (beverage === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "beverage.not_found",
          clientMessage: "Beverage was not found.",
        });
      }

      if (beverage.ownershipType !== "brewfather") {
        throw new ApplicationError({
          category: "conflict",
          code: "beverage.not_linked",
          clientMessage: "Beverage is not currently linked to Brewfather.",
        });
      }

      const sourceProfile = readSourceProfile(this.#database, beverageId);
      if (sourceProfile === undefined) {
        throw new ApplicationError({
          category: "internal",
          code: "beverage.corrupted",
          clientMessage: "Linked source profile is missing.",
        });
      }

      const overrides = readPresentationOverrides(this.#database, beverageId);
      const effectivePresentation = resolveLinkedPresentation(sourceProfile, overrides);

      // Perform atomic unlink transaction
      const customProfile = unlinkBeverageTransaction(
        this.#database,
        beverageId,
        effectivePresentation,
        now,
        actorOptions,
      );

      const settings = readBeverageSettings(this.#database);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);
      const updatedBeverage = readBeverage(this.#database, beverageId)!;
      const detachedSnapshot = readCurrentRecipeSnapshot(this.#database, beverageId);
      const sensoryOverrides = readSensoryOverrides(this.#database, beverageId);

      return {
        beverage: updatedBeverage,
        effectivePresentation,
        density,
        customProfile,
        ...(detachedSnapshot ? { recipeSnapshot: detachedSnapshot } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    });
  }

  getBeverage(id: string): BeverageDetailResult {
    const beverage = readBeverage(this.#database, id);
    if (beverage === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "beverage.not_found",
        clientMessage: "Beverage was not found.",
      });
    }

    const settings = readBeverageSettings(this.#database);
    const sensoryOverrides = readSensoryOverrides(this.#database, id);

    if (beverage.ownershipType === "custom") {
      const customProfile = readCustomProfile(this.#database, id);
      if (customProfile === undefined) {
        throw new ApplicationError({
          category: "internal",
          code: "beverage.corrupted",
          clientMessage: "Custom beverage profile is missing.",
        });
      }
      const customRecipe = readCustomRecipe(this.#database, id);
      const recipeSnapshot = readCurrentRecipeSnapshot(this.#database, id);
      const effectivePresentation = resolveCustomPresentation(customProfile);
      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

      return {
        beverage,
        effectivePresentation,
        density,
        customProfile,
        ...(customRecipe ? { customRecipe } : {}),
        ...(recipeSnapshot ? { recipeSnapshot } : {}),
        ...(sensoryOverrides ? { sensoryOverrides } : {}),
      };
    }

    // Brewfather-linked beverage
    const brewfatherLink = readBeverageLink(this.#database, id);
    const brewfatherSourceProfile = readSourceProfile(this.#database, id);
    if (brewfatherSourceProfile === undefined) {
      throw new ApplicationError({
        category: "internal",
        code: "beverage.corrupted",
        clientMessage: "Brewfather source profile is missing.",
      });
    }
    const presentationOverrides = readPresentationOverrides(this.#database, id);
    const recipeSnapshot = readCurrentRecipeSnapshot(this.#database, id);
    const effectivePresentation = resolveLinkedPresentation(
      brewfatherSourceProfile,
      presentationOverrides,
    );
    const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

    return {
      beverage,
      effectivePresentation,
      density,
      ...(brewfatherLink ? { brewfatherLink } : {}),
      brewfatherSourceProfile,
      ...(presentationOverrides ? { presentationOverrides } : {}),
      ...(recipeSnapshot ? { recipeSnapshot } : {}),
      ...(sensoryOverrides ? { sensoryOverrides } : {}),
    };
  }

  getRecipeSnapshots(beverageId: string): readonly BeverageSourceRecipeSnapshot[] {
    const beverage = readBeverage(this.#database, beverageId);
    if (beverage === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "beverage.not_found",
        clientMessage: "Beverage was not found.",
      });
    }
    return readRecipeSnapshots(this.#database, beverage.id);
  }

  listBeverages(): readonly BeverageSummaryResult[] {
    const beverages = listBeverages(this.#database);
    const settings = readBeverageSettings(this.#database);

    return beverages.map((beverage) => {
      let effectivePresentation: EffectiveBeveragePresentation;
      if (beverage.ownershipType === "custom") {
        const cp = readCustomProfile(this.#database, beverage.id);
        effectivePresentation = cp
          ? resolveCustomPresentation(cp)
          : {
              name: "Unknown",
              beverageType: "beer",
              style: null,
              abv: null,
              ibu: null,
              og: null,
              fg: null,
              srm: null,
              displayColor: null,
              description: null,
              fillGlass: null,
              manualDensityOverride: null,
            };
      } else {
        const sp = readSourceProfile(this.#database, beverage.id);
        const po = readPresentationOverrides(this.#database, beverage.id);
        effectivePresentation = sp
          ? resolveLinkedPresentation(sp, po)
          : {
              name: "Unknown",
              beverageType: "beer",
              style: null,
              abv: null,
              ibu: null,
              og: null,
              fg: null,
              srm: null,
              displayColor: null,
              description: null,
              fillGlass: null,
              manualDensityOverride: null,
            };
      }

      const density = resolveBeverageDensity(effectivePresentation, settings.fallbackFg);

      return {
        beverage,
        effectivePresentation,
        density,
      };
    });
  }

  /**
   * Return the bounded, deterministic authenticated index projection. The
   * repository performs the effective-value joins and usage count in SQL;
   * this method normalizes the bounded query and page window.
   */
  listBeveragePage(query: BeverageListQuery = {}): BeverageListPage {
    const requestedQuery =
      query !== null && typeof query === "object" ? query : ({} as BeverageListQuery);
    const rawQuery = typeof requestedQuery.q === "string" ? requestedQuery.q.trim() : "";
    const normalizedQuery = rawQuery.slice(0, 80);
    const rawPage = requestedQuery.page;
    const requestedPage =
      typeof rawPage === "number" && Number.isInteger(rawPage) && Number.isFinite(rawPage)
        ? Math.max(1, Math.min(10_000, rawPage))
        : 1;
    const total = countBeverages(this.#database, { q: normalizedQuery });
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, pageCount);
    const records = listBeveragePage(this.#database, {
      q: normalizedQuery,
      page,
    });

    return {
      items: records,
      total,
      page,
      pageSize,
      pageCount,
      query: normalizedQuery,
    };
  }

  getBeverageUsage(beverageId: string): BeverageUsage {
    const beverage = readBeverage(this.#database, beverageId);
    if (beverage === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "beverage.not_found",
        clientMessage: "Beverage was not found.",
      });
    }
    return readBeverageUsage(this.#database, beverageId);
  }

  listCurrentFills(beverageId: string, limit = 25): readonly BeverageCurrentFill[] {
    const beverage = readBeverage(this.#database, beverageId);
    if (beverage === undefined) {
      throw new ApplicationError({
        category: "not_found",
        code: "beverage.not_found",
        clientMessage: "Beverage was not found.",
      });
    }
    return readCurrentBeverageFills(this.#database, beverage.id, limit);
  }

  getDeletionImpact(id: string): BeverageDeletionImpact {
    return calculateBeverageDeletionImpact(this.#database, id);
  }

  deleteBeverage(
    id: string,
    input: DeleteBeverageInput = {},
    actorOptions: BeverageActorOptions = {},
  ): BeverageDeletionImpact {
    const validated = validateDeleteBeverageInput(input);
    return deleteBeverageWithAudit(this.#database, id, validated, actorOptions);
  }

  configureBrewfatherAccount(
    input: unknown,
    actorOptions: BeverageActorOptions = {},
  ): BrewfatherAccount {
    const validated = validateConfigureBrewfatherAccountInput(input);
    const accountId = validated.accountId ?? "default";
    const now = (actorOptions.now ?? this.#now)().toISOString();

    return this.#database.withTransaction(() => {
      const account = upsertBrewfatherAccount(
        this.#database,
        {
          id: accountId,
          userId: validated.userId,
          ...(validated.enabled !== undefined ? { enabled: validated.enabled } : {}),
          ...(validated.discoveryStatuses !== undefined
            ? { discoveryStatuses: validated.discoveryStatuses }
            : {}),
        },
        now,
      );

      if (validated.apiKey && this.#secretsService) {
        this.#secretsService.upsert("brewfather", accountId, "api_key", validated.apiKey, {
          ...(actorOptions.now ? { now: actorOptions.now } : {}),
        });
      }

      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType: actorOptions.actorType ?? "admin",
        ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
        ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
        entityType: "brewfather_account",
        entityId: accountId,
        details: {
          change: "configured",
          account_id: accountId,
          user_id: account.userId,
          enabled: account.enabled,
        },
        occurredAt: now,
      });

      return account;
    });
  }

  removeBrewfatherApiKey(
    accountId: string = "default",
    actorOptions: BeverageActorOptions = {},
  ): boolean {
    if (!this.#secretsService) {
      throw new ApplicationError({
        category: "unavailable",
        code: "secrets.unavailable",
        clientMessage: "Secret storage is unavailable.",
      });
    }
    return this.#secretsService.remove("brewfather", accountId, "api_key", {
      ...(actorOptions.now ? { now: actorOptions.now } : {}),
    });
  }

  getBrewfatherStatus(accountId: string = "default"): {
    readonly configured: boolean;
    readonly account?: BrewfatherAccount;
    readonly apiKeyConfigured: boolean;
    readonly totalCandidates: number;
    readonly totalLinkedBeverages: number;
    readonly lastDataUpdateAt: string | null;
  } {
    const account = readBrewfatherAccount(this.#database, accountId);
    const candidates = listCandidates(this.#database, accountId);
    const links = listBeverageLinks(this.#database).filter((l) => l.accountId === accountId);
    const dataUpdateTimes = [
      ...candidates.map((candidate) => candidate.syncedAt),
      ...links.flatMap((link) => (link.lastSyncedAt === null ? [] : [link.lastSyncedAt])),
    ];
    const lastDataUpdateAt =
      dataUpdateTimes.length === 0
        ? null
        : dataUpdateTimes.reduce((latest, current) =>
            Date.parse(current) > Date.parse(latest) ? current : latest,
          );

    let apiKeyConfigured = false;
    if (this.#secretsService) {
      try {
        const desc = this.#secretsService
          .list()
          .find(
            (s) =>
              s.integrationType === "brewfather" &&
              s.recordId === accountId &&
              s.fieldName === "api_key",
          );
        apiKeyConfigured = desc?.configured === true;
      } catch {
        apiKeyConfigured = false;
      }
    }

    return {
      configured: account !== undefined,
      ...(account ? { account } : {}),
      apiKeyConfigured,
      totalCandidates: candidates.length,
      totalLinkedBeverages: links.length,
      lastDataUpdateAt,
    };
  }

  listCandidates(accountId: string = "default"): readonly BrewfatherCandidate[] {
    return listCandidates(this.#database, accountId);
  }

  async syncBrewfather(options: SyncOptions = {}): Promise<readonly SyncResult[]> {
    if (!this.#secretsService) {
      throw new ApplicationError({
        category: "internal",
        code: "secrets.unavailable",
        clientMessage: "Secrets service is unavailable for Brewfather integration.",
      });
    }

    const results = await this.#syncCoordinator.sync(this.#database, this.#secretsService, {
      now: this.#now,
      ...options,
      densityExtensionPort: this.#densityExtensionPort,
    });
    this.#onSyncCompleted?.(results);
    return results;
  }

  async completeBrewfatherBatch(
    beverageId: string,
    options: SyncOptions = {},
  ): Promise<{
    readonly outcome: "not_applicable" | "already_terminal" | "completed" | "failed";
    readonly message?: string;
  }> {
    if (!this.#secretsService) {
      return {
        outcome: "failed",
        message: "Secrets service is unavailable for Brewfather integration.",
      };
    }

    return this.#syncCoordinator.completeBatch(this.#database, this.#secretsService, beverageId, {
      now: this.#now,
      ...options,
    });
  }
}

export function createBeverageService(
  database: DatabaseExecutor,
  options: BeverageServiceOptions = {},
): BeverageService {
  return new BeverageService(database, options);
}
