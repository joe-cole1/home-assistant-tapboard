# Tapboard architecture

## Implemented Foundation, #67 primitives, #85 dev container, #68 Physical Kegs, #69 Custom/Brewfather Beverages, #70 Fills/On Deck, and #71 Taps/Assignment Lifecycles

Issue #66 establishes a Node 24 ESM modular monolith with explicit startup composition. Issue #67 adds security/session, Activity/deletion-audit, encrypted-secret, machine-key, stable-event, and bounded-outbox primitives. Issue #85 adds a development-only Docker image and Compose surface for local operation. Issue #68 adds Physical Kegs domain inventory and lifecycle management. Issue #69 adds Custom and Brewfather-linked Beverages, pure effective presentation resolution, 3-state presentation overrides, density resolution precedence, candidate cache, rate-limited Brewfather sync, atomic unlinking, and bounded recipe snapshots. Issue #70 adds physical Keg Fills, pure derived state resolution (`ended > on_tap > on_deck > available`), at-most-one active fill per keg via SQLite partial unique index (`idx_fills_active_keg`), explicit dense 1-indexed On Deck administrative ordering and unauthenticated public projection, atomic Kick Keg local transaction with assignment-close hook and failure rollback, post-commit Brewfather batch completion coordination (`never`, `ask`, `completed`) with terminal status short-circuiting and account-scoped adapter rate-limiting, and isolated last-fill beverage auto-deletion. Issue #71 adds physical Taps, monotonic `first_used_at` retention across fill kicks/deletions, retired tap status preserving number reservations and preventing new assignments, atomic Tap Assignment Lifecycles with partial unique indexes (`idx_tap_assignments_active_tap`, `idx_tap_assignments_active_fill`), on-deck clearance upon tap assignment, atomic fill moves with new UUID generation and rollback safety, occupied tap conflict guards, never-used-only tap deletion with deletion audit, synchronous `TapAssignmentExtensionPort` with `requiresFreshBaseline` signaling, concrete `FillAssignmentLifecyclePort` integration for `#70`, and authenticated admin and unauthenticated public tap projections (`GET /api/public/taps`). Node executes erasable `.ts` files directly, while TypeScript performs static checking with `tsc --noEmit`. There is no transpiler, backend or application bundler, SPA/client framework, HTTP framework, ORM, query builder, dependency-injection framework, or global service locator.

The implemented source topology is intentionally concise:

- `src/application.ts` composes configuration, logging, one database connection, the Eta renderer, router, and HTTP server;
- `src/shared/` owns typed application errors, explicit validation primitives, and structured `debug`/`info`/`warn`/`error` logging with recursive secret-key redaction;
- `src/infrastructure/database/` is the only connection and migration boundary;
- `src/infrastructure/http/` owns the small exact-match router, centralized HTTP error mapping, and server lifecycle;
- `src/infrastructure/rendering/` owns the file-based Eta rendering boundary;
- `src/main.ts` is the deliberate process bootstrap and signal-handling entry point;
- `src/operator/` owns stdin-only reset-PIN and root-key rotation commands;
- `src/features/auth/`, `activity/`, `events/`, `secrets/`, `machine-keys/`, `outbox/`, `kegs/`, `beverages/`, `fills/`, and `taps/` own typed feature primitives and repository SQL;
- `views/` contains only layout/partial/escaping proof templates, not a product page;
- `test/` covers the database, runtime, rendering, shared primitives, native TypeScript execution, and architecture boundaries.

Normal imports are side-effect free. The bootstrap in `src/main.ts` deliberately creates and starts the application. Dependencies are passed explicitly at composition boundaries so tests can exercise startup, failure, and shutdown behavior without introducing a service locator.

## Runtime and HTTP boundary

The application deterministically creates the database directory, opens and validates the database, creates the renderer, creates the HTTP server, and binds the configured address in that order. Startup and bind errors reject startup and close acquired resources. Shutdown stops HTTP acceptance and connections before closing SQLite, is idempotent, and enforces the configured bounded grace period. `SIGINT` and `SIGTERM` use that same shutdown path.

