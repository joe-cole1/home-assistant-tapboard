import type { SourcedEntry } from "../../src/features/story/flavor/sourced.ts";

// Several sources describe one hop variety, which has no manufacturer. Each variety keeps one
// source: its owner or a national breeders' body for varieties of that home region, then
// breeder-merchants, then growers and merchants. An owner listing a variety from outside its home
// region, or a regional growing named with an origin prefix ("NZ Fuggle", "US Tettnanger"),
// ranks as a grower. `home` null means every variety the source lists is its own.
export const HOP_SOURCES: readonly {
  readonly id: string;
  readonly tier: 0 | 1 | 2;
  readonly home: RegExp | null;
}[] = [
  { id: "hbc", tier: 0, home: null },
  { id: "ycr", tier: 0, home: null },
  { id: "indie-hops", tier: 0, home: /united states/i },
  { id: "hpa", tier: 0, home: /australia/i },
  { id: "nz-hops", tier: 0, home: /new zealand/i },
  { id: "chizatec", tier: 0, home: /czech/i },
  { id: "bohemia-hop", tier: 0, home: /czech/i },
  { id: "british-hops", tier: 0, home: /united kingdom|england|britain/i },
  { id: "deutscher-hopfen", tier: 0, home: /germany/i },
  { id: "hopsteiner", tier: 1, home: null },
  { id: "john-i-haas", tier: 1, home: null },
  { id: "barthhaas", tier: 1, home: null },
  { id: "freestyle", tier: 2, home: null },
  { id: "charles-faram", tier: 2, home: null },
  { id: "crosby", tier: 2, home: null },
  { id: "cls", tier: 2, home: null },
];
const ORIGIN_PREFIX =
  /^(?:nz|new zealand|us|usa|american|uk|english|british|czech|german|australian|slovenian|polish)\s/i;
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

/** One entry per hop variety: sources sharing a name describe one variety, the best-ranked
 * source that names flavour words is kept, and every source's spelling stays an alias.
 * `merged` lists groups that joined differently named entries, for review. */
export function mergeHops(
  outputs: readonly { readonly maker: string; readonly entries: readonly SourcedEntry[] }[],
): { entries: SourcedEntry[]; merged: string[] } {
  const merged: string[] = [];
  const source = (maker: string) => {
    const found = HOP_SOURCES.find((candidate) => candidate.id === maker);
    if (!found) throw new Error(`${maker} has no place in HOP_SOURCES`);
    return found;
  };
  const rank = (maker: string, entry: SourcedEntry) => {
    const { tier, home } = source(maker);
    const origin = entry.limitations
      .map((text) => /^Origin: (.+)\.$/.exec(text)?.[1])
      .find((value) => value !== undefined);
    const regional =
      ORIGIN_PREFIX.test(entry.aliases[0] ?? "") ||
      (home !== null && (origin === undefined || !home.test(origin)));
    return (regional ? 2 : tier) * 100 + HOP_SOURCES.indexOf(source(maker));
  };
  for (const output of outputs) source(output.maker);
  const candidates = outputs
    .flatMap((output) => output.entries.map((entry) => ({ maker: output.maker, entry })))
    .sort((a, b) => rank(a.maker, a.entry) - rank(b.maker, b.entry));
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
      group.sort((a, b) => rank(a.maker, a.entry) - rank(b.maker, b.entry));
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
