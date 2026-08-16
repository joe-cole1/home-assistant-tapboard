# Tapboard v2

Tapboard v2 is an ESM modular monolith. Issues #66 and #67 establish the Node 24 Foundation and security/Activity/event/secret/machine-key/bounded-outbox primitives; #85 adds the development-only container workflow; #68–#75 add the domain, telemetry, forecasting, and health boundaries; #76 adds the Eta-rendered Admin/public browser surface, bounded SSE, and display preferences; and #77 adds Brew Story, sensory guidance, Mystery Tap, and Beverage-owned presentation. Production deployment remains deferred to #81.

The current branch implements Issues #66–#77 and the #85 development container. Issue #77 is implemented locally and is in validation before its PR; it is not yet merged. `/` is the authoritative server-rendered public dashboard; `/admin/*` provides the authenticated progressive Admin shell. Home Assistant/webhook delivery, Tap Wars domain behavior, complete System administration, and production deployment remain assigned to later issues.

The frozen v1 application remains available at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. Reusable v1 evidence is indexed in [`docs/rebuild/v1-reuse-manifest.json`](docs/rebuild/v1-reuse-manifest.json); it is reference material, not an active dependency or import source for v2.

## Requirements and setup

Use Node 24 and install the exact locked dependencies:

```sh
npm ci
```

`better-sqlite3` is a native dependency. A platform C/C++ build toolchain is required when npm compiles it during installation (for example, GNU Make and a C++ compiler on Linux).

Start the local Foundation server:

```sh
npm start
```

The defaults are:

| Environment variable             | Default                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `TAPBOARD_HOST`                  | `127.0.0.1`                                                  |
| `TAPBOARD_PORT`                  | `3000`                                                       |
| `TAPBOARD_DATABASE_PATH`         | `data/tapboard-v2.sqlite3` relative to the working directory |
| `TAPBOARD_SHUTDOWN_GRACE_MS`     | `5000`                                                       |
| `TAPBOARD_EXTERNAL_ORIGIN`       | unset; optional exact `http`/`https` origin                  |
| `TAPBOARD_TRUSTED_PROXIES`       | unset; optional comma-separated exact proxy addresses        |
| `TAPBOARD_SESSION_INACTIVITY_MS` | `2592000000` (30 days)                                       |
| `TAPBOARD_SESSION_ABSOLUTE_MS`   | `31536000000` (365 days)                                     |
| `TAPBOARD_SECRET_KEY`            | unset; optional canonical 32-byte base64url key              |

The runtime creates the database parent directory when needed. A ready process returns HTTP 200 from `GET /healthz` with `{"status":"ok","schemaVersion":13}`. This is local application/database readiness only; it does not check external integrations. Public connectivity is a deliberately aggregate dashboard projection; health administration remains authenticated.

The Admin PIN contract is exactly four ASCII decimal digits (`[0-9]{4}`), including every value from `0000` through `9999`; input is never trimmed or Unicode-normalized. Scrypt, durable SQLite throttling, opaque sessions, CSRF, and strict Origin checks protect online/local access, but the 10,000-value space has limited offline resistance if the SQLite verifier is stolen. The PIN never derives or protects `TAPBOARD_SECRET_KEY`.

`TAPBOARD_SECRET_KEY` is an external canonical 32-byte base64url value. Missing, malformed, or incorrect key material degrades encrypted integration-secret availability only; it does not disable local authentication or domain operation and never deletes encrypted rows. Do not place it in command arguments, logs, or browser input.

Local operator maintenance is stdin-only and never accepts secret positional arguments: `npm run operator:reset-pin` reads one exact PIN line, and `npm run operator:rotate-secret-key` reads exact old/new key lines. There is no browser PIN-reset workflow or default PIN. These commands print only safe revision/count metadata.

The runtime has no backend transpiler, application bundler, SPA framework, or HTTP framework. The Docker/Compose surface below is development-only; production image hardening and deployment remain owned by issue #81.

## Updating the local development instance

After a v2 implementation issue is merged, update `main`, rebuild and recreate the development container without deleting its volume, verify readiness, and manually exercise the delivered behavior:

```sh
git switch main
git fetch --prune
git pull --ff-only
docker compose -f compose.dev.yaml up -d --build --force-recreate
docker compose -f compose.dev.yaml ps
curl -fsS http://127.0.0.1:3000/healthz
```

Follow the service logs when diagnosing a rebuild:

```sh
docker compose -f compose.dev.yaml logs -f --tail=200 tapboard
```

Normal rebuilds MUST NOT use `docker compose -f compose.dev.yaml down --volumes`; that intentionally deletes Tapboard development state. `.env.example` is a v2-safe configuration reference to copy into the ignored `.env` file. `compose.production.example.yaml` is only a provisional, non-runnable illustrative deployment contract; it does not claim a production image or acceptance.

## Development container workflow

Install Docker Desktop with the Compose v2 plugin, then create an ignored local `.env` containing an external canonical 32-byte base64url `TAPBOARD_SECRET_KEY`. No real key or default value belongs in Git. A new key can be written without printing it:

```sh
(umask 077; printf 'TAPBOARD_SECRET_KEY=' > .env; openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n=' >> .env; printf '\n' >> .env)
```

Build and start the development service:

```sh
docker compose -f compose.dev.yaml up --build -d
```

Check status and readiness, view logs, and control the service with:

```sh
docker compose -f compose.dev.yaml ps
curl --fail http://127.0.0.1:3000/healthz
docker compose -f compose.dev.yaml logs -f tapboard
docker compose -f compose.dev.yaml stop
docker compose -f compose.dev.yaml restart tapboard
docker compose -f compose.dev.yaml down
docker compose -f compose.dev.yaml up --build --force-recreate -d
```

The app is published at `http://127.0.0.1:3000` (the container listens on `0.0.0.0:3000`), and the actual readiness route is `/healthz`. SQLite lives at `/app/data/tapboard-v2.sqlite3`. The named volume key `tapboard-data` is materialized by Compose as `tapboard-dev_tapboard-data`; stop, ordinary down, restart, recreate, and rebuild preserve it.

### DEV-ONLY destructive reset

This removes the development database volume and must never be used for another Compose project:

```sh
docker compose -f compose.dev.yaml down --volumes
docker compose -f compose.dev.yaml up --build -d
```

This Compose project declares only the Tapboard development data volume, so the command does not target unrelated projects or volumes. A fresh database has no default PIN.

Operator commands require the service to be running; use the documented start command first. Reset the PIN with a hidden shell variable piped over stdin (there is no PIN argument or default):

```bash
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | docker compose -f compose.dev.yaml exec -T tapboard npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
```

Rotate the root key by piping exactly two stdin lines (old key, then new key), without printing either value:

```bash
IFS= read -r -s TAPBOARD_OLD_KEY; printf '\n'
IFS= read -r -s TAPBOARD_NEW_KEY; printf '\n'
printf '%s\n%s\n' "$TAPBOARD_OLD_KEY" "$TAPBOARD_NEW_KEY" | docker compose -f compose.dev.yaml exec -T tapboard npm run operator:rotate-secret-key
```

After a successful rotation, write the new external key to the ignored `.env`, force-recreate the service, and then clear the shell variables:

```sh
(umask 077; printf 'TAPBOARD_SECRET_KEY=%s\n' "$TAPBOARD_NEW_KEY" > .env)
docker compose -f compose.dev.yaml up --force-recreate -d
unset TAPBOARD_OLD_KEY TAPBOARD_NEW_KEY
```

## Canonical validation

Run the complete local gate with Node 24:

```sh
npm run check
```

The gate runs Prettier checking, ESLint, `tsc --noEmit`, architecture and reuse-manifest checks, and the `node:test` suite. CI installs with `npm ci`, runs this same gate under Node 24, and checks changed-line whitespace.

The browser suite is separate so ordinary Node tests do not require a browser binary:

```sh
npx playwright install chromium
npm run test:e2e
```

CI installs Chromium and runs `npm run test:e2e` in its own Node 24 job.

