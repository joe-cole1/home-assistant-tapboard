# Rebuild architecture guardrails

## Active Foundation and deployment support gate

`scripts/check-architecture.sh` permits the legitimate package manifest and `src/` runtime introduced by issue #66, the exact coherent development container set introduced by #85, the default production Dockerfile/ignore pair restored for existing external Compose users, the v2-safe `.env.example` reference, and one exact non-runnable production compose illustration while enforcing topology- and content-aware boundaries:

- required authoritative rebuild records remain present;
- known v1 runtime, database, Home Assistant telemetry, backup, SPA, and deployment paths do not return;
- no top-level or active-source `v1`, `v2`, or `legacy` shadow runtime tree is introduced;
- application source does not import named legacy v1 runtime modules;
- core/domain locations do not import integration-specific modules;
- browser locations do not import server or infrastructure source;
- raw SQL is allowed only in `src/infrastructure/database/connection.ts`, `src/infrastructure/database/migrations.ts`, or a future feature-owned `repository.ts`/`repositories/*.ts`;
- `better-sqlite3` imports and database construction are allowed only in `src/infrastructure/database/connection.ts`;
- security and crypto ownership remains in `src/features/auth/`, `src/features/secrets/`, and `src/features/machine-keys/`; Activity and event primitives remain provider-neutral in their feature directories; raw SQL remains repository-owned (`src/features/*/repository.ts` or `repositories/*.ts`).
- the only runnable top-level development container paths are `Dockerfile.dev`, `Dockerfile.dev.dockerignore`, and `compose.dev.yaml`, and they must exist as one coherent set; an incomplete set reports `[development-container]`;
- the exact top-level `compose.production.example.yaml` is a provisional, non-runnable illustrative exception that must declare `image:` and must not contain `build:` or `Dockerfile.dev`; invalid content reports `[production-example]`;
- the exact production pair `Dockerfile` and `Dockerfile.dockerignore` must be coherent and content-checked: digest-pinned Node 24 stages, production-only installation, non-root v2 execution, narrow COPY inputs, health checks, and no secret defaults, legacy runtime, or backup/HA-telemetry configuration;
- every other top-level Dockerfile or `compose`/`docker-compose` YAML/YML variant reports `[deployment-scope]`; the check is top-level anchored and does not recurse into docs or fixtures. `.dockerignore` and `docker-compose.yml` retain their legacy-path bans. Broader #81 final acceptance remains deferred.

The gate reports the violated rule and path. `test/architecture.test.ts` uses isolated fixtures to cover the real production pair and unsafe/incomplete alternatives, the coherent development set, the environment reference, and the illustrative production example. Unapproved variants and legacy runtime paths remain rejected. Existing negative fixtures continue to prove rejection of shadow runtime trees, legacy imports, domain-to-integration imports, browser-to-server imports, SQL outside approved ownership, and SQLite access outside the controlled connection boundary. Legitimate Foundation topology still passes.

`scripts/check-reuse-manifest.py` remains dependency-free and enforces the exact immutable frozen v1 commit, manifest schema and classifications, required entry fields, unique entry IDs, and every source/test path's recorded Git blob. The architecture checker intentionally excludes `docs/` from legacy-name scans because the rebuild records and manifest must discuss v1 paths.

These checks preserve the clean rebuild boundary; they do not make v1 code an active dependency. A manifest classification of `reference` never authorizes an import. Raw-SQL keyword detection requires SQL whitespace/context, so JavaScript crypto or collection methods such as `.update()` are not mistaken for SQL.

## Canonical enforcement

`npm run check` is the canonical Foundation gate. It runs:

1. Prettier checking;
2. TypeScript-aware ESLint;
3. `tsc --noEmit`;
4. the architecture checker and reuse-manifest checker;
5. the `node:test` suite, including architecture negative fixtures.

The Foundation CI workflow uses Node 24, installs from the lockfile with `npm ci`, runs the same canonical gate, and checks changed-line whitespace. A pre-commit hook dependency is not part of Foundation; the local and CI gate is authoritative.

## #67 security and feature boundaries

The root secret is supplied only through canonical `TAPBOARD_SECRET_KEY` configuration or local stdin rotation; it is never logged, placed in command arguments, or exposed to browser code. Operator commands reject TTY input and positional secret arguments. PIN reset has no default and no HTTP route. Session, cookie, Origin, CSRF, Activity, deletion-audit, event registry, and bounded-outbox modules expose typed primitives only; there is no recursive Activity-to-outbox path.

The event registry is explicit and rejects provider-specific fields. Outbox capacity degradation reports `not_queued_capacity` and does not claim that an omitted event was queued. At-least-once durable rows are present, but delivery workers and provider adapters belong to later issues.

## Boundaries reserved for later phases

The default Dockerfile path is deliberately restored with v2 content checks; `.dockerignore`, `docker-compose.yml`, and unapproved top-level variants remain banned. The exact `compose.production.example.yaml` remains a non-runnable illustration. This repair does not complete #81, publish an image, add a new production Compose topology, reintroduce backup tooling, or migrate v1 data. The narrow `PORT`, `DATA_DIR`, and `TAPBOARD_PUBLIC_ORIGIN` config aliases are explicitly authorized deployment compatibility, not an import of old runtime behavior; removing them requires migration of supported external consumers and a breaking-change review.

Future issues may add domain, integration, browser, and feature-repository locations only within the frozen architecture. When a legitimate new topology or migration adds a boundary not represented here, that issue must deliberately update the focused allowlists and negative tests without weakening the legacy, layering, SQL-ownership, SQLite-connection, or reuse-manifest protections.

Playwright/browser E2E is intentionally absent in #66 because there is no feature UI or browser workflow. No E2E tests ran or passed; the browser E2E tier is deferred to issue #76.
