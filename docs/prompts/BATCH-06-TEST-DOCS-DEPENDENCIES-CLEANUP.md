# New Codex Task Prompt — Batch 6

Work on **Batch 6 — Test infrastructure, documentation, dependency maintenance, and cleanup** for Tapboard.

## Repository context

- Read `AGENTS.md`, `architecture.md`, and `docs/AUDIT-2026-08-01.md` completely.
- Read `docs/prompts/BATCH-01-POUR-DETECTOR.md` through
  `docs/prompts/BATCH-05-DATABASE-WEBSOCKET-DEPLOYMENT-RELIABILITY.md`, then inspect the completed implementations, tests, and recent history.
- Inspect the current branch and working tree before planning. Preserve unrelated user changes.
- Treat the audit and repository as the canonical handoff; do not rely on prior-chat context.
- Confirm Batches 1–3 and 5 remain complete. Batch 4's recorder work is present, but its physical/mechanical inspection remains deliberately open. Do not mark Batch 4 complete or fold that inspection into Batch 6 without separate evidence and approval.
- The minimum application baseline is **85 passing tests**, a healthy hardened Tapboard container bound exactly to `127.0.0.1:3005`, schema version 2 with `integrity_check=ok`, successful Home Assistant hydration, and host HTTP 200 from `/healthz`.
- Do not regress the deterministic single-active-tap detector, explicit-unit conversion, schema-v2 public projection, compact/coalesced SSE delivery, immediate pour events, targeted DOM updates, security boundaries, fail-closed administrator initialization, immutable keg lifecycles, active-lifecycle forecast isolation, verified backup/restore gates, named-volume persistence, container hardening, or recorder exclusions.

## Known evidence and current implementation

- `package.json` provides `start`, `dev`, `test`, and supported database-maintenance commands, but no real `lint` or combined `check` command.
- No checked-in `.github` workflow or dependency-monitoring configuration was found at the Batch 6 handoff.
- The complete Node 22 glibc suite contains 85 passing tests after Batch 5.
- Version labels drift across the repository: `package.json` and README say 3.2.0, `architecture.md` and `public/index.html` say 3.7.2, `public/app.js` says 3.8.2, `public/styles.css` says 3.5.4, and `public/graphics.js` says 3.7.
- Some architecture/API descriptions still predate the implemented detector, opaque digest-backed administrator sessions, schema-v2 lifecycle model, bounded HA WebSocket hydration, and hardened named-volume deployment.
- `src/checkTaps.js` prints raw tap rows directly from a repository-relative database. `src/enableTap4.js` mutates the database directly without the supported API, validation, lifecycle ownership, backup gate, or named-volume path.
- `config/www/tapboard` contains a second, differing frontend implementation. Its ownership, references, deployment status, and safe disposition must be established before it is changed or deleted.
- The manifest currently declares `bcryptjs`, `better-sqlite3`, `dotenv`, `ws`, and `linkedom`. Major upgrades may exist, but no upgrade is approved merely because it is available. Native compatibility is especially important for `better-sqlite3` and the pinned Node 22 Alpine production image.
- Batch 5 left supported database commands in `scripts/db-maintenance.js` and documented backup, restore, rotation, and two-year pour-retention procedures. Do not replace them with unsafe file copying or ad-hoc SQL.
- The live database and WAL reside in `tapboard_data`; backups reside in `tapboard_backups`. The original OneDrive database, final quiesced backup, rollback image `tapboard:pre-batch5-057bd73`, and disposable rehearsal volumes remain retained rollback artifacts.
- `HA_TOKEN` remains environment-injected by explicit compatibility choice. A prior diagnostic inspection exposed its value in session output, so operator-owned token rotation is an important residual action. Never print, read back, log, or commit the current or replacement value.
- A daily backup scheduler is documented but not installed by the repository; confirm its desired operator-owned implementation rather than assuming one exists.

## Mandatory subagent orchestration

The primary agent is the **orchestrator and verifier**. Use subagents for bounded, independent work whenever the task decomposes cleanly, and use the **least expensive agent that is still capable of the assigned work**.

The task authorization explicitly includes bounded Phase 1 read-only subagents. Do not delegate anything until the orchestrator has personally completed the mandatory repository and instruction reads.

