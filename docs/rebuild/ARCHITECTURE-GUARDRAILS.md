# Rebuild architecture guardrails

## Active Foundation, #67, and #85 support gate

`scripts/check-architecture.sh` now permits the legitimate package manifest and `src/` runtime introduced by issue #66, the exact coherent development-only container set introduced by #85, the v2-safe `.env.example` reference, and one exact non-runnable production compose illustration while enforcing topology- and content-aware boundaries:

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
- every other top-level Dockerfile or `compose`/`docker-compose` YAML/YML variant reports `[deployment-scope]`; the check is top-level anchored and does not recurse into docs or fixtures. Actual production Dockerfiles/Compose variants and #81 hardening remain rejected or deferred.

The gate reports the violated rule and path. `test/architecture.test.ts` uses isolated fixtures to prove that the exact coherent development set passes, `.env.example` is permitted, the exact production example passes with an image and no build, incomplete sets report `[development-container]`, canonical v1 container paths remain rejected, and representative unapproved variants report `[deployment-scope]`; focused production-example fixtures reject `build:` and `Dockerfile.dev` content with `[production-example]`. Its existing negative fixtures continue to prove rejection of shadow runtime trees, legacy imports, domain-to-integration imports, browser-to-server imports, SQL outside approved ownership, and SQLite access outside the controlled connection boundary. It also proves that the legitimate Foundation topology passes.

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

The exact known v1 Docker and Compose paths (`.dockerignore`, `Dockerfile`, and `docker-compose.yml`) remain banned, as do all unapproved top-level container variants. Issue #85's three development paths remain the only runnable container surface. The exact `compose.production.example.yaml` is a non-runnable illustrative exception only; issue #81 must add content-aware v2 production deployment checks in the same change that introduces actual approved production files, while continuing to reject legacy Node, backup-volume, Home Assistant telemetry, and unsafe secret-handling configuration.

Future issues may add domain, integration, browser, and feature-repository locations only within the frozen architecture. When a legitimate new topology or migration adds a boundary not represented here, that issue must deliberately update the focused allowlists and negative tests without weakening the legacy, layering, SQL-ownership, SQLite-connection, or reuse-manifest protections.

Playwright/browser E2E is intentionally absent in #66 because there is no feature UI or browser workflow. No E2E tests ran or passed; the browser E2E tier is deferred to issue #76.
