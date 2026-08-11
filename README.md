# Home Assistant Tapboard

Tapboard is a containerized dashboard for six Home Assistant-connected beer taps. It keeps dashboard configuration and durable pour history in SQLite, receives Home Assistant state over a persistent WebSocket, and sends browser updates over Server-Sent Events (SSE).

## Features

- Deterministic, single-active-tap pour detection using declared volume units and a timestamp-driven state machine.
- Allowlisted public tap-state projection, bounded Home Assistant hydration, and compact/coalesced browser state updates.
- Immediate SSE notifications for pour starts, completions, cancellations, low-keg alerts, HA connection status, and settings changes.
- Immutable keg lifecycles: a pour is attributed to the lifecycle active at its start, even if the tap is reassigned before completion.
- Lifecycle-scoped lifetime forecast based on average consumption and cadence on drinking days, with a clearly labeled 24 oz every 4 days default until usage is recorded.
- Canonical, capacity-aware keg measurements sourced from Home Assistant scales; the browser never estimates volume from a percentage.
- Cozy horizontal-swipe and compact 3-by-2 layouts sized for a six-tap landscape display.
- Per-browser display profiles for theme, title/body fonts, accent colours, and cozy/compact layout; shared SQLite settings remain the default for new or reset displays.
- Native Brewfather v2 cache for Planning, Brewing, Fermenting, Conditioning, and Completed batches, with durable On Deck preferences and stale-cache operation.
- Cache-only Brew Stories for assigned and visible On Deck batches, including recipe intent, planned-versus-actual measurements, bounded telemetry, keg chapters, and deterministic sensory guidance.
- Versioned, allowlisted `tapboard_event` delivery to Home Assistant after durable Tapboard actions.
- One Tapboard-owned custom beverage whose display metadata is editable without Home Assistant hard-coding.
- Hardened Docker Compose deployment with loopback-only access and independent named data and backup volumes.

## Quick start

Install and validate the bundled [Home Assistant packages](home-assistant/README.md)
before starting Tapboard. That guide covers clean installations, migration to
the standalone Brewfather package, credentials, verification, and rollback.

1. Clone the repository and create an ignored environment file:

   ```sh
   cp .env.example .env
   ```

2. Set the Home Assistant endpoint, a long-lived token, Brewfather credentials, and a one-time non-default administrator PIN:

   ```env
   HA_URL=http://192.168.1.100:8123
   HA_TOKEN=your_long_lived_access_token
   BREWFATHER_USER_ID=your_brewfather_user_id
   BREWFATHER_API_KEY=your_existing_brewfather_api_key
   PORT=3000
   TAPBOARD_INITIAL_ADMIN_PIN=<choose-four-digits>
   TAPBOARD_EXPECT_EXISTING_DATA=false
   ```

   Reuse the Brewfather API user/key already used by Home Assistant. Do not regenerate it: Brewfather permits one key per account, and the retained HA fermentation integration still uses that key. The API user needs `batches.read`, `recipes.read`, and `batches.write`; Tapboard's only write is an explicit End Batch status change to `Completed`.

   The Compose host port is fixed at `3005`; `PORT=3000` is the container listener. Do not commit, print, or share `.env`.

3. Start the local deployment:

   ```sh
   docker compose up -d
   ```

4. Open `http://localhost:3005`, then authenticate using the PIN you chose.

5. After confirming authentication, remove `TAPBOARD_INITIAL_ADMIN_PIN`, set `TAPBOARD_EXPECT_EXISTING_DATA=true`, and recreate the service:

   ```sh
   docker compose up -d --force-recreate
   ```

   The initialization PIN is stored only as a bcrypt hash in SQLite. Later production starts refuse an unexpectedly empty data volume.

For an HTTPS reverse proxy, configure the exact public origin, for example `TAPBOARD_PUBLIC_ORIGIN=https://tapboard.example.com`. Reverse-proxy operation is optional; the supported Compose deployment is loopback-only. Read [Security operations](docs/SECURITY.md) before exposing the service beyond the local network.

## Operations and maintenance

## Home Assistant keg-measurement contract

The complete Home Assistant package bundle is maintained in
[`home-assistant/`](home-assistant/README.md). The container and its HA-side
configuration therefore version together in this repository.

For each tap `N` (1–6), Tapboard reads exactly these entities:

- `sensor.tap_N_fl_oz`: remaining measured volume in fluid ounces.
- `input_number.tap_N_keg_capacity_oz`: authoritative per-tap capacity, an integer from 16 through 2048 fluid ounces.

Tapboard publishes the coherent measurement tuple `volumeOz`, `capacityOz`, `fillPercent`, `pintsRemaining`, and `volumeStatus` in snapshot schema version 6 and in incremental SSE updates. It does not consume `sensor.tap_N_fill`, `sensor.tap_N_pints_remaining`, or HA-projected Brewfather entities.

`volumeStatus` is `measured` for a fresh valid scale reading, `stale` when the last valid in-process reading is retained after an existing source becomes unavailable, `assumed_full` only when the exact volume entity is absent and a batch is assigned, or `unavailable` on a cold start without a valid measurement (and for unassigned/sensor-unavailable taps). Low-keg alerts and low-keg badges are limited to fresh `measured` readings. Forecasts use the same server-derived tuple.