1. The orchestrator must personally read the required repository instructions and prompts, own the plan, obtain user decisions, integrate all changes, review the complete diff, run final verification, and decide whether acceptance criteria are satisfied.
2. During Phase 1, delegate read-only inventories that can run independently, such as version/documentation drift, legacy frontend references, script usage, CI conventions, and dependency release-note research.
3. Prefer a low-cost general coding agent such as `gpt-5.6-terra` at low reasoning for bounded read-only inventory, documentation comparison, reference searches, and simple configuration review.
4. Use a medium-cost agent only when the bounded task needs implementation judgment, such as designing lint rules, a CI workflow, or testing one isolated dependency upgrade. Escalate to a higher-cost model only when a concrete cross-cutting or native-runtime risk cannot reasonably be handled by the lower-cost agent; record why.
5. Give every subagent explicit file ownership and a narrow deliverable. Do not allow concurrent edits to the same files. Because agents share the workspace, the orchestrator must sequence overlapping work and inspect changes immediately.
6. Subagents must not commit, merge, push, delete files, mutate secrets, change Home Assistant or ESPHome, touch live Docker state, retire rollback artifacts, or broaden scope. They report findings and test evidence to the orchestrator.
7. Keep concurrency limited to genuinely independent workstreams. Do not spawn agents merely to restate instructions or perform work the orchestrator must verify directly.
8. After Phase 2 implementation, assign at least one low-cost read-only subagent to review the integrated diff for actionable regressions. The orchestrator must independently validate every reported issue and owns the final release decision.

## Phase 1 — Plan and decisions only

Do not edit files, install or upgrade dependencies, change the lockfile, delete or move the legacy frontend, rotate credentials, alter Docker/HA/ESPHome state, create workflows that run externally, rebuild or restart Tapboard, commit, push, or merge during Phase 1.

Read-only local inspection is allowed when it materially improves the plan. Official release-note/security research may begin only after the user approves the separate network-access gate. For technical dependency research, use primary sources such as official package repositories, release notes, migration guides, and registry metadata. Do not treat an automated “latest” result as sufficient upgrade justification.

Use read-only subagents under the orchestration rules above, then investigate enough to produce a concrete staged plan covering:

1. The exact current Git, Node, npm, test, Docker-build, Compose, container-health, schema, integrity, and audit baselines without exposing secrets.
2. Existing `package.json` commands, test discovery, configuration files, generated files, ignored files, and developer workflow on Windows/WSL and Linux containers.
3. A real linting approach for the current ESM Node and browser code. Define environments, globals, ignores, rule severity, and how existing violations will be handled without broad formatting churn or behavior changes.
4. A reproducible `npm run check` contract. Recommended starting point: lint followed by the complete test suite, with separate build/audit verification where platform-specific native compilation is required.
5. A minimal Node 22 CI workflow using `npm ci` and the lockfile. Define permissions, triggers, caching, timeouts, concurrency cancellation, secret-free behavior, and whether Docker build verification belongs in CI.
6. The canonical application-version source and semantic-version value. Identify every displayed/commented/manifest version and whether each should be derived, synchronized, or removed.
7. Every inaccurate architecture, README, security, and operations statement. Correct only facts supported by code or measured evidence; avoid turning Batch 6 into a redesign.
8. All references to `config/www/tapboard`, its actual consumers, differences from the container frontend, and whether it is still deployed. Prefer clear archival/designation before deletion unless removal is separately proven safe and approved.
9. All ad-hoc scripts, especially `src/checkTaps.js` and `src/enableTap4.js`, including callers and operational intent. Decide whether each should be retired, replaced by a safe supported CLI/API, or documented with strict read-only/backup preconditions.
10. The exact installed and declared direct/transitive dependency baselines, production audit result, available major versions, changelogs, supported Node versions, ESM/API changes, native ABI requirements, and likely lockfile churn.
11. An isolated one-major-at-a-time dependency test method. Each candidate needs its own clean install, focused tests, full suite, production audit, and production Docker/native build evidence so one failure cannot be hidden by another upgrade.
12. Whether a major dependency upgrade is justified now. Deferral with documented evidence is valid; availability alone is not an acceptance criterion.
13. Dependency-monitoring configuration. If approved, define provider, cadence, grouping, labels, open-PR limit, target branch, and whether majors must remain ungrouped for individual review.
14. The supported database-maintenance command surface after script cleanup, including backup scheduler expectations and safe access to named volumes.
15. The HA token rotation procedure as a separate operator-controlled action: revoke the exposed token, create a replacement privately, update the ignored environment file without reading it back, recreate Tapboard, verify hydration, and avoid all secret output. Do not combine rotation with unrelated changes unless explicitly approved.
16. The status and retention of Batch 5 rollback artifacts. Default to retaining the original OneDrive database, final backup, rollback image, and rehearsal volumes; retirement is a separate destructive approval.
17. Deterministic tests or static checks needed for lint configuration, version consistency, documentation links, maintenance CLI safety, CI syntax, and each dependency change.
18. Exact files expected to change, explicit file ownership for subagents, sequencing, commit boundaries, and rollback for each stage.
19. Compatibility risks for Node/npm, browser behavior, native modules, Docker Alpine, GitHub Actions, Windows/WSL paths, ignored secrets, and legacy Home Assistant consumers.
20. Every action that needs network, credential, deletion, external-workflow, live-restart, commit, push, merge, or rollback-artifact approval.

