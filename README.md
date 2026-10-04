# Tapboard v2

Tapboard v2 is a Node 24 modular monolith with server-rendered public and Admin pages, a clean SQLite domain model, canonical machine telemetry, deterministic pour detection, forecasting, health, Brew Story/Mystery, Tap Wars, optional outbound integrations, saved Simulation, and System administration. `/` is the authoritative public dashboard; `/admin/*` provides ordinary authenticated forms with progressive browser enhancements.

The v2 implementation is prepared as application version **2.0.0**, schema **23**. [The acceptance ledger](docs/rebuild/STATUS.md) records exact checks and review/merge status for #80, #81, and master #65. Building and testing do not publish a release or deploy a service. The rebuild and follow-up issues #111–#114 are merged and closed. The [transition audit](docs/rebuild/TRANSITION-AUDIT.md) distinguishes the accepted v2 baseline from unresolved v1 parity decisions.

The frozen v1 application remains available at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and through Git history. Reusable v1 evidence is indexed in [`docs/rebuild/v1-reuse-manifest.json`](docs/rebuild/v1-reuse-manifest.json); it is reference material, not an active dependency or import source for v2.

## Requirements and setup

Use Node 24 and install the exact locked dependencies:

```sh
npm ci
```

`better-sqlite3` is a native dependency. A platform C/C++ build toolchain is required when npm compiles it during installation (for example, GNU Make and a C++ compiler on Linux).

Start the local server:

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

The runtime creates the database parent directory when needed. A ready process returns HTTP 200 from `GET /healthz` with `{"status":"ok","schemaVersion":23}`. This is local application/database readiness only; it does not check external integrations. Public connectivity is a deliberately aggregate dashboard projection; health administration remains authenticated.

The Admin PIN contract is exactly four ASCII decimal digits (`[0-9]{4}`), including every value from `0000` through `9999`; input is never trimmed or Unicode-normalized. Scrypt, durable SQLite throttling, opaque sessions, CSRF, and strict Origin checks protect online/local access, but the 10,000-value space has limited offline resistance if the SQLite verifier is stolen. The PIN never derives or protects `TAPBOARD_SECRET_KEY`.

`TAPBOARD_SECRET_KEY` is an external canonical 32-byte base64url value. Missing, malformed, or incorrect key material degrades encrypted integration-secret availability only; it does not disable local authentication or domain operation and never deletes encrypted rows. Do not place it in command arguments, logs, or browser input. Brewfather API keys are encrypted in the shared server database; the root key is configured once on the server, and displays and browsers need no separate encryption setup.

Local operator maintenance is stdin-only and never accepts secret positional arguments: `npm run operator:reset-pin` reads one exact PIN line, and `npm run operator:rotate-secret-key` reads exact old/new key lines. There is no browser PIN-reset workflow or default PIN. These commands print only safe revision/count metadata.

The runtime has no backend transpiler, application bundler, SPA framework, or HTTP framework.

## Production Git-context builds

The root `Dockerfile` is the default for existing Compose `build.context: <repository>#main` configurations; no `dockerfile:` override is needed. It uses a digest-pinned, multi-stage Node 24 image, installs only locked production npm dependencies in the runtime, and includes `wget` for existing health checks. `Dockerfile.dockerignore` admits only the reviewed runtime build inputs and excludes environment files, keys, databases, logs, and host dependencies. Git credentials belong to the deployment tool, never build arguments or committed URLs.

The image runs as `node` (UID/GID 1000), listens on `0.0.0.0:3005` by default, and stores v2 SQLite at `/app/data/tapboard-v2.sqlite3`. Existing port `3005:3005`, UID `1000:1000`, read-only root, writable data volume, `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, `init`, and 15-second stop grace settings remain usable. `GET` and `HEAD /healthz` share readiness semantics, including the existing `wget --no-verbose --tries=1 --spider http://localhost:3005/healthz` probe. The image supplies a health check as well; Compose may override it.

For existing external env files, the following narrow aliases remain supported:

| Canonical setting          | Existing deployment fallback           |
| -------------------------- | -------------------------------------- |
| `TAPBOARD_PORT`            | `PORT`                                 |
| `TAPBOARD_DATABASE_PATH`   | `DATA_DIR` plus `/tapboard-v2.sqlite3` |
| `TAPBOARD_EXTERNAL_ORIGIN` | `TAPBOARD_PUBLIC_ORIGIN`               |

Canonical settings always win and retain validation, even when invalid or empty. An empty legacy public origin is treated as unset. The production image sets `PORT=3005`, `DATA_DIR=/app/data`, and `TAPBOARD_HOST=0.0.0.0`; direct Node and development Compose defaults stay unchanged. Local operator commands use the same config resolution as the server. These compatibility aliases may be removed only after supported external deployments have moved to the canonical names through an explicit breaking-change review.

This restores packaging, not v1 application or data compatibility. Existing `tapboard.db` and `/app/backups` contents are not read, migrated, modified, or deleted; the old backup mount is inert. A volume containing only v1 data starts a separate, empty v2 database with no default Admin PIN. Initialize the PIN using the stdin-only local operator command. Keep `TAPBOARD_SECRET_KEY` external, and configure the canonical external origin for your reverse proxy; old PIN, integration, and secret settings are not translated. Do not point `TAPBOARD_DATABASE_PATH` at a v1 database or delete volumes to force startup. Backups and any v1 data migration remain separate operator-owned work.

### Hardened production Compose

`compose.production.example.yaml` is runnable with Docker Compose 2.24.0 or later. It builds the root Dockerfile, defaults to the local `tapboard:local` image, publishes only host loopback port 3005, and loads an optional ignored `.env` (or `TAPBOARD_ENV_FILE`). It enforces UID/GID 1000, a read-only root, a restricted 16MiB `/tmp`, dropped capabilities, no-new-privileges, init, SIGTERM, a 15-second stop grace, and a writable named data volume. Runtime readiness stays independent of optional integrations.

