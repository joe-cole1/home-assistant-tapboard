import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../scripts/check-architecture.sh", import.meta.url));
const writableTemporaryDirectory = process.platform === "win32" ? tmpdir() : "/tmp";

const requiredRecords = [
  "docs/rebuild/TARGET.md",
  "docs/rebuild/ARCHITECTURE-DECISIONS.md",
  "docs/rebuild/V1-REUSE-CRITERIA.md",
  "docs/rebuild/ARCHITECTURE-FREEZE.md",
  "docs/rebuild/ARCHITECTURE-GUARDRAILS.md",
  "docs/rebuild/STATUS.md",
  "docs/rebuild/v1-reuse-manifest.json",
];

interface CheckResult {
  readonly status: number | null;
  readonly output: string;
}

function writeFixtureFile(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function runFixture(files: Readonly<Record<string, string>>): CheckResult {
  const root = mkdtempSync(join(writableTemporaryDirectory, "tapboard-architecture-"));

  try {
    for (const path of requiredRecords) {
      writeFixtureFile(root, path, path.endsWith(".json") ? "{}\n" : "# Fixture\n");
    }

    for (const [path, contents] of Object.entries(files)) {
      writeFixtureFile(root, path, contents);
    }

    const result = spawnSync("bash", [checker], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TAPBOARD_ARCHITECTURE_ROOT: root },
    });

    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void test("the real worktree architecture checker is syntactically valid", () => {
  execFileSync("bash", ["-n", checker]);
});

void test("legitimate Foundation topology passes", () => {
  const result = runFixture({
    "src/main.ts":
      'import { openDatabase } from "./infrastructure/database/connection.ts";\nvoid openDatabase;\n',
    "src/application.ts":
      'import { createHttpServer } from "./infrastructure/http/server.ts";\nvoid createHttpServer;\n',
    "src/config.ts": 'import { validate } from "./shared/validation.ts";\nvoid validate;\n',
    "src/domain/readiness.ts": "export interface Readiness { readonly ready: boolean; }\n",
    "src/shared/validation.ts": "export function validate(): void {}\n",
    "src/infrastructure/database/connection.ts":
      'import Database from "better-sqlite3";\nexport const openDatabase = () => new Database(":memory:");\nconst pragma = "PRAGMA foreign_keys = ON";\nvoid pragma;\n',
    "src/infrastructure/database/migrations.ts":
      'export const initialMigration = "CREATE TABLE schema_version (version INTEGER)";\n',
    "src/infrastructure/http/server.ts": "export function createHttpServer(): void {}\n",
    "src/features/example/repository.ts":
      'export const select = "SELECT version FROM schema_version";\n',
    "src/features/example/repositories/write.ts":
      'export const update = "UPDATE schema_version SET version = 1";\n',
    "public/dashboard.js": 'import "./config.ts";\nimport "../src/shared/errors.ts";\nexport {};\n',
    "public/config.ts": "export {};\n",
    "src/shared/errors.ts": "export {};\n",
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Architecture guardrails passed\./);
});

void test("allows a v2 module nested beneath a similarly named feature directory", () => {
  const result = runFixture({
    "src/runtime.ts": 'import "./features/brewStory/service.ts";\n',
    "src/features/brewStory/service.ts": "export {};\n",
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Architecture guardrails passed\./);
});

const previouslyOmittedLegacyBasenames = [
  "brewStory",
  "brewfatherCache",
  "brewfatherClient",
  "brewfatherSync",
  "db",
  "displayUpdateCoalescer",
  "draftHealth",
  "fillGraphic",
  "httpSecurity",
  "kegForecast",
  "kegLifecycle",
  "lifecycleExperience",
  "pourDetector",
  "sensoryEngine",
  "sensoryMappings",
  "sseHub",
  "tapboardEvents",
  "validation",
] as const;

for (const basename of previouslyOmittedLegacyBasenames) {
  void test(`rejects legacy v1 module basename ${basename} from a nested source path`, () => {
    const result = runFixture({
      "src/runtime.ts": `import "./renamed/location/${basename}.ts";\n`,
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[legacy-import\]/);
    assert.match(result.output, /src\/runtime\.ts/);
  });
}

const violations = [
  {
    name: "shadow runtime tree",
    rule: "shadow-runtime",
    path: "src/v2/main.ts",
    contents: "export {};\n",
  },
  {
    name: "legacy v1 import",
    rule: "legacy-import",
    path: "src/runtime.ts",
    contents: 'import "./server.js";\n',
  },
  {
    name: "extensionless legacy v1 import",
    rule: "legacy-import",
    path: "src/runtime.ts",
    contents: 'import "./haClient";\n',
  },
  {
    name: "integration import from domain",
    rule: "domain-integration",
    path: "src/domain/beverage.ts",
    contents: 'import "../integrations/brewfather/client.ts";\n',
  },
  {
    name: "infrastructure import from browser source",
    rule: "browser-server",
    path: "public/dashboard.js",
    contents: 'import "../src/infrastructure/database/connection.ts";\n',
  },
  {
    name: "application import from browser source",
    rule: "browser-server",
    path: "public/dashboard.js",
    contents: 'import "../src/application.ts";\n',
  },
  {
    name: "config import from browser source",
    rule: "browser-server",
    path: "public/dashboard.js",
    contents: 'import "../src/config.ts";\n',
  },
  {
    name: "raw SQL outside repository ownership",
    rule: "sql-ownership",
    path: "src/application/readiness.ts",
    contents: 'export const query = "SELECT version FROM schema_version";\n',
  },
  {
    name: "better-sqlite3 import outside connection ownership",
    rule: "sqlite-boundary",
    path: "src/application/database.ts",
    contents: 'import Database from "better-sqlite3";\nvoid Database;\n',
  },
  {
    name: "database construction outside connection ownership",
    rule: "sqlite-boundary",
    path: "src/application/database.ts",
    contents: 'export const database = new Database(":memory:");\n',
  },
  {
    name: "Activity importing the outbox",
    rule: "activity-outbox",
    path: "src/features/activity/operations.ts",
    contents: 'import { admit } from "../outbox/repository.ts";\nvoid admit;\n',
  },
  {
    name: "integration-secret encryption outside centralized ownership",
    rule: "secret-crypto",
    path: "src/features/integrations/credentials.ts",
    contents: 'import { createCipheriv } from "node:crypto";\nvoid createCipheriv;\n',
  },
] as const;

for (const violation of violations) {
  void test(`rejects ${violation.name}`, () => {
    const result = runFixture({ [violation.path]: violation.contents });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`\\[${violation.rule}\\]`));
    assert.match(result.output, new RegExp(violation.path.replaceAll("/", "\\/")));
  });
}
