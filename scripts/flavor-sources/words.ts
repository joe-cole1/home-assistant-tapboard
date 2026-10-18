import { readFile } from "node:fs/promises";
import type { BrewingIngredientRole } from "../../src/features/beverages/brewing-types.ts";
import { extractDescriptors } from "./extract.ts";
import { pdfText } from "./fetch.ts";

// Usage: node scripts/flavor-sources/words.ts <role> <sheet.pdf|notes.txt>
// Prints the lexicon words a maker's text yields, each with the maker phrase it came from, plus
// the mentions left out and the words the lexicon does not know. Use it for a reviewed fact built
// from an operator-supplied data sheet, so its words follow the same rules as the generated data.
const [role, file] = process.argv.slice(2) as [BrewingIngredientRole, string];
const bytes = await readFile(file);
const text =
  bytes.subarray(0, 5).toString() === "%PDF-"
    ? await pdfText({
        url: file,
        retrieved: "",
        sha256: "",
        contentType: "application/pdf",
        body: bytes.toString("base64"),
        encoding: "base64",
      })
    : bytes.toString("utf8");
process.stdout.write(`${JSON.stringify(extractDescriptors(text, role), null, 2)}\n`);
