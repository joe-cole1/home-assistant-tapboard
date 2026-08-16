import { ApplicationError, type SafeErrorDetails } from "../../shared/errors.ts";
import { STATUS_SET } from "./brewfather/sanitizer.ts";
import {
  BEVERAGE_TYPES,
  BEVERAGE_SENSORY_AXES,
  BEVERAGE_SENSORY_CANONICAL_MAX,
  BEVERAGE_SENSORY_CANONICAL_MIN,
  type BeverageSensoryAxis,
  type BeverageType,
  type BrewfatherCompletionPolicy,
  type ConfigureBrewfatherAccountInput,
  type CreateCustomBeverageInput,
  type LinkBrewfatherCandidateInput,
  type UpdateBeverageSettingsInput,
  type UpdateCustomBeverageInput,
  type UpdateBeverageSensoryOverridesInput,
  type UpdatePresentationOverridesInput,
} from "./types.ts";

const ALLOWED_COMPLETION_POLICIES = new Set(["never", "ask", "completed"]);
const CANONICAL_SENSORY_RANGE = `between ${BEVERAGE_SENSORY_CANONICAL_MIN} and ${BEVERAGE_SENSORY_CANONICAL_MAX}`;

function invalidRequest(clientMessage: string, details?: SafeErrorDetails): never {
  throw new ApplicationError({
    category: "validation",
    code: "request.invalid",
    clientMessage,
    ...(details !== undefined ? { details } : {}),
  });
}

function assertPlainObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRequest(message);
  }
}

function assertStrictPlainObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  assertPlainObject(value, message);
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidRequest(message);
  }
}

function assertKnownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      invalidRequest(`Unknown field '${key}' in ${context}.`);
    }
  }
}

function cleanString(value: unknown, maxBytes: number, fieldName: string): string {
  if (typeof value !== "string") {
    invalidRequest(`${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    invalidRequest(`${fieldName} must not be empty.`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    invalidRequest(`${fieldName} exceeds maximum byte length of ${maxBytes}.`);
  }
  return trimmed;
}

function cleanOptionalString(value: unknown, maxBytes: number, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    invalidRequest(`${fieldName} must be a string or null.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    invalidRequest(`${fieldName} exceeds maximum byte length of ${maxBytes}.`);
  }
  return trimmed;
}

function cleanOptionalNumber(
  value: unknown,
  min: number,
  max: number,
  fieldName: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRequest(`${fieldName} must be a valid finite number.`);
  }
  if (value < min || value > max) {
    invalidRequest(`${fieldName} must be between ${min} and ${max}.`);
  }
  return value;
}

function validateBeverageType(value: unknown): BeverageType {
  if (typeof value !== "string" || !BEVERAGE_TYPES.includes(value as BeverageType)) {
    invalidRequest(`Invalid beverageType. Must be one of: ${BEVERAGE_TYPES.join(", ")}`);
  }
  return value as BeverageType;
}