```sh
docker compose -p tapboard-prod -f compose.production.example.yaml up -d --build
docker compose -p tapboard-prod -f compose.production.example.yaml ps
curl -fsS http://127.0.0.1:3005/healthz
```

For an external configuration file, supply it for both runtime variables and Compose interpolation:

```sh
export TAPBOARD_ENV_FILE=/absolute/path/to/tapboard.env
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml up -d --build
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml ps
```

Use that same `--env-file` option on later `exec`, restart, and recreate commands. `TAPBOARD_ENV_FILE` alone does not supply image, host-port, or external-origin interpolation. Shell variables override values in the interpolation file.

Initialize a fresh installation's PIN over stdin, using the same hidden-variable pattern below with the production Compose file/project. A fresh named volume inherits the image's writable `/app/data` ownership. Existing bind mounts must already permit UID/GID 1000 to write; do not run the application as root to bypass incorrect permissions.

For LAN HTTP, set `TAPBOARD_PUBLISH_ADDRESS` to the host's selected LAN IP and `TAPBOARD_EXTERNAL_ORIGIN` to its exact reachable origin, including port. `TAPBOARD_PUBLISH_PORT` controls the host port; the container stays at3005. For a same-host HTTPS proxy, keep loopback publishing and configure the exact HTTPS origin; allow only the proxy's observed source address in `TAPBOARD_TRUSTED_PROXIES`. The configured origin controls Origin validation and Secure cookies; forwarded headers never provide an origin fallback. A containerized proxy should share a private network with Tapboard and remove Tapboard's published ports. See [operator/security patterns](docs/operations.md) for the complete examples and volume-preserving update procedure.

Run the disposable production acceptance check with `bash scripts/check-production-container.sh`. It builds a new local image and uses only its own uniquely named containers/volume, never the normal development or production data. CI runs this separately from canonical Node and Chromium checks. This is validation, not image publication or VPS deployment.

### MANUAL DEV TEST — production Compose compatibility

After merge, use the existing Git sync/build workflow with the existing Compose file and keep its volumes. Confirm the build finds the root `Dockerfile`, the container becomes healthy, and `/healthz` reports schema version 22 through the existing port/proxy. Confirm the existing `wget --spider` probe exits successfully, the dashboard and Admin login render, and stop/start retains v2 state. Check the selected database filename before initialization; v1 data is preserved but not imported. Test first with disposable state or an operator-managed backup, and never use `down --volumes` for this check.

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

Normal rebuilds MUST NOT use `docker compose -f compose.dev.yaml down --volumes`; that intentionally deletes Tapboard development state. `.env.example` is a v2-safe configuration reference to copy into the ignored `.env` file. Use the production Compose example only for the separately named production project; do not switch the development project or repurpose its volume.

## Development container workflow

### Current workstation: native WSL containers

This workstation already has a guarded native WSL launcher at `/home/joeadmin/.local/bin/tapboard-dev`. It is not on the Bash PATH, so use the full path. Docker Desktop is not required for this local workflow. Start the existing container and check readiness:

```sh
/home/joeadmin/.local/bin/tapboard-dev start
/home/joeadmin/.local/bin/tapboard-dev health
```

