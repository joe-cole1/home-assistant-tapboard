# Tapboard architecture

## Implemented Foundation, #67 primitives, #85 dev container, #68–#73 domains, and #74 Pour History/Fill Forecasting

Issue #66 establishes a Node 24 ESM modular monolith with explicit startup composition. Issues #67–#72 add the security, inventory, beverage, Fill, Tap, and canonical telemetry ingestion boundaries described below. Issue #73 adds immutable telemetry epochs and provenance snapshots, durable deterministic per-Tap pour detection, minimal immutable pours, and administration for detector defaults, nullable per-Tap overrides, and explicit arbitration groups. Issue #74 retains those detector-owned pours as immutable Fill-scoped history and derives deterministic Fill forecasts. Node executes erasable `.ts` files directly, while TypeScript performs static checking with `tsc --noEmit`. There is no transpiler, backend or application bundler, SPA/client framework, HTTP framework, ORM, query builder, dependency-injection framework, or global service locator.

The implemented source topology is intentionally concise:

- `src/application.ts` composes configuration, logging, one database connection, the Eta renderer, router, and HTTP server;
- `src/shared/` owns typed application errors, explicit validation primitives, and structured `debug`/`info`/`warn`/`error` logging with recursive secret-key redaction;
- `src/infrastructure/database/` is the only connection and migration boundary;
- `src/infrastructure/http/` owns the small exact-match router, centralized HTTP error mapping, and server lifecycle;
- `src/infrastructure/rendering/` owns the file-based Eta rendering boundary;
- `src/main.ts` is the deliberate process bootstrap and signal-handling entry point;
- `src/operator/` owns stdin-only reset-PIN and root-key rotation commands;
- `src/features/auth/`, `activity/`, `events/`, `secrets/`, `machine-keys/`, `outbox/`, `kegs/`, `beverages/`, `fills/`, `taps/`, `telemetry/`, and `forecasting/` own typed feature primitives and repository SQL;
- `views/` contains only layout/partial/escaping proof templates, not a product page;
- `openapi/` contains the checked-in OpenAPI 3.1 telemetry ingestion contract;
- `test/` covers the database, runtime, rendering, shared primitives, native TypeScript execution, and architecture boundaries.

Normal imports are side-effect free. The bootstrap in `src/main.ts` deliberately creates and starts the application. Dependencies are passed explicitly at composition boundaries so tests can exercise startup, failure, and shutdown behavior without introducing a service locator.

## Runtime and HTTP boundary

The application deterministically creates the database directory, opens and validates the database, creates the renderer, creates the HTTP server, and binds the configured address in that order. Startup and bind errors reject startup and close acquired resources. Shutdown stops HTTP acceptance and connections before closing SQLite, is idempotent, and enforces the configured bounded grace period. `SIGINT` and `SIGTERM` use that same shutdown path.

Routes registered include `GET /healthz` (returning HTTP 200 and schema version 10), unauthenticated public projections at `GET /api/on-deck` and `GET /api/public/taps`, authenticated Admin endpoints under `/api/admin/kegs`, `/api/admin/beverages`, `/api/admin/fills`, `/api/admin/taps`, `/api/admin/telemetry`, and `/api/admin/forecast`, and authenticated external machine endpoints under `/api/v1/telemetry`. The router supports exact and parameterized routes with deterministic 404/405 behavior, and centralized error mapping prevents unexpected implementation details from reaching HTTP clients.

The configured external origin is an exact canonical HTTP(S) origin; trusted proxies are explicit comma-separated addresses and never provide an origin fallback. Session lifetimes default to 30 days inactivity and 365 days absolute, with bounded validation. PIN reset and root-key rotation are local non-TTY stdin commands only; no browser reset flow or default PIN exists.

The PIN is exactly four ASCII decimal digits. Its deliberately small 10,000-value contract has limited offline resistance if a database verifier is stolen; scrypt, durable throttling, opaque digest-only sessions, expiry/revocation, strict Origin, and session-bound CSRF protect online/local use. Integration encryption is independent and uses externally supplied `TAPBOARD_SECRET_KEY` with AES-256-GCM, fresh nonces, identity-bound AAD, safe degraded status, and atomic all-row key rotation.

## Container and configuration boundaries (#85 support)

