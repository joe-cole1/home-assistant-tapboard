# Tapboard v2 rebuild status

- Architecture: **FROZEN**
- Current phase: **Issue #67 primitives implemented locally; awaiting review and shipping**
- Current branch: `codex/issue-67-security-outbox`
- Current base: `7829d9e`
- Frozen v1 source commit: `429cf07e451b64ca1713655a34ffa5ebd376efae`
- ADR index: [`docs/adr/README.md`](../adr/README.md)
- V1 reuse manifest: [`docs/rebuild/v1-reuse-manifest.json`](v1-reuse-manifest.json)
- Guardrail policy: [`docs/rebuild/ARCHITECTURE-GUARDRAILS.md`](ARCHITECTURE-GUARDRAILS.md)

## GitHub planning

- Master: [#65 — Tapboard clean rebuild](https://github.com/joe-cole1/home-assistant-tapboard/issues/65)
- 1. [#66 — Foundation, runtime, and clean schema baseline](https://github.com/joe-cole1/home-assistant-tapboard/issues/66)
- 2. [#67 — Security, Activity, secrets, and bounded outbox primitives](https://github.com/joe-cole1/home-assistant-tapboard/issues/67)
- 3. [#68 — Physical Kegs](https://github.com/joe-cole1/home-assistant-tapboard/issues/68)
- 4. [#69 — Custom and Brewfather-linked Beverages](https://github.com/joe-cole1/home-assistant-tapboard/issues/69)
- 5. [#70 — Fills and On Deck](https://github.com/joe-cole1/home-assistant-tapboard/issues/70)
- 6. [#71 — Taps and assignment lifecycles](https://github.com/joe-cole1/home-assistant-tapboard/issues/71)
- 7. [#72 — Telemetry sources, API, and idempotent ingestion](https://github.com/joe-cole1/home-assistant-tapboard/issues/72)
- 8. [#73 — Telemetry epochs, baselines, and deterministic pour detector](https://github.com/joe-cole1/home-assistant-tapboard/issues/73)
- 9. [#74 — Pour history and Fill forecasting](https://github.com/joe-cole1/home-assistant-tapboard/issues/74)
- 10. [#75 — Draft health and Tap maintenance](https://github.com/joe-cole1/home-assistant-tapboard/issues/75)
- 11. [#76 — SSR Admin/public dashboard, SSE, and display preferences](https://github.com/joe-cole1/home-assistant-tapboard/issues/76)
- 12. [#77 — Brew Story, sensory guidance, and Mystery Tap](https://github.com/joe-cole1/home-assistant-tapboard/issues/77)
- 13. [#78 — Tap Wars](https://github.com/joe-cole1/home-assistant-tapboard/issues/78)
- 14. [#79 — Outbound Home Assistant and webhook delivery workers](https://github.com/joe-cole1/home-assistant-tapboard/issues/79)
- 15. [#80 — System and local operator functions](https://github.com/joe-cole1/home-assistant-tapboard/issues/80)
- 16. [#81 — Deployment, documentation, and final acceptance](https://github.com/joe-cole1/home-assistant-tapboard/issues/81)

The list preserves the frozen implementation sequence. Issue #67 currently contains local security/session, Activity/deletion-audit, event, encrypted-secret, machine-key, and bounded-outbox primitives. It has not been committed, pushed, or opened as a PR under the repository shipping policy.

## Implemented in Foundation

- Node 24 ESM runtime with native erasable TypeScript and `tsc --noEmit` checking;
- explicit application composition, Node HTTP lifecycle, and exactly `GET /healthz` for local application/database readiness;
- file-based Eta rendering with default escaping plus layout/partial proof templates;
- one controlled `better-sqlite3` connection, foreign keys, transactional versioned migrations, exact version-2 schema validation, and resource closure;
- shared typed errors, centralized HTTP error mapping, explicit validation, and structured redacting logging;
- Foundation- and #67-aware architecture guardrails and negative fixtures;
- canonical external-origin/trusted-proxy/session configuration and stdin-only operator PIN/key maintenance commands;
- schema version 2 security/session, Activity/deletion-audit, stable event, secret, machine-key, and bounded-outbox primitives;
- explicit `not_queued_capacity` degradation semantics; no provider adapters, delivery workers, or browser feature pages;
- canonical `npm run check` covering format, lint, types, architecture/reuse integrity, and `node:test`;
- Node 24 CI running `npm ci`, the canonical gate, and changed-line whitespace validation.

Schema version 2 contains typed #67 primitives and no v1 data adoption. The PIN remains exactly four ASCII digits with limited stolen-verifier offline resistance; integration encryption relies on independent external `TAPBOARD_SECRET_KEY` material. Activity never recursively enters the outbox, and `not_queued_capacity` is a fixed-slot bounded degradation state rather than a storage-error classification. Domain entities/workflows, provider adapters, delivery workers, telemetry, UI, and deployment remain deferred. The local branch is awaiting review; no shipping action has been authorized.

## Deferred validation tiers

Playwright/browser E2E is intentionally not introduced in #66 because no feature UI or workflow exists. No E2E tests ran or passed; that tier is deferred to issue #76. A staged-file pre-commit formatter and hook dependency are also not introduced; the canonical local and CI gate is authoritative for Foundation.
