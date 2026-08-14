import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import {
  readBeverage,
  readCustomProfile,
  readPresentationOverrides,
  readSourceProfile,
} from "./repository.ts";
import type {
  BrewfatherPresentationOverrides,
  BrewfatherSourceProfile,
  CustomBeverageProfile,
  EffectiveBeveragePresentation,
} from "./types.ts";

/**
 * Resolves effective presentation fields for a Custom beverage from its profile.
 */
export function resolveCustomPresentation(
  profile: CustomBeverageProfile,
): EffectiveBeveragePresentation {
  return {
    name: profile.name,
    beverageType: profile.beverageType,
    style: profile.style,
    abv: profile.abv,
    ibu: profile.ibu,
    og: profile.og,
    fg: profile.fg,
    srm: profile.srm,
    displayColor: profile.displayColor,
    description: profile.description,
    fillGlass: profile.fillGlass,
    manualDensityOverride: profile.manualDensityOverride,
  };
}

/**
 * Resolves effective presentation fields for a Brewfather-linked beverage by overlaying
 * 3-state presentation overrides on top of the last-known sanitized source profile:
 * - override present = false: inherit source value
 * - override present = true, value = null: explicit clear
 * - override present = true, value = <value>: explicit override
 *
 * This effective presentation is computed purely and is NEVER persisted as a 3rd copy.
 */
export function resolveLinkedPresentation(
  source: BrewfatherSourceProfile,
  overrides?: BrewfatherPresentationOverrides | null,
): EffectiveBeveragePresentation {
  if (overrides === undefined || overrides === null) {
    return {
      name: source.name,
      beverageType: source.beverageType,
      style: source.style,
      abv: source.abv,
      ibu: source.ibu,
      og: source.og,
      fg: source.fg,
      srm: source.srm,
      displayColor: source.displayColor,
      description: source.description,
      fillGlass: null,
      manualDensityOverride: null,
    };
  }

  return {
    name: overrides.overrideNamePresent ? (overrides.name ?? source.name) : source.name,
    beverageType: overrides.overrideBeverageTypePresent
      ? (overrides.beverageType ?? source.beverageType)
      : source.beverageType,
    style: overrides.overrideStylePresent ? overrides.style : source.style,
    abv: overrides.overrideAbvPresent ? overrides.abv : source.abv,
    ibu: overrides.overrideIbuPresent ? overrides.ibu : source.ibu,
    og: overrides.overrideOgPresent ? overrides.og : source.og,
    fg: overrides.overrideFgPresent ? overrides.fg : source.fg,
    srm: overrides.overrideSrmPresent ? overrides.srm : source.srm,
    displayColor: overrides.overrideDisplayColorPresent
      ? overrides.displayColor
      : source.displayColor,
    description: overrides.overrideDescriptionPresent ? overrides.description : source.description,
    fillGlass: overrides.overrideFillGlassPresent ? overrides.fillGlass : null,
    manualDensityOverride: overrides.overrideManualDensityOverridePresent
      ? overrides.manualDensityOverride
      : null,
  };
}

/**
 * Resolves the canonical effective presentation for a beverage by ID directly from the database.
 * Reuses the canonical #69 Custom and Brewfather-linked presentation rules.
 */
export function resolveEffectivePresentationFromDb(
  database: DatabaseExecutor,
  beverageId: string,
): EffectiveBeveragePresentation | undefined {
  const beverage = readBeverage(database, beverageId);
  if (beverage === undefined) {
    return undefined;
  }

  if (beverage.ownershipType === "custom") {
    const profile = readCustomProfile(database, beverageId);
    if (profile === undefined) {
      return undefined;
    }
    return resolveCustomPresentation(profile);
  }

  const source = readSourceProfile(database, beverageId);
  if (source === undefined) {
    return undefined;
  }
  const overrides = readPresentationOverrides(database, beverageId);
  return resolveLinkedPresentation(source, overrides);
}
