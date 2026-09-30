import { readFileSync } from "node:fs";

const metadata: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
if (
  typeof metadata !== "object" ||
  metadata === null ||
  !("version" in metadata) ||
  typeof metadata.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(metadata.version)
) {
  throw new Error("Application version metadata is invalid");
}

export const APPLICATION_VERSION = metadata.version;
