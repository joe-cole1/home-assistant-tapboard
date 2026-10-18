import type { SourcedEntry } from "../../src/features/story/flavor/sourced.ts";

// Several sources describe one hop variety, which has no manufacturer. Each variety keeps one
// source: owners and national breeders' bodies first, then breeder-merchants, then growers and
// merchants.
export const HOP_SOURCES = [
  "hbc",
  "ycr",
  "indie-hops",
  "hpa",
  "nz-hops",
  "chizatec",
  "bohemia-hop",
  "british-hops",
  "deutscher-hopfen",
  "hopsteiner",
  "john-i-haas",
  "barthhaas",
  "freestyle",
  "charles-faram",
  "crosby",
  "cls",
];
/** Hop names as one variety across sources: case, accents and German spellings fold away
 * ("Mittelfrüh", "Mittelfrueh" and "Mittelfruh" are one name). */
const hopKey = (name: string) =>
  name
    .replace(/[®™℠]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(?<=[aou])e/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** One entry per hop variety: sources sharing a name describe one variety, the first source in
 * `HOP_SOURCES` that names flavour words is kept, and every source's spelling stays an alias.
 * `merged` lists groups that joined differently named entries, for review. */
export function mergeHops(
  outputs: readonly { readonly maker: string; readonly entries: readonly SourcedEntry[] }[],
): { entries: SourcedEntry[]; merged: string[] } {
  const merged: string[] = [];
  const rank = (maker: string) => {
    const index = HOP_SOURCES.indexOf(maker);
    if (index === -1) throw new Error(`${maker} has no place in HOP_SOURCES`);
    return index;
  };
  for (const output of outputs) rank(output.maker);
  const candidates = outputs
    .flatMap((output) => output.entries.map((entry) => ({ maker: output.maker, entry })))
    .sort((a, b) => rank(a.maker) - rank(b.maker));
  const groups: (typeof candidates)[] = [];
  const groupOf = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const keys = candidate.entry.aliases.map(hopKey);
    const joined = [
      ...new Set(
        keys
          .map((key) => groupOf.get(key))
          .filter((group): group is typeof candidates => group !== undefined),
      ),
    ];
    const group = joined[0] ?? [];
    if (!joined.length) groups.push(group);
    for (const other of joined.slice(1)) {
      group.push(...other.splice(0));
    }
    group.push(candidate);
    for (const member of group)
      for (const key of member.entry.aliases.map(hopKey)) groupOf.set(key, group);
  }
  const entries = groups
    .filter((group) => group.length)
    .map((group) => {
      group.sort((a, b) => rank(a.maker) - rank(b.maker));
      const chosen = group.find(({ entry }) => entry.descriptors.length) ?? group[0]!;
      // Differently named entries joined through a shared name are printed for review.
      const ids = [...new Set(group.map(({ entry }) => entry.id))];
      if (ids.length > 1)
        merged.push(
          `${chosen.entry.id} (${chosen.maker}): ${group.map(({ maker, entry }) => `${maker}:${entry.id}`).join(", ")}`,
        );
      const wordless = [
        ...new Set(group.slice(0, group.indexOf(chosen)).map(({ maker }) => maker)),
      ];
      return {
        ...chosen.entry,
        aliases: [...new Set(group.flatMap(({ entry }) => entry.aliases))],
        limitations: [
          ...chosen.entry.limitations,
          ...(wordless.length
            ? [`Higher-priority sources name no flavour words: ${wordless.join(", ")}.`]
            : []),
        ],
      };
    });
  return { entries, merged };
}
