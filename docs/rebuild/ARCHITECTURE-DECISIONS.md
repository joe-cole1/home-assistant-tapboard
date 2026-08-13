# Tapboard Rebuild Architecture Decisions

## Status

This document records the intended architecture for the Tapboard rebuild.

These are approved target decisions, not casual suggestions.

Codex may challenge a decision when repository evidence, correctness, security, or current best practice provides a concrete reason, but it must:

1. identify the decision being challenged;
2. explain the problem;
3. propose an alternative;
4. stop for approval rather than silently deviating.

---

# 1. Rebuild Strategy

Tapboard v2 is a **clean rebuild**, not an in-place architectural refactor.

The existing v1 implementation is frozen and is used only as:

* behavioral reference
* algorithm reference
* asset source
* test evidence
* implementation research

v1 is not an architectural dependency of v2.

The new application must not import legacy modules merely to accelerate implementation.

---

# 2. Repository Strategy

Use the existing repository.

Work on a dedicated rearchitecture branch.

Keep `main` as the frozen v1 reference while the rebuild proceeds.

Before implementation:

1. inventory v1;
2. classify reusable code/assets/tests;
3. approve the architecture;
4. remove obsolete v1 application code from the rebuild branch;
5. port only explicitly selected reusable material.

Old code remains available through:

* `main`
* Git history
* `git show`
* targeted comparison

Do not keep permanent parallel `/v1` and `/v2` application trees.

---

# 3. Application Shape

Tapboard remains a **modular monolith**.

One deployable Node application owns:

* public HTTP rendering
* Admin rendering
* HTTP APIs
* SQLite
* SSE
* telemetry ingestion
* pour detection
* forecasts
* health
* Brewfather synchronization
* outbound integrations
* lightweight background jobs

Do not split into microservices without a concrete architectural need.

---

# 4. Runtime

Target:

**Node 24 LTS**

The architecture analysis may recommend a newer production LTS only if one is appropriate at implementation time and the change is justified.

---

# 5. Backend Language

Use **native TypeScript** for backend/domain code.

Requirements:

* direct Node execution using erasable TypeScript syntax
* `tsc --noEmit` for static type checking
* no Babel
* no ts-node requirement
* no backend bundler
* avoid TypeScript syntax requiring transformation
* configure TypeScript for native Node type stripping

Use types aggressively at important boundaries:

* domain objects
* use-case inputs/results
* repository results
* telemetry payloads
* canonical units
* integration adapters
* events
* public/admin DTOs

Browser code remains plain modern JavaScript unless later evidence justifies changing it.

---

# 6. Frontend Technology

Use:

* semantic HTML
* plain CSS
* native browser ES modules
* small page-specific JavaScript

Do not introduce React, Vue, Svelte, Tailwind, Bootstrap, CSS-in-JS, or a bundler merely because the project is large.

Dependencies must solve demonstrated problems.

---

# 7. Server Rendering

Admin pages and the initial public dashboard should be server-rendered.

Use one lightweight mature template engine rather than inventing a home-grown templating framework.

**Eta is the preferred candidate.**

Codex may recommend another lightweight maintained engine only if repository/current-tooling evidence provides a compelling reason.

Requirements:

* automatic HTML escaping by default
* file-based templates
* shared layouts
* reusable partials/components
* presentation separated from route/business logic
* no giant HTML template strings inside route modules

---

# 8. Public Rendering

The public dashboard should render authoritative initial state in the server response.

After paint:

* browser establishes SSE
* SSE applies targeted incremental updates

The browser should not need to construct the entire dashboard from a blank shell after fetching a giant state object.

---

# 9. Admin Rendering

Admin consists of real routes/pages.

Server-rendered pages use progressive enhancement.

Forms should remain understandable as normal HTTP workflows.

JavaScript enhances them with:

* live saving
* inline validation
* confirmations
* drag/reorder
* targeted updates
* SSE synchronization

Do not build a hidden SPA architecture.

---

# 10. Browser JavaScript Structure

Use page-specific entry modules plus genuinely reusable browser modules.

Example shape:

