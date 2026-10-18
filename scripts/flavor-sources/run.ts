import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "prettier";
import type { SourcedEntry } from "../../src/features/story/flavor/sourced.ts";
import { buildEntry } from "./build.ts";
import { CACHE_DIR } from "./fetch.ts";
import { closeDom, type MakerSource } from "./maker.ts";

// Usage:
//   NODE_USE_ENV_PROXY=1 node scripts/flavor-sources/run.ts white-labs [--limit 5]
//   node scripts/flavor-sources/run.ts --write yeasts
// Reading writes data/flavor-sources/out/<maker>.json (entries, review, gaps); --write merges
// every reviewed maker of a role into src/features/story/flavor/sourced/<role>.json.
const OUT_DIR = join(CACHE_DIR, "out");
const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt === -1 ? undefined : Number(args[limitAt + 1]);

interface MakerOutput {
  readonly maker: string;
  readonly role: string;
  readonly entries: readonly SourcedEntry[];
  readonly review: readonly {
    id: string;
    text: string;
    excluded: unknown;
    unmatched: readonly string[];
  }[];
  readonly gaps: readonly { url: string; reason: string }[];
}

async function readMaker(id: string): Promise<void> {
  const { maker } = (await import(`./makers/${id}.ts`)) as { maker: MakerSource };
  const result = await maker.read(limit);
  const built = result.products.map(buildEntry);
  const output: MakerOutput = {
    maker: maker.id,
    role: maker.role,
    entries: built.map(({ entry }) => entry),
    review: built.map(({ entry, extraction }, index) => ({
      id: entry.id,
      text: result.products[index]!.flavorText,
      excluded: extraction.excluded,
      unmatched: extraction.unmatched,
    })),
    gaps: result.gaps,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${maker.id}.json`), JSON.stringify(output, null, 1));
  const worded = output.entries.filter((entry) => entry.descriptors.length > 0).length;
  process.stdout.write(
    `${maker.id}: ${output.entries.length} products (${worded} with words), ${output.gaps.length} gaps\n`,
  );
}

async function writeRole(role: string): Promise<void> {
  const entries: SourcedEntry[] = [];
  for (const file of (await readdir(OUT_DIR)).filter((name) => name.endsWith(".json"))) {
    const output = JSON.parse(await readFile(join(OUT_DIR, file), "utf8")) as MakerOutput;
    if (output.role === role) entries.push(...output.entries);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  // Within one maker, an alias or code naming two entries would make both unmatchable.
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const entry of entries)
    for (const key of [...entry.aliases, ...entry.codes.map((code) => `code ${code}`)]) {
      const owner = `${entry.manufacturer ?? ""}|${key.trim().toLowerCase()}`;
      const other = owners.get(owner);
      if (other && other !== entry.id) clashes.push(`${other} and ${entry.id} share ${key}`);
      owners.set(owner, entry.id);
    }
  if (clashes.length) throw new Error(`Ambiguous identities:\n${clashes.join("\n")}`);
  const target = `src/features/story/flavor/sourced/${role}.json`;
  await writeFile(target, await format(JSON.stringify(entries), { parser: "json" }));
  process.stdout.write(`${target}: ${entries.length} entries\n`);
}

try {
  if (args[0] === "--write") await writeRole(args[1]!);
  else
    for (const id of args.filter(
      (arg, index) => !arg.startsWith("--") && args[index - 1] !== "--limit",
    ))
      await readMaker(id);
} finally {
  await closeDom();
}