export function validateCreateCustomBeverageInput(input: unknown): CreateCustomBeverageInput {
  assertPlainObject(input, "Create beverage input must be an object.");
  assertKnownFields(
    input,
    [
      "id",
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
      "recipe",
      "sensoryOverrides",
    ],
    "create custom beverage",
  );

  const name = cleanString(input.name, 160, "name");
  const beverageType =
    input.beverageType !== undefined ? validateBeverageType(input.beverageType) : "beer";
  const style = cleanOptionalString(input.style, 120, "style");
  const abv = cleanOptionalNumber(input.abv, 0, 100, "abv");
  const ibu = cleanOptionalNumber(input.ibu, 0, 2000, "ibu");
  const og = cleanOptionalNumber(input.og, 0.5, 2.0, "og");
  const fg = cleanOptionalNumber(input.fg, 0.5, 2.0, "fg");
  const srm = cleanOptionalNumber(input.srm, 0, 100, "srm");
  const displayColor = cleanOptionalString(input.displayColor, 32, "displayColor");
  const description = cleanOptionalString(input.description, 4000, "description");
  const fillGlass = cleanOptionalString(input.fillGlass, 64, "fillGlass");
  const manualDensityOverride = cleanOptionalNumber(
    input.manualDensityOverride,
    0.5,
    2.0,
    "manualDensityOverride",
  );

  let recipe: CreateCustomBeverageInput["recipe"] = null;
  if (input.recipe !== undefined && input.recipe !== null) {
    assertPlainObject(input.recipe, "Recipe must be an object.");
    assertKnownFields(input.recipe, ["notes", "ingredients", "steps"], "recipe");
    const notes = cleanOptionalString(input.recipe.notes, 4000, "recipe.notes");
    let ingredients: NonNullable<CreateCustomBeverageInput["recipe"]>["ingredients"] = [];
    if (input.recipe.ingredients !== undefined) {
      if (!Array.isArray(input.recipe.ingredients)) {
        invalidRequest("recipe.ingredients must be an array.");
      }
      if (input.recipe.ingredients.length > 200) {
        invalidRequest("recipe.ingredients cannot exceed 200 items.");
      }
      ingredients = input.recipe.ingredients.map((item, index) => {
        assertPlainObject(item, `recipe.ingredients[${index}] must be an object.`);
        assertKnownFields(item, ["name", "amount", "unit", "note"], `recipe.ingredients[${index}]`);
        return {
          name: cleanString(item.name, 160, `recipe.ingredients[${index}].name`),
          amount: cleanOptionalNumber(
            item.amount,
            0,
            1_000_000,
            `recipe.ingredients[${index}].amount`,
          ),
          unit: cleanOptionalString(item.unit, 32, `recipe.ingredients[${index}].unit`),
          note: cleanOptionalString(item.note, 255, `recipe.ingredients[${index}].note`),
        };
      });
    }

    let steps: NonNullable<CreateCustomBeverageInput["recipe"]>["steps"] = [];
    if (input.recipe.steps !== undefined) {
      if (!Array.isArray(input.recipe.steps)) {
        invalidRequest("recipe.steps must be an array.");
      }
      if (input.recipe.steps.length > 100) {
        invalidRequest("recipe.steps cannot exceed 100 items.");
      }
      steps = input.recipe.steps.map((item, index) => {
        assertPlainObject(item, `recipe.steps[${index}] must be an object.`);
        assertKnownFields(
          item,
          ["name", "temperatureC", "timeMinutes", "note"],
          `recipe.steps[${index}]`,
        );
        return {
          name: cleanString(item.name, 160, `recipe.steps[${index}].name`),
          temperatureC: cleanOptionalNumber(
            item.temperatureC,
            -50,
            150,
            `recipe.steps[${index}].temperatureC`,
          ),
          timeMinutes: cleanOptionalNumber(
            item.timeMinutes,
            0,
            100_000,
            `recipe.steps[${index}].timeMinutes`,
          ),
          note: cleanOptionalString(item.note, 1000, `recipe.steps[${index}].note`),
        };
      });
    }

    recipe = { notes, ingredients, steps };
  }

  let sensoryOverrides: CreateCustomBeverageInput["sensoryOverrides"] = null;
  if (input.sensoryOverrides !== undefined && input.sensoryOverrides !== null) {
    assertPlainObject(input.sensoryOverrides, "sensoryOverrides must be an object.");
    assertKnownFields(
      input.sensoryOverrides,
      ["bitterness", "sweetness", "body", "roast", "tartness", "alcohol"],
      "sensoryOverrides",
    );
    sensoryOverrides = {
      bitterness: cleanOptionalNumber(
        input.sensoryOverrides.bitterness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "bitterness",
      ),
      sweetness: cleanOptionalNumber(
        input.sensoryOverrides.sweetness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "sweetness",
      ),
      body: cleanOptionalNumber(
        input.sensoryOverrides.body,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "body",
      ),
      roast: cleanOptionalNumber(
        input.sensoryOverrides.roast,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "roast",
      ),
      tartness: cleanOptionalNumber(
        input.sensoryOverrides.tartness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "tartness",
      ),
      alcohol: cleanOptionalNumber(
        input.sensoryOverrides.alcohol,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "alcohol",
      ),
    };
  }

  return {
    ...(typeof input.id === "string" ? { id: input.id } : {}),
    name,
    beverageType,
    style,
    abv,
    ibu,
    og,
    fg,
    srm,
    displayColor,
    description,
    fillGlass,
    manualDensityOverride,
    recipe,
    sensoryOverrides,
  };
}