```text
public/
  dashboard.js

admin/
  overview.js
  integrations.js
  beverages.js
  kegs.js
  fills.js
  taps.js
  tap-wars.js
  display.js
  system.js

shared/
  sse.js
  http.js
  forms.js
  dialogs.js
  formatting.js
```

Exact paths are Codex's decision after repository analysis.

No single giant `app.js`.

---

# 11. Source Organization

Organize backend code primarily by **domain/feature**, not exclusively by technical layer.

Conceptual features include:

* beverages
* kegs
* fills
* taps
* tapWars
* telemetry
* health
* integrations
* display
* auth
* activity

Each feature should own relevant:

* types
* validation
* repositories
* domain helpers
* use cases
* HTTP/view code where appropriate
* tests

Shared infrastructure contains only truly cross-cutting concerns.

---

# 12. Shared Infrastructure

Potential shared infrastructure includes:

* SQLite connection/transactions
* HTTP server/router primitives
* authentication/session middleware
* CSRF
* SSE hub
* domain event dispatcher
* transactional outbox
* encryption/secrets service
* units/conversions
* structured logging
* common validation primitives
* application composition/bootstrap

Avoid giant shared utility modules.

---

# 13. Domain Style

Prefer:

**plain typed data + pure domain functions**

Examples:

* `canAssignFillToTap(...)`
* `calculateRemainingVolume(...)`
* `effectiveBeverageMetadata(...)`
* `isFillActive(...)`

Avoid unnecessary rich mutable domain classes.

Avoid direct procedural manipulation of raw database rows throughout the application.

---

# 14. Application / Use-Case Layer

Cross-domain operations belong in explicit use-case/application functions.

Example:

`assignFillToTap(...)`

A use case:

1. validates business rules;
2. opens one SQLite transaction where needed;
3. coordinates feature repositories/domain helpers;
4. commits domain state atomically;
5. emits post-commit local events;
6. persists any required external event to the transactional outbox.

HTTP routes must not orchestrate complex business workflows.

---

# 15. Dependency Injection

Use explicit dependency passing during application composition/startup.

Construct:

* DB
* repositories
* secrets service
* event dispatcher
* outbox
* integration adapters
* use cases
* HTTP routes
* background jobs

Pass dependencies explicitly.

Do not use:

* global service locator
* giant application context imported everywhere
* dependency-injection framework

---

# 16. SQLite

Use SQLite as Tapboard's durable system of record.

Keep `better-sqlite3` unless the architecture analysis produces a compelling current reason to change.

Do not change database drivers merely for novelty or dependency count.

Enable and enforce foreign keys.

Use transactions for cross-record invariants.

WAL may be used where appropriate.

---

# 17. Schema Strategy

Start with a clean new schema baseline.

Do not extend or migrate the v1 schema.

After the new baseline:

* use ordered schema migrations
* validate schema version at startup
* reject future/unsupported schema versions
* apply migrations transactionally where SQLite permits

Backward compatibility with the v1 DB is not required.

---

# 18. Schema Design

Normalize core Tapboard-owned domain data.

Use:

* proper foreign keys
* uniqueness constraints
* check constraints where useful
* typed columns
* derived state where possible

Avoid:

* giant generic settings tables as the default
* duplicated status columns that can drift from relationships
* arbitrary JSON blobs for core domain truth

Denormalize only for demonstrated read/performance reasons.

---

# 19. Feature-Owned Repositories

SQL belongs in feature-owned repositories.

Examples:

```text
beverages/repository.ts
fills/repository.ts
taps/repository.ts
```

Business logic and HTTP code should not embed raw SQL.

Cross-domain use cases may coordinate multiple repositories inside one transaction.

Do not add an ORM/query builder unless Codex can demonstrate a meaningful benefit that earns the dependency and abstraction.

---

# 20. Brewfather Storage Exception

External source snapshots are an intentional exception to the "avoid JSON blobs" rule.

For Brewfather:

* Tapboard-owned state remains normalized
* integration metadata gets typed columns
* sanitized source batch/recipe payloads may be stored as integration-owned snapshots
* only the Brewfather adapter/repository understands the external shape
* domain code never reaches into arbitrary Brewfather JSON

Source snapshots are cache/reference data, not core truth.

---

# 21. Settings Storage

Prefer feature-owned typed configuration tables.