`Dockerfile.dev`, `Dockerfile.dev.dockerignore`, and `compose.dev.yaml` remain the only runnable container surface and form one coherent, development-only set. The image installs the locked dependencies, copies only the v2 `src/` and `views/` runtime inputs, runs as the unprivileged `node` user, and exposes port 3000. Compose binds host loopback `127.0.0.1:3000` to the container's `0.0.0.0:3000`, requires an external canonical 32-byte base64url `TAPBOARD_SECRET_KEY` from ignored local configuration, and checks the actual `/healthz` route. SQLite is `/app/data/tapboard-v2.sqlite3` on the named `tapboard-data` volume, materialized by Compose as `tapboard-dev_tapboard-data`; ordinary lifecycle operations preserve that volume. Stdin-only operator reset and root-key rotation run through the service and never accept secret arguments or defaults. `.env.example` is a v2-safe operator reference, not a secret-bearing runtime file. The exact top-level `compose.production.example.yaml` is a non-runnable illustrative exception with an unpublished placeholder image; it is not a production deployment or acceptance surface. All actual production Dockerfiles/Compose variants and production hardening remain rejected or deferred to issue #81.

## Rendering boundary

`src/infrastructure/rendering/renderer.ts` owns a file-based Eta instance with escaping enabled by default and a module-relative `views/` root. The proof templates exercise a layout, a partial, and escaped untrusted values. They establish the server-rendering seam only; no Admin or public dashboard page is implemented.

## SQLite boundary and schema

`src/infrastructure/database/connection.ts` is the sole `better-sqlite3` import and connection-construction boundary. It enables and verifies `foreign_keys=ON`, initializes and validates the schema, runs integrity checks, exposes a synchronous `BEGIN IMMEDIATE` transaction primitive, and provides idempotent close behavior. Raw application SQL is restricted to database infrastructure/migrations and future feature repository ownership by the architecture gate.

Schema version 9 adds detector defaults and nullable per-Tap overrides, explicit arbitration groups, immutable `telemetry_epochs` provenance snapshots, mutable durable epoch runtime state, bounded detector samples, and immutable minimal `pours`. Schema version 10 adds the singleton `forecast_settings` row and Fill-history indexes; it leaves detector-owned pours unchanged. Each Tap has at most one open epoch and a closed epoch cannot reopen. Activity is separate from runtime logs, has bounded retention, and never recursively admits outbox rows. Deletion audit stores minimal impact counts and remains immutable.

