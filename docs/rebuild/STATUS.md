# Tapboard v2 rebuild status

- Architecture: **FROZEN**
- Current phase: **Issue #72 Telemetry sources, API, and idempotent ingestion implementation ready for coordinator validation; Telemetry epochs, baselines, and deterministic pour detector (#73) remains next**
- Current branch: `codex/issue-72-telemetry-sources-api`
- Current base: `fb782bc`
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

The list preserves the frozen implementation sequence with #85's local development surface between #67 and #68. Issues #67, #85, #68, #69, #70, and #71 are implemented; the #72 implementation is present on the current branch and ready for validation; issue #73 (Telemetry epochs, baselines, and deterministic pour detector) remains next.

## Implemented in Foundation

- Node 24 ESM runtime with native erasable TypeScript and `tsc --noEmit` checking;
- explicit application composition, Node HTTP lifecycle, and exactly `GET /healthz` for local application/database readiness;
- file-based Eta rendering with default escaping plus layout/partial proof templates;
- one controlled `better-sqlite3` connection, foreign keys, transactional versioned migrations, exact version-8 schema validation, and resource closure;
- shared typed errors, centralized HTTP error mapping, explicit validation, and structured redacting logging;
- Foundation-, #67-, #68-, #69-, #70-, #71-, and #72-aware architecture guardrails and negative fixtures;
- canonical external-origin/trusted-proxy/session configuration and stdin-only operator PIN/key maintenance commands;
- schema version 2 security/session, Activity/deletion-audit, stable event, secret, machine-key, and bounded-outbox primitives;
- #85's coherent development-only Docker image/Compose surface, loopback binding, healthcheck, named-volume persistence, and external-secret/operator workflow;
- #68 Physical Kegs domain inventory, capacity and tare ownership, prospective append-only tare history, append-only maintenance timeline, synchronous telemetry correction hook seam, deletion impact and audit integration, and authenticated admin HTTP API;
- #69 Custom and Brewfather-linked Beverages domain entity, custom profile/recipe tree, dynamic effective presentation resolution, 3-state presentation overrides, density resolution precedence, candidate cache, rate-limited Brewfather sync with persistent backoff, atomic unlinking, and bounded recipe snapshots;
- #70 Physical Keg Fills domain entity, pure derived state resolution (`ended > on_tap > on_deck > available`), partial unique index active keg constraint (`idx_fills_active_keg`), explicit dense 1-indexed On Deck administrative ordering and unauthenticated public projection, atomic Kick Keg local transaction with assignment-close hook and failure rollback, post-commit Brewfather batch completion coordination (`never`, `ask`, `completed`) with terminal status short-circuiting and account-scoped adapter rate-limiting, and isolated last-fill beverage auto-deletion;
- #71 Physical Taps domain entity, monotonic `first_used_at` retention across fill kicks/deletions, retired tap status preserving number reservations and preventing new assignments, atomic Tap Assignment Lifecycles with partial unique indexes (`idx_tap_assignments_active_tap`, `idx_tap_assignments_active_fill`), on-deck clearance upon tap assignment, atomic fill moves with new UUID generation and rollback safety, occupied tap conflict guards, never-used-only tap deletion with deletion audit, synchronous `TapAssignmentExtensionPort` with `requiresFreshBaseline` signaling, concrete `FillAssignmentLifecyclePort` integration for `#70`, and authenticated admin and unauthenticated public tap projections (`GET /api/public/taps`);
- #72 Telemetry sources, machine key authentication, tap authority assignment with `TelemetryAuthorityExtensionPort`, external REST API endpoints (`POST /api/v1/telemetry/taps/:tapNumber`, `POST /api/v1/telemetry/batch`), unit normalization to canonical units (grams, milliliters, Celsius, percent) with 6-decimal rounding, deterministic batch ordering and duplicate coalescing, SHA-256 semantic payload digests, idempotency receipts (`telemetry_ingest_receipts`), bounded raw measurement retention (`telemetry_measurements`), latest hardware status (`telemetry_source_tap_status`), in-memory token bucket rate limiting, synchronous `AcceptedTelemetryExtensionPort` seam, and OpenAPI 3.1 specification (`openapi/telemetry-v1.json`);
- #85 architecture guardrails that preserve banned canonical production paths and reject incomplete or unapproved top-level container variants;
- explicit `not_queued_capacity` degradation semantics; no provider adapters, delivery workers, or browser feature pages;
- canonical `npm run check` covering format, lint, types, architecture/reuse integrity, and `node:test`;
- Node 24 CI running `npm ci`, the canonical gate, and changed-line whitespace validation.