Open [localhost](http://localhost:3000). To recreate it from the current working tree, then check health:

```sh
/home/joeadmin/.local/bin/tapboard-dev rebuild
/home/joeadmin/.local/bin/tapboard-dev health
```

Other launcher commands are:

```sh
/home/joeadmin/.local/bin/tapboard-dev status
/home/joeadmin/.local/bin/tapboard-dev logs
/home/joeadmin/.local/bin/tapboard-dev stop
/home/joeadmin/.local/bin/tapboard-dev --help
```

The launcher calls `/mnt/c/Program Files/WSL/wslc.exe` and manages `tapboard-dev` at `127.0.0.1:3000`. Normal start, stop, and rebuild retain the native `tapboard-dev-data` volume and existing operator PIN. This volume is distinct from portable Compose's `tapboard-dev_tapboard-data`; do not interchange or delete them. Automatic startup after a Windows reboot is not configured, so run `start` when needed. This local workflow does not replace the Docker/Compose production acceptance gate.

### Portable Docker Engine and Compose setup

This alternative requires Docker Engine and the Compose v2 plugin, then an ignored local `.env` containing an external canonical 32-byte base64url `TAPBOARD_SECRET_KEY`. No real key or default value belongs in Git. A new key can be written without printing it:

```sh
test ! -e .env && (umask 077; printf 'TAPBOARD_SECRET_KEY=' > .env; openssl rand -base64 32 | tr '+/' '-_' | tr -d '\n=' >> .env; printf '\n' >> .env)
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

After a successful rotation, write the new external key to the selected configuration file (default `.env`), force-recreate the service, and then clear the shell variables. For production, replace both `compose.dev.yaml` invocations in the rotation sequence with the production file/project and the same `--env-file` prefix shown in [operations](docs/operations.md) before running it:

```sh
export TAPBOARD_NEW_KEY
node --input-type=module <<'NODE' && docker compose -f compose.dev.yaml up --force-recreate -d
import { readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
const path = process.env.TAPBOARD_ENV_FILE ?? ".env";
if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Expected a regular env file");
const key = process.env.TAPBOARD_NEW_KEY;
if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, "base64url").toString("base64url") !== key) throw new Error("Invalid new key");
const old = readFileSync(path, "utf8");
const lines = old.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?TAPBOARD_SECRET_KEY\s*=/.test(line));
const temporary = `${path}.rotation.tmp`;
writeFileSync(temporary, `${lines.join("\n").replace(/\n*$/, "")}\nTAPBOARD_SECRET_KEY=${key}\n`, { mode: 0o600, flag: "wx" });
renameSync(temporary, path);
NODE
unset TAPBOARD_OLD_KEY TAPBOARD_NEW_KEY
```

## Built-in Simulation

The public dashboard always has a **Settings** link, including when no taps are visible or Home Assistant is offline. It opens System for signed-in users; otherwise, sign in with the existing Admin PIN and select **System**. You can also open `/admin` directly or tap the connectivity indicator.

The header summarizes enabled tap-input checks, every enabled Brewfather account, and outbound integrations marked **Required** (off by default):

| Indicator            | Meaning                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Green **Connected**  | Every required check has confirmed healthy evidence.                                                                                                                                            |
| Yellow **Partial**   | A check is pending, an input is stale, or a connection has a transient failure.                                                                                                                 |
| Red **Disconnected** | A required connection has missing/unavailable credentials, an authentication failure, a sustained outage, or critical input loss. Also shown when no connections are configured for monitoring. |

Required outbound connection failures turn yellow immediately and red after five minutes of continuous failure; authentication/configuration failures are red immediately. Optional integrations and deliberately disabled integrations do not affect the indicator, but a required integration automatically disabled because its credentials are missing stays red. Brewfather waits for a successful request using its current configuration before reporting connected; saved beverage data and syncs that make no requests are not connection evidence. Changing an outbound endpoint or credentials also requires fresh success before it can return to green. Inspect **Admin → Integrations** for each destination's status. Changes stream to open displays, with a 15-second status check covering time-based escalation and recovery.

Open **Admin → System → Enable simulation**. Tapboard creates a separate saved sample taproom and opens **Simulator**. The regular dashboard, Beverages, Kegs, Fills, Taps, display controls, and history now show that workspace, with a **SIMULATION** banner. This is an installation-wide switch, including other open displays.

New sample workspaces contain five on-tap beers: **Oktoberfest** (fixture B064), **Saison** (fixture B058), **Porter** (fixture B061), **IPA** (fixture B033), and **Bourbon Barrel Stout** (fixture B026). **Hefeweizen** (fixture B052) and **Spiced Lager** (fixture B060) are On Deck. These truthful style labels replace unavailable original names from anonymized offline history. Seven minimized recipe snapshots supply historical batch values, ingredients, and process facts for flavor guidance; simulated keg volume is independent of historical fermentation volume. No private account or external connection is created.

Saved original samples upgrade only when their entire original editable profile is untouched, with no recipe, source snapshot, or manual flavor override. A wholly untouched original six-tap layout becomes five taps and two On Deck entries; its sixth tap is disabled while its sensor, settings, volume, and history remain saved. Customized profiles or layouts retain their state. This upgrade does not reset Simulation or change normal inventory, the PIN, or the development volume.

Open the dashboard in another tab. Wait for a sensor to say **Ready**, then pour 4, 12, 16, or a custom 1–32 US fl oz. Readings flow on the server while you browse elsewhere; the normal detector produces the pour history. **Pause sensor** stops readings and **Bring online** resumes them. **Noise** adds small scale fluctuations. Existing health thresholds determine when a paused sensor becomes stale. Remaining volume follows a Filled Keg when you move it between taps; newly created Fills start full.

**Exit simulation** saves its test data and returns to normal operation. Enabling it again resumes the same samples and history. **Reset simulation** requires confirmation and replaces only the sample workspace. Normal data and integration configuration are preserved. Browser display preferences are also saved separately for each mode. Mode changes keep the initiating browser signed in and invalidate older Admin forms/sessions; other devices may need to sign in again.

The sample database is stored beside the normal database with `.simulation.sqlite3` appended to its filename, inside the existing writable data volume. It uses the same schema and migrations. No additional container, port, environment flag, external service, or default Admin PIN is required. Integration management and external deliveries are unavailable in simulation. Physical senders using the telemetry API continue updating the normal installation even while its public display shows simulation.

The selected mode and sample data survive application restart. Running pours stop at their last submitted volume; their remaining requested volume is not replayed. A completed pour stays in history. If saved simulation cannot open, Tapboard returns to the normal workspace and records an error in its runtime log.

### MANUAL DEV TEST — built-in Simulation

After the normal non-destructive rebuild, verify `/healthz` reports schema version 23. Sign in with the existing PIN, enable simulation from System, and confirm five sample taps and two On Deck entries and a SIMULATION banner in Admin and the public dashboard. Pour 12 oz from a Ready sensor; watch remaining volume update, then confirm the settled remaining estimate has fallen by about 355 mL. Pause/resume another sensor and check its health after the configured stale interval. Turn on noise and confirm idle readings do not create pours. Change a sample Beverage's glass and a Display theme while readings continue. Exit and re-enter to confirm sample history persists and normal inventory returns. Restart the container and confirm the selected workspace/history survive. Finally, explicitly reset simulation and verify only the sample workspace is replaced. Never remove the normal development volume for this check.

After a normal rebuild and recreation without deleting the development volume, enable Simulation and open its public dashboard at tablet and desktop widths (800px, 1280px, and 1911px or wider). Confirm the SIMULATION banner sits above the header, all five cards sit below the header and above the fully visible On Deck strip, and the page has no horizontal or vertical overflow. Repeat with JavaScript disabled.

### MANUAL DEV TEST — Simulation history and flavor

At [localhost](http://localhost:3000), sign in with the existing PIN and enable Simulation after the volume-preserving rebuild. In a new or untouched original sample workspace, confirm the five on-tap labels and two On Deck labels above. Inspect each sample's flavor guidance and Admin source facts; check the Bourbon Barrel Stout's completed barrel context. Set a malt or hops override to **0**, verify a real zero rather than fallback, then clear it and confirm recipe guidance returns. Pour from a Ready sensor, exit and re-enter, and verify volume and history persist. Check the five-card dashboard and two On Deck entries with JavaScript enabled and disabled. Existing customized samples or layouts must remain customized; normal inventory must return on exit. Use Simulation only and preserve the normal volume and PIN.

### Public recipe sheet

Ordinary Brew Story already permits anonymous HTML and JSON access. **View recipe** opens a read-only sheet of the actual cached recipe: recipe targets stay separate from batch-reported measurements, with fermentables, hops, miscellaneous additions, yeast, recorded units, complete-only mass totals, mash steps, fermentation durations in days, and water values when recorded. Missing efficiency, equipment, and water volumes are not invented. The PDF reference informs layout only; no author, logo, or PDF file is copied and no stored recipe is replaced.

The sheet uses two desktop columns, stacks on phones, follows the preferred metric/US units and theme, works without JavaScript, and prints only recipes on white paper. Mystery's recipe reveal remains separate from beverage type, style, OG, FG, ABV, IBU, and SRM controls; revealing the recipe does not reveal those hidden fields. This extension adds no migration, provider call, editing route, or dependency: database schema remains 23 and recipe snapshot payload schema remains 2.

### MANUAL DEV TEST — Public recipe sheet

After the volume-preserving rebuild and health check, open [localhost](http://localhost:3000), select Simulation, and open Oktoberfest's **Story → View recipe**. Compare targets, ingredients, timings, and recorded measurements against that sample's actual stored recipe, rather than the reference PDF. Check metric/US, light/dark, phone stacking, JavaScript-disabled reading, and print preview. In a guest or incognito window, confirm ordinary Story HTML and JSON remain accessible without signing in. Use a disposable fixture workspace to check Mystery with recipe hidden, recipe revealed alone, and the independent beverage type/style/OG/FG/ABV/IBU/SRM reveals. Preserve existing samples, volume, and PIN; stop for review before committing or shipping.

### MANUAL DEV TEST — dashboard Settings access

After the normal rebuild without deleting the data volume, verify `/healthz` still reports schema version 22. On a phone and a wall display, confirm **Settings** remains visible with populated and empty dashboards, including while Home Assistant is unavailable. In a disposable workspace, hide every tap and check **No taps to display** and **Open settings**; re-enable a tap and check the message disappears on the already-open dashboard. Follow Settings, sign in if needed, open **System**, and confirm **Enable simulation** is reachable. Repeat navigation with JavaScript disabled. The connectivity indicator must still open Admin. With a disposable required integration, verify green **Connected** after confirmed success, yellow **Partial** on a connection failure, and red **Disconnected** after five minutes; recovery must return to green when all other checks are healthy. Missing credentials or critical sensor loss must be red. An optional destination failure must not override healthy required checks.

## MANUAL DEV TEST — Issue #109 Brewfather boundaries

After merging, rebuild and recreate the development container without deleting its volume; confirm `/healthz` is healthy and the database remains at schema version 22. Use a development fixture or local fake Brewfather transport: defer a linked batch response, unlink or delete its Beverage, then release the response and verify the obsolete source profile/recipe is not restored. Repeat with a missing/error response and confirm a replacement link keeps its own state. Verify normal sync still updates linked data, disabled accounts do not degrade the public header, and enabled stale/error links show Partial. Oversized, malformed, stalled, and retried response checks are covered by automated fake-transport tests; no production Brewfather writes are needed.

## System administration

Open **Admin → System** for application readiness/version, local storage and delivery counts, a category-filtered Activity Log, calculation defaults, retention settings, and active Admin sessions. These are normal forms that work without JavaScript. Activity pages are capped at 50 entries with stable time/ID pagination; diagnostics never fetch an external service or expose credentials, private notes, raw payloads, or configured endpoints.

Calculation defaults coordinate the existing Beverage fallback final gravity and Forecast serving-size settings. Beverage-specific density and pour-size overrides take precedence. Changes use the existing prospective telemetry correction lifecycle and preserve completed pours.

Session inactivity and absolute lifetimes can be saved from one minute to one year, with inactivity no longer than the absolute lifetime. A saved policy overrides environment defaults. Shorter limits immediately constrain existing sessions; later lengthening cannot revive an expired session or extend its original absolute deadline. System lists up to 100 active sessions, marks the current session, and supports confirmed individual revocation. Changing the four-digit Admin PIN requires the current PIN and revokes every session. Forgotten-PIN recovery remains a local operator command.

Automatic retention runs one bounded pass per minute: at most 1,000 Activity rows, 500 raw measurements, 500 deduplication receipts, 100 combined terminal delivery/event/version rows, and 1,000 expired or revoked sessions. Receipts outlive raw telemetry and cover the reconnect horizon. Pending, retrying, and leased deliveries protect their events and versions; current destination versions and versions owning encrypted endpoint material remain protected. Explicit destination retirement removes those secrets before obsolete versions become eligible. Capacity pressure may prune terminal delivery history earlier to enforce the existing outbox hard bounds. Domain history, epochs, completed pours, calibration, maintenance, deletion audits, and monotonic Tap first-use evidence are preserved.

Simulation data settings, Activity, and storage diagnostics belong to its separate saved workspace. Admin sessions, PIN changes, and session policy use normal installation authentication in both workspaces. Backups/restores and encryption master-key handling remain deployment-owned.

### MANUAL DEV TEST — Issue #80

After merging, rebuild and recreate normally without deleting the development volume. Verify `/healthz` reports schema 22. Open System in two signed-in browsers and with JavaScript disabled. Save calculation defaults, verify a live display refreshes, and restore the defaults. Reject a receipt horizon shorter than raw telemetry or reconnect without changing any retention field. Filter Activity and open an older page; confirm credentials and private notes are absent. Revoke the other browser's session and verify it must sign in again while this browser stays signed in. In disposable state, shorten session lifetimes, change the PIN, and verify all prior sessions are rejected. Enable Simulation and verify access controls remain shared while data settings/history stay separate. Check 390px mobile and desktop layouts. Never delete the persistent volume for these tests.

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

CI runs canonical checks, the complete Chromium suite, and disposable hardened production-container validation as separate jobs. No validation command deploys or publishes the image.

Schema version 23 is the current supported schema. It adds nullable malt and hops sensory overrides, preserves all previous values, and leaves effective flavor guidance derived. Recipe snapshot payload schema 2 is independent of source record revisions. Version 22 (`system-administration-and-retention`) added singleton typed session-policy and terminal-outbox-retention tables, preserving the previous schema and data. Session defaults remain inherited until explicitly saved. Version 21 (`builtin-simulation`) added typed workspace settings, simulated sensor state, and Fill-owned physical volume; version 20 added Fill-owned Featured preferences after version 19's outbound delivery schema. Low and New badges are derived rather than persisted. Browser-local overrides, live/SSE state, and effective sensory projections are never persisted in SQLite. `/healthz` reports `schemaVersion: 23` when the database is ready. An unpublished badge-only version-19 database is not a canonical upgrade source and is rejected without repair; preserve its data and obtain an explicit migration plan instead of deleting a volume or rewriting its ledger.

## MANUAL DEV TEST — Issue #110 autosave and live refresh

After updating, rebuild and recreate the development container without deleting its volume, then verify `/healthz` reports schema version 22. Enable Simulation and keep its public dashboard open beside Admin. With browser network throttling enabled, change a safe Tap name from A to B and back to A while the first save is pending; repeat with A to B to C. Wait for Saved and reload: the final value must match your last edit. Check Undo, inline validation, and a conflict from a second Admin tab.

Temporarily block a targeted public dashboard request in browser developer tools, change a shared display setting, then unblock requests. The already-open display must recover to the saved state while retaining its existing cards, glass graphics, and bubbles. Disabling a Tap must remove its public card; reenabling it must restore it. Confirm the normal Admin form still saves with JavaScript disabled.

## MANUAL DEV TEST — vessel artwork and pour animation

After the normal development rebuild, confirm `/healthz` reports schema version 22. In the Beverage Fill Glass picker, inspect all 17 vessels and switch between a mug, tulip, snifter, and keg while the dashboard is open. Confirm the existing SVG node updates, the viewport stays the same, and a stemmed glass fills only its bowl. Check empty, low, half-full, and full levels in light and dark themes.

As an authenticated Admin, hold a glass or use Shift+Space to preview a pour. It fills visually from empty to the current reading; the stream ends at the rising surface and never enters a stem. The preview does not change the stored reading. Confirm bubbles still rise within the beer, live updates interrupt the preview safely, and reduced motion shows the final reading with stationary bubbles. Inspect the same artwork in the Admin picker and display preview.

## MANUAL DEV TEST — browser feedback and card badges

After updating, rebuild and recreate the development container normally without deleting its volume, then verify `/healthz` reports schema version 22. With disposable entities, check four-digit PIN autosubmit and a cleared retry after an incorrect PIN; matching Beverage/Tap/Keg table styling and unit labels; live shared and per-Tap previews, including inheritance and Undo; Featured updates on an already-open dashboard; Low/New/Tap Wars footer badges; fading vote feedback; and canceled/confirmed Kick Keg actions with and without JavaScript. Kick must end the selected Fill and leave its Tap empty. The original PR #106 used a historical browser/CI waiver; final v2 validation is recorded separately in the acceptance ledger. These manual checks remain for the operator.

The event registry is an explicit allowlist with durable IDs and canonical UTC envelopes. Outbox admission uses hard global/per-destination row and UTF-8 byte bounds, bounded terminal pruning, restricted semantic coalescing, fixed overflow slots, and explicit `not_queued_capacity` degradation semantics. Delivery state provides at-least-once processing with leases and compare-and-set results; it does not claim exactly-once network delivery. Issue #79 adds provider-neutral destination workers, immutable configuration versions, and six-event subscriptions while keeping network I/O outside SQLite transactions.

The public and Admin pages are Eta SSR with semantic HTML and ordinary forms. Small external ES modules progressively add targeted live refresh, rotation, and per-display preferences; there is no SPA, hydration framework, frontend router, bundler, or client-side application state snapshot.

## Issue #79 outbound Home Assistant and webhook delivery

Outbound destinations are provider-neutral logical records with immutable configuration versions and six-event subscriptions. The generic transactional outbox remains the delivery authority: leased claims use compare-and-set completion, permit at most one unexpired in-flight delivery per logical destination, preserve at-least-once semantics, and keep total attempts separate from the bounded retry cycle. Retryable failures use deterministic backoff (5 seconds, capped at one hour) and become terminal after 24 hours of active failure or the cycle bound; permanent failures are terminal immediately. The dashboard shows early required-connection failures as Partial, escalating sustained failures to Disconnected after five minutes; authentication/configuration faults are immediately Disconnected. Disable/re-enable pauses due and failure-window clocks while retaining history; Retry is terminal-only and Dismiss is final.

Home Assistant uses one injected/native WebSocket per logical destination and sends the exact `tapboard_event` event; it does not expose arbitrary service calls. Explicitly configured LAN HTTP is allowed for Home Assistant. Webhooks validate each attempt against public-only destinations, reject unsafe or mixed DNS answers, pin the validated address for the actual dial, follow no redirects, and enforce bounded connection, response, body, and abort limits. The standard webhook envelope is the default, with one bounded Discord-message formatter as an optional format; there is no dedicated Discord adapter, plugin, template, or script.

Secret values remain encrypted and are never read back through Admin, errors, logs, Activity, or delivery history. Home Assistant tokens and webhook secret-header values belong to logical destination slots; webhook endpoint material is bound to an immutable configuration version, whose header references resolve at send time so rotation/removal applies immediately, including historical retries. Workers claim and record in SQLite but perform all network I/O outside SQLite transactions. Admin exposes safe summaries, connectivity evidence, bounded history, and create/edit/toggle/retire/retry/dismiss controls.

### MANUAL DEV TEST — Issue #79

After updating to the Issue #79 revision, use the normal non-destructive rebuild (`docker compose -f compose.dev.yaml up -d --build --force-recreate`; never use `down --volumes` or delete `tapboard-dev_tapboard-data`). Verify `GET /healthz` returns `{"status":"ok","schemaVersion":22}`. Sign in to Admin and inspect the outbound destination UI: confirm all six registered event subscriptions are selected by default and `Required` defaults to OFF, then inspect safe summaries, create/edit/toggle/retire controls, and bounded delivery history. Create one disposable Home Assistant destination and one disposable webhook destination, inspect the Standard JSON and bounded Discord format choices, and confirm secret values are never returned in the page, history, logs, or errors. If available, run the optional Home Assistant check only against a safe disposable/LAN endpoint and verify `tapboard_event` without arbitrary service calls. Exercise both webhook formats against a disposable receiver, including rejection of redirects/private or mixed-DNS targets. Disable and re-enable a disposable destination and verify due/failure timing shifts while history remains; confirm Retry is available only for terminal rows and Dismiss is final. Inspect responsive behavior at approximately 800 px, 1280×720, 1920×1080, and 3840×2160. Do not delete or repurpose the persistent development volume.

## Issue #77 Brew Story, sensory guidance, and Mystery Tap

Brew Story is a read-only, server-rendered projection backed by local Tapboard state. The central public projection/redaction boundary serves the dashboard, legacy public taps, Story HTML/JSON, and targeted refreshes; public SSE carries dirty identifiers only. Mystery is owned by the active Tap assignment, uses the exact title `Mystery Tap`, hides Beverage and custom Tap names, and defaults every eligible field to hidden. Its typed reveal allowlist is `beverage_type`, `style`, `abv`, `ibu`, `og`, `fg`, `srm`, `description`, `recipe`, `sensory`, and `history`; Tap number, display color, Fill Glass, remaining/fill percentage, forecast/days/servings, and serving temperature remain visible exemptions.

Sensory guidance exposes only bitterness, sweetness, body, roast, tartness, and alcohol on a bounded public 0–5 scale. Canonical persisted manual overrides and their Admin/API inputs remain the legacy 0–10 scale so all valid pre-v13 state remains truthful; Story maps each valid manual value deterministically by dividing by two. Each axis resolves independently as manual override, recipe prediction, style baseline, or unavailable; effective sensory values are derived and not persisted. Tasting data, malt/hops detail, and fabricated fallback values are not used. Custom recipes are separately editable, while linked, detached, and superseded source snapshots remain read-only and provenance-labelled. Beverage-owned presentation uses the finite 17-ID Fill Glass catalog with sculpted SVG contours, per-instance glass reflections and clipped liquid/foam/bubble layers, a synchronized 8-second fill transition, and safe deterministic display color/SRM fallback; arbitrary artwork is not accepted.

### MANUAL DEV TEST — Issue #77

After the normal non-destructive rebuild (`docker compose -f compose.dev.yaml up -d --build --force-recreate`; never use `down --volumes`), verify `/healthz` reports schema version 22. Using disposable entities where mutation is needed, open a normal Brew Story with JavaScript disabled and inspect custom, linked, and detached recipe provenance; check each sensory axis and clear a manual override to expose the next precedence layer. Enable Mystery on an active assignment, confirm the exact `Mystery Tap` title, protected identity, selective reveals, always-visible exemptions, assignment reset after unassign/move, live redaction updates, and dirty-ID-only SSE. Change at least two finite Fill Glass choices and display-color/SRM inputs, confirming distinct safe graphics and stable SVG root identity. Do not delete or repurpose the persistent development volume.

## Issue #75 health and Tap maintenance

Health checks use the exact IDs `low_keg`, `scale_availability`, `suspected_leak`, `serving_temperature`, and `line_cleaning_due`. Typed global defaults flow into nullable per-Tap overrides. `low_keg` and `scale_availability` are enabled by default; leak, serving-temperature, and line-cleaning checks are opt-in. Scale availability reads the latest accepted measurement from the current authoritative source/Tap status independently of serving-epoch state; low-keg, leak, and serving-temperature retain current-epoch provenance isolation. Disabled Taps evaluate; retired Taps skip with deterministic incident resolution.

Current health state is rebuildable and separate from durable incidents/transitions. Acknowledgement does not resolve or hide an incident, and bounded cooldown suppresses repeated incident side effects rather than health truth. Resolved incidents are retained for 365 days and pruned in batches of at most 100; open incidents, current state, and Tap `first_used_at` are never pruned. Tap line maintenance is append-only, due dates are server-derived, `line_cleaned` establishes the line-cleaning baseline only, and private notes are Admin maintenance detail. Durable incidents and maintenance atomically set Tap `first_used_at`.

Accepted telemetry evaluates health after detector processing; assignment, authority, correction, density, configuration, maintenance, startup, and one coalesced periodic sweep also trigger evaluation. Only meaningful changes create Activity. Admin-only detail APIs remain available, while the safe targeted `HealthTargetedUpdate` seam feeds aggregate public card/connectivity refresh without exposing evidence or private notes. There is no public health-detail API; Issue #79 owns outbound Home Assistant/webhook delivery and its connectivity evidence.

### MANUAL DEV TEST — Issue #75

Persistent, safe read-only checks: after the normal rebuild, verify `GET /healthz` returns `{"status":"ok","schemaVersion":22}` and inspect the authenticated Admin health and Tap-maintenance projections without acknowledging incidents, changing configuration/overrides/cooldowns, or recording maintenance. Do not mutate the persistent development volume in this pass.

Ephemeral, mutating smoke: use a disposable database and disposable Tap to exercise a default-enabled check, an opt-in check, a nullable per-Tap override, incident acknowledgement/cooldown, retired-Tap resolution, and append-only line maintenance with a server-derived due date. Confirm durable incidents and maintenance atomically set `first_used_at`, and that `line_cleaned` establishes the line-cleaning baseline only. Maintenance and incidents permanently mark a Tap used; never use a persistent Tap or the named development volume, and do not delete the volume as cleanup. No tests are claimed as run here; this is an operator test plan.

## Issue #76 SSR dashboard, Admin, SSE, and display preferences

The initial public response contains the header, every enabled Tap card in Tap-number order, the reserved hidden Tap Wars slot, and the authoritative On Deck footer. Public refresh endpoints expose purpose-built projections only. Named SSE events carry dirty-target identifiers, not state snapshots; blocked clients have bounded coalesced queues and reconnect through a page-scoped authoritative reconciliation that patches surviving cards in place.

Shared display defaults flow into sparse, strictly validated browser-local overrides stored at `tapboard.v2.display-preferences.v1` with record version `1`. A synchronous external head script applies allowlisted values before CSS to prevent theme flash. Storage failures and malformed values fall back to shared defaults, while the browser `storage` event synchronizes peer tabs.

### MANUAL DEV TEST — Issue #76

Rebuild and recreate normally without deleting `tapboard-dev_tapboard-data`, then confirm `/healthz` reports schema version 22. Check `/` with zero, one, six, and more than six enabled Taps; a disabled Tap; an unassigned Tap; and On Deck entries. Sign in at `/admin/login`, visit every Admin navigation route, submit one representative form with JavaScript disabled, and exercise shared plus local Display settings. In two tabs, verify local preference persistence, reset-to-inherit, and storage synchronization. Update a Tap while the dashboard is open, confirm the field changes without replacing its SVG graphic node, then interrupt/reconnect the event stream and confirm authoritative reconciliation. Inspect approximately 800 px, 1280×720, 1920×1080, and 3840×2160. Use disposable state for destructive fixture scenarios; never delete the persistent volume.

## MANUAL DEV TEST — Issue #81

After both implementation PRs are merged, update main and rebuild/recreate the development container with its existing volume. Verify `/healthz` reports schema 22 and System reports application 2.0.0. Confirm PIN login, no-JavaScript forms, a saved Simulation pour, Story/Mystery redaction, Tap Wars, and live display updates still work. Stop/start and recreate without deleting volumes; verify normal inventory, Simulation history, and installation policies persist. Use disposable fake integrations to confirm an outage degrades connectivity while local administration/readiness remain available, and stop during a delayed request without late database errors. For production, run the disposable container script before applying the documented LAN/proxy pattern to the operator's own stack. Keep actual deployment, key/backup management, and destructive fixtures separate from the persistent development volume.

## Authoritative rebuild context

- [`docs/rebuild/TARGET.md`](docs/rebuild/TARGET.md)
- [`docs/rebuild/ARCHITECTURE-DECISIONS.md`](docs/rebuild/ARCHITECTURE-DECISIONS.md)
- [`docs/rebuild/V1-REUSE-CRITERIA.md`](docs/rebuild/V1-REUSE-CRITERIA.md)
- [`docs/rebuild/ARCHITECTURE-FREEZE.md`](docs/rebuild/ARCHITECTURE-FREEZE.md)
- [`docs/adr/`](docs/adr/)
- [`architecture.md`](architecture.md)
- [`docs/rebuild/STATUS.md`](docs/rebuild/STATUS.md)

If these sources appear to conflict, follow the precedence in `ARCHITECTURE-FREEZE.md` and stop on any unresolved conflict.

## Admin errors and container diagnostics

Authenticated Admin forms, autosaves, and pages show actionable messages for known failures. Operational errors include a reference matching one structured JSON event in the container logs. Logs identify the operation, error code, severity, and safe provider HTTP status/retry delay when available. Credentials, submitted forms, cookies, raw exception text, and provider response bodies are excluded. Unexpected failures retain a safe message and reference. Public and login responses retain their restricted messages.

Brewfather saving stores credentials locally; it does not validate them with Brewfather. The integration reports Connected only after a successful request with the current settings. Manual refresh distinguishes failed, partial, skipped, and verified successful work. Background failures are logged when their classification changes; repeated unchanged failures are suppressed until a verified recovery.

Follow development logs with `docker compose -f compose.dev.yaml logs -f --tail=200 tapboard`. A startup warning identifies missing/invalid server encryption setup or unreadable stored credentials. Restore the original encryption key or use supported rotation when existing credentials cannot be decrypted; preserve the data volume.

## MANUAL DEV TEST — Admin errors and Brewfather diagnostics

After merging, rebuild and recreate the development container without deleting its volume, then verify `/healthz` reports schema version 22. Sign in to Admin and inspect Brewfather: saved credentials alone must not show Connected, a disabled account must show Disabled, and a failed refresh must show the appropriate recovery guidance. Match an operational error's reference with its single container log event. Verify ordinary invalid forms still show field guidance and autosave retains unsaved edits after a failure. Use a disposable instance or the automated fake-transport fixtures for missing/wrong encryption keys, rejected credentials, permission errors, rate limits, and timeouts; never replace the persistent instance's key to provoke a failure. Confirm API keys, PINs, cookies, and provider payloads appear in neither UI errors nor logs.

## MANUAL DEV TEST — #111

After merge, update to current main and run `/home/joeadmin/.local/bin/tapboard-dev rebuild`, preserving `tapboard-dev-data`, then `/home/joeadmin/.local/bin/tapboard-dev health` and verify `/healthz` is healthy. Sign in to Admin, save valid form and autosave edits, reload to confirm persistence, check validation guidance, and exercise a stale revision conflict (409). Confirm ordinary forms use a 303 redirect after submission. In disposable fixtures, verify missing, malformed, and expired session cookies plus wrong or missing Origin/CSRF reject changes; provoke expected and unexpected errors and match the safe reference to one sanitized log event. Exercise anonymous public Tap Wars voting with JavaScript enabled and disabled, including the no-JavaScript 303 redirect. Use disposable state for invalid sessions and error scenarios; keep live integrations and production untouched.

## MANUAL DEV TEST — #112

Rebuild the reviewed #112 working tree with `/home/joeadmin/.local/bin/tapboard-dev rebuild`, then run `/home/joeadmin/.local/bin/tapboard-dev health`. Preserve the native `tapboard-dev-data` volume and operator PIN. Visit `http://localhost:3000`, confirm `/healthz` is healthy and reports schema version 22, then sign in and inspect Tap health details and incident history for unchanged valid evidence.