Foundation schema version 1 contained exactly one infrastructure table:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
)
```

SQLite `user_version` is 10 and the migration machinery uses `schema_migrations` as its ordered history ledger, appending migration 10 as `pour-history-forecasting`. Migration definitions are contiguous from version 1 with nonempty unique names. A clean empty version-0 database migrates transactionally through version 10; current databases reopen only when version, ledger, constraints, required singleton state, and exact schema object set match the supported baseline. Future versions, unknown nonempty version-0 databases, missing or inconsistent ledgers, and unexpected schema objects fail closed without adoption or repair. Failed migrations roll back schema changes, ledger changes, and `user_version`.

The exact-object validation is intentionally the supported schema-version-10 baseline, not a claim that future domain tables are forbidden forever. Later migrations must deliberately extend the schema validator alongside their versioned schema changes. Outbox admission serializes inside `BEGIN IMMEDIATE`, counts persisted UTF-8 bytes, bounds global/per-destination rows and bytes, and records fixed-slot degradation when it returns `not_queued_capacity`. Providers and workers remain deferred.

## Telemetry ingestion boundary (#72)

Telemetry sources reuse the existing `machine_api_keys` primitive, but a Telemetry Source identity is distinct from its current MachineKey credential. The `telemetry_sources` row owns the stable source UUID and points to the current credential; source creation and rotation return a strong Bearer token only once, while list/get responses expose only key metadata. Rotation revokes the old credential and preserves the source UUID, source-scoped idempotency namespace, source-scoped rate-limit identity, and Tap authority. A valid generic MachineKey that is not currently bound to a Telemetry Source cannot authenticate telemetry.

Each Tap has zero or one authoritative source, enforced by the Tap-keyed `tap_telemetry_authority` table; there is no automatic failover. Disabled Taps continue to accept telemetry, while retired Taps reject it with a durable rejection and do not advance status or `first_used_at`. Assigning, clearing, or changing the actual source invokes the synchronous `TelemetryAuthorityExtensionPort` inside the database transaction with `requiresFreshBaseline: true`; assigning the same source again is a no-op. Credential rotation is not an authority change. Source creation/rename/rotation, authority changes, and settings changes use existing Activity audit patterns. Ordinary telemetry—accepted, duplicate, conflict, rejected, rate-limited, or status-only—creates no Activity or outbox row.

The machine-facing v1 contract is documented in [`openapi/telemetry-v1.json`](openapi/telemetry-v1.json) and exposes only `POST /api/v1/telemetry/taps/:tapNumber` and `POST /api/v1/telemetry/batch`. It requires `Authorization: Bearer <telemetry-source-key>`; browser cookies, query-string keys, and Admin authentication are not alternatives, and machine requests do not use browser CSRF. The external JSON contract is strict snake_case with exactly one primary `measurement` (`total_weight`, `remaining_volume`, or `fill_percentage`), required `measured_at`, optional `client_sample_id`, and optional `temperature`; batch items carry `tap_number`. Unknown fields, malformed JSON, unsupported shapes, or invalid timestamps are rejected before ingestion. Single and batch bodies are capped at 16 KiB and 256 KiB respectively, and batches contain 1–100 samples. Single responses use 200 for accepted/duplicate outcomes, 409 for durable rejected outcomes, 429 for a rate-limited new sample, 400 for structural errors, 401 for missing/invalid credentials, 404 for an unknown Tap, and 413 for an oversized body; batch item outcomes are returned in HTTP 200 after structural preflight.

Normalization version 1 accepts mass (`g`, `kg`, `oz`, `lb`) and stores grams, volume (`ml`, `l`, `us_fl_oz`, `us_gal`) and stores milliliters, temperature (`c`, `f`) and stores Celsius, and percentage (`percent`) and stores percent. Canonical values are rounded to six decimal places. `measured_at` must use strict RFC3339 with an explicit uppercase `Z` or `+/-HH:MM` offset and is stored as both UTC ISO-8601 milliseconds and epoch milliseconds. The semantic SHA-256 digest is computed from canonical JSON containing normalization version, immutable Tap UUID, canonical measured-at epoch milliseconds, primary kind/value, and optional canonical temperature; transport details such as Authorization, credential ID, Tap number, raw unit spelling, JSON property order, batch position, and `client_sample_id` are excluded.

Durable receipts are the idempotency source of truth. When present, identity is `(source_id, client_sample_id)` and is source-scoped even if a retry names another Tap; otherwise it is `(source_id, tap_id, measured_at_epoch_ms)`. SQLite partial unique indexes are the race backstop. Receipt lookup occurs before the in-memory token bucket, whose key is the stable source ID: an existing same-digest receipt returns its original accepted/rejected outcome with `duplicate: true` and no side effects, an existing different digest returns a conflict with no effects, and only a new identity consumes sample-rate capacity. Structural failures that cannot establish a canonical identity do not create receipts. Operational outcomes such as non-authority, retired, future, stale, and out-of-order are durable and replay the same rejection; rate-limit responses are deliberately non-durable.

New samples are processed in a synchronous `BEGIN IMMEDIATE` transaction. The transaction rechecks receipt and authority, rejects retired/future/stale/out-of-order samples, and requires a new measured-at timestamp to be strictly greater than the per-`(source_id, tap_id)` status watermark. That watermark is retained for each source/Tap pair across authority changes, so changing back to an earlier source cannot reopen older timestamps. An accepted sample stores the canonical measurement, advances latest source/Tap hardware status with a monotonic guard, registers Tap `first_used_at` using received time (not measurement time), captures only the currently open assignment when `measured_at >= assigned_at`, invokes `AcceptedTelemetryExtensionPort`, and finalizes the accepted receipt last. A delayed sample before the current assignment remains unassigned; an accepted sample with no Fill remains stored with null assignment/Fill and does not become a future baseline automatically. Extension failure rolls back the durable accepted writes. The `telemetry_measurements` raw rows and `telemetry_ingest_receipts` are pruned separately using the settings horizons (defaults six hours and 24 hours), in deterministic batches of at most 500 rows per table; raw rows are pruned first, while status, authority, and Tap `first_used_at` survive.

Batch ingestion performs structural validation, normalization, Tap resolution, identity construction, and digest computation for every item before effects. Equal identities with equal digests are coalesced into one pipeline operation and mirror duplicate results; equal identities with different digests are all conflicts with no effects. Remaining representatives run in deterministic `(measured_at_epoch_ms, tap UUID, identity key, digest)` order and results map back to original indexes. Both single and batch ingestion use the same acceptance pipeline.

## Telemetry epochs and deterministic pour detection (#73)

An assignment opens an immutable interpretation epoch that snapshots Tap/source/Fill/assignment, Keg capacity and tare, effective density and its provenance source, normalization version, effective detector configuration and content-hash version, and arbitration membership. Assignment, move, unassign, Kick, source, capacity, tare, effective-density, effective-config, arbitration, and manual-rebaseline transitions close the old epoch exactly once; an eligible fresh sample must establish a new settled baseline, and historical samples are never reused. Manual rebaseline preserves the current assignment but opens a fresh epoch and awaits that new eligible sample. Density changes use numeric effective-density equality to avoid churn; changed provenance is snapped only on future epochs.

Canonical accepted telemetry is interpreted through the epoch snapshot, stabilized, and then projected as public-safe clamped volume; diagnostic actuals remain available separately. Implausible upward jumps enter a durable warning path rather than being treated as refills. Per-Tap/epoch detector state, candidate/arbitration/quiet/timeout deadlines, and recovery are timestamp-driven and durable across restart. Taps operate independently; cross-Tap arbitration applies only to explicitly configured groups. At the earliest due logical deadline in a group, only candidates that had already started participate; stable loss/start/Tap ordering resolves ties, and an already-pouring member suppresses a later due candidate.

Detector configuration has persisted global defaults plus nullable per-Tap field overrides; the effective ordered content is hashed and snapshotted by epoch. Completed pours capture only immutable Fill/Tap/assignment/epoch/session, canonical volume, and timestamps. A deterministic terminal `effect_key` makes completion idempotent across retries, batches, restart recovery, and replay. Detector effects run in the accepted-ingestion transaction; the #72 receipt is finalized last, so extension failure rolls back both detector work and accepted telemetry. No outbound worker is introduced.

## Pour history and Fill forecasting (#74)

Forecasting reads completed immutable pours by Fill, including history from each Tap assignment and move; another Fill's pours never contribute. The observation range starts at the Fill's first assignment, and daily UTC buckets include the current `completed_at` day and its zero-consumption days. The current-volume input is the actual stabilized volume of the current open epoch with that epoch's capacity snapshot, rather than a reconstructed historical estimate.

A Fill requires at least 14 observation days and three qualifying pours for the sufficient-history method. It uses a deterministic SHA-256-seeded, 512-sample, seven-day circular moving-block bootstrap. Insufficient history uses the exact 24 oz per four-day fallback: 177.441177375 mL/day median, bounded by 88.7205886875 and 354.88235475 mL/day; method identifiers and bootstrap seeding remain stable. Confidence is low for fallback, stale, or anomaly results, medium for sufficient history, and high only with at least 28 days and eight qualifying pours.

Forecasting fails closed for a waiting/currently unassigned Fill, an ended Fill, unavailable or invalid current volume, and capacity inconsistencies. Invalid, future, or pre-observation pours are excluded from consumption math, recorded as anomaly evidence, and lower confidence. The singleton serving-size setting defaults to 354.88235475 mL, using v1's 12 oz evidence; servings remaining is the conservative whole-serving floor. Authenticated Admin routes provide Fill pour history and forecasts plus forecast settings. The server has a deliberately whitelisted public-safe forecast projection for future use, but #74 registers no public forecast endpoint and does not expose raw telemetry time series, forecast snapshots, health, SSE, Home Assistant, or Tap Planning.

## Dependencies

The only production dependencies are:

- `better-sqlite3`, for the frozen synchronous SQLite connection and transaction model;
- `eta`, for the frozen file-based server-rendering boundary with safe escaping, layouts, and partials.

Development dependencies are TypeScript, `@types/node`, and `@types/better-sqlite3` for strict no-emit checking; ESLint, `@eslint/js`, and `typescript-eslint` for TypeScript-aware linting; and Prettier for deterministic formatting. No other runtime library or framework is introduced.

## Architecture enforcement

The canonical `npm run check` gate combines format, lint, type, architecture, reuse-manifest, and `node:test` validation. The architecture checker permits the legitimate Foundation package and source paths, the exact coherent #85 development container set, the v2-safe `.env.example` reference, and only the exact non-runnable `compose.production.example.yaml` illustration. It rejects legacy/v1 imports and paths, shadow v1/v2 runtime trees, integration-specific imports from domain locations, browser-to-server/infrastructure imports, raw SQL outside approved ownership, and any `better-sqlite3` construction outside the controlled connection module. The production example must declare an `image:` and may not include `build:` or `Dockerfile.dev`; all other production Docker/Compose paths and variants remain banned until issue #81 introduces and hardens the production deployment topology. Negative fixture tests prove these rules reject representative violations.

## Not implemented

The implemented slices intentionally do not implement provider delivery workers, Home Assistant/webhook adapters, draft health and Tap maintenance (#75), Admin/public feature pages, SSE, Brew Story, Mystery Tap, Tap Wars, or production Docker hardening/deployment. The `.env.example` reference and provisional production compose illustration do not change the runnable development-only container boundary, and production deployment remains deferred to issue #81.

Playwright/browser E2E is also not present because Foundation has no feature UI or browser workflow. No E2E tests ran or passed; the tier is deferred to issue #76.

## Historical v1

The complete v1 implementation remains recoverable at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. The rebuild does not import it, maintain a shadow runtime tree, reproduce its schema, or introduce compatibility shims by default. The frozen reuse manifest governs any later reference to v1 evidence.
