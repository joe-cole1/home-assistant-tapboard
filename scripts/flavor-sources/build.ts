import type { BrewingIngredientRole } from "../../src/features/beverages/brewing-types.ts";
import type { SourcedEntry } from "../../src/features/story/flavor/sourced.ts";
import { extractDescriptors, type Extraction } from "./extract.ts";

/** What a maker-specific parser reads from one product page: identity exactly as the maker
 * prints it, the maker's own flavour text, and the structured facts the page states. */
export interface ParsedProduct {
  readonly id: string;
  readonly role: BrewingIngredientRole;
  readonly manufacturer: string | null;
  readonly manufacturerAliases: readonly string[];
  readonly codes: readonly string[];
  readonly aliases: readonly string[];
  /** Only the page's flavour or aroma statement; never style, usage or history text. */
  readonly flavorText: string;
  readonly source: SourcedEntry["source"];
  readonly family?: SourcedEntry["family"];
  readonly souring?: boolean | null;
  readonly functions?: SourcedEntry["functions"];
  readonly bodyClass?: SourcedEntry["bodyClass"];
  readonly roastClass?: SourcedEntry["roastClass"];
  readonly noticeableGPerL?: number | null;
  readonly limitations?: readonly string[];
}

/** Turns a parsed product into a dataset entry; the words come only from deterministic
 * extraction of the maker's flavour text. The extraction is returned for the review report. */
export function buildEntry(product: ParsedProduct): {
  entry: SourcedEntry;
  extraction: Extraction;
} {
  const extraction = extractDescriptors(product.flavorText, product.role);
  return {
    extraction,
    entry: {
      id: product.id,
      manufacturer: product.manufacturer,
      manufacturerAliases: product.manufacturerAliases,
      codes: product.codes,
      aliases: product.aliases,
      descriptors: extraction.words.slice(0, 8),
      source: product.source,
      family: product.family ?? null,
      souring: product.souring ?? null,
      functions: product.functions ?? [],
      bodyClass: product.bodyClass ?? null,
      roastClass: product.roastClass ?? "none",
      noticeableGPerL: product.noticeableGPerL ?? null,
      limitations: [
        ...(extraction.words.length === 0 ? ["The maker's text names no flavour words."] : []),
        ...(product.limitations ?? []),
      ],
    },
  };
}