Examples may include:

* display settings
* Brewfather settings
* pour-detection defaults
* health defaults
* system settings

Avoid one application-wide `settings(key, value)` dumping ground.

---

# 22. Configuration Ownership

Use three configuration tiers.

## Infrastructure-only environment/deployment configuration

Examples:

* encryption master key
* listen host/port
* data path
* deployment-level security options

## Encrypted SQLite secrets

Examples:

* Brewfather credentials
* Home Assistant token
* webhook secrets/static auth headers

## Normal SQLite application settings

Examples:

* Tapboard name
* display defaults
* theme/font/color
* Brewfather discovery statuses
* health defaults
* pour-detection defaults
* serving size
* fallback FG
* Activity Log retention

Rule:

**If changing it should require deployment access, keep it outside the DB. Otherwise configure it through Tapboard.**

---

# 23. Secret Encryption

Use Node's built-in cryptography.

Prefer authenticated encryption such as AES-256-GCM.

Store a versioned encrypted-secret envelope containing the information needed for safe decryption, such as:

* format/version
* nonce/IV
* ciphertext
* authentication tag

Root encryption key comes from externally supplied:

`TAPBOARD_SECRET_KEY`

Requirements:

* fresh nonce for every encryption
* no secret returned to browser after storage
* no plaintext in logs/errors/activity
* centralized secrets service
* versioned format for future migration

---

# 24. Encryption Key Rotation

Provide an explicit local operator command for master-key rotation.

Rotation:

* receives old/new key locally
* decrypts existing values safely
* re-encrypts with fresh nonces
* verifies before commit
* never prints plaintext
* aborts safely on failure
* does not happen silently during startup

---

# 25. Missing/Wrong Encryption Key

If encrypted credentials exist but cannot be decrypted:

* Tapboard starts in degraded mode
* affected integrations are disabled
* local domain functionality remains available
* Admin shows a prominent warning
* encrypted values are not erased
* operator may restore the correct key or replace credentials

Integration-secret failure is not grounds to destroy local availability.

---

# 26. API Key Storage

Telemetry/API keys used only for verification must be stored as cryptographic hashes, not recoverable encrypted values.

Generate with strong randomness.

Show once.

Rotate when lost.

---

# 27. Authentication

Single administrator PIN.

Use server-side opaque sessions.

Session identifier:

* strong random value
* stored hashed in SQLite
* sent in `HttpOnly` cookie

Use appropriate:

* `SameSite`
* `Secure` when HTTPS is used
* expiration
* revocation

No JWT requirement.

No account/role system.

---

# 28. Sessions

Store sessions in SQLite.

Support:

* configurable inactivity timeout
* configurable absolute maximum lifetime
* values up to one year
* PIN-change revocation
* individual session revocation
* automatic expiry pruning

Do not add Redis merely for sessions.

---

# 29. CSRF

Admin cookie-authenticated mutations require layered protection:

* SameSite session cookie
* strict Origin validation
* server-issued CSRF token

Machine APIs using explicit API-key authentication do not use the browser CSRF model.

---

# 30. Admin PIN Recovery

Provide a supported local/operator command to reset the Admin PIN.

It should:

* require host/container access
* set a new PIN securely
* revoke all sessions
* never expose a public browser recovery endpoint

---

# 31. API Versioning

Version externally meaningful machine APIs from the start.

Example:

`/api/v1/telemetry/taps/:tapNumber`

Admin browser APIs do not need the same long-term compatibility promise and need not all be versioned.

---

# 32. OpenAPI

Maintain an explicit OpenAPI specification for supported external APIs.

Cover:

* telemetry contract
* authentication
* units
* timestamps
* request/response schema
* error schema
* versioning

Do not force all internal Admin endpoints into OpenAPI.

Do not add a large API framework just to generate the document.

---

# 33. HTTP Layer

Prefer Node built-ins and the smallest routing abstraction that remains readable.

Codex must inspect the current/project needs before choosing.

A small router dependency is acceptable when it demonstrably improves:

* route composition
* middleware
* readability
* maintainability

Do not add Express/Fastify/etc. simply because they are conventional.

---

# 34. Input Validation

Use feature-owned explicit validation plus shared primitives.