Schema version 13 (`brew-story-sensory-mystery`) is the current supported schema. It adds assignment-owned `tap_assignment_mystery` typed reveal flags with a default-hidden allowlist and preserves assignment-reset semantics. Browser-local overrides, live/SSE state, and effective sensory projections are never persisted in SQLite. `/healthz` reports `schemaVersion: 13` when the database is ready.

The event registry is an explicit allowlist with durable IDs and canonical UTC envelopes. Outbox admission uses hard global/per-destination row and UTF-8 byte bounds, bounded terminal pruning, restricted semantic coalescing, fixed overflow slots, and explicit `not_queued_capacity` degradation semantics. Delivery state is designed for at-least-once processing with leases and compare-and-set results; it does not claim exactly-once network delivery. Providers, workers, webhooks, Home Assistant delivery, and domain producers remain deferred.

The public and Admin pages are Eta SSR with semantic HTML and ordinary forms. Small external ES modules progressively add targeted live refresh, rotation, and per-display preferences; there is no SPA, hydration framework, frontend router, bundler, or client-side application state snapshot.

## Issue #77 Brew Story, sensory guidance, and Mystery Tap

Brew Story is a read-only, server-rendered projection backed by local Tapboard state. The central public projection/redaction boundary serves the dashboard, legacy public taps, Story HTML/JSON, and targeted refreshes; public SSE carries dirty identifiers only. Mystery is owned by the active Tap assignment, uses the exact title `Mystery Tap`, hides Beverage and custom Tap names, and defaults every eligible field to hidden. Its typed reveal allowlist is `beverage_type`, `style`, `abv`, `ibu`, `og`, `fg`, `srm`, `description`, `recipe`, `sensory`, and `history`; Tap number, display color, Fill Glass, remaining/fill percentage, forecast/days/servings, and serving temperature remain visible exemptions.

Sensory guidance exposes only bitterness, sweetness, body, roast, tartness, and alcohol on a bounded public 0–5 scale. Canonical persisted manual overrides and their Admin/API inputs remain the legacy 0–10 scale so all valid pre-v13 state remains truthful; Story maps each valid manual value deterministically by dividing by two. Each axis resolves independently as manual override, recipe prediction, style baseline, or unavailable; effective sensory values are derived and not persisted. Tasting data, malt/hops detail, and fabricated fallback values are not used. Custom recipes are separately editable, while linked, detached, and superseded source snapshots remain read-only and provenance-labelled. Beverage-owned presentation uses the finite 17-ID Fill Glass catalog with the actual v1 static SVG contours, clipped liquid/shadow/foam layers, the reviewed 8-second fill transition, and safe deterministic display color/SRM fallback; arbitrary artwork is not accepted.

### MANUAL DEV TEST — Issue #77

After the normal non-destructive rebuild (`docker compose -f compose.dev.yaml up -d --build --force-recreate`; never use `down --volumes`), verify `/healthz` reports schema version 13. Using disposable entities where mutation is needed, open a normal Brew Story with JavaScript disabled and inspect custom, linked, and detached recipe provenance; check each sensory axis and clear a manual override to expose the next precedence layer. Enable Mystery on an active assignment, confirm the exact `Mystery Tap` title, protected identity, selective reveals, always-visible exemptions, assignment reset after unassign/move, live redaction updates, and dirty-ID-only SSE. Change at least two finite Fill Glass choices and display-color/SRM inputs, confirming distinct safe graphics and stable SVG root identity. Do not delete or repurpose the persistent development volume.

## Issue #75 health and Tap maintenance

Health checks use the exact IDs `low_keg`, `scale_availability`, `suspected_leak`, `serving_temperature`, and `line_cleaning_due`. Typed global defaults flow into nullable per-Tap overrides. `low_keg` and `scale_availability` are enabled by default; leak, serving-temperature, and line-cleaning checks are opt-in. Scale availability reads the latest accepted measurement from the current authoritative source/Tap status independently of serving-epoch state; low-keg, leak, and serving-temperature retain current-epoch provenance isolation. Disabled Taps evaluate; retired Taps skip with deterministic incident resolution.

