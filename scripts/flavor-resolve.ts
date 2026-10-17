import { parseArgs } from "node:util";
import type {
  BrewingIngredient,
  BrewingIngredientRole,
} from "../src/features/beverages/brewing-types.ts";
import { resolveIngredient } from "../src/features/story/flavor/catalog.ts";

// Shows how the flavor catalog resolves one ingredient, e.g.
// node scripts/flavor-resolve.ts yeasts "Hefeweizen IV" --maker "White Labs" --code WLP380 --type Wheat
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    maker: { type: "string" },
    code: { type: "string" },
    type: { type: "string" },
    form: { type: "string" },
    color: { type: "string" },
  },
});
const [role, name] = positionals;
const roles: readonly string[] = ["fermentables", "hops", "yeasts", "miscs"];
if (!role || !roles.includes(role) || !name) {
  process.stderr.write(
    'Usage: node scripts/flavor-resolve.ts <fermentables|hops|yeasts|miscs> "<name>" [--maker M] [--code C] [--type T] [--form F] [--color SRM]\n',
  );
  process.exit(2);
}
const item: BrewingIngredient = {
  sourcePath: "cli",
  name,
  supplier: role === "yeasts" ? null : (values.maker ?? null),
  laboratory: role === "yeasts" ? (values.maker ?? null) : null,
  productId: values.code ?? null,
  type: values.type ?? null,
  grainCategory: null,
  use: null,
  usage: null,
  form: values.form ?? null,
  amount: null,
  unit: null,
  grams: null,
  percentage: null,
  color: values.color === undefined ? null : Number(values.color),
  lovibond: null,
  alpha: null,
  day: null,
  time: null,
  timeUnit: null,
  stage: "unknown",
  boilMinutes: null,
  contactDays: null,
  additionDay: null,
  temperatureC: null,
  aroma: null,
  totalOil: null,
  limitations: [],
};
process.stdout.write(
  `${JSON.stringify(resolveIngredient(role as BrewingIngredientRole, item), null, 2)}\n`,
);
