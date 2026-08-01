# Home Assistant Tapboard

Tapboard is a containerized dashboard for six Home Assistant-connected beer taps. It keeps dashboard configuration and durable pour history in SQLite, receives Home Assistant state over a persistent WebSocket, and sends browser updates over Server-Sent Events (SSE).

## Features

- Deterministic, single-active-tap pour detection using declared volume units and a timestamp-driven state machine.
- Allowlisted public tap-state projection, bounded Home Assistant hydration, and compact/coalesced browser state updates.
- Immediate SSE notifications for pour starts, completions, cancellations, low-keg alerts, HA connection status, and settings changes.
- Immutable keg lifecycles: a pour is attributed to the lifecycle active at its start, even if the tap is reassigned before completion.
- Lifecycle-scoped 14-day usage forecast; no forecast is shown without usage for the currently open lifecycle.
- Hardened Docker Compose deployment with loopback-only access and independent named data and backup volumes.

## Quick start

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

- Home Assistant and ESPHome configuration, including the physical/mechanical inspection tracked in Batch 4, remain outside this repository work and are still open.
- HA-token rotation is operator-owned and deliberately deferred. Replace it privately in the ignored environment file, recreate Tapboard, and verify hydration without displaying the token or authorization data.
- The legacy `config/www/tapboard` frontend has been removed. Its separate Home Assistant writer/configuration cleanup is explicitly deferred and must be handled as a separately reviewed HA change.