export function validateUpdateCustomBeverageInput(input: unknown): UpdateCustomBeverageInput {
  assertPlainObject(input, "Beverage payload must be an object.");
  assertKnownFields(
    input,
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
      "manualDensityOverride",
      "recipe",
      "sensoryOverrides",
    ],
    "custom_beverage_update",
  );

  const result: Record<string, unknown> = {};

  if (input.name !== undefined) {
    result.name = cleanString(input.name, 160, "name");
  }
  if (input.beverageType !== undefined) {
    result.beverageType = validateBeverageType(input.beverageType);
  }
  if (input.style !== undefined) {
    result.style = cleanOptionalString(input.style, 120, "style");
  }
  if (input.abv !== undefined) {
    result.abv = cleanOptionalNumber(input.abv, 0, 100, "abv");
  }
  if (input.ibu !== undefined) {
    result.ibu = cleanOptionalNumber(input.ibu, 0, 2000, "ibu");
  }
  if (input.og !== undefined) {
    result.og = cleanOptionalNumber(input.og, 0.5, 2.0, "og");
  }
  if (input.fg !== undefined) {
    result.fg = cleanOptionalNumber(input.fg, 0.5, 2.0, "fg");
  }
  if (input.srm !== undefined) {
    result.srm = cleanOptionalNumber(input.srm, 0, 100, "srm");
  }
  if (input.displayColor !== undefined) {
    result.displayColor = cleanOptionalString(input.displayColor, 32, "displayColor");
  }
  if (input.description !== undefined) {
    result.description = cleanOptionalString(input.description, 4000, "description");
  }
  if (input.fillGlass !== undefined) {
    result.fillGlass = cleanOptionalString(input.fillGlass, 64, "fillGlass");
  }
  if (input.manualDensityOverride !== undefined) {
    result.manualDensityOverride = cleanOptionalNumber(
      input.manualDensityOverride,
      0.5,
      2.0,
      "manualDensityOverride",
    );
  }

  if (input.recipe !== undefined) {
    if (input.recipe === null) {
      result.recipe = null;
    } else {
      assertPlainObject(input.recipe, "Recipe must be an object.");
      assertKnownFields(input.recipe, ["notes", "ingredients", "steps"], "recipe");
      const notes = cleanOptionalString(input.recipe.notes, 4000, "recipe.notes");
      let ingredients: NonNullable<CreateCustomBeverageInput["recipe"]>["ingredients"] = [];
      if (input.recipe.ingredients !== undefined) {
        if (!Array.isArray(input.recipe.ingredients)) {
          invalidRequest("recipe.ingredients must be an array.");
        }
        if (input.recipe.ingredients.length > 200) {
          invalidRequest("recipe.ingredients cannot exceed 200 items.");
        }
        ingredients = input.recipe.ingredients.map((item, index) => {
          assertPlainObject(item, `recipe.ingredients[${index}] must be an object.`);
          assertKnownFields(
            item,
            ["name", "amount", "unit", "note"],
            `recipe.ingredients[${index}]`,
          );
          return {
            name: cleanString(item.name, 160, `recipe.ingredients[${index}].name`),
            amount: cleanOptionalNumber(
              item.amount,
              0,
              1_000_000,
              `recipe.ingredients[${index}].amount`,
            ),
            unit: cleanOptionalString(item.unit, 32, `recipe.ingredients[${index}].unit`),
            note: cleanOptionalString(item.note, 255, `recipe.ingredients[${index}].note`),
          };
        });
      }

      let steps: NonNullable<CreateCustomBeverageInput["recipe"]>["steps"] = [];
      if (input.recipe.steps !== undefined) {
        if (!Array.isArray(input.recipe.steps)) {
          invalidRequest("recipe.steps must be an array.");
        }
        if (input.recipe.steps.length > 100) {
          invalidRequest("recipe.steps cannot exceed 100 items.");
        }
        steps = input.recipe.steps.map((item, index) => {
          assertPlainObject(item, `recipe.steps[${index}] must be an object.`);
          assertKnownFields(
            item,
            ["name", "temperatureC", "timeMinutes", "note"],
            `recipe.steps[${index}]`,
          );
          return {
            name: cleanString(item.name, 160, `recipe.steps[${index}].name`),
            temperatureC: cleanOptionalNumber(
              item.temperatureC,
              -50,
              150,
              `recipe.steps[${index}].temperatureC`,
            ),
            timeMinutes: cleanOptionalNumber(
              item.timeMinutes,
              0,
              100_000,
              `recipe.steps[${index}].timeMinutes`,
            ),
            note: cleanOptionalString(item.note, 1000, `recipe.steps[${index}].note`),
          };
        });
      }

      result.recipe = { notes, ingredients, steps };
    }
  }

  if (input.sensoryOverrides !== undefined) {
    if (input.sensoryOverrides === null) {
      result.sensoryOverrides = null;
    } else {
      assertPlainObject(input.sensoryOverrides, "sensoryOverrides must be an object.");
      assertKnownFields(
        input.sensoryOverrides,
        ["bitterness", "sweetness", "body", "roast", "tartness", "alcohol"],
        "sensoryOverrides",
      );
      result.sensoryOverrides = {
        bitterness: cleanOptionalNumber(
          input.sensoryOverrides.bitterness,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "bitterness",
        ),
        sweetness: cleanOptionalNumber(
          input.sensoryOverrides.sweetness,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "sweetness",
        ),
        body: cleanOptionalNumber(
          input.sensoryOverrides.body,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "body",
        ),
        roast: cleanOptionalNumber(
          input.sensoryOverrides.roast,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "roast",
        ),
        tartness: cleanOptionalNumber(
          input.sensoryOverrides.tartness,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "tartness",
        ),
        alcohol: cleanOptionalNumber(
          input.sensoryOverrides.alcohol,
          BEVERAGE_SENSORY_CANONICAL_MIN,
          BEVERAGE_SENSORY_CANONICAL_MAX,
          "alcohol",
        ),
      };
    }
  }

  return result;
}

