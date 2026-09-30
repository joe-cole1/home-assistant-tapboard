import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("../scripts/check-architecture.sh", import.meta.url));
const repositoryRoot = dirname(dirname(checker));
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

void test("the production container smoke script and fixture are syntactically valid", () => {
  execFileSync("bash", ["-n", join(repositoryRoot, "scripts/check-production-container.sh")]);
  execFileSync(process.execPath, [
    "--check",
    join(repositoryRoot, "test/fixtures/production-container-smoke.mjs"),
  ]);
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

void test("allows the exact coherent development container set", () => {
  const result = runFixture({
    "Dockerfile.dev": "FROM node:24-bookworm-slim\n",
    "Dockerfile.dev.dockerignore": "node_modules\n",
    "compose.dev.yaml": "services:\n  tapboard:\n    build: .\n",
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Architecture guardrails passed\./);
});

const productionDockerfile = readFileSync(join(repositoryRoot, "Dockerfile"), "utf8");
const productionDockerignore = readFileSync(
  join(repositoryRoot, "Dockerfile.dockerignore"),
  "utf8",
);
const productionCompose = readFileSync(
  join(repositoryRoot, "compose.production.example.yaml"),
  "utf8",
);

void test("allows the real coherent production Dockerfile and build-context policy", () => {
  const result = runFixture({
    Dockerfile: readFileSync(join(repositoryRoot, "Dockerfile"), "utf8"),
    "Dockerfile.dockerignore": readFileSync(
      join(repositoryRoot, "Dockerfile.dockerignore"),
      "utf8",
    ),
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Architecture guardrails passed\./);
});

void test("rejects an incomplete production Dockerfile pair", () => {
  const result = runFixture({
    Dockerfile: readFileSync(join(repositoryRoot, "Dockerfile"), "utf8"),
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /\[production-container\]/);
  assert.match(result.output, /coherent set/);
});

void test("rejects a production build-context policy without its Dockerfile", () => {
  const result = runFixture({ "Dockerfile.dockerignore": productionDockerignore });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /\[production-container\]/);
  assert.match(result.output, /coherent set/);
});

for (const [name, mutate] of [
  [
    "legacy Node runtime",
    (contents: string) => contents.replaceAll("node:24-bookworm-slim", "node:22-bookworm-slim"),
  ],
  [
    "legacy entrypoint",
    (contents: string) => `${contents}\nENTRYPOINT ["node", "src/server.js"]\n`,
  ],
  ["root runtime user", (contents: string) => `${contents}\nUSER root\n`],
  [
    "copy-all context",
    (contents: string) => contents.replace("COPY --chown=node:node src/ ./src/", "COPY . ."),
  ],
  [
    "copy secret file",
    (contents: string) =>
      contents.replace("COPY --chown=node:node src/ ./src/", "COPY .env ./src/.env"),
  ],
  [
    "secret build argument",
    (contents: string) => `${contents}\nARG TAPBOARD_SECRET_KEY=not-a-secret\n`,
  ],
  [
    "secret continuation environment",
    (contents: string) =>
      `${contents}\nENV NODE_ENV=production \\\n    TAPBOARD_SECRET_KEY=not-a-secret\n`,
  ],
  ["backup path", (contents: string) => `${contents}\nENV BACKUP_DIR=/app/backups\n`],
] as const) {
  void test(`rejects production Dockerfile with ${name}`, () => {
    const result = runFixture({
      Dockerfile: mutate(productionDockerfile),
      "Dockerfile.dockerignore": productionDockerignore,
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[production-container\]/);
  });
}

for (const [name, mutate] of [
  ["root .env allowlist", (contents: string) => `${contents}\n!.env\n`],
  ["nested .env allowlist", (contents: string) => `${contents}\n!src/.env\n`],
  ["allowlist after final exclusions", (contents: string) => `${contents}\n!src/**\n`],
] as const) {
  void test(`rejects Dockerfile.dockerignore with ${name}`, () => {
    const result = runFixture({
      Dockerfile: productionDockerfile,
      "Dockerfile.dockerignore": mutate(productionDockerignore),
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[production-container\]/);
  });
}

void test("allows the environment reference and runnable hardened production example", () => {
  const result = runFixture({
    Dockerfile: productionDockerfile,
    "Dockerfile.dockerignore": productionDockerignore,
    ".env.example": "TAPBOARD_HOST=127.0.0.1\n",
    "compose.production.example.yaml": productionCompose,
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Architecture guardrails passed\./);
});

void test("production example requires its production Dockerfile pair", () => {
  const result = runFixture({ "compose.production.example.yaml": productionCompose });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /\[production-example\]/);
  assert.match(result.output, /coherent production Dockerfile pair/);
});

void test("production example permits comments and blank lines without changing content", () => {
  const result = runFixture({
    Dockerfile: productionDockerfile,
    "Dockerfile.dockerignore": productionDockerignore,
    "compose.production.example.yaml": `# Operator guidance\n\n${productionCompose}\n`,
  });

  assert.equal(result.status, 0, result.output);
});

for (const [name, mutate] of [
  [
    "placeholder image",
    (contents: string) =>
      contents.replace("${TAPBOARD_IMAGE:-tapboard:local}", "example.invalid/tapboard:placeholder"),
  ],
  [
    "development Dockerfile",
    (contents: string) => contents.replace("dockerfile: Dockerfile", "dockerfile: Dockerfile.dev"),
  ],
  ["remote build context", (contents: string) => contents.replace("context: .", "context: /tmp")],
  ["root runtime user", (contents: string) => contents.replace('user: "1000:1000"', 'user: "0:0"')],
  [
    "writable root filesystem",
    (contents: string) => contents.replace("read_only: true", "read_only: false"),
  ],
  [
    "duplicate writable root override",
    (contents: string) =>
      contents.replace("read_only: true", "read_only: true\n    read_only: false"),
  ],
  [
    "hardening present only in comments",
    (contents: string) => contents.replace("    read_only: true", "    # read_only: true"),
  ],
  ["executable tmpfs", (contents: string) => contents.replace("rw,noexec,nosuid", "rw,exec,suid")],
  ["unbounded tmpfs", (contents: string) => contents.replace("size=16m", "size=1g")],
  [
    "retained capabilities",
    (contents: string) => contents.replace("      - ALL", "      - NET_RAW"),
  ],
  [
    "new privileges",
    (contents: string) => contents.replace("no-new-privileges:true", "no-new-privileges:false"),
  ],
  [
    "privileged mode",
    (contents: string) => contents.replace("    init: true", "    privileged: true"),
  ],
  ["missing init", (contents: string) => contents.replace("    init: true", "    init: false")],
  [
    "hard kill",
    (contents: string) => contents.replace("stop_signal: SIGTERM", "stop_signal: SIGKILL"),
  ],
  [
    "short shutdown timeout",
    (contents: string) => contents.replace("stop_grace_period: 15s", "stop_grace_period: 1s"),
  ],
  [
    "v1 database",
    (contents: string) => contents.replace("tapboard-v2.sqlite3", "tapboard.sqlite3"),
  ],
  [
    "extra backup mount",
    (contents: string) =>
      contents.replace(
        "      - tapboard-data:/app/data",
        "      - tapboard-data:/app/data\n      - ./backups:/app/backups",
      ),
  ],
  [
    "host networking",
    (contents: string) =>
      contents.replace(
        "    restart: unless-stopped",
        "    network_mode: host\n    restart: unless-stopped",
      ),
  ],
  [
    "public bind default",
    (contents: string) =>
      contents.replace(
        "${TAPBOARD_PUBLISH_ADDRESS:-127.0.0.1}",
        "${TAPBOARD_PUBLISH_ADDRESS:-0.0.0.0}",
      ),
  ],
  [
    "legacy health port",
    (contents: string) =>
      contents.replace("http://127.0.0.1:3005/healthz", "http://127.0.0.1:3000/healthz"),
  ],
  [
    "secret environment default",
    (contents: string) =>
      contents.replace(
        "      NODE_ENV: production",
        "      NODE_ENV: production\n      TAPBOARD_SECRET_KEY: placeholder",
      ),
  ],
  [
    "missing canonical public origin",
    (contents: string) =>
      contents.replace(
        "      TAPBOARD_EXTERNAL_ORIGIN: ${TAPBOARD_EXTERNAL_ORIGIN:-http://127.0.0.1:3005}\n",
        "",
      ),
  ],
  [
    "required operator environment file",
    (contents: string) => contents.replace("required: false", "required: true"),
  ],
] as const) {
  void test(`rejects the production example with ${name}`, () => {
    const result = runFixture({
      Dockerfile: productionDockerfile,
      "Dockerfile.dockerignore": productionDockerignore,
      "compose.production.example.yaml": mutate(productionCompose),
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /\[production-example\]/);
    assert.match(result.output, /compose\.production\.example\.yaml/);
  });
}

void test("rejects an incomplete development container set", () => {
  const result = runFixture({
    "Dockerfile.dev": "FROM node:24-bookworm-slim\n",
    "compose.dev.yaml": "services:\n  tapboard:\n    build: .\n",
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /\[development-container\]/);
});

for (const path of [".dockerignore", "docker-compose.yml"] as const) {
  void test(`continues rejecting canonical v1 container path ${path}`, () => {
    const result = runFixture({ [path]: "legacy\n" });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /legacy v1 path is active/);
  });
}

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
  {
    name: "unapproved top-level Dockerfile variant",
    rule: "deployment-scope",
    path: "Dockerfile.prod",
    contents: "FROM node:24-bookworm-slim\n",
  },
  {
    name: "unapproved top-level Compose variant",
    rule: "deployment-scope",
    path: "compose.prod.yaml",
    contents: "services:\n  tapboard:\n    build: .\n",
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
