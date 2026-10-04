import { readFileSync } from "node:fs";

import { readBrewingInputs } from "../../../src/features/beverages/brewing-inputs.ts";
import { sanitizeRecipeSnapshot } from "../../../src/features/beverages/brewfather/sanitizer.ts";
import { resolveIngredient } from "../../../src/features/story/flavor/catalog.ts";
import { resolveFlavorProfile } from "../../../src/features/story/profile.ts";
import { SENSORY_AXES } from "../../../src/features/story/types.ts";

export interface FlavorFixture {
  readonly caseId: string;
  readonly input: Record<string, unknown>;
}
export interface FlavorCorpus {
  readonly recipes: readonly FlavorFixture[];
  readonly batches: readonly FlavorFixture[];
}
export const corpus = JSON.parse(
  readFileSync(new URL("./development-corpus.json", import.meta.url), "utf8"),
) as FlavorCorpus;
export const priorityCases = JSON.parse(
  readFileSync(new URL("./regression-expectations.json", import.meta.url), "utf8"),
) as readonly {
  readonly caseId: string;
  readonly name: string;
  readonly required: readonly string[];
}[];

export function batchFixture(caseId: string): Record<string, unknown> {
  const fixture = corpus.batches.find((item) => item.caseId === caseId);
  if (fixture === undefined) throw new Error(`Missing flavor fixture ${caseId}`);
  return structuredClone(fixture.input);
}

/** Always crosses the production sanitizer and persisted-envelope reader. */
export function evaluateFixture(input: unknown, kind: "batch" | "recipe" = "batch") {
  const recipe = kind === "batch" ? (input as Record<string, unknown>)["recipe"] : input;
  const snapshot = sanitizeRecipeSnapshot(recipe, kind === "batch" ? input : undefined, {
    format: "brewfather-export-v3",
  });
  if (snapshot === null) throw new Error("Fixture rejected by production sanitizer");
  const brewingInputs = readBrewingInputs(JSON.parse(snapshot.recipeJson));
  if (brewingInputs === null) throw new Error("Fixture rejected by production snapshot reader");
  return {
    inputs: brewingInputs,
    snapshot,
    calculation: resolveFlavorProfile({ brewingInputs }),
    snapshotBytes: Buffer.byteLength(snapshot.recipeJson, "utf8"),
  };
}

export function corpusReport() {
  const cases = [
    ...corpus.batches.map((item) => ({ ...item, kind: "batch" as const })),
    ...corpus.recipes.map((item) => ({ ...item, kind: "recipe" as const })),
  ].map((fixture) => {
    const { calculation, snapshotBytes, inputs } = evaluateFixture(fixture.input, fixture.kind);
    return {
      caseId: fixture.caseId,
      kind: fixture.kind,
      snapshotBytes,
      fingerprint: calculation.fingerprint,
      selectedScalars: inputs.scalars,
      unresolvedIngredients: (["fermentables", "hops", "yeasts", "miscs"] as const).flatMap(
        (role) =>
          inputs.ingredients[role].items.flatMap((item) => {
            const resolution = resolveIngredient(role, item);
            return resolution.level === "unresolved"
              ? [
                  {
                    role,
                    sourcePath: item.sourcePath,
                    name: item.name,
                    supplier: item.supplier,
                    laboratory: item.laboratory,
                    productId: item.productId,
                    grams: item.grams,
                    stage: item.stage,
                    reasons: resolution.diagnostics,
                  },
                ]
              : [];
          }),
      ),
      axes: Object.fromEntries(
        SENSORY_AXES.map((axis) => [
          axis,
          {
            value: calculation.profile[axis].value,
            band: calculation.profile[axis].band,
            source: calculation.axes[axis].source,
            support: calculation.axes[axis].support,
            reasons: calculation.axes[axis].reasons,
          },
        ]),
      ),
      coverage: calculation.coverage,
      diagnostics: calculation.diagnostics,
    };
  });
  const first = evaluateFixture(corpus.batches[0]!.input).calculation;
  return {
    format: "tapboard-flavor-corpus-report-1",
    modelVersion: first.modelVersion,
    catalogVersion: first.catalogVersion,
    qualification:
      "Offline normalization and behavior acceptance; no sensory ground-truth labels or scientific validation.",
    counts: {
      batches: corpus.batches.length,
      savedRecipes: corpus.recipes.length,
      total: cases.length,
    },
    maximumSnapshotBytes: Math.max(...cases.map((item) => item.snapshotBytes)),
    perAxis: Object.fromEntries(
      SENSORY_AXES.map((axis) => {
        const results = cases.map((item) => item.axes[axis]!);
        const countBy = (key: "source" | "band" | "support") =>
          Object.fromEntries(
            [...new Set(results.map((item) => item[key] ?? "Unknown"))]
              .sort()
              .map((value) => [
                value,
                results.filter((item) => (item[key] ?? "Unknown") === value).length,
              ]),
          );
        return [
          axis,
          {
            available: results.filter((item) => item.value !== null).length,
            unavailable: results.filter((item) => item.value === null).length,
            explicitZero: results.filter((item) => item.value === 0).length,
            saturatedFive: results.filter((item) => item.value === 5).length,
            source: countBy("source"),
            support: countBy("support"),
            bands: countBy("band"),
          },
        ];
      }),
    ),
    priorityNullAndZeroReasons: cases
      .filter((item) => priorityCases.some((priority) => priority.caseId === item.caseId))
      .map((item) => ({
        caseId: item.caseId,
        coverage: item.coverage,
        unresolvedIngredients: item.unresolvedIngredients,
        axes: Object.fromEntries(
          SENSORY_AXES.filter(
            (axis) => item.axes[axis]!.value === null || item.axes[axis]!.value === 0,
          ).map((axis) => [axis, item.axes[axis]]),
        ),
      })),
    cases,
  };
}