Routes registered include `GET /healthz` (returning HTTP 200 and schema version 6), unauthenticated public projections at `GET /api/on-deck` and `GET /api/public/taps`, and authenticated Admin endpoints under `/api/admin/kegs`, `/api/admin/beverages`, `/api/admin/fills`, and `/api/admin/taps`. The router supports exact and parameterized routes with deterministic 404/405 behavior, and centralized error mapping prevents unexpected implementation details from reaching HTTP clients.

The configured external origin is an exact canonical HTTP(S) origin; trusted proxies are explicit comma-separated addresses and never provide an origin fallback. Session lifetimes default to 30 days inactivity and 365 days absolute, with bounded validation. PIN reset and root-key rotation are local non-TTY stdin commands only; no browser reset flow or default PIN exists.

The PIN is exactly four ASCII decimal digits. Its deliberately small 10,000-value contract has limited offline resistance if a database verifier is stolen; scrypt, durable throttling, opaque digest-only sessions, expiry/revocation, strict Origin, and session-bound CSRF protect online/local use. Integration encryption is independent and uses externally supplied `TAPBOARD_SECRET_KEY` with AES-256-GCM, fresh nonces, identity-bound AAD, safe degraded status, and atomic all-row key rotation.

## Container and configuration boundaries (#85 support)

`Dockerfile.dev`, `Dockerfile.dev.dockerignore`, and `compose.dev.yaml` remain the only runnable container surface and form one coherent, development-only set. The image installs the locked dependencies, copies only the v2 `src/` and `views/` runtime inputs, runs as the unprivileged `node` user, and exposes port 3000. Compose binds host loopback `127.0.0.1:3000` to the container's `0.0.0.0:3000`, requires an external canonical 32-byte base64url `TAPBOARD_SECRET_KEY` from ignored local configuration, and checks the actual `/healthz` route. SQLite is `/app/data/tapboard-v2.sqlite3` on the named `tapboard-data` volume, materialized by Compose as `tapboard-dev_tapboard-data`; ordinary lifecycle operations preserve that volume. Stdin-only operator reset and root-key rotation run through the service and never accept secret arguments or defaults. `.env.example` is a v2-safe operator reference, not a secret-bearing runtime file. The exact top-level `compose.production.example.yaml` is a non-runnable illustrative exception with an unpublished placeholder image; it is not a production deployment or acceptance surface. All actual production Dockerfiles/Compose variants and production hardening remain rejected or deferred to issue #81.

## Rendering boundary

`src/infrastructure/rendering/renderer.ts` owns a file-based Eta instance with escaping enabled by default and a module-relative `views/` root. The proof templates exercise a layout, a partial, and escaped untrusted values. They establish the server-rendering seam only; no Admin or public dashboard page is implemented.

## SQLite boundary and schema

`src/infrastructure/database/connection.ts` is the sole `better-sqlite3` import and connection-construction boundary. It enables and verifies `foreign_keys=ON`, initializes and validates the schema, runs integrity checks, exposes a synchronous `BEGIN IMMEDIATE` transaction primitive, and provides idempotent close behavior. Raw application SQL is restricted to database infrastructure/migrations and future feature repository ownership by the architecture gate.

Schema version 6 contains the migration ledger plus typed security/session, encrypted-secret, machine-key, Activity, immutable deletion-audit, event, bounded-outbox, Physical Keg inventory tables (`kegs`, append-only `keg_tare_history`, and append-only `keg_maintenance_records`), Beverage domain tables (`beverage_settings`, `beverages`, `custom_beverage_profiles`, `custom_recipes`, `custom_recipe_ingredients`, `custom_recipe_steps`, `beverage_sensory_overrides`, `brewfather_accounts`, `brewfather_candidate_cache`, `brewfather_beverage_links`, `brewfather_source_profiles`, `brewfather_presentation_overrides`, and `beverage_source_recipe_snapshots`), Fill/On Deck domain tables (`fill_settings`, `fills`), and Tap domain tables (`taps`, `tap_assignment_lifecycles`). Activity is separate from runtime logs, has bounded retention, and never recursively admits outbox rows. Deletion audit stores minimal impact counts and remains immutable. The stable event registry is an explicit allowlist; durable envelopes are canonical, versioned, and provider-neutral.