### Decisions requiring explicit confirmation

Walk through material decisions with the user **one at a time**. Present the recommended option first, explain its tradeoffs, then present viable alternatives and wait for an explicit answer. At minimum, obtain decisions for:

- lint tool/rule posture and the exact `check` command;
- CI provider, triggers, permissions, and whether Docker builds run in CI;
- canonical version source and new semantic-version value;
- archival/designation versus deletion of `config/www/tapboard`;
- retirement versus supported replacement for each ad-hoc script;
- each proposed major dependency upgrade individually;
- dependency-monitoring provider, cadence, grouping, and PR policy;
- operator-owned HA token rotation and the separately authorized live recreation;
- daily backup scheduler ownership and implementation expectations;
- whether any Batch 5 rollback artifact may be retired;
- commit structure, merge target, and every required post-commit live rebuild/restart.

End Phase 1 with a complete plan, subagent assignment matrix, expected files, isolated upgrade order, test matrix, commit/rollback structure, and explicit approval gates. General implementation approval does not authorize dependency majors, deletions, secret changes, external workflow effects, live restarts, commits, pushes, merges, or artifact retirement unless those exact actions were included and approved.

## Phase 2 — Only after explicit approval

Implement only the approved stages. Continue using the least-cost capable subagents for non-overlapping bounded work while the primary agent remains orchestrator and verifier.

### Orchestrator responsibilities

1. Reconfirm the working tree and live baseline, preserve unrelated changes, and record which approval gates are open.
2. Assign explicit non-overlapping files/workstreams to subagents and prevent shared-file races. Review every subagent result before integration.
3. Establish lint/check/CI infrastructure without mass reformatting, generated noise, weakened rules, or suppressions that conceal real defects.
4. Keep tests deterministic and compatible with the supported Node 22 glibc environment. Do not make tests depend on live Home Assistant, secrets, the live database, or Internet availability.
5. Make documentation and version changes mechanically verifiable where practical. Do not claim deployment, security, or compatibility behavior without evidence.
6. Do not delete or mutate the legacy frontend until its ownership and references are proven and the exact disposition is approved.
7. Retire unsafe scripts only after proving no supported workflow depends on them; replace needed behavior with validated, documented commands that respect named-volume and backup boundaries.
   Any retained or replacement diagnostic must use an explicit supported data target and emit only a minimal redacted projection; it must never default to the repository-relative legacy database or print complete rows/private fields.
8. Upgrade at most one major dependency at a time. Capture the pre-upgrade lockfile state, use official migration guidance, run the complete isolated verification matrix, and revert only that upgrade if it fails.
9. Treat `better-sqlite3` as a native-runtime gate: verify clean installation and the actual pinned production image, database open, schema v2, foreign keys, backup/restore tooling, and graceful shutdown.
10. Validate dependency-monitoring configuration locally where possible and use least-privilege workflow permissions. Do not trigger or merge external automated pull requests as part of configuration creation.
11. Rotate the HA token only through the separately approved operator-controlled procedure. Never print `.env`, `Config.Env`, token values, Authorization headers, or command output capable of revealing them.
12. Do not change detector behavior, HA/ESPHome configuration, database schema/data, forecast/lifecycle semantics, Compose networking/storage/privileges, or retention policy unless a newly discovered dependency is explained and separately approved.
13. Run focused checks first, then `npm run check`, the full suite, production audit, Compose validation, and the production Docker build as applicable.
14. Use a final read-only subagent review, validate its findings, inspect the complete diff, run `git diff --check`, and verify only approved files changed.
15. Update `architecture.md`, README/operations documentation, and `docs/AUDIT-2026-08-01.md` only with implemented behavior and measured evidence. Keep Batch 4's physical/mechanical item open.
16. Do not create a commit until the user has approved the corresponding post-commit live rebuild required by `AGENTS.md`. After **every** commit, immediately run `docker compose up -d --build`, confirm the `tapboard` container is healthy and bound exactly to host port `3005`, verify host `/healthz` returns HTTP 200, and confirm HA hydration without inspecting environment values.
17. Push or merge only after explicit approval. Never retire rollback artifacts as an incidental cleanup step.

