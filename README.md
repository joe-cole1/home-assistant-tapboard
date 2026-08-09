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
- Brewfather-powered tap assignment and On Deck visibility for Planning, Fermenting, and Conditioning batches.
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

2. Set the Home Assistant endpoint, a long-lived token, and a one-time non-default administrator PIN:

   ```env
   HA_URL=http://192.168.1.100:8123
   HA_TOKEN=your_long_lived_access_token
   PORT=3000
   TAPBOARD_INITIAL_ADMIN_PIN=<choose-four-digits>
   TAPBOARD_EXPECT_EXISTING_DATA=false
   ```

   The Compose host port is fixed at `3005`; `PORT=3000` is the container listener. Do not commit or share `.env`.

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

Tapboard publishes the coherent measurement tuple `volumeOz`, `capacityOz`, `fillPercent`, `pintsRemaining`, and `volumeStatus` in snapshot schema version 5 and in incremental SSE updates. It does not consume `sensor.tap_N_fill` or `sensor.tap_N_pints_remaining`.

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
