# Tapboard v2 rebuild status

- Architecture: **FROZEN**
- Current phase: **Issue #69 Custom and Brewfather-linked Beverages implemented; Fills and On Deck (#70) is next**
- Current branch: `main`
- Current base: `4f80a79`
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

The list preserves the frozen implementation sequence with #85's local development surface between #67 and #68. Issues #67, #85, and #68 are merged on `main`; issue #69 (Beverages) is implemented, and issue #70 (Fills and On Deck) is next.

## Implemented in Foundation

- Node 24 ESM runtime with native erasable TypeScript and `tsc --noEmit` checking;
- explicit application composition, Node HTTP lifecycle, and exactly `GET /healthz` for local application/database readiness;
- file-based Eta rendering with default escaping plus layout/partial proof templates;
- one controlled `better-sqlite3` connection, foreign keys, transactional versioned migrations, exact version-4 schema validation, and resource closure;
- shared typed errors, centralized HTTP error mapping, explicit validation, and structured redacting logging;
- Foundation-, #67-, #68-, and #69-aware architecture guardrails and negative fixtures;
- canonical external-origin/trusted-proxy/session configuration and stdin-only operator PIN/key maintenance commands;
- schema version 2 security/session, Activity/deletion-audit, stable event, secret, machine-key, and bounded-outbox primitives;
- #85's coherent development-only Docker image/Compose surface, loopback binding, healthcheck, named-volume persistence, and external-secret/operator workflow;
- #68 Physical Kegs domain inventory, capacity and tare ownership, prospective append-only tare history, append-only maintenance timeline, synchronous telemetry correction hook seam, deletion impact and audit integration, and authenticated admin HTTP API;
- #69 Custom and Brewfather-linked Beverages domain entity, custom profile/recipe tree, dynamic effective presentation resolution, 3-state presentation overrides, density resolution precedence, candidate cache, rate-limited Brewfather sync with persistent backoff, atomic unlinking, and bounded recipe snapshots;
- #85 architecture guardrails that preserve banned canonical production paths and reject incomplete or unapproved top-level container variants;
- explicit `not_queued_capacity` degradation semantics; no provider adapters, delivery workers, or browser feature pages;
- canonical `npm run check` covering format, lint, types, architecture/reuse integrity, and `node:test`;
- Node 24 CI running `npm ci`, the canonical gate, and changed-line whitespace validation.

Schema version 4 contains typed #67 primitives, #68 Physical Keg tables (`kegs`, `keg_tare_history`, `keg_maintenance_records`), #69 Beverage tables (`beverage_settings`, `beverages`, `custom_beverage_profiles`, `custom_recipes`, `custom_recipe_ingredients`, `custom_recipe_steps`, `beverage_sensory_overrides`, `brewfather_accounts`, `brewfather_candidate_cache`, `brewfather_beverage_links`, `brewfather_source_profiles`, `brewfather_presentation_overrides`, `beverage_source_recipe_snapshots`), and no v1 data adoption. The PIN remains exactly four ASCII digits with limited stolen-verifier offline resistance; integration encryption relies on independent external `TAPBOARD_SECRET_KEY` material. Activity never recursively enters the outbox, and `not_queued_capacity` is a fixed-slot bounded degradation state rather than a storage-error classification. Domain fills, taps, provider adapters, delivery workers, telemetry, UI, and production deployment remain deferred.

## Post-merge operator handoff

After each completed and merged v2 implementation issue, update `main`, rebuild and recreate the development container without deleting its volume, verify `/healthz`, and manually exercise the delivered behavior. Every future implementation handoff must include a short issue-specific heading `MANUAL DEV TEST` describing what to test after the rebuild. See the normal command order in the root README.

## Deferred validation tiers

Playwright/browser E2E is intentionally not introduced in #66 because no feature UI or workflow exists. No E2E tests ran or passed; that tier is deferred to issue #76. A staged-file pre-commit formatter and hook dependency are also not introduced; the canonical local and CI gate is authoritative for Foundation.
