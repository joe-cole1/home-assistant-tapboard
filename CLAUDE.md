# Tapboard — instructions for Claude Code

Tapboard is a self-hosted taproom display for one homebrewing household: Node 24, SQLite, and
server-rendered HTML. It shows what is on tap, detects pours from keg-scale telemetry, syncs
recipes from Brewfather, computes deterministic flavor guidance, and raises health incidents that
can be delivered to any configured destination.

**Source code and executable configuration are the source of truth.** If documentation disagrees
with the code, trust the code and fix or flag the document. `docs/rebuild/` and `docs/adr/`
record how the v2 rebuild was designed; read them for background, not as requirements.

## Product principles

- Hands-off: prefer automation over features that need regular manual data entry.
- No single hard dependency: Tapboard keeps working when Home Assistant, Brewfather, or a
  destination is down. Integrations are optional edges, never the core.
- Flexible edges: any device can post to the telemetry API, and any event (including health
  incidents) can go to any destination. Routing and filtering belong in receivers (Home
  Assistant, n8n, Node-RED), not in Tapboard.
- Real data runs on the operator's VPS: every change must upgrade existing databases safely.

## Commands

- Install: `npm ci` (Node 24; `better-sqlite3` may need a C/C++ toolchain to build).
- Run: `npm start` → http://127.0.0.1:3000, where `GET /healthz` is readiness. The database
  defaults to `data/tapboard-v2.sqlite3`; set `TAPBOARD_DATABASE_PATH` for a throwaway one.
- Full gate: `npm run check` (format, lint, types, architecture guardrails, unit tests).
- One test file: `node --test test/<name>.test.ts`.
- Browser tests: `npm run test:e2e`. Locally, run `npx playwright install chromium` once. Cloud
  sessions use the preinstalled Chromium through `TAPBOARD_E2E_CHROMIUM_PATH`, which the
  SessionStart hook sets; don't run `playwright install` there.
- Format: `npm run format`.

## Where things live

- `src/application.ts`: the composition root. It builds services and wires cross-feature
  callbacks explicitly; don't add a DI container, service locator, or event bus.
- `src/features/<feature>/`: `service.ts` (behavior), `repository.ts` or `repositories/` (all
  SQL), `*-validation.ts`, `types.ts`, `routes.ts`.
- Telemetry in: `telemetry/` (`/api/v1/telemetry`, contract in `openapi/telemetry-v1.json`) →
  `telemetry/detector.ts` (pure pour detector) → pours, forecasts, and `health/` incidents.
- Events out: `events/` (envelope) → `outbox/` → `outbound/` (Home Assistant and webhook
  transports).
- Brewfather: `beverages/brewfather/`. Flavor: `story/flavor/` (pure functions).
- `src/features/web/` and `views/`: server-rendered Admin and public pages (Eta). `public/js/` is
  progressive enhancement only; pages must work without JavaScript.
- `src/infrastructure/database/`: the SQLite connection and append-only migrations.
- `src/features/simulation/`: the built-in sample workspace on a second database. It's the main
  development tool while hardware is unavailable; don't break it.

## Rules that matter

- SQL only in `repository.ts`, `repositories/*.ts`, and `src/infrastructure/database/`;
  `better-sqlite3` only in `connection.ts`. `npm run check:architecture` enforces both.
- Never do network I/O inside `withTransaction`. After any `await`, re-check that what you're
  about to write, or act on remotely, is still current.
- Migrations: append a new version in `migrations.ts`; never edit, reorder, or squash shipped
  migrations.
- Never send a stored credential to a host other than the one it was entered for.
- Public pages and JSON show only what their public projection selects: never secrets, raw
  provider payloads, Admin-only fields, or Mystery-hidden fields.
- External contracts: `/api/v1/telemetry`, `/api/public/*`, and the outbound event envelope
  (`schema_version` 1). Change them only deliberately and backward-compatibly.
- No new runtime dependency, framework, bundler, database, or background service without
  explicit approval.

## Keep it simple

- Make the smallest change that fully solves the task. Reuse existing helpers first.
- No speculative abstractions, configuration options, plugin points, or "future integration"
  seams. Add generality only when a second real use exists.
- No alias exports, duplicate method names, or "backward-compatible" synonyms for internal code.
  Rename and update the callers.
- One canonical input shape per internal API (no camelCase and snake_case variants).
- If existing code is needlessly complex, say so and propose a simplification instead of copying
  the pattern. "Too complex for its value" is a valid reason to revisit a design.
- In the PR description, justify any new table, background job, or abstraction by the concrete
  requirement it serves.

## Tests

- Test behavior: pure calculations, data transformations, HTTP, telemetry, and event contracts,
  and privacy guarantees. Avoid asserting incidental markup or class names.
- Never delete, skip, or weaken a test to make a change pass. Change a test only when behavior
  intentionally changes, and say so in the PR.
- Every bug fix gets a regression test that fails without the fix.

## Documentation

- When behavior, setup, configuration, or commands change, update `README.md`, `architecture.md`,
  `docs/operations.md`, or `openapi/` in the same change. Docs describe the current state;
  history belongs in git and PR descriptions.
- Every implementation PR description includes a `## MANUAL DEV TEST` section: short,
  issue-specific steps the operator runs against a rebuilt development container. Never add these
  steps to README or other docs.

## Safety

- Never read or print `.env`, keys, tokens, or the Admin PIN.
- Never call live Brewfather or Home Assistant, touch the VPS, or delete Docker volumes
  (`down --volumes`) or development databases.
- Ask before dependency changes, schema migrations, feature removals, or deployment changes.

## Before asking to ship

- Run `npm run check`, plus `npm run test:e2e` when UI or routes changed.
- For changes to migrations, auth, secrets, outbound, telemetry ingest, or transactions, run
  `/code-review` and `/security-review` on the diff and address or rebut every finding.
- Use plan mode before migrations, feature removals, or changes to `src/application.ts` wiring.
- Subagents are optional. Use them for broad read-only searches or independent pieces of work,
  and review every change they make yourself.
- Cloud sessions (claude.ai/code) have no WSL launcher or Docker daemon; say what couldn't be
  verified.

## Operator workstation (WSL): only when `/home/joeadmin/.local/bin/tapboard-dev` exists

- Once the change is ready and `npm run check` passes, run `tapboard-dev rebuild` and then
  `tapboard-dev health` from that path before any commit (standing authorization). The recreated
  container must run the current working tree, including uncommitted changes, and report healthy
  at http://localhost:3000/healthz. Preserve the `tapboard-dev-data` volume and the PIN.
- A rebuild or health failure blocks shipping; report the exact error. On success, present
  http://localhost:3000 and the MANUAL DEV TEST, then wait for "ship it" before committing. A
  passing health check is not "ship it". If runtime code changes afterwards, rebuild again.
- `gh auth status` can falsely fail in WSL. Before reporting an auth problem, confirm with
  `gh api user --jq .login` and a read-only repository command such as `gh repo view`. Never
  print tokens or credential files.