Validate at HTTP/API boundaries.

Reject unknown fields.

Normalize external units/representations once.

Business-rule validation also occurs in use cases.

Do not add Zod/Ajv/Joi by default.

Codex may recommend one only if explicit validation clearly becomes more costly or error-prone than the dependency.

---

# 35. Error Handling

Use typed application errors and centralized HTTP mapping.

Conceptual categories may include:

* ValidationError
* NotFoundError
* ConflictError
* AuthenticationError
* IntegrationError
* TelemetryError

Business/domain code should not know HTTP status codes.

Integration adapters translate third-party errors into Tapboard-owned categories.

Unexpected errors must not expose secrets or server stack traces to clients.

---

# 36. Public/Admin DTOs

Never serialize raw database/domain objects directly to browsers.

Create explicit purpose-specific projections such as:

* PublicTapView
* PublicOnDeckView
* PublicBrewStoryView
* AdminTapView
* AdminFillView
* AdminIntegrationStatusView

This protects:

* Mystery Tap
* secrets
* raw telemetry
* integration details
* internal schema boundaries

---

# 37. Telemetry Boundary

Canonical measurements enter through Tapboard's versioned API.

No domain module imports Home Assistant-specific telemetry concepts.

Normalize:

* raw weight
* volume
* fill percentage
* temperature
* timestamp

at the boundary.

Telemetry source identity and Tap authority are explicit.

---

# 38. Integration Architecture

Use capability-based adapters, not a dynamic plugin system.

Useful capabilities include:

* Beverage data source
* telemetry source
* outbound event destination

Integration-specific payloads terminate at the adapter boundary.

Core domain code must not import Brewfather- or Home Assistant-specific modules.

Do not build:

* plugin manifests
* dynamic extension loading
* third-party SDK
* plugin marketplace infrastructure

---

# 39. Home Assistant

HA is an optional outbound integration.

Maintain its WebSocket only when enabled.

Use it to publish versioned `tapboard_event` events.

Do not use HA as domain truth.

Do not use HA helpers for Keg capacity.

Do not directly call arbitrary notification/services as part of core Tapboard behavior.

---

# 40. Domain Events

Use a small in-process domain event dispatcher.

After successful commits, domain/application code may publish events such as:

* fill.assigned
* fill.ended
* pour.completed
* keg.maintenance_recorded
* tap_wars.started

Independent local handlers may react.

Do not couple a business use case directly to every downstream subsystem.

Do not add Kafka/RabbitMQ/etc.

---

# 41. Transactional Outbox

Externally delivered events use a SQLite transactional outbox.

When a domain mutation requiring external delivery commits, the outbox record is created in the same SQLite transaction.

External delivery occurs afterward.

Guarantees:

* primary Tapboard action is authoritative
* external failure never rolls back domain state
* crash after commit cannot silently lose the external event
* retries survive restart

Purely local UI/SSE events need not be persisted through the outbox.

---

# 42. Outbound Delivery

Use a durable bounded retry queue/outbox worker.

Requirements:

* bounded exponential backoff
* stable event ID across retries
* bounded retention/queue size
* manual retry/dismiss for permanently failed delivery if useful
* external failure visible in Admin
* no unbounded queue growth

---

# 43. Webhooks

Generic webhooks receive the standard Tapboard event envelope.

Allow:

* URL
* subscribed events
* static headers/secrets

Do not build:

* custom JSON templating language
* arbitrary transforms
* arbitrary code execution

---

# 44. SSE

Use Server-Sent Events for server→browser live updates.

Mutations use normal HTTP.

Use feature-specific event names and targeted payloads.

Examples:

* tap.updated
* fill.updated
* telemetry.updated
* health.updated
* ondeck.updated
* tap_wars.updated
* integration_status.updated

Do not send a complete global application snapshot after every change.

---

# 45. SSE Recovery

SSE is not a durable event log.

After reconnect:

1. request/receive fresh authoritative page state;
2. reconcile;
3. resume targeted incremental events.

Do not build browser event replay unless a real requirement appears.

---

# 46. Background Jobs

Use lightweight in-process scheduling.

Examples:

* Brewfather hourly sync
* outbox retries
* Activity Log pruning
* periodic health evaluation

