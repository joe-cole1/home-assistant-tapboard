/** Pure server-side formatting for the public recipe sheet. */
interface RecipeAmount {
  readonly amount: number | null;
  readonly unit: string | null;
  readonly grams: number | null;
}

const GRAMS_PER_OUNCE = 28.349523125;
const GRAMS_PER_POUND = 453.59237;

function validAmount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function recipeNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const precision = Number.isFinite(digits) ? Math.max(0, Math.min(6, Math.trunc(digits))) : 2;
  const rounded = value.toFixed(precision);
  if (value !== 0 && Number(rounded) === 0) {
    return `${value < 0 ? "> -" : "< "}${(10 ** -precision).toFixed(precision)}`;
  }
  return String(Number(rounded));
}

export function recipeMass(grams: number, system: "metric" | "us", role: string): string {
  if (!validAmount(grams)) return "—";
  const group = role.toLowerCase();
  if (group === "fermentables" || group === "fermentable") {
    if (system === "us") {
      const pounds = Math.floor(grams / GRAMS_PER_POUND);
      const ounces = (grams % GRAMS_PER_POUND) / GRAMS_PER_OUNCE;
      // Carry an ounce rounding boundary into the pounds column.
      if (Number(ounces.toFixed(2)) >= 16) return `${pounds + 1} lb 0 oz`;
      const fraction = pounds > 0 && Number(ounces.toFixed(2)) === 0 ? "0" : recipeNumber(ounces);
      return `${pounds} lb ${fraction} oz`;
    }
    return grams >= 1000 ? `${recipeNumber(grams / 1000, 3)} kg` : `${recipeNumber(grams)} g`;
  }
  if (group === "hops" || group === "hop") {
    return system === "us"
      ? `${recipeNumber(grams / GRAMS_PER_OUNCE)} oz`
      : `${recipeNumber(grams)} g`;
  }
  return grams > 0 && grams < 1 ? `${recipeNumber(grams * 1000)} mg` : `${recipeNumber(grams)} g`;
}

export function recipeAmount(row: RecipeAmount, system: "metric" | "us", role: string): string {
  const unit = typeof row.unit === "string" ? row.unit.trim() : "";
  const massFactors: Readonly<Record<string, number>> = {
    mg: 0.001,
    g: 1,
    kg: 1000,
    oz: GRAMS_PER_OUNCE,
    lb: GRAMS_PER_POUND,
    lbs: GRAMS_PER_POUND,
  };
  const key = unit.toLowerCase();
  const factor = Object.hasOwn(massFactors, key) ? massFactors[key] : undefined;
  if (factor !== undefined) {
    const grams = validAmount(row.grams)
      ? row.grams
      : validAmount(row.amount)
        ? row.amount * factor
        : null;
    return grams === null ? "—" : recipeMass(grams, system, role);
  }
  // Explicit non-mass units and missing units must never be guessed from grams.
  if (validAmount(row.amount)) {
    return `${recipeNumber(row.amount)} ${unit || "(unit not recorded)"}`;
  }
  return "—";
}