Use disposable Simulation state for representative valid and invalid Keg, Fill, and Tap edits and shared/per-Tap Display inheritance. Confirm validation messages and nullable/default behavior, then reload to verify the saved behavior.

With Node 24, run `node --test test/validation-contracts.test.ts test/health-evidence-storage.test.ts test/health-http.test.ts` for isolated corruption, 2048-byte boundary, error, and log-privacy regressions. All database corruption belongs in ephemeral test fixtures; never corrupt the normal development volume or touch live integrations or production. These are operator instructions, not a claim that the checks were run.

## MANUAL DEV TEST — #113

Rebuild the reviewed #113 working tree with `/home/joeadmin/.local/bin/tapboard-dev rebuild`, then run `/home/joeadmin/.local/bin/tapboard-dev health`. Preserve the native `tapboard-dev-data` volume and operator PIN. Visit `http://localhost:3000`, confirm `/healthz` is healthy and reports schema version 22, then sign in to Admin. Where Keg Room results have pagination, verify Previous/Next retain search and Keg, Fill, and Tap filters, including `active`, `number`, and `state` search text and encoded characters. Actual defaults and page 1 should be omitted from pagination links.

In disposable Simulation state, exercise shared Display settings and all five per-Tap metric choices: inherit uses the shared choice, show remains visible, and hide remains hidden. Reload to confirm saved choices and check Undo/autosave, including a hidden (`false`) choice. With Node 24, run `node --test test/web-admin-helpers.test.ts test/admin-web-qc.test.ts test/display-backend.test.ts test/admin-tap-card-display.test.ts test/admin-autosave.test.ts` for pagination fixtures and edge cases; there is no need to generate 25 rows manually if current data lacks pagination. Keep live integrations and production untouched. These are operator instructions, not a claim that the checks were run.