Requirements:

* restart-safe
* idempotent
* bounded
* overlapping runs coalesce/skip safely
* durable work stored in SQLite where required
* graceful shutdown

Do not add a queue/scheduler framework without demonstrated need.

---

# 47. Redis

Redis is **not prohibited**, but it is not a default dependency.

Codex must evaluate whether Redis materially improves a concrete need such as:

* high-frequency telemetry
* SSE fan-out
* multi-process coordination
* distributed jobs
* expensive shared cache
* future horizontal scaling

If proposed, Codex must explain:

* exact use case
* exact data stored
* durability expectations
* why SQLite/process memory is insufficient
* failure behavior
* operational cost

Core Tapboard domain truth remains in SQLite unless separately approved.

---

# 48. Caching

Do not introduce a generic cache layer by default.

Cache only:

* external data
* expensive replaceable projections
* data safe to discard/rebuild

Do not create an in-memory shadow copy of the entire SQLite domain.

Correctness must not depend on cache freshness.

---

# 49. Logging

Use structured application logging.

Levels:

* debug
* info
* warn
* error

Useful context may include:

* subsystem
* Tap/Fill/Beverage ID
* integration
* event ID
* safe error category

Never log:

* API keys
* tokens
* PINs
* Authorization headers
* decrypted credentials
* secret webhook headers

Write runtime logs to stdout/stderr.

Container/host owns log retention.

Activity Log is separate from runtime logs.

---

# 50. Activity Log

Activity Log stores meaningful domain/Admin actions in SQLite.

It is not a raw request log or telemetry time-series database.

Retention is configurable and automatically pruned.

Deletion audit/tombstone records are minimal and immutable.

---

# 51. Telemetry Retention

Retain:

* latest measurement
* bounded historical telemetry required for:

  * pour detection
  * health
  * forecasting
  * diagnostics

Automatically prune raw telemetry no longer needed.

Do not retain every raw scale sample forever.

---

# 52. Testing

Backend/domain tests use Node's built-in test runner.

Use Playwright for real browser/E2E workflows.

Avoid Jest/Vitest/Mocha unless a concrete missing capability justifies them.

Feature tests should generally live with/mirror feature ownership.

Maintain a smaller set of cross-domain workflows.

---

# 53. Required Cross-Domain Tests

At minimum, the rebuilt system should eventually protect workflows including:

* first-run/Admin login
* Beverage creation
* Brewfather linking/override behavior
* physical Keg creation
* Fill creation
* Fill→Tap assignment
* move Fill between Taps
* On Deck
* telemetry normalization
* sensor noise/baseline behavior
* telemetry→pour detection
* Kick Keg
* Mystery Tap
* Tap Wars
* Brew Story
* SSE live updates
* outbound event retry
* destructive deletion confirmation
* display preferences

Exact suite is determined during planning.

---

# 54. Linting

Use ESLint with:

* TypeScript-aware correctness rules
* unused/import checks
* promise/async correctness
* targeted architecture rules where practical

Avoid stylistic rules that overlap with Prettier.

Rules should catch meaningful problems rather than maximize strictness for its own sake.

---

# 55. Formatting

Prettier is the canonical formatter.

Use pre-commit tooling to auto-format staged supported files.

CI independently verifies formatting.

Pre-commit should remain lightweight.

Full validation stays in `npm run check`.

---

# 56. `npm run check`

The rebuild should maintain one authoritative validation command that covers appropriate combinations of:

* Prettier check
* ESLint
* `tsc --noEmit`
* architecture checks
* backend tests
* browser tests or the appropriate E2E tier

Exact separation between fast checks and full E2E may be refined during implementation.

---

# 57. Architecture Checks

Automate cheap, high-value boundaries.

Potential examples:

* no v1 imports
* no SQL outside approved repository modules
* no integration imports inside core domain modules
* no browser→server module imports
* prohibited dependency/import patterns

Do not build an elaborate custom architecture linter merely to enforce subjective file design.

---

# 58. God Files

Do not enforce arbitrary maximum line counts.

A module becomes a refactor candidate when it has multiple unrelated responsibilities or excessive coupling.

Warning signs include:

