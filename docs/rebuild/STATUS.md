# Tapboard v2 rebuild status

- Architecture: **FROZEN**
- Current phase: **Issue #79 outbound Home Assistant/webhook delivery implemented on the current branch; final validation and acceptance status pending**
- Current branch: `codex/issue-79-outbound-delivery`
- Current base: `cc804476` (merged #78)
- Current schema: **v19** (`outbound-destination-delivery`)
- Validation: **No automated or CI result is claimed in this status snapshot**
- Prebaseline: **333 passing tests** (prebaseline evidence, not a current validation result)
- Frozen v1 source commit: `429cf07e451b64ca1713655a34ffa5ebd376efae`
- ADR index: [`docs/adr/README.md`](../adr/README.md)
- V1 reuse manifest: [`docs/rebuild/v1-reuse-manifest.json`](v1-reuse-manifest.json)
- Guardrail policy: [`docs/rebuild/ARCHITECTURE-GUARDRAILS.md`](ARCHITECTURE-GUARDRAILS.md)

## GitHub planning

- Master: [#65 — Tapboard clean rebuild](https://github.com/joe-cole1/home-assistant-tapboard/issues/65)
- 1. [#66 — Foundation, runtime, and clean schema baseline](https://github.com/joe-cole1/home-assistant-tapboard/issues/66)
- 2. [#67 — Security, Activity, secrets, and bounded outbox primitives](https://github.com/joe-cole1/home-assistant-tapboard/issues/67)
- 3. [#85 — Development container and manual-test environment](https://github.com/joe-cole1/home-assistant-tapboard/issues/85)
- 4. [#68 — Physical Kegs](https://github.com/joe-cole1/home-assistant-tapboard/issues/68)
- 5. [#69 — Custom and Brewfather-linked Beverages](https://github.com/joe-cole1/home-assistant-tapboard/issues/69)
- 6. [#70 — Fills and On Deck](https://github.com/joe-cole1/home-assistant-tapboard/issues/70)
- 7. [#71 — Taps and assignment lifecycles](https://github.com/joe-cole1/home-assistant-tapboard/issues/71)
- 8. [#72 — Telemetry sources, API, and idempotent ingestion](https://github.com/joe-cole1/home-assistant-tapboard/issues/72)
- 9. [#73 — Telemetry epochs, baselines, and deterministic pour detector](https://github.com/joe-cole1/home-assistant-tapboard/issues/73)
- 10. [#74 — Pour history and Fill forecasting](https://github.com/joe-cole1/home-assistant-tapboard/issues/74)
- 11. [#75 — Draft health and Tap maintenance](https://github.com/joe-cole1/home-assistant-tapboard/issues/75)
- 12. [#76 — SSR Admin/public dashboard, SSE, and display preferences](https://github.com/joe-cole1/home-assistant-tapboard/issues/76)
- 13. [#77 — Brew Story, sensory guidance, and Mystery Tap](https://github.com/joe-cole1/home-assistant-tapboard/issues/77)
- 14. [#78 — Tap Wars](https://github.com/joe-cole1/home-assistant-tapboard/issues/78)
- 15. [#79 — Outbound Home Assistant and webhook delivery workers](https://github.com/joe-cole1/home-assistant-tapboard/issues/79)
- 16. [#80 — System and local operator functions](https://github.com/joe-cole1/home-assistant-tapboard/issues/80)
- 17. [#81 — Deployment, documentation, and final acceptance](https://github.com/joe-cole1/home-assistant-tapboard/issues/81)

The list preserves the frozen implementation sequence with #85's local development surface between #67 and #68. Issues #67, #85, and #68–#78 are merged; #79 is delivered on the current implementation branch and remains in final validation/acceptance. Issues #80–#81 remain out of scope.

## Implemented in Foundation

- Node 24 ESM runtime with native erasable TypeScript and `tsc --noEmit` checking;
- explicit application composition, Node HTTP lifecycle, and exactly `GET /healthz` for local application/database readiness;
- file-based Eta rendering with default escaping plus layout/partial proof templates;
- one controlled `better-sqlite3` connection, foreign keys, transactional versioned migrations, exact version-19 schema validation, and resource closure;
- shared typed errors, centralized HTTP error mapping, explicit validation, and structured redacting logging;
- Foundation- and #67–#74-aware architecture guardrails and negative fixtures;
- canonical external-origin/trusted-proxy/session configuration and stdin-only operator PIN/key maintenance commands;
- security/session, Activity/deletion-audit, stable event, secret, machine-key, and bounded-outbox primitives introduced in schema version 2 and retained through current schema version 19;
- #85's coherent development-only Docker image/Compose surface, loopback binding, healthcheck, named-volume persistence, and external-secret/operator workflow;
- #68 Physical Kegs domain inventory, capacity and tare ownership, prospective append-only tare history, append-only maintenance timeline, synchronous telemetry correction hook seam, deletion impact and audit integration, and authenticated admin HTTP API;
- #69 Custom and Brewfather-linked Beverages domain entity, custom profile/recipe tree, dynamic effective presentation resolution, 3-state presentation overrides, density resolution precedence, candidate cache, rate-limited Brewfather sync with persistent backoff, atomic unlinking, and bounded recipe snapshots;
- #70 Physical Keg Fills domain entity, pure derived state resolution (`ended > on_tap > on_deck > available`), partial unique index active keg constraint (`idx_fills_active_keg`), explicit dense 1-indexed On Deck administrative ordering and unauthenticated public projection, atomic Kick Keg local transaction with assignment-close hook and failure rollback, post-commit Brewfather batch completion coordination (`never`, `ask`, `completed`) with terminal status short-circuiting and account-scoped adapter rate-limiting, and isolated last-fill beverage auto-deletion;
- #71 Physical Taps domain entity, monotonic `first_used_at` retention across fill kicks/deletions, retired tap status preserving number reservations and preventing new assignments, atomic Tap Assignment Lifecycles with partial unique indexes (`idx_tap_assignments_active_tap`, `idx_tap_assignments_active_fill`), on-deck clearance upon tap assignment, atomic fill moves with new UUID generation and rollback safety, occupied tap conflict guards, never-used-only tap deletion with deletion audit, synchronous `TapAssignmentExtensionPort` with `requiresFreshBaseline` signaling, concrete `FillAssignmentLifecyclePort` integration for `#70`, and authenticated admin and unauthenticated public tap projections (`GET /api/public/taps`);
- #72 canonical telemetry ingestion and #73 immutable telemetry epochs/provenance snapshots, one-way closure and single-open Tap invariants, fresh settled baselines without historical reuse, canonical→interpreted→stabilized→public-safe volume pipeline, durable timestamp-driven detector/deadline recovery, upward-jump warnings, minimal immutable pours with deterministic `effect_key`, and transaction-local accepted-ingestion extension with rollback;
- #74 Fill-scoped immutable pour history across Tap moves, first-assignment UTC daily consumption with inclusive zero days, actual stabilized current-open-epoch volume/capacity input, deterministic sufficient-history forecasting (14 days/3 pours; SHA-256-seeded 512-sample seven-day circular moving-block bootstrap), bounded 24 oz-per-four-day fallback, low/medium/high confidence, conservative whole-serving forecasts, serving-size settings defaulting to 354.88235475 mL from v1 12 oz evidence, and authenticated Admin history/forecast/settings routes with no public forecast endpoint;
- #75 draft health and Tap line maintenance: typed health IDs (`low_keg`, `scale_availability`, `suspected_leak`, `serving_temperature`, `line_cleaning_due`), typed global defaults with nullable per-Tap overrides, low-keg/scale checks enabled by default and leak/temperature/cleaning checks opt-in, authoritative stabilized-volume and epoch-isolated evaluation, disabled-versus-retired semantics with deterministic incident resolution, rebuildable current state distinct from durable incidents/transitions, acknowledgement that does not resolve or hide, bounded cooldown for repeated incident side effects only, 365-day resolved-incident retention in batches of at most 100, append-only line maintenance with server-derived due dates and `line_cleaned` establishing the line-cleaning baseline only, Admin-only overview/detail/configuration/override/incident/acknowledgement/cooldown/maintenance routes and projections, meaningful-Activity filtering, and the safe targeted `HealthTargetedUpdate` DTO seam for #76;
- #76 authoritative Eta SSR for `/` and nine authenticated Admin pages, purpose-built public/Admin projections, progressive PRG forms, explicit safe static assets, a bounded public/Admin SSE hub with post-commit dirty notifications and authoritative reconnect reconciliation, stable Tap graphic nodes, typed shared display defaults, sparse validated browser-local overrides with pre-paint bootstrap and storage-event synchronization, responsive scroll/rotation modes, and a separate Playwright Chromium suite;
- #77 read-only SSR Brew Story backed by local persisted state, one central public projection/redaction boundary across dashboard/legacy taps/Story HTML/JSON, assignment-owned default-hidden Mystery Tap reveal flags with exact allowlist and reset semantics, six-axis sensory guidance with per-axis manual → recipe prediction → style baseline → unavailable precedence, separate Custom versus read-only linked/detached/superseded recipe projections, a finite 17-ID Beverage-owned Fill Glass catalog with safe deterministic color/SRM fallback, no-JavaScript Story/Admin forms, stable SVG root identity, and post-commit dirty-ID-only live refresh;
- #85 architecture guardrails that preserve banned canonical production paths and reject incomplete or unapproved top-level container variants;
- explicit `not_queued_capacity` degradation semantics; #79 provider-neutral outbound destination profiles, immutable transport versions/subscriptions, bounded delivery workers, and Admin history controls;
- canonical `npm run check` covering format, lint, types, architecture/reuse integrity, and `node:test`;
- Node 24 CI running `npm ci`, the canonical gate, and changed-line whitespace validation.

Schema version 9 adds persisted detector state, version 10 adds forecast settings/history indexes, and version 11 adds health and Tap maintenance. Schema version 12 (`ssr-dashboard-display-settings`) adds the typed singleton shared-display defaults with deterministic seed, SQL constraints, and revision. Schema version 13 (`brew-story-sensory-mystery`) adds assignment-owned typed Mystery reveal flags. Versions 14–18 extend Tap-card/display, telemetry-source, font, and Tap Wars contracts. Schema version 19 (`outbound-destination-delivery`) adds optional logical destination profiles, immutable transport configuration/subscription versions, and bounded delivery retry evidence. Browser-local preferences, live clients/queues, rotation state, effective sensory values, and Story projections are never persisted.

## Issue #73 implementation boundary

Telemetry Sources reuse the existing MachineKey service but keep source identity separate from credential identity. A source has a stable UUID and a current key; creation and rotation show the strong Bearer token once, list/get omit secrets, unbound generic machine keys cannot authenticate, and rotation revokes the old key without changing source identity, Tap authority, idempotency namespace, or rate-limit identity. Each Tap has zero or one explicit authority. Disabled Taps continue to accept telemetry; retired Taps produce durable rejection outcomes. Actual authority changes or clears synchronously call `TelemetryAuthorityExtensionPort` with `requiresFreshBaseline: true`, while same-source assignment is a no-op and credential rotation is not an authority change.

The external v1 contract is the checked-in [`openapi/telemetry-v1.json`](../../openapi/telemetry-v1.json): `POST /api/v1/telemetry/taps/:tapNumber` and `POST /api/v1/telemetry/batch`, Bearer-only machine authentication, strict snake_case nested measurement objects, and batch `tap_number`. Exactly one primary measurement is accepted. Mass, volume, temperature, and percentage normalize to grams, milliliters, Celsius, and percent under normalization version 1 with six-decimal rounding. `measured_at` requires an explicit RFC3339 offset and is canonicalized to UTC ISO milliseconds plus epoch milliseconds. Single and batch bodies are capped at 16 KiB and 256 KiB, and external batches are limited to 100 samples. Structural failures map to the documented 400/401/404/413 responses; single durable rejections use 409 (rate-limited new samples use 429), while batch item outcomes are returned in HTTP 200.

Idempotency uses `(source_id, client_sample_id)` when a client ID is present and `(source_id, tap_id, measured_at_epoch_ms)` otherwise. SHA-256 digests cover canonical semantic data—normalization version, immutable Tap UUID, canonical time, primary value/kind, and optional temperature—not transport spelling or batch position. Durable receipts retain accepted/rejected outcomes and are checked before the source-keyed in-memory rate limiter: same-digest retries mirror the original result with `duplicate: true`, different digests conflict without effects, and only new identities consume rate capacity. Structural inputs that cannot establish identity do not create receipts; operational authority, retired, future, stale, and out-of-order outcomes do.

Accepted samples run through one synchronous transaction that rechecks identity/authority, enforces a strictly increasing `(source_id, tap_id)` status watermark retained across authority changes, stores the canonical raw measurement, advances latest hardware status, sets Tap `first_used_at` from received time, captures only the current open assignment when `measured_at >= assigned_at`, calls `AcceptedTelemetryExtensionPort`, and finalizes the receipt last. Hook failure rolls back the durable accepted writes. Delayed pre-assignment samples remain unassigned; accepted samples with no Fill retain null assignment/Fill. Raw measurements and receipts have separate horizons and deterministic pruning of at most 500 rows per table per call; raw rows are removed before receipts, and status/first-use survive pruning. Ordinary telemetry does not create Activity or outbox entries, while source, key, authority, and settings administration follows existing audit patterns.

The #72 accepted-sample and authority-change ports now invoke #73 transaction-local detector work. Accepted canonical samples are interpreted against the immutable epoch provenance, stabilized, and exposed only as public-safe volume; failures roll back the accepted extension before its receipt finalizes. Manual rebaseline retains the assignment, opens a new epoch, and waits for a new eligible baseline sample. Completed pours are immutable and deduplicated by deterministic terminal `effect_key` across retries, restarts, and replay.

## Issue #75 implementation boundary

The health contract uses exactly `low_keg`, `scale_availability`, `suspected_leak`, `serving_temperature`, and `line_cleaning_due`. Typed global defaults are the baseline and nullable per-Tap overrides selectively replace fields. `low_keg` and `scale_availability` are enabled by default; `suspected_leak`, `serving_temperature`, and `line_cleaning_due` are opt-in. Scale availability reads the latest accepted measurement from the current authoritative source/Tap status independently of serving-epoch state; low-keg, suspected-leak, and serving-temperature retain current-epoch provenance isolation. Disabled Taps evaluate; retired Taps skip evaluation and receive deterministic incident resolution.

Rebuildable current health state is separate from durable incidents and transitions. Acknowledgement records acknowledgement only and does not resolve or hide an incident. Cooldown suppresses repeated incident side effects for a bounded period, not health truth. Resolved incidents are retained for 365 days and pruned in deterministic batches of at most 100; open incidents, current state, and Tap `first_used_at` are never pruned. A durable incident and a line-maintenance record each atomically set Tap `first_used_at`.

Tap line maintenance is append-only. The server derives resulting due dates, `line_cleaned` establishes the line-cleaning baseline only, and private notes are available only in Admin maintenance detail. Health evaluation runs after accepted telemetry (following detector processing), assignment, authority, correction, density, configuration, maintenance, and startup changes, plus one coalesced periodic sweep. Only meaningful changes create Activity. Authenticated Admin routes/projections cover overview, detail, configuration, per-Tap override, incidents, acknowledgement, cooldown, and maintenance. The safe targeted `HealthTargetedUpdate` DTO now feeds #76 dirty notifications without exposing evidence. Public health remains aggregate-only; Issue #79 owns outbound Home Assistant/webhook delivery and its connectivity evidence.

## Issue #76 implementation boundary

Issue #76 established the stable generic Tap graphic node seam consumed by the Issue #77 Beverage-owned Fill Glass presentation.

`/` is complete authoritative SSR: aggregate header/connectivity, every enabled nonretired Tap in ascending number order, a stable hidden Tap Wars slot, and the existing authoritative On Deck projection. Public JSON and SSE use explicit privacy DTOs and dirty identifiers only. Browser modules patch existing text/attributes/SVG geometry, insert or remove only changed cards, and fetch a dashboard-scoped authoritative projection after reconnect. The in-process public/Admin hubs bound clients, queued events, and queued bytes; coalesce dirty targets; respect write backpressure and drain; disconnect overflow; clean up listeners; and periodically revalidate Admin sessions. They do not provide durable replay.

Authenticated Eta Admin pages cover Overview, Integrations, Beverages, Kegs, Fills, Taps, Tap Wars, Display, System, and #79 outbound destination/history controls. Ordinary forms retain CSRF/Origin-protected POST→303 behavior without JavaScript. Complete System administration remains the next local-operator seam; #78 Tap Wars and #79 outbound behavior are implemented rather than fabricated.

Shared display defaults are typed, revisioned schema-v12 state. Sparse browser overrides use localStorage key `tapboard.v2.display-preferences.v1`, version 1, exact keys, safe enums, reset-to-inherit, and cross-tab storage events. An external synchronous bootstrap applies validated values before CSS; malformed/unavailable storage fails to shared defaults. Layout defaults to responsive scrolling, while optional automatic rotation retains all SSR cards in the DOM and respects focus, visibility, and reduced motion.

## Issue #77 implementation boundary (merged)

The merged Issue #77 implementation provides a read-only SSR Brew Story backed by local persisted Tapboard state. `PublicStoryService` is the single public projection/redaction boundary for the dashboard, legacy public taps, Story HTML/JSON, and targeted refreshes; redaction occurs before serialization/rendering. Public SSE continues to carry dirty Tap identifiers only. Story and Admin forms remain useful without JavaScript.

Mystery is stored on the active assignment in `tap_assignment_mystery`, defaults all eligible reveals to hidden, uses the exact title `Mystery Tap`, and always protects Beverage and custom Tap names. The typed reveal allowlist is `beverage_type`, `style`, `abv`, `ibu`, `og`, `fg`, `srm`, `description`, `recipe`, `sensory`, and `history`; Tap number, display color, Fill Glass, remaining/fill percentage, forecast/days/servings, and serving temperature are always visible. Unassign, move, and reassign transitions reset the new assignment's Mystery state.

Sensory guidance exposes bitterness, sweetness, body, roast, tartness, and alcohol, resolving each axis independently as manual override, recipe prediction, style baseline, or unavailable. Effective sensory values are derived only. Custom recipe data is editable and separate from read-only linked, detached, and superseded source snapshots. Presentation uses a finite 17-ID Beverage-owned Fill Glass catalog with safe deterministic descriptors and display-color/SRM fallback; browser updates preserve the root `.tap-graphic` SVG node. Issue #77 is historical context; current validation status is tracked at the top of this file.

## Issue #78 Tap Wars (merged)

Issue #78 is merged into the current base `cc804476`. It owns assignment-scoped Tap Wars with anonymous atomic voting, explicit pause/resume/completion, Mystery-safe public projection, immutable Admin history, and a completed-result dismissal boundary. Its public projection and event seam remain separate from the #79 outbound destination workers.

## Issue #79 outbound delivery implementation

The current `codex/issue-79-outbound-delivery` branch delivers schema v19 and the provider-neutral outbound boundary. `src/features/outbound/` owns typed destination configuration, immutable endpoint versions, six-event subscriptions, logical secret slots, connectivity evidence, Admin destination/history behavior, and worker lifecycle. The generic outbox remains the transactional authority: leased/CAS claims provide at-least-once delivery, allow at most one unexpired claim per logical destination, and retain total-attempt evidence separately from the bounded retry cycle. Retryable failures back off from five seconds to a one-hour cap and become terminal after 24 hours of active failure or the cycle limit; permanent failures are terminal immediately. Required destinations degrade only after five minutes of continuous failure. Disable/re-enable pauses due and failure-window clocks while preserving history; Retry is terminal-only and Dismiss is final.

Home Assistant uses one injected/native WebSocket per logical destination and sends `tapboard_event`, with explicit LAN HTTP allowed and no arbitrary service calls. Webhooks use the standard envelope or one bounded Discord-message format, with public-only DNS validation, mixed/unsafe-answer rejection, address pinning, no redirects, and bounded request/response/abort limits. Endpoint material is immutable-version-bound; Home Assistant tokens and webhook secret-header values are logical slots resolved at send time, so rotation/removal applies immediately to historical retries. No secret is returned by Admin or written to logs/history. Workers perform network I/O outside SQLite transactions. Final automated and CI validation remains pending; this document does not claim results.

### MANUAL DEV TEST — Issue #79

After updating to the Issue #79 revision, run the normal non-destructive rebuild (`docker compose -f compose.dev.yaml up -d --build --force-recreate`; never use `down --volumes` or delete `tapboard-dev_tapboard-data`). Verify `GET /healthz` returns `{"status":"ok","schemaVersion":19}`. Sign in to Admin and open outbound destination management. Confirm the defaults have all six registered event subscriptions selected and `Required` defaults to OFF; create one disposable Home Assistant destination and one disposable webhook destination, then inspect safe summaries and the Standard JSON and bounded Discord format choices. Confirm no secret is readable in the form response, destination page, history, logs, errors, or Activity. If available, exercise Home Assistant only against a safe disposable/LAN endpoint and verify `tapboard_event` without arbitrary service calls; use a disposable receiver for both webhook formats and verify redirects/private or mixed-DNS targets are rejected. Disable and re-enable a disposable destination and verify due/failure timing shifts while history remains. In delivery history, confirm Retry appears only for terminal rows and Dismiss is final. Inspect responsive behavior at approximately 800 px, 1280×720, 1920×1080, and 3840×2160. Do not delete or repurpose the persistent development volume.

## Post-merge operator handoff

After each completed and merged v2 implementation issue, update `main`, rebuild and recreate the development container without deleting its volume, verify `/healthz`, and manually exercise the delivered behavior. Every future implementation handoff must include a short issue-specific heading `MANUAL DEV TEST` describing what to test after the rebuild. See the normal command order in the root README.

### MANUAL DEV TEST — Issue #74

After the normal rebuild, verify `/healthz` reports schema version 11. In an ephemeral database, verify one Fill retains pour history across a move between Taps, is waiting after a move until a new measurement then resumes forecasting, does not include another Fill's pours, and reports ended Fill history without forecasting. Do not select arbitrary persistent entities, mutate a real Brewfather batch, assume a default PIN, or delete the Compose volume as cleanup.

### MANUAL DEV TEST — Issue #75

Persistent, safe read-only checks: after the normal rebuild, verify `/healthz` reports `{"status":"ok","schemaVersion":11}`; inspect the authenticated Admin health overview/detail/configuration/incident and Tap maintenance projections; and confirm that no public health API, SSE stream, or browser feature page is implied. Do not acknowledge an incident, change a default/override/cooldown, record maintenance, or otherwise mutate the persistent development volume during this pass.

Ephemeral, mutating smoke: use a disposable database and disposable Tap to exercise a default-enabled check, an opt-in check, a nullable per-Tap override, incident acknowledgement/cooldown, deterministic retired-Tap handling, and append-only line maintenance with a server-derived due date. Confirm that a durable incident and a maintenance record atomically set `first_used_at`, and that `line_cleaned` establishes the line-cleaning baseline only. Maintenance and incidents permanently mark a Tap used; never run this smoke against a persistent Tap or the normal named volume, and do not delete the Compose volume as cleanup. No tests are claimed as run here; this is an operator test plan.

### MANUAL DEV TEST — Issue #76

Use the normal `docker compose -f compose.dev.yaml build` and `up -d --force-recreate` workflow without `down -v` or deleting `tapboard-dev_tapboard-data`; then verify `/healthz` reports schema version 13. Exercise `/` with zero, one, six, and more than six enabled Taps, plus disabled/unassigned Taps and On Deck. Sign in, visit all nine Admin routes, submit one no-JavaScript form, and inspect Display inheritance. Set/reload/reset local preferences and verify two-tab synchronization. Cause a Tap update, verify live targeted content and retained SVG node identity, disconnect/reconnect SSE, and verify missed state reconciles. Inspect approximately 800 px, 1280×720, 1920×1080, and 3840×2160. Use disposable state for destructive fixtures; never delete or repurpose the persistent development volume.

### MANUAL DEV TEST — Issue #77

After the normal non-destructive rebuild (`docker compose -f compose.dev.yaml up -d --build --force-recreate`; never use `down --volumes`), verify `/healthz` reports schema version 13. With disposable entities for mutating checks, open a normal Story with JavaScript disabled and inspect Custom, linked, and detached recipe provenance; verify all six sensory axes and clear a manual override to expose the next precedence layer. Enable Mystery on an active assignment and confirm the exact title, protected identity, selective reveals, always-visible exemptions, reset after unassign/move, live redaction updates, and dirty-ID-only SSE. Change at least two finite Fill Glass choices and display-color/SRM inputs, confirming distinct safe graphics and stable SVG root identity. Do not delete or repurpose the persistent development volume.

## Validation tiers

`npm run check` remains the Node 24 canonical gate. `npm run test:e2e` is a separate Playwright/Chromium gate so ordinary Node tests do not require a browser binary; CI installs Chromium and runs it independently. A staged-file pre-commit formatter and hook dependency remain intentionally absent.