## Minimum verification targets

The approved plan may make these stricter but must not weaken them without explanation:

- The original 85-test baseline remains green in the supported Node 22 glibc environment.
- `npm test`, a real `npm run lint`, and the combined `npm run check` exist and pass from a clean lockfile install.
- Lint configuration distinguishes Node, browser, and test environments without blanket disabling or unrelated formatting churn.
- CI uses reproducible `npm ci`, least-privilege permissions, bounded timeouts, and no repository or Home Assistant secrets.
- The production Docker image still builds from its pinned base and `npm audit --omit=dev` has no unreviewed high/critical finding.
- All version surfaces follow the approved canonical source/value or intentionally omit redundant version labels.
- Architecture and operations documentation accurately describe the implemented detector, projection/SSE, administrator sessions, schema-v2 lifecycles/forecast, WebSocket bounds, container hardening, named volumes, backups, retention, and startup gates.
- The legacy frontend is either demonstrably unreferenced and explicitly approved for removal, or clearly designated/archived with its relationship to the container frontend documented.
- Every retained maintenance command has validation, safe paths, documented preconditions, and deterministic tests where appropriate; unsafe ad-hoc mutation paths are retired only with approval.
- Every accepted major dependency upgrade has isolated clean-install, focused-test, full-suite, audit, and production-build evidence. Deferred upgrades have a documented reason.
- Native SQLite behavior remains verified after any relevant dependency change: schema v2, `foreign_keys=ON`, `integrity_check=ok`, zero violations, index-backed forecast query, and supported backup/restore commands.
- Dependency-monitoring configuration validates and matches the approved cadence/grouping if added.
- If token rotation is approved, the old token is revoked, the replacement is never displayed, Tapboard is recreated, HA hydration succeeds, and no secret-bearing output enters the repository or audit.
- The daily backup scheduler decision and operator ownership are documented; no scheduler is claimed unless actually configured and verified.
- Batch 5 rollback artifacts remain intact unless their exact deletion was separately approved.
- Batch 4 remains open unless the physical/mechanical checklist is independently completed with evidence.
- `git diff --check`, the complete approved verification matrix, post-commit Compose rebuild, exact loopback port 3005, container health, and host HTTP 200 all pass. The working tree is clean after all approved changes are committed, or contains only the intentional reviewed changes before an approved commit.

## Explicit live and external-action gates

Treat these as separate approvals; one does not imply another:

1. Edit tracked tooling, CI, documentation, cleanup, dependency, and test files.
2. Access the network for dependency metadata or package installation.
3. Change the lockfile or accept any major dependency upgrade.
4. Add or enable an external CI/dependency-monitoring workflow.
5. Archive, move, or delete the legacy frontend or ad-hoc scripts.
6. Rotate/revoke the HA token and recreate the live container.
7. Commit changes, which triggers the mandatory local Compose rebuild/restart.
8. Push a branch or merge it into another branch.
9. Remove the original OneDrive database, final backup, rollback image, rehearsal volumes, or any other rollback artifact.

## Scope exclusions

- No detector threshold, arbitration, volume, cooldown, or unit-conversion redesign.
- No Home Assistant or ESPHome functional/configuration change, recorder mutation, or physical/mechanical work.
- No database schema/data migration, pour deletion, forecast/lifecycle semantic change, or retention-policy change.
- No Compose port, storage, privilege, base-runtime, or secret-injection redesign unless separately approved after a new dependency is proven.
- No secret value display, `.env` dump, raw Docker environment inspection, or sensitive database-row output.
- No remote deployment, automated dependency PR merge, release publication, tag creation, or rollback-artifact retirement without separate approval.

## Completion report

When complete, report:

- Outcome first and whether Batch 6 is fully complete or has intentionally deferred items.
- Subagents used, their bounded assignments, cost/capability choice, and how the orchestrator verified their work.
- Files changed, commits created, branch/merge/push status, and clean-worktree result.
- Test/lint/check/CI design and reproducibility evidence.
- Canonical version and every reconciled version/documentation surface.
- Legacy frontend and ad-hoc script disposition, including any retained compatibility path.
- Each dependency evaluated, accepted/deferred version change, migration impact, and isolated test/audit/build evidence.
- Dependency-monitoring policy if configured.
- HA-token rotation outcome without secret values, backup-scheduler status, and retained rollback artifacts.
- Focused checks, full 85-plus-test suite, production audit, Docker build, Compose validation, post-commit rebuild, port-3005, HA hydration, and `/healthz` results.
- Compatibility changes, residual risks, Batch 4's still-open status, and the safest next step.