export function validateUpdateBeverageSensoryOverridesInput(
  input: unknown,
): UpdateBeverageSensoryOverridesInput {
  assertStrictPlainObject(input, "Sensory overrides input must be a plain object.");
  assertKnownFields(input, BEVERAGE_SENSORY_AXES, "sensory overrides");

  const presentAxes = BEVERAGE_SENSORY_AXES.filter((axis) =>
    Object.prototype.hasOwnProperty.call(input, axis),
  );
  if (presentAxes.length === 0) {
    invalidRequest("Sensory overrides input must include at least one axis.");
  }

  const result: Partial<Record<BeverageSensoryAxis, number | null>> = {};
  for (const axis of presentAxes) {
    const value = input[axis];
    if (value === null) {
      result[axis] = null;
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < BEVERAGE_SENSORY_CANONICAL_MIN ||
      value > BEVERAGE_SENSORY_CANONICAL_MAX
    ) {
      invalidRequest(`${axis} must be a finite number ${CANONICAL_SENSORY_RANGE} or null.`);
    }
    result[axis] = value;
  }

  return result;
}

function parseOverrideField<T>(
  fieldInput: unknown,
  cleaner: (val: unknown) => T | null,
  context: string,
): { readonly inherit?: boolean; readonly clear?: boolean; readonly value?: T | null } {
  assertPlainObject(fieldInput, `${context} override specification must be an object.`);
  assertKnownFields(fieldInput, ["inherit", "reset", "clear", "value"], context);

  const inherit =
    (fieldInput as { inherit?: boolean; reset?: boolean }).inherit === true ||
    (fieldInput as { inherit?: boolean; reset?: boolean }).reset === true;
  if (inherit) {
    return { inherit: true, value: null };
  }

  const clear = (fieldInput as { clear?: boolean }).clear === true;
  if (clear) {
    if (context === "name" || context === "beverageType") {
      invalidRequest(
        `${context} override cannot be cleared to empty. Use 'inherit: true' to use the source value.`,
      );
    }
    return { clear: true, value: null };
  }

  if ((fieldInput as { value?: unknown }).value !== undefined) {
    return { value: cleaner((fieldInput as { value?: unknown }).value) };
  }

  invalidRequest(`${context} override must specify 'inherit: true', 'clear: true', or 'value'.`);
}

