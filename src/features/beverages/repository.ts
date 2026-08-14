import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import { appendDeletionAudit } from "../activity/deletion-audit.ts";
import type {
  Beverage,
  BeverageActorOptions,
  BeverageDeletionImpact,
  BeverageOwnershipType,
  BeverageSensoryOverrides,
  BeverageSettings,
  BeverageSourceRecipeSnapshot,
  BeverageType,
  BrewfatherAccount,
  BrewfatherBeverageLink,
  BrewfatherCandidate,
  BrewfatherCompletionPolicy,
  BrewfatherPresentationOverrides,
  BrewfatherSourceProfile,
  BrewfatherSyncState,
  CustomBeverageProfile,
  CustomRecipe,
  CustomRecipeIngredient,
  CustomRecipeStep,
  EffectiveBeveragePresentation,
  RecipeSnapshotState,
} from "./types.ts";

interface BeverageRow {
  readonly id: string;
  readonly ownership_type: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BeverageSettingsRow {
  readonly id: number;
  readonly fallback_fg: number;
  readonly brewfather_completion_policy: string;
  readonly updated_at: string;
}

interface CustomProfileRow {
  readonly beverage_id: string;
  readonly name: string;
  readonly beverage_type: string;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly display_color: string | null;
  readonly description: string | null;
  readonly fill_glass: string | null;
  readonly manual_density_override: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CustomRecipeRow {
  readonly id: string;
  readonly beverage_id: string;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CustomRecipeIngredientRow {
  readonly id: string;
  readonly recipe_id: string;
  readonly sort_order: number;
  readonly name: string;
  readonly amount: number | null;
  readonly unit: string | null;
  readonly note: string | null;
}

interface CustomRecipeStepRow {
  readonly id: string;
  readonly recipe_id: string;
  readonly sort_order: number;
  readonly name: string;
  readonly temperature_c: number | null;
  readonly time_minutes: number | null;
  readonly note: string | null;
}

interface SensoryOverridesRow {
  readonly beverage_id: string;
  readonly bitterness: number | null;
  readonly sweetness: number | null;
  readonly body: number | null;
  readonly roast: number | null;
  readonly tartness: number | null;
  readonly alcohol: number | null;
  readonly updated_at: string;
}

interface BrewfatherAccountRow {
  readonly id: string;
  readonly user_id: string;
  readonly enabled: number;
  readonly discovery_statuses_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BrewfatherCandidateRow {
  readonly id: string;
  readonly account_id: string;
  readonly source_batch_id: string;
  readonly batch_name: string | null;
  readonly batch_number: string | null;
  readonly status: string;
  readonly brewer: string | null;
  readonly recipe_name: string | null;
  readonly style: string | null;
  readonly brew_date: string | null;
  readonly estimated_og: number | null;
  readonly estimated_fg: number | null;
  readonly estimated_abv: number | null;
  readonly estimated_ibu: number | null;
  readonly estimated_srm: number | null;
  readonly raw_summary_json: string | null;
  readonly summary_fingerprint: string;
  readonly synced_at: string;
}

interface BrewfatherLinkRow {
  readonly beverage_id: string;
  readonly account_id: string;
  readonly source_batch_id: string;
  readonly sync_state: string;
  readonly last_synced_at: string | null;
  readonly last_error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BrewfatherSourceProfileRow {
  readonly beverage_id: string;
  readonly name: string;
  readonly beverage_type: string;
  readonly style: string | null;
  readonly abv: number | null;
  readonly ibu: number | null;
  readonly og: number | null;
  readonly fg: number | null;
  readonly srm: number | null;
  readonly display_color: string | null;
  readonly description: string | null;
  readonly raw_source_json: string | null;
  readonly source_fingerprint: string;
  readonly updated_at: string;
}

interface PresentationOverridesRow {
  readonly beverage_id: string;
  readonly override_name_present: number;
  readonly name: string | null;
  readonly override_beverage_type_present: number;
  readonly beverage_type: string | null;
  readonly override_style_present: number;
  readonly style: string | null;
  readonly override_abv_present: number;
  readonly abv: number | null;
  readonly override_ibu_present: number;
  readonly ibu: number | null;
  readonly override_og_present: number;
  readonly og: number | null;
  readonly override_fg_present: number;
  readonly fg: number | null;
  readonly override_srm_present: number;
  readonly srm: number | null;
  readonly override_display_color_present: number;
  readonly display_color: string | null;
  readonly override_description_present: number;
  readonly description: string | null;
  readonly override_fill_glass_present: number;
  readonly fill_glass: string | null;
  readonly override_manual_density_override_present: number;
  readonly manual_density_override: number | null;
  readonly updated_at: string;
}

interface RecipeSnapshotRow {
  readonly id: string;
  readonly beverage_id: string;
  readonly account_id: string;
  readonly source_batch_id: string;
  readonly source_recipe_id: string | null;
  readonly state: string;
  readonly version: number;
  readonly recipe_json: string;
  readonly recipe_fingerprint: string;
  readonly created_at: string;
}

function mapBeverage(row: BeverageRow): Beverage {
  return {
    id: row.id,
    ownershipType: row.ownership_type as BeverageOwnershipType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCustomProfile(row: CustomProfileRow): CustomBeverageProfile {
  return {
    beverageId: row.beverage_id,
    name: row.name,
    beverageType: row.beverage_type as BeverageType,
    style: row.style,
    abv: row.abv,
    ibu: row.ibu,
    og: row.og,
    fg: row.fg,
    srm: row.srm,
    displayColor: row.display_color,
    description: row.description,
    fillGlass: row.fill_glass,
    manualDensityOverride: row.manual_density_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSensoryOverrides(row: SensoryOverridesRow): BeverageSensoryOverrides {
  return {
    beverageId: row.beverage_id,
    bitterness: row.bitterness,
    sweetness: row.sweetness,
    body: row.body,
    roast: row.roast,
    tartness: row.tartness,
    alcohol: row.alcohol,
    updatedAt: row.updated_at,
  };
}

function mapBrewfatherAccount(row: BrewfatherAccountRow): BrewfatherAccount {
  let discoveryStatuses: readonly string[] = [
    "Planning",
    "Brewing",
    "Fermenting",
    "Conditioning",
    "Completed",
  ];
  try {
    const parsed: unknown = JSON.parse(row.discovery_statuses_json);
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")) {
      discoveryStatuses = parsed;
    }
  } catch {
    // fallback
  }
  return {
    id: row.id,
    userId: row.user_id,
    enabled: row.enabled === 1,
    discoveryStatuses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: BrewfatherCandidateRow): BrewfatherCandidate {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceBatchId: row.source_batch_id,
    batchName: row.batch_name,
    batchNumber: row.batch_number,
    status: row.status,
    brewer: row.brewer,
    recipeName: row.recipe_name,
    style: row.style,
    brewDate: row.brew_date,
    estimatedOg: row.estimated_og,
    estimatedFg: row.estimated_fg,
    estimatedAbv: row.estimated_abv,
    estimatedIbu: row.estimated_ibu,
    estimatedSrm: row.estimated_srm,
    rawSummaryJson: row.raw_summary_json,
    summaryFingerprint: row.summary_fingerprint,
    syncedAt: row.synced_at,
  };
}

function mapBrewfatherLink(row: BrewfatherLinkRow): BrewfatherBeverageLink {
  return {
    beverageId: row.beverage_id,
    accountId: row.account_id,
    sourceBatchId: row.source_batch_id,
    syncState: row.sync_state as BrewfatherSyncState,
    lastSyncedAt: row.last_synced_at,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSourceProfile(row: BrewfatherSourceProfileRow): BrewfatherSourceProfile {
  return {
    beverageId: row.beverage_id,
    name: row.name,
    beverageType: row.beverage_type as BeverageType,
    style: row.style,
    abv: row.abv,
    ibu: row.ibu,
    og: row.og,
    fg: row.fg,
    srm: row.srm,
    displayColor: row.display_color,
    description: row.description,
    rawSourceJson: row.raw_source_json,
    sourceFingerprint: row.source_fingerprint,
    updatedAt: row.updated_at,
  };
}

function mapPresentationOverrides(row: PresentationOverridesRow): BrewfatherPresentationOverrides {
  return {
    beverageId: row.beverage_id,
    overrideNamePresent: row.override_name_present === 1,
    name: row.name,
    overrideBeverageTypePresent: row.override_beverage_type_present === 1,
    beverageType: row.beverage_type as BeverageType | null,
    overrideStylePresent: row.override_style_present === 1,
    style: row.style,
    overrideAbvPresent: row.override_abv_present === 1,
    abv: row.abv,
    overrideIbuPresent: row.override_ibu_present === 1,
    ibu: row.ibu,
    overrideOgPresent: row.override_og_present === 1,
    og: row.og,
    overrideFgPresent: row.override_fg_present === 1,
    fg: row.fg,
    overrideSrmPresent: row.override_srm_present === 1,
    srm: row.srm,
    overrideDisplayColorPresent: row.override_display_color_present === 1,
    displayColor: row.display_color,
    overrideDescriptionPresent: row.override_description_present === 1,
    description: row.description,
    overrideFillGlassPresent: row.override_fill_glass_present === 1,
    fillGlass: row.fill_glass,
    overrideManualDensityOverridePresent: row.override_manual_density_override_present === 1,
    manualDensityOverride: row.manual_density_override,
    updatedAt: row.updated_at,
  };
}

function mapRecipeSnapshot(row: RecipeSnapshotRow): BeverageSourceRecipeSnapshot {
  return {
    id: row.id,
    beverageId: row.beverage_id,
    accountId: row.account_id,
    sourceBatchId: row.source_batch_id,
    sourceRecipeId: row.source_recipe_id,
    state: row.state as RecipeSnapshotState,
    version: row.version,
    recipeJson: row.recipe_json,
    recipeFingerprint: row.recipe_fingerprint,
    createdAt: row.created_at,
  };
}

export function readBeverageSettings(database: DatabaseExecutor): BeverageSettings {
  const row = database
    .prepare<[], BeverageSettingsRow>(
      `SELECT id, fallback_fg, brewfather_completion_policy, updated_at
       FROM beverage_settings
       WHERE id = 1`,
    )
    .get();

  if (row === undefined) {
    throw new Error("Beverage settings are missing from database");
  }

  return {
    fallbackFg: row.fallback_fg,
    brewfatherCompletionPolicy: row.brewfather_completion_policy as BrewfatherCompletionPolicy,
    updatedAt: row.updated_at,
  };
}

export function updateBeverageSettings(
  database: DatabaseExecutor,
  settings: Partial<Pick<BeverageSettings, "fallbackFg" | "brewfatherCompletionPolicy">>,
  now: string,
): BeverageSettings {
  const current = readBeverageSettings(database);
  const fallbackFg = settings.fallbackFg ?? current.fallbackFg;
  const brewfatherCompletionPolicy =
    settings.brewfatherCompletionPolicy ?? current.brewfatherCompletionPolicy;

  database
    .prepare<[number, string, string]>(
      `UPDATE beverage_settings
       SET fallback_fg = ?, brewfather_completion_policy = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(fallbackFg, brewfatherCompletionPolicy, now);

  return {
    fallbackFg,
    brewfatherCompletionPolicy,
    updatedAt: now,
  };
}

export function insertBeverage(database: DatabaseExecutor, beverage: Beverage): void {
  database
    .prepare<[string, string, string, string]>(
      `INSERT INTO beverages (id, ownership_type, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(beverage.id, beverage.ownershipType, beverage.createdAt, beverage.updatedAt);
}

export function readBeverage(database: DatabaseExecutor, beverageId: string): Beverage | undefined {
  const row = database
    .prepare<[string], BeverageRow>(
      `SELECT id, ownership_type, created_at, updated_at
       FROM beverages
       WHERE id = ?`,
    )
    .get(beverageId);
  return row ? mapBeverage(row) : undefined;
}

export function listBeverages(database: DatabaseExecutor): readonly Beverage[] {
  const rows = database
    .prepare<[], BeverageRow>(
      `SELECT id, ownership_type, created_at, updated_at
       FROM beverages
       ORDER BY created_at DESC`,
    )
    .all();
  return rows.map(mapBeverage);
}

export function insertCustomProfile(
  database: DatabaseExecutor,
  profile: CustomBeverageProfile,
): void {
  database
    .prepare<
      [
        string,
        string,
        string,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string,
        string,
      ]
    >(
      `INSERT INTO custom_beverage_profiles
       (beverage_id, name, beverage_type, style, abv, ibu, og, fg, srm,
        display_color, description, fill_glass, manual_density_override,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profile.beverageId,
      profile.name,
      profile.beverageType,
      profile.style,
      profile.abv,
      profile.ibu,
      profile.og,
      profile.fg,
      profile.srm,
      profile.displayColor,
      profile.description,
      profile.fillGlass,
      profile.manualDensityOverride,
      profile.createdAt,
      profile.updatedAt,
    );
}

export function readCustomProfile(
  database: DatabaseExecutor,
  beverageId: string,
): CustomBeverageProfile | undefined {
  const row = database
    .prepare<[string], CustomProfileRow>(
      `SELECT beverage_id, name, beverage_type, style, abv, ibu, og, fg, srm,
              display_color, description, fill_glass, manual_density_override,
              created_at, updated_at
       FROM custom_beverage_profiles
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row ? mapCustomProfile(row) : undefined;
}

export function updateCustomProfile(
  database: DatabaseExecutor,
  beverageId: string,
  updates: Partial<Omit<CustomBeverageProfile, "beverageId" | "createdAt" | "updatedAt">>,
  now: string,
): CustomBeverageProfile {
  const current = readCustomProfile(database, beverageId);
  if (current === undefined) {
    throw new ApplicationError({
      category: "not_found",
      code: "beverage.not_found",
      clientMessage: "Custom beverage profile was not found.",
    });
  }

  const updated: CustomBeverageProfile = {
    beverageId,
    name: updates.name ?? current.name,
    beverageType: updates.beverageType ?? current.beverageType,
    style: updates.style !== undefined ? updates.style : current.style,
    abv: updates.abv !== undefined ? updates.abv : current.abv,
    ibu: updates.ibu !== undefined ? updates.ibu : current.ibu,
    og: updates.og !== undefined ? updates.og : current.og,
    fg: updates.fg !== undefined ? updates.fg : current.fg,
    srm: updates.srm !== undefined ? updates.srm : current.srm,
    displayColor: updates.displayColor !== undefined ? updates.displayColor : current.displayColor,
    description: updates.description !== undefined ? updates.description : current.description,
    fillGlass: updates.fillGlass !== undefined ? updates.fillGlass : current.fillGlass,
    manualDensityOverride:
      updates.manualDensityOverride !== undefined
        ? updates.manualDensityOverride
        : current.manualDensityOverride,
    createdAt: current.createdAt,
    updatedAt: now,
  };

  database
    .prepare<
      [
        string,
        string,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string,
        string,
      ]
    >(
      `UPDATE custom_beverage_profiles
       SET name = ?, beverage_type = ?, style = ?, abv = ?, ibu = ?,
           og = ?, fg = ?, srm = ?, display_color = ?, description = ?,
           fill_glass = ?, manual_density_override = ?, updated_at = ?
       WHERE beverage_id = ?`,
    )
    .run(
      updated.name,
      updated.beverageType,
      updated.style,
      updated.abv,
      updated.ibu,
      updated.og,
      updated.fg,
      updated.srm,
      updated.displayColor,
      updated.description,
      updated.fillGlass,
      updated.manualDensityOverride,
      updated.updatedAt,
      beverageId,
    );

  database
    .prepare<[string, string]>(`UPDATE beverages SET updated_at = ? WHERE id = ?`)
    .run(now, beverageId);

  return updated;
}

export function saveCustomRecipe(
  database: DatabaseExecutor,
  beverageId: string,
  recipeInput: {
    readonly notes?: string | null;
    readonly ingredients?: readonly {
      readonly name: string;
      readonly amount?: number | null;
      readonly unit?: string | null;
      readonly note?: string | null;
    }[];
    readonly steps?: readonly {
      readonly name: string;
      readonly temperatureC?: number | null;
      readonly timeMinutes?: number | null;
      readonly note?: string | null;
    }[];
  },
  now: string,
  idFactory: () => string = randomUUID,
): CustomRecipe {
  // Delete existing recipe for this beverage if any (cascading ingredients and steps)
  database.prepare<[string]>(`DELETE FROM custom_recipes WHERE beverage_id = ?`).run(beverageId);

  const recipeId = idFactory();
  database
    .prepare<[string, string, string | null, string, string]>(
      `INSERT INTO custom_recipes (id, beverage_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(recipeId, beverageId, recipeInput.notes ?? null, now, now);

  const ingredients: CustomRecipeIngredient[] = [];
  if (recipeInput.ingredients !== undefined) {
    for (let index = 0; index < recipeInput.ingredients.length; index += 1) {
      const ing = recipeInput.ingredients[index]!;
      const ingId = idFactory();
      database
        .prepare<[string, string, number, string, number | null, string | null, string | null]>(
          `INSERT INTO custom_recipe_ingredients
           (id, recipe_id, sort_order, name, amount, unit, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ingId,
          recipeId,
          index,
          ing.name,
          ing.amount ?? null,
          ing.unit ?? null,
          ing.note ?? null,
        );
      ingredients.push({
        id: ingId,
        recipeId,
        sortOrder: index,
        name: ing.name,
        amount: ing.amount ?? null,
        unit: ing.unit ?? null,
        note: ing.note ?? null,
      });
    }
  }

  const steps: CustomRecipeStep[] = [];
  if (recipeInput.steps !== undefined) {
    for (let index = 0; index < recipeInput.steps.length; index += 1) {
      const step = recipeInput.steps[index]!;
      const stepId = idFactory();
      database
        .prepare<[string, string, number, string, number | null, number | null, string | null]>(
          `INSERT INTO custom_recipe_steps
           (id, recipe_id, sort_order, name, temperature_c, time_minutes, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stepId,
          recipeId,
          index,
          step.name,
          step.temperatureC ?? null,
          step.timeMinutes ?? null,
          step.note ?? null,
        );
      steps.push({
        id: stepId,
        recipeId,
        sortOrder: index,
        name: step.name,
        temperatureC: step.temperatureC ?? null,
        timeMinutes: step.timeMinutes ?? null,
        note: step.note ?? null,
      });
    }
  }

  // If a detached recipe snapshot existed for this beverage, mark it superseded
  database
    .prepare<[string]>(
      `UPDATE beverage_source_recipe_snapshots
       SET state = 'superseded'
       WHERE beverage_id = ? AND state = 'detached'`,
    )
    .run(beverageId);

  return {
    id: recipeId,
    beverageId,
    notes: recipeInput.notes ?? null,
    ingredients,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function readCustomRecipe(
  database: DatabaseExecutor,
  beverageId: string,
): CustomRecipe | undefined {
  const row = database
    .prepare<[string], CustomRecipeRow>(
      `SELECT id, beverage_id, notes, created_at, updated_at
       FROM custom_recipes
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  if (row === undefined) return undefined;

  const ingredientRows = database
    .prepare<[string], CustomRecipeIngredientRow>(
      `SELECT id, recipe_id, sort_order, name, amount, unit, note
       FROM custom_recipe_ingredients
       WHERE recipe_id = ?
       ORDER BY sort_order ASC`,
    )
    .all(row.id);

  const stepRows = database
    .prepare<[string], CustomRecipeStepRow>(
      `SELECT id, recipe_id, sort_order, name, temperature_c, time_minutes, note
       FROM custom_recipe_steps
       WHERE recipe_id = ?
       ORDER BY sort_order ASC`,
    )
    .all(row.id);

  return {
    id: row.id,
    beverageId: row.beverage_id,
    notes: row.notes,
    ingredients: ingredientRows.map((r) => ({
      id: r.id,
      recipeId: r.recipe_id,
      sortOrder: r.sort_order,
      name: r.name,
      amount: r.amount,
      unit: r.unit,
      note: r.note,
    })),
    steps: stepRows.map((r) => ({
      id: r.id,
      recipeId: r.recipe_id,
      sortOrder: r.sort_order,
      name: r.name,
      temperatureC: r.temperature_c,
      timeMinutes: r.time_minutes,
      note: r.note,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deleteCustomRecipe(database: DatabaseExecutor, beverageId: string): boolean {
  const result = database
    .prepare<[string]>(`DELETE FROM custom_recipes WHERE beverage_id = ?`)
    .run(beverageId);
  return result.changes > 0;
}

export function upsertSensoryOverrides(
  database: DatabaseExecutor,
  beverageId: string,
  overrides: Partial<Omit<BeverageSensoryOverrides, "beverageId" | "updatedAt">>,
  now: string,
): BeverageSensoryOverrides {
  const current = readSensoryOverrides(database, beverageId);
  const updated: BeverageSensoryOverrides = {
    beverageId,
    bitterness:
      overrides.bitterness !== undefined ? overrides.bitterness : (current?.bitterness ?? null),
    sweetness:
      overrides.sweetness !== undefined ? overrides.sweetness : (current?.sweetness ?? null),
    body: overrides.body !== undefined ? overrides.body : (current?.body ?? null),
    roast: overrides.roast !== undefined ? overrides.roast : (current?.roast ?? null),
    tartness: overrides.tartness !== undefined ? overrides.tartness : (current?.tartness ?? null),
    alcohol: overrides.alcohol !== undefined ? overrides.alcohol : (current?.alcohol ?? null),
    updatedAt: now,
  };

  database
    .prepare<
      [
        string,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string,
      ]
    >(
      `INSERT INTO beverage_sensory_overrides
       (beverage_id, bitterness, sweetness, body, roast, tartness, alcohol, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (beverage_id) DO UPDATE SET
         bitterness = excluded.bitterness,
         sweetness = excluded.sweetness,
         body = excluded.body,
         roast = excluded.roast,
         tartness = excluded.tartness,
         alcohol = excluded.alcohol,
         updated_at = excluded.updated_at`,
    )
    .run(
      updated.beverageId,
      updated.bitterness,
      updated.sweetness,
      updated.body,
      updated.roast,
      updated.tartness,
      updated.alcohol,
      updated.updatedAt,
    );

  return updated;
}

export function readSensoryOverrides(
  database: DatabaseExecutor,
  beverageId: string,
): BeverageSensoryOverrides | undefined {
  const row = database
    .prepare<[string], SensoryOverridesRow>(
      `SELECT beverage_id, bitterness, sweetness, body, roast, tartness, alcohol, updated_at
       FROM beverage_sensory_overrides
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row ? mapSensoryOverrides(row) : undefined;
}

export function upsertBrewfatherAccount(
  database: DatabaseExecutor,
  account: {
    readonly id: string;
    readonly userId: string;
    readonly enabled?: boolean;
    readonly discoveryStatuses?: readonly string[];
  },
  now: string,
): BrewfatherAccount {
  const enabled = account.enabled !== undefined ? (account.enabled ? 1 : 0) : 1;
  const discoveryJson = JSON.stringify(
    account.discoveryStatuses ?? ["Planning", "Brewing", "Fermenting", "Conditioning", "Completed"],
  );

  database
    .prepare<[string, string, number, string, string, string]>(
      `INSERT INTO brewfather_accounts
       (id, user_id, enabled, discovery_statuses_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         user_id = excluded.user_id,
         enabled = excluded.enabled,
         discovery_statuses_json = excluded.discovery_statuses_json,
         updated_at = excluded.updated_at`,
    )
    .run(account.id, account.userId, enabled, discoveryJson, now, now);

  return readBrewfatherAccount(database, account.id)!;
}

export function readBrewfatherAccount(
  database: DatabaseExecutor,
  id: string = "default",
): BrewfatherAccount | undefined {
  const row = database
    .prepare<[string], BrewfatherAccountRow>(
      `SELECT id, user_id, enabled, discovery_statuses_json, created_at, updated_at
       FROM brewfather_accounts
       WHERE id = ?`,
    )
    .get(id);
  return row ? mapBrewfatherAccount(row) : undefined;
}

export function listBrewfatherAccounts(database: DatabaseExecutor): readonly BrewfatherAccount[] {
  const rows = database
    .prepare<[], BrewfatherAccountRow>(
      `SELECT id, user_id, enabled, discovery_statuses_json, created_at, updated_at
       FROM brewfather_accounts
       ORDER BY id ASC`,
    )
    .all();
  return rows.map(mapBrewfatherAccount);
}

export function upsertCandidate(
  database: DatabaseExecutor,
  candidate: Omit<BrewfatherCandidate, "id">,
  idFactory: () => string = randomUUID,
): BrewfatherCandidate {
  const existing = database
    .prepare<[string, string], { readonly id: string }>(
      `SELECT id FROM brewfather_candidate_cache WHERE account_id = ? AND source_batch_id = ?`,
    )
    .get(candidate.accountId, candidate.sourceBatchId);

  const id = existing?.id ?? idFactory();

  database
    .prepare<
      [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO brewfather_candidate_cache
       (id, account_id, source_batch_id, batch_name, batch_number, status,
        brewer, recipe_name, style, brew_date, estimated_og, estimated_fg,
        estimated_abv, estimated_ibu, estimated_srm, raw_summary_json,
        summary_fingerprint, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, source_batch_id) DO UPDATE SET
         batch_name = excluded.batch_name,
         batch_number = excluded.batch_number,
         status = excluded.status,
         brewer = excluded.brewer,
         recipe_name = excluded.recipe_name,
         style = excluded.style,
         brew_date = excluded.brew_date,
         estimated_og = excluded.estimated_og,
         estimated_fg = excluded.estimated_fg,
         estimated_abv = excluded.estimated_abv,
         estimated_ibu = excluded.estimated_ibu,
         estimated_srm = excluded.estimated_srm,
         raw_summary_json = excluded.raw_summary_json,
         summary_fingerprint = excluded.summary_fingerprint,
         synced_at = excluded.synced_at`,
    )
    .run(
      id,
      candidate.accountId,
      candidate.sourceBatchId,
      candidate.batchName,
      candidate.batchNumber,
      candidate.status,
      candidate.brewer,
      candidate.recipeName,
      candidate.style,
      candidate.brewDate,
      candidate.estimatedOg,
      candidate.estimatedFg,
      candidate.estimatedAbv,
      candidate.estimatedIbu,
      candidate.estimatedSrm,
      candidate.rawSummaryJson,
      candidate.summaryFingerprint,
      candidate.syncedAt,
    );

  return { ...candidate, id };
}

export function readCandidate(
  database: DatabaseExecutor,
  accountId: string,
  sourceBatchId: string,
): BrewfatherCandidate | undefined {
  const row = database
    .prepare<[string, string], BrewfatherCandidateRow>(
      `SELECT id, account_id, source_batch_id, batch_name, batch_number, status,
              brewer, recipe_name, style, brew_date, estimated_og, estimated_fg,
              estimated_abv, estimated_ibu, estimated_srm, raw_summary_json,
              summary_fingerprint, synced_at
       FROM brewfather_candidate_cache
       WHERE account_id = ? AND source_batch_id = ?`,
    )
    .get(accountId, sourceBatchId);
  return row ? mapCandidate(row) : undefined;
}

export function listCandidates(
  database: DatabaseExecutor,
  accountId: string = "default",
): readonly BrewfatherCandidate[] {
  const rows = database
    .prepare<[string], BrewfatherCandidateRow>(
      `SELECT id, account_id, source_batch_id, batch_name, batch_number, status,
              brewer, recipe_name, style, brew_date, estimated_og, estimated_fg,
              estimated_abv, estimated_ibu, estimated_srm, raw_summary_json,
              summary_fingerprint, synced_at
       FROM brewfather_candidate_cache
       WHERE account_id = ?
       ORDER BY synced_at DESC`,
    )
    .all(accountId);
  return rows.map(mapCandidate);
}

export function insertBeverageLink(database: DatabaseExecutor, link: BrewfatherBeverageLink): void {
  database
    .prepare<[string, string, string, string, string | null, string | null, string, string]>(
      `INSERT INTO brewfather_beverage_links
       (beverage_id, account_id, source_batch_id, sync_state, last_synced_at,
        last_error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      link.beverageId,
      link.accountId,
      link.sourceBatchId,
      link.syncState,
      link.lastSyncedAt,
      link.lastErrorMessage,
      link.createdAt,
      link.updatedAt,
    );
}

export function readBeverageLink(
  database: DatabaseExecutor,
  beverageId: string,
): BrewfatherBeverageLink | undefined {
  const row = database
    .prepare<[string], BrewfatherLinkRow>(
      `SELECT beverage_id, account_id, source_batch_id, sync_state,
              last_synced_at, last_error_message, created_at, updated_at
       FROM brewfather_beverage_links
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row ? mapBrewfatherLink(row) : undefined;
}

export function readBeverageLinkByBatch(
  database: DatabaseExecutor,
  accountId: string,
  sourceBatchId: string,
): BrewfatherBeverageLink | undefined {
  const row = database
    .prepare<[string, string], BrewfatherLinkRow>(
      `SELECT beverage_id, account_id, source_batch_id, sync_state,
              last_synced_at, last_error_message, created_at, updated_at
       FROM brewfather_beverage_links
       WHERE account_id = ? AND source_batch_id = ?`,
    )
    .get(accountId, sourceBatchId);
  return row ? mapBrewfatherLink(row) : undefined;
}

export function listBeverageLinks(database: DatabaseExecutor): readonly BrewfatherBeverageLink[] {
  const rows = database
    .prepare<[], BrewfatherLinkRow>(
      `SELECT beverage_id, account_id, source_batch_id, sync_state,
              last_synced_at, last_error_message, created_at, updated_at
       FROM brewfather_beverage_links`,
    )
    .all();
  return rows.map(mapBrewfatherLink);
}

export function updateBeverageLinkState(
  database: DatabaseExecutor,
  beverageId: string,
  syncState: BrewfatherSyncState,
  lastErrorMessage: string | null,
  now: string,
): void {
  database
    .prepare<[string, string, string | null, string, string]>(
      `UPDATE brewfather_beverage_links
       SET sync_state = ?, last_synced_at = ?, last_error_message = ?, updated_at = ?
       WHERE beverage_id = ?`,
    )
    .run(syncState, now, lastErrorMessage, now, beverageId);
}

export function upsertSourceProfile(
  database: DatabaseExecutor,
  profile: BrewfatherSourceProfile,
): void {
  database
    .prepare<
      [
        string,
        string,
        string,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO brewfather_source_profiles
       (beverage_id, name, beverage_type, style, abv, ibu, og, fg, srm,
        display_color, description, raw_source_json, source_fingerprint, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (beverage_id) DO UPDATE SET
         name = excluded.name,
         beverage_type = excluded.beverage_type,
         style = excluded.style,
         abv = excluded.abv,
         ibu = excluded.ibu,
         og = excluded.og,
         fg = excluded.fg,
         srm = excluded.srm,
         display_color = excluded.display_color,
         description = excluded.description,
         raw_source_json = excluded.raw_source_json,
         source_fingerprint = excluded.source_fingerprint,
         updated_at = excluded.updated_at`,
    )
    .run(
      profile.beverageId,
      profile.name,
      profile.beverageType,
      profile.style,
      profile.abv,
      profile.ibu,
      profile.og,
      profile.fg,
      profile.srm,
      profile.displayColor,
      profile.description,
      profile.rawSourceJson,
      profile.sourceFingerprint,
      profile.updatedAt,
    );
}

export function readSourceProfile(
  database: DatabaseExecutor,
  beverageId: string,
): BrewfatherSourceProfile | undefined {
  const row = database
    .prepare<[string], BrewfatherSourceProfileRow>(
      `SELECT beverage_id, name, beverage_type, style, abv, ibu, og, fg, srm,
              display_color, description, raw_source_json, source_fingerprint, updated_at
       FROM brewfather_source_profiles
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row ? mapSourceProfile(row) : undefined;
}

export function upsertPresentationOverrides(
  database: DatabaseExecutor,
  overrides: BrewfatherPresentationOverrides,
): void {
  database
    .prepare<
      [
        string,
        number,
        string | null,
        number,
        string | null,
        number,
        string | null,
        number,
        number | null,
        number,
        number | null,
        number,
        number | null,
        number,
        number | null,
        number,
        number | null,
        number,
        string | null,
        number,
        string | null,
        number,
        string | null,
        number,
        number | null,
        string,
      ]
    >(
      `INSERT INTO brewfather_presentation_overrides
       (beverage_id,
        override_name_present, name,
        override_beverage_type_present, beverage_type,
        override_style_present, style,
        override_abv_present, abv,
        override_ibu_present, ibu,
        override_og_present, og,
        override_fg_present, fg,
        override_srm_present, srm,
        override_display_color_present, display_color,
        override_description_present, description,
        override_fill_glass_present, fill_glass,
        override_manual_density_override_present, manual_density_override,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (beverage_id) DO UPDATE SET
         override_name_present = excluded.override_name_present,
         name = excluded.name,
         override_beverage_type_present = excluded.override_beverage_type_present,
         beverage_type = excluded.beverage_type,
         override_style_present = excluded.override_style_present,
         style = excluded.style,
         override_abv_present = excluded.override_abv_present,
         abv = excluded.abv,
         override_ibu_present = excluded.override_ibu_present,
         ibu = excluded.ibu,
         override_og_present = excluded.override_og_present,
         og = excluded.og,
         override_fg_present = excluded.override_fg_present,
         fg = excluded.fg,
         override_srm_present = excluded.override_srm_present,
         srm = excluded.srm,
         override_display_color_present = excluded.override_display_color_present,
         display_color = excluded.display_color,
         override_description_present = excluded.override_description_present,
         description = excluded.description,
         override_fill_glass_present = excluded.override_fill_glass_present,
         fill_glass = excluded.fill_glass,
         override_manual_density_override_present = excluded.override_manual_density_override_present,
         manual_density_override = excluded.manual_density_override,
         updated_at = excluded.updated_at`,
    )
    .run(
      overrides.beverageId,
      overrides.overrideNamePresent ? 1 : 0,
      overrides.name,
      overrides.overrideBeverageTypePresent ? 1 : 0,
      overrides.beverageType,
      overrides.overrideStylePresent ? 1 : 0,
      overrides.style,
      overrides.overrideAbvPresent ? 1 : 0,
      overrides.abv,
      overrides.overrideIbuPresent ? 1 : 0,
      overrides.ibu,
      overrides.overrideOgPresent ? 1 : 0,
      overrides.og,
      overrides.overrideFgPresent ? 1 : 0,
      overrides.fg,
      overrides.overrideSrmPresent ? 1 : 0,
      overrides.srm,
      overrides.overrideDisplayColorPresent ? 1 : 0,
      overrides.displayColor,
      overrides.overrideDescriptionPresent ? 1 : 0,
      overrides.description,
      overrides.overrideFillGlassPresent ? 1 : 0,
      overrides.fillGlass,
      overrides.overrideManualDensityOverridePresent ? 1 : 0,
      overrides.manualDensityOverride,
      overrides.updatedAt,
    );
}

export function readPresentationOverrides(
  database: DatabaseExecutor,
  beverageId: string,
): BrewfatherPresentationOverrides | undefined {
  const row = database
    .prepare<[string], PresentationOverridesRow>(
      `SELECT beverage_id,
              override_name_present, name,
              override_beverage_type_present, beverage_type,
              override_style_present, style,
              override_abv_present, abv,
              override_ibu_present, ibu,
              override_og_present, og,
              override_fg_present, fg,
              override_srm_present, srm,
              override_display_color_present, display_color,
              override_description_present, description,
              override_fill_glass_present, fill_glass,
              override_manual_density_override_present, manual_density_override,
              updated_at
       FROM brewfather_presentation_overrides
       WHERE beverage_id = ?`,
    )
    .get(beverageId);
  return row ? mapPresentationOverrides(row) : undefined;
}

export function saveRecipeSnapshot(
  database: DatabaseExecutor,
  snapshot: Omit<BeverageSourceRecipeSnapshot, "id" | "version">,
  idFactory: () => string = randomUUID,
): BeverageSourceRecipeSnapshot {
  const current = database
    .prepare<[string], { readonly version: number; readonly recipe_fingerprint: string }>(
      `SELECT version, recipe_fingerprint
       FROM beverage_source_recipe_snapshots
       WHERE beverage_id = ? AND state = 'linked_current'`,
    )
    .get(snapshot.beverageId);

  // If identical fingerprint already current, return it without duplicate insertion
  if (current !== undefined && current.recipe_fingerprint === snapshot.recipeFingerprint) {
    const existing = database
      .prepare<[string], RecipeSnapshotRow>(
        `SELECT id, beverage_id, account_id, source_batch_id, source_recipe_id,
                state, version, recipe_json, recipe_fingerprint, created_at
         FROM beverage_source_recipe_snapshots
         WHERE beverage_id = ? AND state = 'linked_current'`,
      )
      .get(snapshot.beverageId)!;
    return mapRecipeSnapshot(existing);
  }

  // If there's an existing linked_current snapshot, transition it to superseded
  if (current !== undefined) {
    database
      .prepare<[string]>(
        `UPDATE beverage_source_recipe_snapshots
         SET state = 'superseded'
         WHERE beverage_id = ? AND state = 'linked_current'`,
      )
      .run(snapshot.beverageId);
  }

  const nextVersion = (current?.version ?? 0) + 1;
  const id = idFactory();

  database
    .prepare<
      [string, string, string, string, string | null, string, number, string, string, string]
    >(
      `INSERT INTO beverage_source_recipe_snapshots
       (id, beverage_id, account_id, source_batch_id, source_recipe_id,
        state, version, recipe_json, recipe_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      snapshot.beverageId,
      snapshot.accountId,
      snapshot.sourceBatchId,
      snapshot.sourceRecipeId,
      snapshot.state,
      nextVersion,
      snapshot.recipeJson,
      snapshot.recipeFingerprint,
      snapshot.createdAt,
    );

  return {
    id,
    beverageId: snapshot.beverageId,
    accountId: snapshot.accountId,
    sourceBatchId: snapshot.sourceBatchId,
    sourceRecipeId: snapshot.sourceRecipeId,
    state: snapshot.state,
    version: nextVersion,
    recipeJson: snapshot.recipeJson,
    recipeFingerprint: snapshot.recipeFingerprint,
    createdAt: snapshot.createdAt,
  };
}

export function readRecipeSnapshots(
  database: DatabaseExecutor,
  beverageId: string,
): readonly BeverageSourceRecipeSnapshot[] {
  const rows = database
    .prepare<[string], RecipeSnapshotRow>(
      `SELECT id, beverage_id, account_id, source_batch_id, source_recipe_id,
              state, version, recipe_json, recipe_fingerprint, created_at
       FROM beverage_source_recipe_snapshots
       WHERE beverage_id = ?
       ORDER BY version DESC`,
    )
    .all(beverageId);
  return rows.map(mapRecipeSnapshot);
}

export function readCurrentRecipeSnapshot(
  database: DatabaseExecutor,
  beverageId: string,
): BeverageSourceRecipeSnapshot | undefined {
  const row = database
    .prepare<[string], RecipeSnapshotRow>(
      `SELECT id, beverage_id, account_id, source_batch_id, source_recipe_id,
              state, version, recipe_json, recipe_fingerprint, created_at
       FROM beverage_source_recipe_snapshots
       WHERE beverage_id = ? AND state IN ('linked_current', 'detached')
       ORDER BY version DESC
       LIMIT 1`,
    )
    .get(beverageId);
  return row ? mapRecipeSnapshot(row) : undefined;
}

/**
 * Executes the critical atomic Unlink-to-Custom transaction:
 * 1. Materializes current effective presentation values as Custom profile
 * 2. Updates beverage ownership_type to 'custom'
 * 3. Marks linked_current recipe snapshot as 'detached' and immutable
 * 4. Preserves manual sensory overrides (remains on beverage_sensory_overrides)
 * 5. Deletes active link, source profile, and presentation overrides
 * 6. Emits Activity Log entry
 *
 * All in ONE synchronous SQLite transaction.
 */
export function unlinkBeverageTransaction(
  database: DatabaseExecutor,
  beverageId: string,
  effectivePresentation: EffectiveBeveragePresentation,
  now: string,
  actorOptions: BeverageActorOptions = {},
): CustomBeverageProfile {
  return database.withTransaction(() => {
    const beverage = readBeverage(database, beverageId);
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

    // 1. Insert custom beverage profile with materialized effective values
    const customProfile: CustomBeverageProfile = {
      beverageId,
      name: effectivePresentation.name,
      beverageType: effectivePresentation.beverageType,
      style: effectivePresentation.style,
      abv: effectivePresentation.abv,
      ibu: effectivePresentation.ibu,
      og: effectivePresentation.og,
      fg: effectivePresentation.fg,
      srm: effectivePresentation.srm,
      displayColor: effectivePresentation.displayColor,
      description: effectivePresentation.description,
      fillGlass: effectivePresentation.fillGlass,
      manualDensityOverride: effectivePresentation.manualDensityOverride,
      createdAt: now,
      updatedAt: now,
    };
    insertCustomProfile(database, customProfile);

    // 2. Update beverage ownership type
    database
      .prepare<[string, string]>(
        `UPDATE beverages SET ownership_type = 'custom', updated_at = ? WHERE id = ?`,
      )
      .run(now, beverageId);

    // 3. Mark current recipe snapshot as detached
    database
      .prepare<[string]>(
        `UPDATE beverage_source_recipe_snapshots
         SET state = 'detached'
         WHERE beverage_id = ? AND state = 'linked_current'`,
      )
      .run(beverageId);

    // 4. Delete presentation overrides, source profile, and link
    database
      .prepare<[string]>(`DELETE FROM brewfather_presentation_overrides WHERE beverage_id = ?`)
      .run(beverageId);
    database
      .prepare<[string]>(`DELETE FROM brewfather_source_profiles WHERE beverage_id = ?`)
      .run(beverageId);
    database
      .prepare<[string]>(`DELETE FROM brewfather_beverage_links WHERE beverage_id = ?`)
      .run(beverageId);

    // 5. Append activity log
    appendActivity(database, {
      category: "domain",
      action: "transition",
      actorType: actorOptions.actorType ?? "admin",
      ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
      ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
      entityType: "beverage",
      entityId: beverageId,
      details: {
        transition: "unlinked",
        from_ownership: "brewfather",
        to_ownership: "custom",
        name: customProfile.name,
      },
      occurredAt: now,
    });

    return customProfile;
  });
}

export function calculateBeverageDeletionImpact(
  database: DatabaseExecutor,
  beverageId: string,
): BeverageDeletionImpact {
  const beverage = readBeverage(database, beverageId);
  if (beverage === undefined) {
    throw new ApplicationError({
      category: "not_found",
      code: "beverage.not_found",
      clientMessage: "Beverage was not found.",
    });
  }

  let name = "Unnamed Beverage";
  if (beverage.ownershipType === "custom") {
    const cp = readCustomProfile(database, beverageId);
    if (cp) name = cp.name;
  } else {
    const sp = readSourceProfile(database, beverageId);
    const po = readPresentationOverrides(database, beverageId);
    if (po?.overrideNamePresent && po.name) {
      name = po.name;
    } else if (sp) {
      name = sp.name;
    }
  }

  const recipeCount =
    database
      .prepare<[string], { readonly count: number }>(
        `SELECT COUNT(*) as count FROM custom_recipes WHERE beverage_id = ?`,
      )
      .get(beverageId)?.count ?? 0;

  const sensoryCount =
    database
      .prepare<[string], { readonly count: number }>(
        `SELECT COUNT(*) as count FROM beverage_sensory_overrides WHERE beverage_id = ?`,
      )
      .get(beverageId)?.count ?? 0;

  const snapshotCount =
    database
      .prepare<[string], { readonly count: number }>(
        `SELECT COUNT(*) as count FROM beverage_source_recipe_snapshots WHERE beverage_id = ?`,
      )
      .get(beverageId)?.count ?? 0;

  const impacts: { readonly code: string; readonly count: number }[] = [
    { code: "beverages", count: 1 },
  ];

  if (recipeCount > 0) impacts.push({ code: "custom_recipes", count: recipeCount });
  if (sensoryCount > 0) impacts.push({ code: "beverage_sensory_overrides", count: sensoryCount });
  if (snapshotCount > 0)
    impacts.push({ code: "beverage_source_recipe_snapshots", count: snapshotCount });

  return {
    beverageId,
    name,
    ownershipType: beverage.ownershipType,
    impacts,
  };
}

export function deleteBeverageWithAudit(
  database: DatabaseExecutor,
  beverageId: string,
  input: { readonly reason?: string | null } = {},
  actorOptions: BeverageActorOptions = {},
): BeverageDeletionImpact {
  const now = (actorOptions.now ?? (() => new Date()))().toISOString();

  return database.withTransaction(() => {
    const impact = calculateBeverageDeletionImpact(database, beverageId);

    // Insert deletion audit
    appendDeletionAudit(database, {
      entityType: "beverage",
      entityId: beverageId,
      actorType: actorOptions.actorType ?? "admin",
      ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
      reason: input.reason ?? "Administrative deletion",
      impacts: impact.impacts,
      deletedAt: now,
    });

    // Delete beverage (FK cascading deletes custom profile, recipes, sensory, link, source profile, overrides, snapshots)
    database.prepare<[string]>(`DELETE FROM beverages WHERE id = ?`).run(beverageId);

    // Append activity
    appendActivity(database, {
      category: "domain",
      action: "deletion",
      actorType: actorOptions.actorType ?? "admin",
      ...(actorOptions.actorId !== undefined ? { actorId: actorOptions.actorId } : {}),
      ...(actorOptions.sessionId !== undefined ? { sessionId: actorOptions.sessionId } : {}),
      entityType: "beverage",
      entityId: beverageId,
      details: { name: impact.name, ownershipType: impact.ownershipType },
      occurredAt: now,
    });

    return impact;
  });
}