Schema version 8 contains typed #67 primitives, #68 Physical Keg tables (`kegs`, `keg_tare_history`, `keg_maintenance_records`), #69 Beverage tables (`beverage_settings`, `beverages`, `custom_beverage_profiles`, `custom_recipes`, `custom_recipe_ingredients`, `custom_recipe_steps`, `beverage_sensory_overrides`, `brewfather_accounts`, `brewfather_candidate_cache`, `brewfather_beverage_links`, `brewfather_source_profiles`, `brewfather_presentation_overrides`, `beverage_source_recipe_snapshots`), #70 Fill tables (`fill_settings`, `fills`), #71 Tap tables (`taps`, `tap_assignment_lifecycles`), #72 Telemetry tables (`telemetry_sources`, `tap_telemetry_authority`, `telemetry_settings`, `telemetry_ingest_receipts`, `telemetry_measurements`, `telemetry_source_tap_status`), and the additive forensic-QC integrity guards applied to the original v7 telemetry schema without replacing persisted rows. There is no v1 data adoption. Telemetry settings default to a 100-sample batch, 300-second future skew, 21,600-second reconnect and raw-retention horizons, 86,400-second receipt retention, 600 samples/minute, and a 100-sample burst. Durable settings enforce receipt retention at least as long as both reconnect and raw retention, and the batch size no greater than the burst. The PIN remains exactly four ASCII digits with limited stolen-verifier offline resistance; integration encryption relies on independent external `TAPBOARD_SECRET_KEY` material. Activity never recursively enters the outbox, and `not_queued_capacity` is a fixed-slot bounded degradation state rather than a storage-error classification. Telemetry epochs, baselines, pour detection, provider adapters, delivery workers, UI, and production deployment remain deferred.

## Issue #72 implementation boundary

Telemetry Sources reuse the existing MachineKey service but keep source identity separate from credential identity. A source has a stable UUID and a current key; creation and rotation show the strong Bearer token once, list/get omit secrets, unbound generic machine keys cannot authenticate, and rotation revokes the old key without changing source identity, Tap authority, idempotency namespace, or rate-limit identity. Each Tap has zero or one explicit authority. Disabled Taps continue to accept telemetry; retired Taps produce durable rejection outcomes. Actual authority changes or clears synchronously call `TelemetryAuthorityExtensionPort` with `requiresFreshBaseline: true`, while same-source assignment is a no-op and credential rotation is not an authority change.

The external v1 contract is the checked-in [`openapi/telemetry-v1.json`](../../openapi/telemetry-v1.json): `POST /api/v1/telemetry/taps/:tapNumber` and `POST /api/v1/telemetry/batch`, Bearer-only machine authentication, strict snake_case nested measurement objects, and batch `tap_number`. Exactly one primary measurement is accepted. Mass, volume, temperature, and percentage normalize to grams, milliliters, Celsius, and percent under normalization version 1 with six-decimal rounding. `measured_at` requires an explicit RFC3339 offset and is canonicalized to UTC ISO milliseconds plus epoch milliseconds. Single and batch bodies are capped at 16 KiB and 256 KiB, and external batches are limited to 100 samples. Structural failures map to the documented 400/401/404/413 responses; single durable rejections use 409 (rate-limited new samples use 429), while batch item outcomes are returned in HTTP 200.

Idempotency uses `(source_id, client_sample_id)` when a client ID is present and `(source_id, tap_id, measured_at_epoch_ms)` otherwise. SHA-256 digests cover canonical semantic data—normalization version, immutable Tap UUID, canonical time, primary value/kind, and optional temperature—not transport spelling or batch position. Durable receipts retain accepted/rejected outcomes and are checked before the source-keyed in-memory rate limiter: same-digest retries mirror the original result with `duplicate: true`, different digests conflict without effects, and only new identities consume rate capacity. Structural inputs that cannot establish identity do not create receipts; operational authority, retired, future, stale, and out-of-order outcomes do.

Accepted samples run through one synchronous transaction that rechecks identity/authority, enforces a strictly increasing `(source_id, tap_id)` status watermark retained across authority changes, stores the canonical raw measurement, advances latest hardware status, sets Tap `first_used_at` from received time, captures only the current open assignment when `measured_at >= assigned_at`, calls `AcceptedTelemetryExtensionPort`, and finalizes the receipt last. Hook failure rolls back the durable accepted writes. Delayed pre-assignment samples remain unassigned; accepted samples with no Fill retain null assignment/Fill. Raw measurements and receipts have separate horizons and deterministic pruning of at most 500 rows per table per call; raw rows are removed before receipts, and status/first-use survive pruning. Ordinary telemetry does not create Activity or outbox entries, while source, key, authority, and settings administration follows existing audit patterns.

The accepted-sample port and the authority-change port are the exact #73 seams. They are synchronous, default to no-op, and do not create epochs, baselines, detector state, stabilization/filtering, or pours. No #72 validation, development-container rebuild, or `/healthz` result is recorded here yet; coordinator validation supplies that evidence.

## Post-merge operator handoff

After each completed and merged v2 implementation issue, update `main`, rebuild and recreate the development container without deleting its volume, verify `/healthz`, and manually exercise the delivered behavior. Every future implementation handoff must include a short issue-specific heading `MANUAL DEV TEST` describing what to test after the rebuild. See the normal command order in the root README.

### MANUAL DEV TEST — Issue #72

After the normal rebuild, verify `/healthz` reports schema version 8. Exercise telemetry mutations only against an ephemeral SQLite database (the focused telemetry tests provide this path), unless the operator intentionally chooses persistent development entities. Do not create a supposedly disposable Tap in the named-volume database and send it a sample: the first accepted sample permanently sets `first_used_at`, so that Tap is no longer deletable under the frozen lifecycle. Do not select arbitrary "first" Keg, Beverage, Fill, or Tap rows, mutate a real Brewfather batch, assume a default PIN, or delete the Compose volume as cleanup.

## Deferred validation tiers

Playwright/browser E2E is intentionally not introduced in #66 because no feature UI or workflow exists. No E2E tests ran or passed; that tier is deferred to issue #76. A staged-file pre-commit formatter and hook dependency are also not introduced; the canonical local and CI gate is authoritative for Foundation.