export function validateUpdatePresentationOverridesInput(
  input: unknown,
): UpdatePresentationOverridesInput {
  assertPlainObject(input, "Overrides must be an object.");
  assertKnownFields(
    input,
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
      "manualDensityOverride",
    ],
    "presentation overrides",
  );

  const result: Record<string, unknown> = {};

  if (input.name !== undefined) {
    result.name = parseOverrideField(
      input.name,
      (val) => cleanString(val, 160, "overrides.name"),
      "name",
    );
  }
  if (input.beverageType !== undefined) {
    result.beverageType = parseOverrideField(
      input.beverageType,
      (val) => validateBeverageType(val),
      "beverageType",
    );
  }
  if (input.style !== undefined) {
    result.style = parseOverrideField(
      input.style,
      (val) => cleanOptionalString(val, 120, "overrides.style"),
      "style",
    );
  }
  if (input.abv !== undefined) {
    result.abv = parseOverrideField(
      input.abv,
      (val) => cleanOptionalNumber(val, 0, 100, "overrides.abv"),
      "abv",
    );
  }
  if (input.ibu !== undefined) {
    result.ibu = parseOverrideField(
      input.ibu,
      (val) => cleanOptionalNumber(val, 0, 2000, "overrides.ibu"),
      "ibu",
    );
  }
  if (input.og !== undefined) {
    result.og = parseOverrideField(
      input.og,
      (val) => cleanOptionalNumber(val, 0.5, 2.0, "overrides.og"),
      "og",
    );
  }
  if (input.fg !== undefined) {
    result.fg = parseOverrideField(
      input.fg,
      (val) => cleanOptionalNumber(val, 0.5, 2.0, "overrides.fg"),
      "fg",
    );
  }
  if (input.srm !== undefined) {
    result.srm = parseOverrideField(
      input.srm,
      (val) => cleanOptionalNumber(val, 0, 100, "overrides.srm"),
      "srm",
    );
  }
  if (input.displayColor !== undefined) {
    result.displayColor = parseOverrideField(
      input.displayColor,
      (val) => cleanOptionalString(val, 32, "overrides.displayColor"),
      "displayColor",
    );
  }
  if (input.description !== undefined) {
    result.description = parseOverrideField(
      input.description,
      (val) => cleanOptionalString(val, 4000, "overrides.description"),
      "description",
    );
  }
  if (input.fillGlass !== undefined) {
    result.fillGlass = parseOverrideField(
      input.fillGlass,
      (val) => cleanOptionalString(val, 64, "overrides.fillGlass"),
      "fillGlass",
    );
  }
  if (input.manualDensityOverride !== undefined) {
    result.manualDensityOverride = parseOverrideField(
      input.manualDensityOverride,
      (val) => cleanOptionalNumber(val, 0.5, 2.0, "overrides.manualDensityOverride"),
      "manualDensityOverride",
    );
  }

  return result;
}

export function validateLinkBrewfatherCandidateInput(input: unknown): LinkBrewfatherCandidateInput {
  assertPlainObject(input, "Link candidate input must be an object.");
  assertKnownFields(
    input,
    ["id", "accountId", "sourceBatchId", "overrides", "sensoryOverrides"],
    "link Brewfather candidate",
  );

  const sourceBatchId = cleanString(input.sourceBatchId, 256, "sourceBatchId");
  const accountId = cleanOptionalString(input.accountId, 64, "accountId") ?? "default";

  let overrides: UpdatePresentationOverridesInput | undefined;
  if (input.overrides !== undefined && input.overrides !== null) {
    overrides = validateUpdatePresentationOverridesInput(input.overrides);
  }

  let sensoryOverrides: LinkBrewfatherCandidateInput["sensoryOverrides"] = null;
  if (input.sensoryOverrides !== undefined && input.sensoryOverrides !== null) {
    assertPlainObject(input.sensoryOverrides, "sensoryOverrides must be an object.");
    assertKnownFields(
      input.sensoryOverrides,
      ["bitterness", "sweetness", "body", "roast", "tartness", "alcohol"],
      "sensoryOverrides",
    );
    sensoryOverrides = {
      bitterness: cleanOptionalNumber(
        input.sensoryOverrides.bitterness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "bitterness",
      ),
      sweetness: cleanOptionalNumber(
        input.sensoryOverrides.sweetness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "sweetness",
      ),
      body: cleanOptionalNumber(
        input.sensoryOverrides.body,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "body",
      ),
      roast: cleanOptionalNumber(
        input.sensoryOverrides.roast,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "roast",
      ),
      tartness: cleanOptionalNumber(
        input.sensoryOverrides.tartness,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "tartness",
      ),
      alcohol: cleanOptionalNumber(
        input.sensoryOverrides.alcohol,
        BEVERAGE_SENSORY_CANONICAL_MIN,
        BEVERAGE_SENSORY_CANONICAL_MAX,
        "alcohol",
      ),
    };
  }

  return {
    ...(typeof input.id === "string" ? { id: input.id } : {}),
    accountId,
    sourceBatchId,
    ...(overrides !== undefined ? { overrides } : {}),
    sensoryOverrides,
  };
}

