# Tapboard architecture

## Implemented Foundation

Issue #66 establishes a Node 24 ESM modular monolith with explicit startup composition. Node executes erasable `.ts` files directly, while TypeScript performs static checking with `tsc --noEmit`. There is no transpiler, backend or application bundler, SPA/client framework, HTTP framework, ORM, query builder, dependency-injection framework, or global service locator.

The implemented source topology is intentionally concise:

- `src/application.ts` composes configuration, logging, one database connection, the Eta renderer, router, and HTTP server;
- `src/shared/` owns typed application errors, explicit validation primitives, and structured `debug`/`info`/`warn`/`error` logging with recursive secret-key redaction;
- `src/infrastructure/database/` is the only connection and migration boundary;
- `src/infrastructure/http/` owns the small exact-match router, centralized HTTP error mapping, and server lifecycle;
- `src/infrastructure/rendering/` owns the file-based Eta rendering boundary;
- `src/main.ts` is the deliberate process bootstrap and signal-handling entry point;
- `views/` contains only layout/partial/escaping proof templates, not a product page;
- `test/` covers the database, runtime, rendering, shared primitives, native TypeScript execution, and architecture boundaries.

Normal imports are side-effect free. The bootstrap in `src/main.ts` deliberately creates and starts the application. Dependencies are passed explicitly at composition boundaries so tests can exercise startup, failure, and shutdown behavior without introducing a service locator.

## Runtime and HTTP boundary

The application deterministically creates the database directory, opens and validates the database, creates the renderer, creates the HTTP server, and binds the configured address in that order. Startup and bind errors reject startup and close acquired resources. Shutdown stops HTTP acceptance and connections before closing SQLite, is idempotent, and enforces the configured bounded grace period. `SIGINT` and `SIGTERM` use that same shutdown path.

Exactly one route is registered: `GET /healthz`. When the local application state is ready and the database connection remains open, it returns HTTP 200 and schema version 1. It does not represent integrations, telemetry, Home Assistant, or future feature health. The small router also supplies deterministic 404/405 behavior, and centralized error mapping prevents unexpected implementation details from reaching HTTP clients.

## Rendering boundary

`src/infrastructure/rendering/renderer.ts` owns a file-based Eta instance with escaping enabled by default and a module-relative `views/` root. The proof templates exercise a layout, a partial, and escaped untrusted values. They establish the server-rendering seam only; no Admin or public dashboard page is implemented.

## SQLite boundary and schema

`src/infrastructure/database/connection.ts` is the sole `better-sqlite3` import and connection-construction boundary. It enables and verifies `foreign_keys=ON`, initializes and validates the schema, runs integrity checks, exposes a synchronous `BEGIN IMMEDIATE` transaction primitive, and provides idempotent close behavior. Raw application SQL is restricted to database infrastructure/migrations and future feature repository ownership by the architecture gate.

Foundation schema version 1 contains exactly one infrastructure table:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)
```

SQLite `user_version` is 1 and the migration machinery uses `schema_migrations` as its ordered history ledger, appending migration 1 as `foundation-schema`. Migration definitions must be contiguous from version 1 with nonempty unique names. A clean empty version-0 database migrates transactionally to version 1. A current version-1 database reopens only when its version, ledger, constraints, and exact schema object set match the supported baseline. Future versions, unknown nonempty version-0 databases, missing or inconsistent ledgers, and unexpected schema objects fail closed without adoption or repair. Failed migrations roll back schema changes, ledger changes, and `user_version`.

The exact-object validation is intentionally the Foundation version-1 baseline, not a claim that future domain tables are forbidden forever. Later migrations must deliberately extend the schema validator alongside their versioned schema changes. There is no v1 data migration, generic settings JSON, or Beverage, Keg, Fill, Tap, security, outbox, or telemetry table.

## Dependencies

The only production dependencies are:

- `better-sqlite3`, for the frozen synchronous SQLite connection and transaction model;
- `eta`, for the frozen file-based server-rendering boundary with safe escaping, layouts, and partials.

Development dependencies are TypeScript, `@types/node`, and `@types/better-sqlite3` for strict no-emit checking; ESLint, `@eslint/js`, and `typescript-eslint` for TypeScript-aware linting; and Prettier for deterministic formatting. No other runtime library or framework is introduced.

## Architecture enforcement

The canonical `npm run check` gate combines format, lint, type, architecture, reuse-manifest, and `node:test` validation. The architecture checker permits the legitimate Foundation package and source paths while rejecting legacy/v1 imports and paths, shadow v1/v2 runtime trees, integration-specific imports from domain locations, browser-to-server/infrastructure imports, raw SQL outside approved ownership, and any `better-sqlite3` construction outside the controlled connection module. Negative fixture tests prove these rules reject representative violations. Docker/Compose path bans remain active until issue #81 introduces the deployment topology.

## Not implemented

Foundation does not implement the work assigned to issue #67 or later: PIN authentication, sessions, CSRF, throttling, Activity Log, encrypted integration secrets, API keys, outbox/event delivery, domain entities or workflows, telemetry or pour detection, forecasting or draft health, Admin/public feature pages, SSE, Brew Story, Mystery Tap, Tap Wars, Home Assistant/webhooks, or final Docker deployment.

Playwright/browser E2E is also not present because Foundation has no feature UI or browser workflow. No E2E tests ran or passed; the tier is deferred to issue #76.

## Historical v1

The complete v1 implementation remains recoverable at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. The rebuild does not import it, maintain a shadow runtime tree, reproduce its schema, or introduce compatibility shims by default. The frozen reuse manifest governs any later reference to v1 evidence.