## MANUAL DEV TEST — #114

Rebuild the reviewed #114 working tree with `/home/joeadmin/.local/bin/tapboard-dev rebuild`, then run `/home/joeadmin/.local/bin/tapboard-dev health`, preserving the native `tapboard-dev-data` volume and operator PIN. Visit `http://localhost:3000` and confirm `/healthz` is healthy. Sign in at `http://127.0.0.1:3000/admin/login`, using the launcher's configured origin for Admin forms, and visit every Admin navigation page. Check that new-entity pages resolve before ID detail routes, a missing Admin page returns an HTML 404, and an unknown API route returns a JSON 404.

Use disposable Simulation state for a representative form with JavaScript disabled, confirming POST→303→GET and persistence, then check enhanced autosave. Inspect public Brew Story and Mystery redaction alongside live dashboard refresh after a safe edit. Inspect Integration and System pages read-only without triggering live integration calls. These are operator instructions, not a claim that all manual checks ran.

## MANUAL DEV TEST — v1 transition cleanup

Run `/home/joeadmin/.local/bin/tapboard-dev rebuild`, then `/home/joeadmin/.local/bin/tapboard-dev health`, preserving `tapboard-dev-data` and the existing operator PIN. Open [localhost](http://localhost:3000) and verify `/healthz` reports schema 22. Check the public dashboard and signed-in Admin navigation. Inspect existing Simulation state and history read-only; optionally use safe sample pours in Simulation. Do not call external integrations or delete the volume. This documentation cleanup changes no runtime behavior.

## Recipe-informed flavor guidance

Brew Story uses eight axes: malt, hops, bitterness, sweetness, body, roast, tartness and alcohol. Per-axis precedence is manual override, supported recipe calculation, reviewed exact style baseline, then unavailable. Stored manual values use 0–10; public guidance uses 0–5. Unknown is distinct from zero. Admin shows selected sources, coverage and limitations; public projections contain only bounded generic guidance and respect Mystery disclosure. This deterministic heuristic uses a local producer-fact catalog, not a trained model or measured tasting data. No additional service or API configuration is required.

See [the flavor model](docs/flavor-model.md) for source normalization, formulas, snapshot enrichment and [the flavor manual test](docs/flavor-model.md#manual-dev-test--flavor-guidance). The offline 107-recipe corpus is validation evidence only; regenerate its report with Node 24 using `node scripts/report-flavor-corpus.ts`. Keep fixtures out of normal databases and public browser/log output. Historical schema-22 manual tests retain their original acceptance context; current readiness is schema 23.