Administrators can update a capacity with `POST /api/taps/:id` using an integer `capacity_oz`. Tapboard writes that value to the matching HA `input_number` helper; if HA rejects the authoritative write, the request fails and the settings UI shows the returned error.

The supported database interface is the maintenance CLI exposed through npm:

```sh
npm run db:backup
npm run db:verify -- <database-file>
npm run db:restore -- <backup-file> <empty-data-directory>
npm run db:prune-pours
```

When running against the Compose service, use `docker compose exec -T tapboard` before the npm command. These commands use the configured data and backup locations; do not copy a live SQLite database file or use retired ad-hoc database scripts. See [Database operations](docs/DATABASE-OPERATIONS.md) for backup, restore rehearsal, retention, and rollback procedures.

The repository does not install a backup scheduler. Run the supported backup command from an operator-owned scheduler after verifying the deployment.

On a normal production startup, Tapboard rejects an empty data volume and any database schema newer than it supports. When it detects an older supported schema, it automatically creates and verifies a new backup in the independent backup volume before applying the transactional migration. A backup or migration failure stops startup without approving or partially continuing the upgrade.

## Native Brewfather synchronization

Tapboard refreshes at startup and every six hours, with bounded retry backoff after failures. An authenticated manual refresh uses the same coordinator and the same rolling request budget, so overlapping startup, scheduled, and manual refreshes coalesce into one cycle.

The summary cycle reads `GET /v2/batches` for all five supported statuses using `limit=50` and `start_after` pagination. It fetches `GET /v2/batches/:id` only for new or changed batches, prioritizing assigned and visible On Deck batches, with at most 12 details per cycle. Sparse embedded recipes are enriched through `GET /v2/recipes/:id`. For visible active batches it reads at most 12 latest readings through `GET /v2/batches/:id/readings/last`; a separate daily, bounded pass caches full history for at most 12 visible active candidates through `GET /v2/batches/:id/readings`. Browser story requests never call Brewfather.

The default Tapboard budget is 100 requests in any rolling hour and cannot be configured above 200. A single-page no-change cycle normally costs five list calls; its bounded enrichment work adds at most 12 details and 12 latest readings. Pagination can use more list calls, but the same 100/hour ceiling applies to every scheduled, manual, detail, reading, and End Batch request. Together with the retained HA package's normal three list calls every six hours, the steady request rate is about 1.3 calls/hour and Tapboard always leaves at least 400 of the shared 500 calls/hour available to HA at the default limit.

Failed pages or details never erase successful cached data. The administrator On Deck status distinguishes Brewfather configuration, last attempt/success, stale-cache state, safe error category, retry timing, request budget, and HA connectivity. Cached beer display remains available when either external service is down.

End Batch validates the current non-custom assignment, sends exactly `PATCH /v2/batches/:id` with `{"status":"Completed"}`, and only then transactionally closes the lifecycle and clears the assignment. A failed PATCH leaves local state unchanged. End Keg only closes the local lifecycle and never contacts Brewfather.

Selecting an assigned tap card or public On Deck item opens a full-screen Brew Story. Public access is limited to currently assigned batches and On Deck batches that are both visible and globally enabled. An authenticated administrator can open any present cached candidate and set per-axis half-step sensory overrides, replace the generated description, or hide sensory guidance from public viewers. Unknown traits remain unknown; the radar appears only when at least three axes have evidence.

Home Assistant receives the versioned `tapboard_event` contract on a best-effort basis. See [Home Assistant event examples](docs/HOME-ASSISTANT-EVENTS.md). No HA configuration is created or changed automatically.

## Development

The supported baseline is Node 22 and npm. Run:

```sh
npm ci
npm run check
```

`npm run check` performs non-mutating lint/format checks and the complete test suite. `npm run check:fix` applies approved automatic lint/format fixes before running tests.

## Current operational boundaries

- Display profiles are local to one browser profile and exact origin (scheme, host, and port). They persist across reloads and hard refreshes through browser storage, but private browsing, site-data clearing, kiosk policies, or blocked storage can remove or prevent that persistence. A storage failure leaves the current page usable and shows that the preference could not be saved.
- Appearance and layout controls are administrator-only. Their normal changes apply only to the current browser; local values override shared HTTP and SSE settings. “Use theme defaults” restores the active preset’s accent colours, “Reset this browser” removes its local profile, and “Set current display as shared defaults” deliberately writes the current display values to SQLite for browsers that inherit them.
- Per-browser layout currently covers only cozy versus compact mode. Tap visibility/order, tap sizing, drag-and-drop placement, content configuration, and Home Assistant integration remain shared; this feature makes no Home Assistant changes.
- Home Assistant and ESPHome deployment, including the physical/mechanical inspection tracked in Batch 4, remain operator-owned and are still open.
- HA-token rotation is operator-owned and deliberately deferred. Replace it privately in the ignored environment file, recreate Tapboard, and verify hydration without displaying the token or authorization data.
- The legacy `config/www/tapboard` frontend, its `write_tapboard_json` shell command, and the orphaned writer script have been removed. Apply and validate the accompanying Home Assistant packages before restarting Home Assistant.
