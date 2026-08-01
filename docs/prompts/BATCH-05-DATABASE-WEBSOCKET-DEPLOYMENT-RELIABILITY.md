# New Codex Task Prompt — Batch 5

Work on **Batch 5 — Database, forecast, WebSocket, and deployment reliability** for Tapboard.

Repository context:

- Read `AGENTS.md`, `architecture.md`, and `docs/AUDIT-2026-08-01.md` completely.
- Read `docs/prompts/BATCH-01-POUR-DETECTOR.md` through `docs/prompts/BATCH-04-ESPHOME-HA-TELEMETRY-HYGIENE.md`, then inspect the completed implementations, tests, and recent history.
- Inspect the current branch and working tree before planning. Preserve unrelated user changes.
- Treat the audit and repository as the canonical handoff; do not rely on prior-chat context.
- Confirm Batches 1–3 remain complete and Batch 4's recorder work is present. Batch 4 still has a deliberately open physical/mechanical inspection item; do not mark it complete or fold it into Batch 5 without separate evidence.
- The minimum application baseline is **60 passing tests**, a healthy Tapboard container bound to host port `3005`, and HTTP 200 from `/healthz`.
- Do not regress the deterministic single-active-tap detector, explicit-unit conversion, schema-v2 public projection, compact/coalesced SSE delivery, immediate pour events, targeted DOM updates, security boundaries, fail-closed administrator initialization, or recorder exclusions.

Known evidence and current implementation:

- `src/db.js` opens `data/tapboard.db` with `better-sqlite3`, WAL mode, and `synchronous = NORMAL`, but does not enable SQLite foreign-key enforcement.
- Schema changes are currently attempted with repeated `ALTER TABLE` statements whose exceptions are all silently suppressed. There is no explicit schema-version migration framework.
- `pour_logs` has `tap_id`, nullable `batch_id`, `volume_poured_oz`, and a SQLite `CURRENT_TIMESTAMP`, but physical pour insertion currently writes only `tap_id` and volume. The declared foreign key covers only `tap_id`.
- `pour_logs(tap_id, timestamp)` lacks a supporting index.
- `src/kegForecast.js` normalizes mixed SQLite/ISO timestamps through `unixepoch(timestamp)` and bounds the window to 14 days. Preserve this improvement unless evidence supports a safer replacement.
- The current forecast workaround deletes every `pour_logs` row for a tap when its batch assignment changes, is cleared, or an end-batch/end-keg action succeeds. This prevents cross-keg forecasts but destroys durable pour history and cannot distinguish successive kegs that use the same Brewfather batch ID.
- Forecast UI is intentionally hidden when the active lifecycle has no usage data. Do not restore fabricated default consumption.
- `src/haClient.js` keeps pending WebSocket requests in a map without per-request timeout or close-time rejection. Its hydration `eventQueue` is unbounded, authentication failure lacks a terminal/retry policy, and connection-state notifications can repeat.
- The Docker runtime uses root, publishes `3005` on all host interfaces, passes the HA token as a normal environment variable, uses a floating Alpine base tag, and bind-mounts `./data` from a OneDrive-synchronized repository.
- A prior consistent SQLite online backup exists under the ignored `data/backups/` directory, but Batch 5 must design and verify a repeatable backup **and restore** procedure rather than relying on that one artifact.
- Batch 4 excluded and purged only the two exact fast HA sensor histories. Home Assistant and ESPHome changes are out of scope for Batch 5 unless a newly discovered dependency is explained and separately approved.

## Phase 1 — Plan only

Do not edit files, install dependencies, migrate or copy the live database, restart/rebuild Tapboard, change Docker storage, alter secrets, mutate Home Assistant, push, merge, or spawn subagents yet.

Read-only inspection of the local Tapboard container and database is allowed when it materially improves the plan. Use bounded queries and summarize results. Never print the HA token, administrator PIN, bearer tokens, session digests, `.env` contents, full database rows containing private values, or unrelated Home Assistant state.

Investigate enough to produce a concrete, staged implementation plan covering:

1. The complete current schema, row counts, `PRAGMA` state, indexes, foreign-key definitions, database/WAL sizes, integrity result, and every code path that inserts, updates, forecasts from, or deletes pour history.
2. A durable lifecycle identity model. Distinguish Brewfather `batch_id` from a specific keg/tap assignment instance so that two kegs from the same batch cannot share a forecast. Prefer an immutable internal lifecycle or keg-instance ID, and explain its ownership and creation/closure rules.
3. The exact semantics for assignment, reassignment, end batch, end keg, override-only beverages, application restart, HA resync, and a pour completing while an assignment changes. Define which identity a physical pour records and how race-free capture is achieved.
4. A migration from existing nullable/unscoped `pour_logs`. Specify how legacy rows are preserved, whether they remain forecast-ineligible or are assigned only when evidence is unambiguous, and how rollback avoids data loss.
5. Forecast query semantics scoped to the active lifecycle. Preserve normalized timestamps, a defensible elapsed-day denominator, the 14-day window, no fabricated baseline, and hidden output when evidence is insufficient. Do not delete history merely to reset a forecast.
6. Required indexes based on actual query shapes and `EXPLAIN QUERY PLAN`, including the active lifecycle plus timestamp path. Avoid speculative indexes that do not serve a demonstrated query.
7. Foreign-key enforcement and relationships. Account for SQLite's per-connection `PRAGMA foreign_keys = ON`, migration order, existing orphan detection, delete/update actions, and test behavior.
8. A real migration mechanism with explicit schema versioning and transactions. Expected idempotent cases must be distinguished from corruption, syntax errors, constraint failures, disk errors, and incompatible schema. Startup must fail safely on unexpected migration failure.
9. HA WebSocket request lifecycle: bounded request timeouts, rejection/cleanup on close and authentication failure, send-callback errors, subscription identity, reconnect timer ownership, duplicate-connection prevention, and deterministic state transitions.
10. Hydration buffering: a justified event/byte bound, overflow behavior, snapshot retry behavior, ordering guarantees, and detector safety. Do not allow stale buffered telemetry to create pours after reconnect.
11. Authentication and reconnect policy for `auth_invalid`, transient network failures, repeated close/error events, and clean shutdown. Avoid both infinite tight retries and permanent silent stalling.
12. Container least privilege: non-root UID/GID, writable-path ownership, read-only root filesystem feasibility, temporary directories, dropped capabilities, `no-new-privileges`, init/signal handling, and healthcheck compatibility.
13. Network and secret handling alternatives. Explain the operational impact of loopback-only versus LAN binding and whether Docker secrets or a token file can replace the environment variable without breaking the local deployment.
14. Database persistence alternatives that move the live SQLite database and WAL files off OneDrive. Compare a Docker named volume with an explicit local non-synchronized host path, including observability, backup access, Windows/WSL behavior, permissions, and rollback.
15. A repeatable SQLite-safe backup process using the online backup API or an equivalent consistent mechanism, with timestamps, retention, permissions, integrity checks, and no secret disclosure.
16. A restore rehearsal performed against a disposable copy or isolated test container before any live storage migration. Define objective checks: `integrity_check`, schema version, representative counts, critical relationships, initialization state, and successful application startup.
17. A live storage-migration runbook: preflight free space, quiesce boundary, final online backup, copy/restore, permissions, Compose change, first start, rollback trigger, and proof that the original database remains recoverable.
18. Deterministic tests for database migration, lifecycle attribution, same-batch successive kegs, legacy rows, forecast isolation, timestamp normalization, indexes/foreign keys, WebSocket timeout/disconnect/auth/overflow paths, and non-regression of all prior behavior.
19. Exact files expected to change. Likely files include `src/db.js`, `src/server.js`, `src/haClient.js`, `src/kegForecast.js`, `Dockerfile`, `docker-compose.yml`, tests, and documentation, but include only files justified by the approved design.
20. Compatibility risks, downtime, migration/rollback behavior, data-retention consequences, and every decision requiring explicit approval.

Walk through each material decision with the user **one at a time**. Present the recommended option first, explain the tradeoff, then present viable alternatives and wait for an explicit answer. At minimum, obtain decisions for:

- lifecycle/keg-instance identity and treatment of legacy pour rows;
- whether historical pour logs are retained indefinitely or under an explicit retention policy;
- named Docker volume versus an explicit local non-OneDrive host path;
- loopback-only versus LAN port binding;
- HA token environment compatibility versus secret-file migration;
- the container-hardening set and any required filesystem changes;
- backup retention and restore-rehearsal procedure;
- acceptable Tapboard downtime and the live database/storage migration gate.

End Phase 1 with a complete plan, exact migration stages, rollback artifacts, and explicit approval gates. General implementation approval does not authorize moving or overwriting the live database, deleting history, changing network reachability, changing secret injection, or restarting the production container unless those exact actions were included and approved.

## Phase 2 — Only after explicit approval

Implement the approved code and disposable/offline tests before touching live persistence. Do not use subagents unless the user explicitly requests delegation or parallel agent work.

Orchestrator responsibilities:

1. Maintain the approved plan and preserve unrelated changes.
2. Capture pre-change repository, container, database, schema, integrity, row-count, port, and health baselines without exposing secrets.
3. Create a consistent online database backup before any schema or storage mutation; verify it independently.
4. Build migrations that are transactional, versioned, idempotent where intended, and fail closed on unexpected errors.
5. Preserve existing pour history. Never use broad `DELETE`, replacement, or destructive filesystem commands as a migration shortcut.
6. Make lifecycle attribution atomic with pour insertion. Forecast only from the active lifecycle and retain prior lifecycles for audit/history.
7. Add only query-backed indexes and verify their use with deterministic query plans.
8. Enable and test foreign-key enforcement on every application database connection. Audit existing rows before applying constraints.
9. Make WebSocket cleanup and retry behavior deterministic under close, error, timeout, authentication failure, hydration overflow, and shutdown.
10. Keep detector ingestion safe across hydration/reconnect; no queued stale event may synthesize a physical pour.
11. Build and test the non-root container against a disposable database first. Prove required paths are writable and unrelated paths are not.
12. Rehearse backup restore and any persistence move in isolation. Do not point the production Compose service at new storage until the rehearsal passes and the live-change gate is approved.
13. Stop before each live action whose interruption or rollback scope differs from the approved offline work.
14. After each commit, follow `AGENTS.md`: rebuild/restart the local Compose service, confirm the `tapboard` container is bound to host port `3005`, and verify `/healthz` returns HTTP 200.
15. Review the complete diff, run `git diff --check`, and verify only approved files changed.
16. Update `architecture.md`, operational backup/restore documentation, and `docs/AUDIT-2026-08-01.md` only with implemented behavior and measured evidence.

## Minimum verification targets

The approved plan may make these stricter but must not weaken them without explaining why:

- A pre-migration backup passes `PRAGMA integrity_check` and remains untouched through rollout.
- A disposable restore from that backup passes integrity, schema-version, relationship, representative-count, and startup checks.
- Existing pour rows survive migration with volumes and timestamps unchanged.
- Every new physical pour captures the active immutable lifecycle identity atomically; no-assignment behavior is explicit and tested.
- Two successive kegs using the same external `batch_id` receive different lifecycle identities and never share forecast usage.
- Changing or ending a keg resets the active forecast without deleting historical pour logs.
- Forecast queries use normalized SQLite time semantics, exclude legacy/other-lifecycle rows, use the intended index, and return no fabricated estimate without usage.
- `PRAGMA foreign_keys` is enabled and orphan/constraint tests fail safely.
- Re-running the current migration is a no-op; an unexpected migration error aborts startup and leaves the prior schema/data intact.
- Every pending HA request settles exactly once on response, timeout, disconnect, authentication failure, send failure, or shutdown.
- Hydration buffering remains within the approved bound, preserves valid ordering, and fails into a fresh snapshot without creating a false pour.
- Reconnect timers/connections do not multiply, and connection-state notifications are edge-triggered rather than duplicated.
- The production image runs as the approved non-root identity and starts with the approved least-privilege settings.
- The selected storage location is not inside the OneDrive repository, and the application uses it successfully after an approved migration.
- Rollback to the original storage and Compose definition is documented and tested as far as safely possible.
- Port `3005` has exactly the approved bind scope and `/healthz` returns HTTP 200.
- All 60 pre-Batch-5 tests plus new focused tests pass in the repository's supported Node/glibc environment.
- No Home Assistant or ESPHome configuration/state is changed.

## Live-change gates

Treat these as separate approvals; one does not imply another:

1. Edit tracked application, migration, container, test, and documentation files.
2. Run an offline migration and restore rehearsal using disposable database copies.
3. Change live port binding, secret injection, or container privilege settings.
4. Stop/rebuild Tapboard against its current live database for schema migration.
5. Move live database persistence off OneDrive and start against the new storage.
6. Remove or retire the original storage only after an explicitly approved observation period. Prefer retaining it as a rollback artifact.

When complete, report:

- Outcome first.
- Files changed and commits created.
- Schema versions, lifecycle model, legacy-row treatment, foreign keys, and indexes.
- Forecast semantics and proof that successive kegs remain isolated without deleting history.
- WebSocket bounds, timeouts, cleanup, reconnect behavior, and failure tests.
- Container user, least-privilege settings, port scope, secret handling, and storage location.
- Backup and restore artifacts, integrity results, representative counts, and rollback procedure.
- Offline rehearsal and live migration/restart results, clearly separated.
- Focused and full-suite test results.
- Batch 5 acceptance criteria satisfied or still open.
- Important decisions, downtime, compatibility changes, and residual risks.
- Current port-3005 and `/healthz` status.
- The safest next step.