Current health state is rebuildable and separate from durable incidents/transitions. Acknowledgement does not resolve or hide an incident, and bounded cooldown suppresses repeated incident side effects rather than health truth. Resolved incidents are retained for 365 days and pruned in batches of at most 100; open incidents, current state, and Tap `first_used_at` are never pruned. Tap line maintenance is append-only, due dates are server-derived, `line_cleaned` establishes the line-cleaning baseline only, and private notes are Admin maintenance detail. Durable incidents and maintenance atomically set Tap `first_used_at`.

Accepted telemetry evaluates health after detector processing; assignment, authority, correction, density, configuration, maintenance, startup, and one coalesced periodic sweep also trigger evaluation. Only meaningful changes create Activity. Admin-only detail APIs remain available, while the safe targeted `HealthTargetedUpdate` seam feeds aggregate public card/connectivity refresh without exposing evidence or private notes. There is no public health-detail API or outbound Home Assistant/webhook delivery worker (#79).

### MANUAL DEV TEST — Issue #75

Persistent, safe read-only checks: after the normal rebuild, verify `GET /healthz` returns `{"status":"ok","schemaVersion":11}` and inspect the authenticated Admin health and Tap-maintenance projections without acknowledging incidents, changing configuration/overrides/cooldowns, or recording maintenance. Do not mutate the persistent development volume in this pass.

Ephemeral, mutating smoke: use a disposable database and disposable Tap to exercise a default-enabled check, an opt-in check, a nullable per-Tap override, incident acknowledgement/cooldown, retired-Tap resolution, and append-only line maintenance with a server-derived due date. Confirm durable incidents and maintenance atomically set `first_used_at`, and that `line_cleaned` establishes the line-cleaning baseline only. Maintenance and incidents permanently mark a Tap used; never use a persistent Tap or the named development volume, and do not delete the volume as cleanup. No tests are claimed as run here; this is an operator test plan.

## Issue #76 SSR dashboard, Admin, SSE, and display preferences

The initial public response contains the header, every enabled Tap card in Tap-number order, the reserved hidden Tap Wars slot, and the authoritative On Deck footer. Public refresh endpoints expose purpose-built projections only. Named SSE events carry dirty-target identifiers, not state snapshots; blocked clients have bounded coalesced queues and reconnect through a page-scoped authoritative reconciliation that patches surviving cards in place.

Shared display defaults flow into sparse, strictly validated browser-local overrides stored at `tapboard.v2.display-preferences.v1` with record version `1`. A synchronous external head script applies allowlisted values before CSS to prevent theme flash. Storage failures and malformed values fall back to shared defaults, while the browser `storage` event synchronizes peer tabs.

### MANUAL DEV TEST — Issue #76

Rebuild and recreate normally without deleting `tapboard-dev_tapboard-data`, then confirm `/healthz` reports schema version 12. Check `/` with zero, one, six, and more than six enabled Taps; a disabled Tap; an unassigned Tap; and On Deck entries. Sign in at `/admin/login`, visit every Admin navigation route, submit one representative form with JavaScript disabled, and exercise shared plus local Display settings. In two tabs, verify local preference persistence, reset-to-inherit, and storage synchronization. Update a Tap while the dashboard is open, confirm the field changes without replacing its SVG graphic node, then interrupt/reconnect the event stream and confirm authoritative reconciliation. Inspect approximately 800 px, 1280×720, 1920×1080, and 3840×2160. Use disposable state for destructive fixture scenarios; never delete the persistent volume.

## Authoritative rebuild context

- [`docs/rebuild/TARGET.md`](docs/rebuild/TARGET.md)
- [`docs/rebuild/ARCHITECTURE-DECISIONS.md`](docs/rebuild/ARCHITECTURE-DECISIONS.md)
- [`docs/rebuild/V1-REUSE-CRITERIA.md`](docs/rebuild/V1-REUSE-CRITERIA.md)
- [`docs/rebuild/ARCHITECTURE-FREEZE.md`](docs/rebuild/ARCHITECTURE-FREEZE.md)
- [`docs/adr/`](docs/adr/)
- [`architecture.md`](architecture.md)
- [`docs/rebuild/STATUS.md`](docs/rebuild/STATUS.md)

If these sources appear to conflict, follow the precedence in `ARCHITECTURE-FREEZE.md` and stop on any unresolved conflict.