Foundation schema version 1 contained exactly one infrastructure table:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)
```

SQLite `user_version` is 6 and the migration machinery uses `schema_migrations` as its ordered history ledger, appending migration 1 as `foundation-schema`, migration 2 as `security-activity-outbox-primitives`, migration 3 as `physical-kegs`, migration 4 as `custom-and-brewfather-beverages`, migration 5 as `fills-and-on-deck`, and migration 6 as `taps-and-assignment-lifecycles`. Migration definitions must be contiguous from version 1 with nonempty unique names. A clean empty version-0 database migrates transactionally through version 6. A current version-6 database reopens only when its version, ledger, constraints, and exact schema object set match the supported baseline. Future versions, unknown nonempty version-0 databases, missing or inconsistent ledgers, and unexpected schema objects fail closed without adoption or repair. Failed migrations roll back schema changes, ledger changes, and `user_version`.

The exact-object validation is intentionally the supported schema-version-6 baseline, not a claim that future domain tables are forbidden forever. Later migrations must deliberately extend the schema validator alongside their versioned schema changes. Outbox admission serializes inside `BEGIN IMMEDIATE`, counts persisted UTF-8 bytes, bounds global/per-destination rows and bytes, and records fixed-slot degradation when it returns `not_queued_capacity`. Leases and compare-and-set delivery results support later at-least-once workers without claiming exactly-once delivery; providers, workers, and domain producers are deferred.

## Dependencies

The only production dependencies are:

- `better-sqlite3`, for the frozen synchronous SQLite connection and transaction model;
- `eta`, for the frozen file-based server-rendering boundary with safe escaping, layouts, and partials.

Development dependencies are TypeScript, `@types/node`, and `@types/better-sqlite3` for strict no-emit checking; ESLint, `@eslint/js`, and `typescript-eslint` for TypeScript-aware linting; and Prettier for deterministic formatting. No other runtime library or framework is introduced.

## Architecture enforcement

The canonical `npm run check` gate combines format, lint, type, architecture, reuse-manifest, and `node:test` validation. The architecture checker permits the legitimate Foundation package and source paths, the exact coherent #85 development container set, the v2-safe `.env.example` reference, and only the exact non-runnable `compose.production.example.yaml` illustration. It rejects legacy/v1 imports and paths, shadow v1/v2 runtime trees, integration-specific imports from domain locations, browser-to-server/infrastructure imports, raw SQL outside approved ownership, and any `better-sqlite3` construction outside the controlled connection module. The production example must declare an `image:` and may not include `build:` or `Dockerfile.dev`; all other production Docker/Compose paths and variants remain banned until issue #81 introduces and hardens the production deployment topology. Negative fixture tests prove these rules reject representative violations.

## Not implemented

The #67/#85 slices intentionally do not implement provider delivery workers, Home Assistant/webhook adapters, domain entities/workflows, telemetry or pour detection, forecasting or draft health, Admin/public feature pages, SSE, Brew Story, Mystery Tap, Tap Wars, or production Docker hardening/deployment. Authentication/session, CSRF, throttling, Activity, encrypted secrets, machine API keys, canonical events, bounded outbox storage, and the local development container workflow are implemented boundaries; the `.env.example` reference and provisional production compose illustration do not change the runnable development-only container boundary, and production deployment remains deferred to issue #81.

Playwright/browser E2E is also not present because Foundation has no feature UI or browser workflow. No E2E tests ran or passed; the tier is deferred to issue #76.

## Historical v1

The complete v1 implementation remains recoverable at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. The rebuild does not import it, maintain a shadow runtime tree, reproduce its schema, or introduce compatibility shims by default. The frozen reuse manifest governs any later reference to v1 evidence.