export function validateUpdateBeverageSettingsInput(input: unknown): UpdateBeverageSettingsInput {
  assertPlainObject(input, "Settings input must be an object.");
  assertKnownFields(input, ["fallbackFg", "brewfatherCompletionPolicy"], "beverage settings");

  let fallbackFg: number | undefined;
  let brewfatherCompletionPolicy: BrewfatherCompletionPolicy | undefined;

  if (input.fallbackFg !== undefined) {
    const fg = cleanOptionalNumber(input.fallbackFg, 0.5, 2.0, "fallbackFg");
    if (fg === null) invalidRequest("fallbackFg must be a valid number.");
    fallbackFg = fg;
  }
  if (input.brewfatherCompletionPolicy !== undefined) {
    if (
      typeof input.brewfatherCompletionPolicy !== "string" ||
      !ALLOWED_COMPLETION_POLICIES.has(input.brewfatherCompletionPolicy)
    ) {
      invalidRequest(
        `brewfatherCompletionPolicy must be one of: ${Array.from(ALLOWED_COMPLETION_POLICIES).join(", ")}`,
      );
    }
    brewfatherCompletionPolicy = input.brewfatherCompletionPolicy as BrewfatherCompletionPolicy;
  }

  return {
    ...(fallbackFg !== undefined ? { fallbackFg } : {}),
    ...(brewfatherCompletionPolicy !== undefined ? { brewfatherCompletionPolicy } : {}),
  };
}

export function validateConfigureBrewfatherAccountInput(
  input: unknown,
): ConfigureBrewfatherAccountInput {
  assertPlainObject(input, "Brewfather configuration must be an object.");
  assertKnownFields(
    input,
    ["accountId", "userId", "apiKey", "enabled", "discoveryStatuses"],
    "brewfather account configuration",
  );

  const accountId = cleanOptionalString(input.accountId, 64, "accountId") ?? "default";
  const userId = cleanString(input.userId, 120, "userId");
  const apiKey =
    input.apiKey !== undefined
      ? (cleanOptionalString(input.apiKey, 256, "apiKey") ?? undefined)
      : undefined;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    invalidRequest("enabled must be a boolean.");
  }
  const enabled = input.enabled ?? true;

  let discoveryStatuses: string[] | undefined;
  if (input.discoveryStatuses !== undefined) {
    if (!Array.isArray(input.discoveryStatuses)) {
      invalidRequest("discoveryStatuses must be an array of strings.");
    }
    discoveryStatuses = input.discoveryStatuses.map((s, idx) => {
      const val = cleanString(s, 32, `discoveryStatuses[${idx}]`);
      if (!STATUS_SET.has(val)) {
        invalidRequest(
          `discoveryStatuses[${idx}] must be one of: ${Array.from(STATUS_SET).join(", ")}`,
        );
      }
      return val;
    });
  }

  return {
    accountId,
    userId,
    ...(apiKey !== undefined ? { apiKey } : {}),
    enabled,
    ...(discoveryStatuses !== undefined ? { discoveryStatuses } : {}),
  };
}

export interface DeleteBeverageInput {
  readonly reason?: string | null;
}

export function validateDeleteBeverageInput(input: unknown): DeleteBeverageInput {
  if (input === undefined || input === null || input === "") {
    return {};
  }
  assertPlainObject(input, "Delete beverage input must be an object.");
  assertKnownFields(input, ["reason"], "delete beverage input");

  const reason = cleanOptionalString(input.reason, 255, "reason");
  return {
    ...(reason !== null ? { reason } : {}),
  };
}