* HTTP + SQL + business rules in one file
* validation + persistence + remote calls mixed together
* unrelated workflows in one module
* massive dependency/import surface
* global knowledge of unrelated features

A long cohesive algorithm may be acceptable.

A shorter multi-purpose file may not be.

---

# 59. CSS

Use plain CSS with a small shared design system.

Conceptual organization:

```text
tokens.css
base.css
layout.css
components/
pages/
```

Requirements:

* CSS custom properties for design tokens
* shared buttons/cards/forms/badges/tables/etc.
* reuse rather than copied declarations
* public and Admin share visual primitives where appropriate
* page CSS only for genuinely unique needs
* remove dead/duplicated v1 CSS during porting

Do not add a styling framework.

---

# 60. Themes

Existing v1 themes are explicitly valuable.

They should be inventoried as high-priority reuse/reference assets.

Preserve their appearance where practical while reorganizing their implementation into the new design-token system.

---

# 61. SVGs / Fill Glass Graphics

Existing SVG Fill Glass assets are explicitly valuable.

Evaluate them for direct asset reuse.

Do not recreate working graphics merely because the application is being rebuilt.

---

# 62. Docker

Rebuild the container/deployment files cleanly for v2 while preserving the existing hardening principles.

Target posture:

* Node 24 LTS
* non-root user
* read-only root filesystem
* dedicated writable Tapboard data volume
* tmpfs where appropriate
* dropped Linux capabilities
* `no-new-privileges`
* health check
* graceful shutdown
* minimal production image
* development dependencies excluded
* secrets supplied externally
* no legacy backup volume

Do not blindly copy old Docker configuration.

---

# 63. Backup Tooling

Do not port the v1 Tapboard-owned backup/verify/restore subsystem.

Tapboard owns:

* schema initialization
* migrations
* integrity checks required for safe operation

Deployment/operator owns backups.

---

# 64. Documentation

Maintain:

* `README.md`
* `architecture.md`
* `docs/rebuild/*` during the rebuild
* OpenAPI specification
* short ADRs

`architecture.md` describes the system that actually exists.

It must not become an aspirational document that drifts from implementation.

---

# 65. ADRs

Use lightweight ADRs for consequential choices.

Likely initial ADR subjects:

* clean rebuild strategy
* Beverage / Physical Keg / Fill / Tap model
* modular monolith
* canonical telemetry API
* native TypeScript
* SQLite + better-sqlite3
* server rendering / Eta
* transactional outbox
* integration capability boundaries

Keep ADRs concise.

---

# 66. AGENTS.md Philosophy

Keep project agent instructions concise.

`AGENTS.md` should be a map to authoritative repository documents, not a thousand-line architecture encyclopedia.

Agents should be directed to read the relevant source-of-truth files before work.

---

# 67. Implementation Strategy

After architecture approval:

1. establish foundation;
2. implement vertical feature slices;
3. keep validation green at phase boundaries;
4. delete obsolete paths rather than maintaining compatibility;
5. finish with one architecture.

Do not build by broad horizontal layers across the whole product if vertical slices provide earlier end-to-end validation.

---

# 68. Proposed Issue Strategy

Foundation first, then bounded vertical slices.

Potential sequence:

1. application foundation
2. physical Kegs
3. Beverages / Brewfather linkage
4. Fills
5. Taps / lifecycle assignment
6. telemetry / pour detection
7. health / maintenance
8. On Deck / public display
9. Brew Story
10. Tap Wars
11. outbound integrations
12. Display / System
13. final cleanup/docs/acceptance

This sequence is provisional until Codex completes repository analysis.

---

# 69. Final Acceptance Gate

The rebuild is not complete merely because all implementation issues close.

A final acceptance review must verify:

* approved architecture implemented
* no accidental v1 dependencies
* clean DB initialization
* schema rules/invariants
* core workflows
* public responsive display
* Admin live updates
* telemetry→filter→pour pipeline
* Brewfather behavior
* Keg→Fill→Tap lifecycle
* Mystery Tap
* Tap Wars
* outbound event delivery/retries
* authentication/CSRF/secrets
* test suite
* Docker startup
* documentation
* OpenAPI
* ADRs
* dead-code/dependency audit
