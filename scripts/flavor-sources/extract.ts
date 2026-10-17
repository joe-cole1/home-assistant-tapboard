import type { BrewingIngredientRole } from "../../src/features/beverages/brewing-types.ts";
import { IGNORED_PHRASES, LEXICON, type LexiconTerm } from "./lexicon.ts";

export interface ExtractedWord {
  readonly word: string;
  /** The maker's own phrase, normalised, that produced the word. */
  readonly evidence: string;
}
export interface ExcludedWord extends ExtractedWord {
  readonly reason: "negated" | "conditional" | "pairing" | "other ingredient";
}
export interface Extraction {
  readonly words: readonly ExtractedWord[];
  readonly excluded: readonly ExcludedWord[];
  /** Content words the lexicon does not know, for deliberate lexicon review. */
  readonly unmatched: readonly string[];
}

// A negator reaches forward to the next comma in its clause: "low fruitiness and esters" negates
// both, while "no diacetyl, fruity" keeps "fruity".
const NEGATOR =
  /\b(?:no|not|non|low|lower|minimal|minimum|without|free of|absence of|absent|lacks?|lacking|less|reduced|reduces?|suppress\w*|avoid\w*|never|nor|zero)\b/g;
// Conditional and temperature-dependent statements describe what can happen, not what the
// product gives, so every word in that clause is left out.
const CONDITIONAL =
  /\b(?:if|when|whenever|unless|depending|depends|can|could|may|might|potentially|optionally|at (?:higher|lower|warmer|cooler|high|low|the upper|the lower)|with (?:warmer|cooler|higher|lower)|warmer temperatures|cooler temperatures|higher temperatures|lower temperatures)\b/;
// Words after a pairing or use marker describe other ingredients or beer styles.
const PAIRING =
  /\b(?:for|ideal for|suited (?:to|for)|recommended for|great for|perfect for|used in|use in|pairs?(?: well)? with|complement\w*|accentuat\w*|enhanc\w*|matches up|showcas\w*|alongside|blends?(?: well)? with|works well with|similar to|substitute\w*|replacement for)\b/;
const STOPWORDS = new Set(
  "a an and are as at be been but by character characteristics contributes delivers distinct excellent flavor flavors flavour flavours from gives good great has have high hints imparts in into is it its known light medium mild moderate more most notes of on or over pleasant produces profile provides rich slightly strong subtle that the these this to touch very well which with aroma aromas aromatic taste tastes beer beers brewing brew style styles use used variety hop hops malt malts yeast strain also intense intensely nice clean crisp neutral balanced smooth dry sweet sweetness bitter bitterness body full finish mouthfeel".split(
    " ",
  ),
);

function normalise(text: string): string {
  return text
    .replace(/[®™℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[‐‑–—-]/g, " ")
    .replace(/[\/&+]/g, " , ")
    .replace(/\s+/g, " ");
}
const escape = (phrase: string) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const entries: readonly { readonly phrase: string; readonly term: LexiconTerm | null }[] = [
  ...LEXICON.flatMap((term) => term.phrases.map((phrase) => ({ phrase, term }))),
  ...IGNORED_PHRASES.map((phrase) => ({ phrase, term: null })),
].sort((a, b) => b.phrase.length - a.phrase.length);
const byPhrase = new Map(entries.map((entry) => [entry.phrase, entry.term]));
const PHRASES = new RegExp(
  `\\b(?:${entries.map((entry) => escape(entry.phrase)).join("|")})\\b`,
  "g",
);

/** Deterministic flavour words from a maker's own text. Only lexicon phrases are recorded, in
 * the maker's order; negated, conditional and pairing mentions are reported, never kept. */
export function extractDescriptors(text: string, role: BrewingIngredientRole): Extraction {
  const words: ExtractedWord[] = [];
  const excluded: ExcludedWord[] = [];
  const unmatched = new Set<string>();
  const seen = new Set<string>();
  for (const clause of normalise(text).split(/[.;!?:\n]+|\b(?:but|while|whereas|however)\b/)) {
    const conditional = CONDITIONAL.test(clause);
    const pairingAt = clause.search(PAIRING);
    const negators = [...clause.matchAll(NEGATOR)].map((match) => match.index);
    let consumedTo = 0;
    for (const match of clause.matchAll(PHRASES)) {
      for (const token of clause.slice(consumedTo, match.index).match(/[a-z]{4,}/g) ?? [])
        if (!STOPWORDS.has(token)) unmatched.add(token);
      consumedTo = match.index + match[0].length;
      const term = byPhrase.get(match[0]);
      if (!term) continue;
      const evidence = match[0];
      const negatedBy = negators.findLast((at) => at < match.index);
      const reason: ExcludedWord["reason"] | null =
        term.maltOnly && (role === "yeasts" || role === "hops")
          ? "other ingredient"
          : negatedBy !== undefined && !clause.slice(negatedBy, match.index).includes(",")
            ? "negated"
            : conditional
              ? "conditional"
              : pairingAt !== -1 && pairingAt < match.index
                ? "pairing"
                : null;
      if (reason) excluded.push({ word: term.word, evidence, reason });
      else if (!seen.has(term.word)) {
        seen.add(term.word);
        words.push({ word: term.word, evidence });
      }
    }
    for (const token of clause.slice(consumedTo).match(/[a-z]{4,}/g) ?? [])
      if (!STOPWORDS.has(token)) unmatched.add(token);
  }
  return { words, excluded, unmatched: [...unmatched].sort() };
}
