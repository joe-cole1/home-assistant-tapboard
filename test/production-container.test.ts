import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/check-production-container.sh", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/production-container-smoke.mjs", import.meta.url),
);

// The container proof itself needs Docker; CI's production-container job runs it.
void test("the production container smoke script and fixture are syntactically valid", () => {
  execFileSync("bash", ["-n", script]);
  execFileSync(process.execPath, ["--check", fixture]);
});
