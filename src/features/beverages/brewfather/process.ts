import type { BrewingProcessFact } from "../brewing-types.ts";
/** Completed action/object clauses only; private text and dates never enter the snapshot. */
export function extractProcessFacts(batch: Record<string, unknown>): {
  facts: readonly BrewingProcessFact[];
  complete: boolean;
} {
  const notes = Array.isArray(batch.notes) ? batch.notes : [];
  const entries: {
    text: unknown;
    path: string;
    category: BrewingProcessFact["sourceCategory"];
    timestamp: unknown;
  }[] = notes.slice(0, 30).map((v, i) => ({
    text: v && typeof v === "object" ? (v as Record<string, unknown>).note : undefined,
    timestamp: v && typeof v === "object" ? (v as Record<string, unknown>).timestamp : undefined,
    path: `batch.notes[${i}].note`,
    category: "batch_note",
  }));
  if (batch.batchNotes !== undefined)
    entries.push({
      text: batch.batchNotes,
      timestamp: undefined,
      path: "batch.batchNotes",
      category: "batch_notes",
    });
  let complete = notes.length <= 30 && (!batch.notes || Array.isArray(batch.notes));
  const facts: BrewingProcessFact[] = [];
  const epoch = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? (v < 1e10 ? v * 1000 : v) : null;
  const bottled = epoch(batch.bottlingDate);
  for (const entry of entries) {
    if (typeof entry.text !== "string") {
      if (entry.text !== undefined && entry.text !== null) complete = false;
      continue;
    }
    if (entry.text.length > 4000) complete = false;
    const clauses = entry.text
      .slice(0, 4000)
      .toLowerCase()
      .split(/[.\n;!?]/)
      .filter((clause) => clause.trim() !== "");
    if (clauses.length > 40) complete = false;
    for (const clause of clauses.slice(0, 40)) {
      if (
        /\b(no|not|never|without|maybe|might|will|plan|planned|planning|next|future|intend|would|could|should|if)\b/.test(
          clause,
        )
      )
        continue;
      // Relevant completed souring context is retained as a limitation, never a guessed intensity.
      if (
        /\b(?:kettle[ -]sour(?:ed|ing)?|soured|souring|lactobacillus|pediococcus|brettanomyces|mixed culture|wild fermentation)\b/.test(
          clause,
        )
      )
        complete = false;
      const barrel =
        /\b(?:added|transferred|racked|placed)\s+(?:(?:the\s+)?(?:beer|batch|it)\s+)?(?:to|into)\s+(?:an?\s+|the\s+)?(?:(bourbon|whiskey|whisky|oak)\s+)?barrel\b|\baged\s+in\s+(?:an?\s+|the\s+)?(?:(bourbon|whiskey|whisky|oak)\s+)?barrel\b/.exec(
          clause,
        );
      let kind: BrewingProcessFact["kind"] | null = null;
      if (barrel)
        kind = /\b(bourbon|whiskey|whisky)\b/.test(barrel[0])
          ? "bourbon_barrel_recorded"
          : "oak_barrel_recorded";
      else if (
        /\badded\b[^.;]{0,100}\b(?:oak|wood)\s+(?:cubes|chips|spirals|staves)\b/.test(clause) ||
        /\bsoaked\s+(?:oak|wood)\s+(?:cubes|chips|spirals|staves)\b[^.;]{0,100}\band\s+added\s+(?:the\s+)?(?:drained\s+|soaked\s+)?(?:cubes|chips|spirals|staves)\b/.test(
          clause,
        )
      )
        kind = "oak_contact_recorded";
      else if (
        /\badded\s+(?:[\d.]+\s+(?:ml|l|oz)\s+)?(?:bourbon|whiskey|whisky|rum)\b/.test(clause)
      )
        kind = "spirit_addition_recorded";
      else if (/\badded\s+vanilla\s+extract\b/.test(clause)) kind = "vanilla_addition_recorded";
      if (!kind || facts.some((f) => f.kind === kind)) continue;
      const started = epoch(entry.timestamp);
      facts.push({
        kind,
        sourcePath: entry.path,
        sourceCategory: entry.category,
        timing:
          barrel && started !== null && bottled !== null && bottled < started
            ? "inconsistent"
            : "unknown",
      });
    }
  }
  return { facts, complete };
}
