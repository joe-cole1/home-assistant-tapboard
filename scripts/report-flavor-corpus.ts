import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { format } from "prettier";
import { corpusReport } from "../test/fixtures/flavor/corpus.ts";

const output = resolve(process.argv[2] ?? "docs/reports/flavor-corpus.json");
const report = corpusReport();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, await format(JSON.stringify(report), { parser: "json" }));
process.stdout.write(
  `${JSON.stringify({ output, counts: report.counts, maximumSnapshotBytes: report.maximumSnapshotBytes, perAxis: report.perAxis }, null, 2)}\n`,
);
