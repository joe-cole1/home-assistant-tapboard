# Tapboard architecture

Tapboard is a Node.js ES-module service and single-page dashboard for six Home Assistant taps. The application serves its own static frontend, stores durable configuration and pour history in SQLite, consumes Home Assistant state through a persistent WebSocket, and publishes live browser updates through Server-Sent Events (SSE).

```
Home Assistant -- WebSocket --> Tapboard (Node.js + SQLite) -- SSE /events --> browser
```

## Runtime and deployment

- The production image is a pinned Node 22 Alpine image. `better-sqlite3` is built in the image’s builder stage.
- Compose binds the service exactly to `127.0.0.1:3005`, while the container listens on port `3000`.
- The service runs as the non-root `node` user with a read-only root filesystem, `/tmp` tmpfs, all Linux capabilities dropped, `no-new-privileges`, Docker init, and a 15-second shutdown grace period.
- `tapboard_data` is the writable named volume for the live SQLite database and WAL files. `tapboard_backups` is a separate writable named volume for verified backups. Neither is the container writable layer.
- Direct access is suitable for the loopback deployment. An optional reverse proxy must set the exact `TAPBOARD_PUBLIC_ORIGIN` and support unbuffered long-lived SSE responses.

## Main components

```
src/
  server.js               HTTP API, session checks, SSE wiring, snapshots
  haClient.js             HA WebSocket, bounded hydration, detector adapter
  pourDetector.js         deterministic timestamp-driven single-pour detector
  tapboardProjection.js   allowlisted Home Assistant state projection
  displayUpdateCoalescer.js compact browser state-change batching
  sseHub.js               SSE framing, heartbeat, slow-client bounds
  db.js / dbMigrations.js SQLite startup and schema-v2 migrations
  kegLifecycle.js         immutable lifecycle assignment and attribution
  kegForecast.js          active-lifecycle forecast calculation
  databaseMaintenance.js  verified backup, restore, rotation, and retention
public/
  app.js                  SSE client and targeted DOM updates
  graphics.js             SVG glassware and SRM colour rendering
  styles.css              dashboard styles
```

## Home Assistant state and pour detection

The HA client authenticates over `/api/websocket`, subscribes to `state_changed` before requesting `get_states`, then applies the snapshot plus a bounded queue of intervening events. The queue is limited to 512 events or 1 MiB; overflow discards the partial generation and reconnects. The detector is hydrated once from the final state and buffered telemetry is never replayed into it, preventing reconnect data from synthesizing pours.

Only each tap’s designated primary volume sensor is used for pour detection. Values must declare a supported unit and are converted explicitly to fluid ounces; missing or unsupported units are ignored. The detector rejects stale/duplicate timestamps and implausible jumps, establishes settled baselines, arbitrates simultaneous candidates, permits only one active tap, and finalizes after a quiet period or cancels a hard-timeout session. It emits `pour_start`, `pour_complete`, or `pour_cancel`; completion records only qualifying pours.

The public projection exposes only the required tap fields: fill percentage, volume in ounces, pints remaining, batch metadata, and batch-selection value/options. It does not relay arbitrary Home Assistant state or attributes.

## SQLite schema and lifecycle ownership

Startup enforces `foreign_keys=ON`, validates the database, and migrates ordered schema versions transactionally. The current schema is version 2.

- A tap assignment opens one immutable keg lifecycle; reassignment or an end action closes the existing lifecycle.
- A pour captures the open lifecycle at pour start. Historical and unassigned pours may have no lifecycle and cannot affect an active keg forecast.
- Foreign keys restrict invalid tap/lifecycle relationships. `pour_logs_lifecycle_epoch` supports forecast queries by lifecycle and timestamp.
- The forecast uses at most 14 elapsed days of pours for the currently open lifecycle. It returns no estimated remaining time when that lifecycle has no qualifying usage.

## Browser delivery

`GET /events` starts an SSE stream with an initial `snapshot`, a retry directive, and heartbeats. `SSEHub` drops stalled clients when buffered output exceeds 64 KiB or remains blocked past its heartbeat deadline. Normal HA display changes are compacted/coalesced before the `state_changed` event; detector and operational events are delivered immediately.

The application publishes these SSE events:

- `snapshot`
- `state_changed`
- `ha_connection_status`
- `pour_start`, `pour_complete`, `pour_cancel`
- `low_keg_alert`
- `settings_updated`

The dashboard applies targeted updates so SVG glassware remains attached rather than being recreated for each telemetry update.

## HTTP API and access control

All API JSON responses are `no-store`. Mutation bodies must be JSON and are limited to 16 KiB; validation rejects unknown fields and invalid values before database or Home Assistant mutation. Origin checks allow the configured public origin or, for direct access, the request host.

| Endpoint                  | Method | Purpose                                            |
| ------------------------- | ------ | -------------------------------------------------- |
| `/healthz`                | `GET`  | Health response for the container health check.    |
| `/events`                 | `GET`  | Public live SSE stream.                            |
| `/api/state`              | `GET`  | Public formatted snapshot.                         |
| `/api/auth`               | `POST` | Administrator PIN authentication.                  |
| `/api/settings`           | `POST` | Administrator settings update.                     |
| `/api/taps/:id`           | `POST` | Administrator tap configuration/assignment update. |
| `/api/taps/:id/end-batch` | `POST` | Administrator batch end and lifecycle close.       |
| `/api/taps/:id/end-keg`   | `POST` | Administrator keg end and lifecycle close.         |
| `/api/catalog`            | `POST` | Administrator catalog/on-deck addition.            |

`POST /api/auth` returns an opaque random bearer token. The database stores only `sha256:` token digests and expiry timestamps; it does not use JWTs. Sessions expire after 24 hours, expired sessions are pruned, and a PIN change revokes all existing sessions. A newly initialized database fails closed for administrator actions until a deliberate non-default PIN has been configured.

## Operations boundaries

Use `scripts/db-maintenance.js` only through the supported npm commands: `db:backup`, `db:verify`, `db:restore`, and `db:prune-pours`. Backup and restore preconditions are documented in [Database operations](docs/DATABASE-OPERATIONS.md). The repository installs no scheduler; daily backups are operator-owned.

The legacy `config/www/tapboard` frontend is removed. Any Home Assistant writer/configuration cleanup remains explicitly deferred. HA-token rotation is also operator-owned and deferred; never expose token values in logs, documentation, or diagnostics. Batch 4’s physical/mechanical inspection remains open.
