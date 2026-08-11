# Tapboard architecture

Tapboard is a Node.js ES-module service and single-page dashboard for six Home Assistant taps. The application serves its own static frontend, stores durable configuration and pour history in SQLite, consumes Home Assistant state through a persistent WebSocket, and publishes live browser updates through Server-Sent Events (SSE).

```
Brewfather API -- batch/recipe/reading reads --> Tapboard
Brewfather API <-- PATCH status=Completed -------- Tapboard End Batch only

Home Assistant -- serving telemetry/state changes --> Tapboard
Home Assistant <-- tapboard_event ----------------- Tapboard

Tapboard -- SQLite --> cache, assignments, lifecycles, pours, preferences, sync state
Tapboard -- SSE/API --> browser
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
  brewfatherClient.js     bounded native Brewfather v2 transport and budget
  brewfatherCache.js      sanitized durable cache queries and writes
  brewfatherSync.js       coalesced startup/scheduled/manual synchronization
  tapActions.js           serialized End Batch and End Keg semantics
  tapboardEvents.js       strict versioned outbound event envelopes
  pourDetector.js         deterministic timestamp-driven single-pour detector
  tapboardProjection.js   allowlisted, capacity-aware Home Assistant projection
  displayUpdateCoalescer.js compact browser state-change batching
  sseHub.js               SSE framing, heartbeat, slow-client bounds
  brewStory.js            bounded cache-only story projection and keg chapters
  sensoryEngine.js        deterministic versioned sensory precedence engine
  sensoryMappings.js      reviewed local style and ingredient mappings
  imageProxy.js           pinned-resolution, bounded HTTPS image retrieval
  db.js / dbMigrations.js SQLite startup and schema-v6 migrations
  kegLifecycle.js         immutable lifecycle assignment and attribution
  kegForecast.js          active-lifecycle forecast calculation
  databaseMaintenance.js  verified backup, restore, rotation, and retention
public/
  app.js                  SSE client, browser display profiles, targeted DOM updates
  brewStory.js            safe full-screen story rendering and override controls
  displayPreferences.js  validated local storage, precedence, and pre-paint display bootstrap
  graphics.js             SVG glassware and SRM colour rendering
  styles.css              dashboard styles
```

## Home Assistant state and pour detection

The HA client authenticates over `/api/websocket`, subscribes to `state_changed` before requesting `get_states`, then applies the snapshot plus a bounded queue of intervening events. The queue is limited to 512 events or 1 MiB; overflow discards the partial generation and reconnects. The detector is hydrated once from the final state and buffered telemetry is never replayed into it, preventing reconnect data from synthesizing pours.

Only each tap’s designated primary volume sensor is used for pour detection. Values must declare a supported unit and are converted explicitly to fluid ounces; missing or unsupported units are ignored. The detector rejects stale/duplicate timestamps and implausible jumps, establishes settled baselines, arbitrates simultaneous candidates, permits only one active tap, and finalizes after a quiet period or cancels a hard-timeout session. It emits `pour_start`, `pour_complete`, or `pour_cancel`; completion records only qualifying pours.

The canonical measurement contract is `sensor.tap_N_fl_oz` plus `input_number.tap_N_keg_capacity_oz`. The public snapshot uses schema version 6 and exposes one coherent tuple per tap: `volumeOz`, `capacityOz`, `fillPercent`, `pintsRemaining`, and `volumeStatus`, plus native-cache batch metadata and selection options. Settings also expose nullable `primary_color` and `secondary_color` overrides; `null` selects the active preset default. `sensor.tap_N_fill`, `sensor.tap_N_pints_remaining`, `sensor.brewfather_active_batches`, `sensor.tap_N_batch_info`, and the HA batch selectors are deliberately excluded from Tapboard reads.

`volumeStatus` is `measured` for a fresh scale reading; `stale` when a previously valid in-process scale source becomes unavailable; `assumed_full` only when the exact volume entity is absent while the tap has an active assignment; or `unavailable` when there is no valid measurement to retain. Ounces are clamped to capacity and pints/percent are derived on the server. The browser renders this tuple directly and may draw an empty graphic for unavailable data, but does not fabricate a numeric readout. Low-keg alerts and badges require `measured`; forecasts use the same derived tuple.

## SQLite schema and lifecycle ownership

Startup enforces `foreign_keys=ON` and validates the database. It rejects a future schema version and, for an older supported schema, creates and verifies a fresh backup in `tapboard_backups` before running all ordered migrations in one transaction. Backup verification or migration failure aborts startup; no manual restore marker or empty-volume approval is required. The production empty-volume guard remains separate. The current schema is version 6. Version 3 adds the display-layout and On Deck defaults, per-Brewfather-batch visibility preferences, and the singleton custom-beverage record; version 4 adds nullable primary and secondary accent overrides; version 5 extends the existing batch table with indexed native summaries and adds bounded detail snapshots, idempotent readings, and singleton sync metadata. Version 6 adds reading pH, per-batch history-sync state, and authenticated per-batch sensory overrides.

- A tap assignment opens one immutable keg lifecycle; reassignment or an end action closes the existing lifecycle.
- A pour captures the open lifecycle at pour start. Historical and unassigned pours may have no lifecycle and cannot affect an active keg forecast.
- Foreign keys restrict invalid tap/lifecycle relationships. `pour_logs_lifecycle_epoch` supports forecast queries by lifecycle and timestamp.
- The forecast uses all pours from the currently open lifecycle, averaging consumption across UTC calendar days with positive usage and the observed interval between those days. A single observed day uses the default four-day interval; an active lifecycle with no usage uses a clearly labeled default of 24 oz every four days. Unassigned taps still have no forecast.

## Brewfather ownership and cache

Brewfather owns recipes, batches, brewing and fermentation measurements, profiles, and brewer tasting records. Tapboard reads summaries for Planning, Brewing, Fermenting, Conditioning, and Completed through paginated `GET /v2/batches`; changed/important details through `GET /v2/batches/:id`; recipes through `GET /v2/recipes/:id`; latest readings through `GET /v2/batches/:id/readings/last`; and lazy history through `GET /v2/batches/:id/readings`.

The coordinator starts an immediate refresh and schedules six-hour refreshes. Concurrent manual/scheduled work coalesces. A rolling default budget of 100 requests/hour (hard configuration ceiling 200) retains at least 300 calls/hour of headroom under Brewfather's shared 500-call limit. Details and latest-reading polls are each limited to 12 per cycle. A due-state table limits full-history refreshes to a daily background pass over at most 12 public active candidates; story GETs are cache-only. History writes are limited to 1,000 readings per request and retained to 5,000 per batch. Individual detail snapshots are 256 KiB and reading snapshots are 16 KiB.

### Brew Story projection

`GET /api/batches/:id/story` returns versioned, allowlisted cached data with an explicit 512 KiB JSON ceiling. Public reads require either a current tap assignment or a visible On Deck preference while the global On Deck footer is enabled; authenticated reads may access any present cached batch. The 24-hour, 7-day, and all-history windows are anchored to the newest cached reading and downsample to at most 600 points while retaining endpoints and per-bucket extrema. Each immutable keg lifecycle is a separate Tapboard chapter.

The sensory engine uses the fixed precedence `manual > brewer tasting > recipe prediction > style baseline`, resolves eight 0–5 axes in half steps, attaches evidence/confidence/source metadata, and leaves unsupported values null. Public responses suppress hidden guidance; authenticated responses include raw override controls. Remote artwork is fetched only through a same-origin endpoint that revalidates the exact cached URL, requires credential-free default-port HTTPS, pins a public DNS result, limits redirects/time/type/bytes, and sends no cookies or authorization headers.

Summary absence is authoritative only when every requested status/page succeeds. Partial or external failures preserve last-known-good summaries, details, readings, assignments, lifecycles, and On Deck preferences. A Completed batch is presentation data only and does not imply a physical keg exists.

Tapboard owns assignments and lifecycle state. It does not write HA batch selectors or text helpers. End Batch is the sole Brewfather mutation: exact assigned non-custom batch validation, exact Completed PATCH, then local lifecycle/assignment transaction. End Keg is local only. HA capacity helpers remain authoritative and serving telemetry remains HA-owned.

## Home Assistant event bridge

Outbound operational events use one HA WebSocket `fire_event` type, `tapboard_event`. The envelope is schema version 1 and contains a unique ID, occurrence time, nullable tap/lifecycle/batch IDs, bounded display metadata, and a strict type-specific data object. Batch 7 publishes `keg_assigned`, `keg_ended`, `pour_start`, `pour_complete`, `pour_cancelled`, and `low_keg` only.

Durable events are published after their SQLite transaction or pour insert succeeds. Delivery is best effort: a WebSocket failure never rolls back or fails the primary action, and operational events are not replayed after a disconnection. The common request path has a 64-request pending ceiling and settles requests on result, timeout, disconnect, authentication failure, send failure, or shutdown. No event contains gravity, fermentation temperature/status/progress, controller state, complete Brewfather objects, arbitrary notes, service targets, credentials, or generic webhook payloads.

## Browser delivery

`GET /events` starts an SSE stream with an initial `snapshot`, a retry directive, and heartbeats. `SSEHub` drops stalled clients when buffered output exceeds 64 KiB or remains blocked past its heartbeat deadline. Normal HA display changes are compacted/coalesced before the `state_changed` event; detector and operational events are delivered immediately.

The application publishes these SSE events:

- `snapshot`
- `state_changed`
- `ha_connection_status`
- `pour_start`, `pour_complete`, `pour_cancel`
- `low_keg_alert`
- `settings_updated`
- `brewfather_batches_changed`

The dashboard applies targeted updates so SVG glassware remains attached rather than being recreated for each telemetry update.

### Per-browser display profiles

SQLite settings are the installation-wide defaults supplied by the HTTP snapshot and `settings_updated` SSE events. Each browser may store a small, versioned, non-sensitive `localStorage` record under `tapboard.display-preferences.v1` containing validated overrides for `theme`, `font_title`, `font_body`, `primary_color`, `secondary_color`, and `layout_mode`. The record is scoped to the browser profile and exact origin, so different browsers, profiles, schemes, hosts, or ports have independent displays.

The browser derives effective display settings by overlaying valid local fields on the latest shared settings. Local values therefore retain precedence after HTTP reloads and subsequent SSE updates; missing fields inherit the server default. Accent `null` explicitly selects the active theme preset's built-in colour. A same-origin `storage` event synchronizes a changed profile to other tabs.

A small same-origin bootstrap script reads and validates the record before dashboard content paints, so explicit browser overrides do not flash back to shared appearance values during startup. Fields that inherit installation defaults resolve when the first server snapshot arrives. Stored values are untrusted: the frontend accepts only fixed theme, font, and layout allowlists plus strict hex colours. Storage can be unavailable in private browsing or due to browser policy/quota; in that case the current page uses an in-memory profile and reports that it was not persisted.

Display controls remain behind administrator authentication. Normal theme, font, accent, and cozy/compact changes write only browser storage and do not call the server. “Use theme defaults” writes explicit null accent overrides, “Reset this browser” removes the record and restores shared defaults, and the confirmed “Set current display as shared defaults” action sends the effective appearance to the existing authenticated settings endpoint for SQLite persistence. Per-browser layout is intentionally limited to cozy/compact mode; tap ordering, visibility, sizing, placement, dashboard content, and all Home Assistant configuration remain shared.

## HTTP API and access control

All API JSON responses are `no-store`. Mutation bodies must be JSON and are limited to 16 KiB; validation rejects unknown fields and invalid values before database or Home Assistant mutation. Origin checks allow the configured public origin or, for direct access, the request host.

| Endpoint                   | Method | Purpose                                             |
| -------------------------- | ------ | --------------------------------------------------- |
| `/healthz`                 | `GET`  | Health response for the container health check.     |
| `/events`                  | `GET`  | Public live SSE stream.                             |
| `/api/state`               | `GET`  | Public formatted snapshot.                          |
| `/api/batches/:id/story`   | `GET`  | Eligible public or administrator cached Brew Story. |
| `/api/batches/:id/image`   | `GET`  | Eligible bounded same-origin cached artwork proxy.  |
| `/api/batches/:id/sensory` | `POST` | Administrator sensory guidance override.            |
| `/api/auth`                | `POST` | Administrator PIN authentication.                   |
| `/api/settings`            | `POST` | Administrator settings update.                      |
| `/api/admin/pin`           | `POST` | Verify and replace the administrator PIN.           |
| `/api/taps/:id`            | `POST` | Administrator tap configuration/assignment update.  |
| `/api/taps/:id/end-batch`  | `POST` | Administrator batch end and lifecycle close.        |
| `/api/taps/:id/end-keg`    | `POST` | Administrator keg end and lifecycle close.          |
| `/api/ondeck`              | `GET`  | Administrator Brewfather On Deck preferences.       |
| `/api/ondeck`              | `POST` | Administrator Brewfather visibility update.         |
| `/api/brewfather/status`   | `GET`  | Administrator Brewfather sync and cache status.     |
| `/api/brewfather/refresh`  | `POST` | Native coalesced Brewfather refresh and outcome.    |
| `/api/custom-beverage`     | `POST` | Administrator custom-beverage metadata update.      |

`POST /api/auth` returns an opaque random bearer token. The database stores only `sha256:` token digests and expiry timestamps; it does not use JWTs. Sessions expire after 24 hours, expired sessions are pruned, and a PIN change revokes all existing sessions. PIN changes use a separate authenticated endpoint and require the current PIN plus matching new values; failed current-PIN verification is separately limited. A newly initialized database fails closed for administrator actions until a deliberate non-default PIN has been configured.

`POST /api/taps/:id` accepts `capacity_oz` as an integer from 16 through 2048. The server must successfully call `input_number.set_value` for `input_number.tap_N_keg_capacity_oz` before treating that capacity update as saved; it returns a visible error if Home Assistant cannot accept it.

The legacy Tapboard-facing HA Brewfather entities and commands remain installed for compatibility with uncertain fermentation consumers, but Tapboard no longer reads or writes them. No file under `home-assistant/` is changed as part of the native cutover.

## Operations boundaries

Use `scripts/db-maintenance.js` only through the supported npm commands: `db:backup`, `db:verify`, `db:restore`, and `db:prune-pours`. Backup and restore preconditions are documented in [Database operations](docs/DATABASE-OPERATIONS.md). The repository installs no scheduler; daily backups are operator-owned.

The legacy `config/www/tapboard` frontend, `write_tapboard_json` shell command, and orphaned writer script are removed. The accompanying Home Assistant packages still require an operator-run configuration check and controlled restart. HA-token rotation is operator-owned and deferred; never expose token values in logs, documentation, or diagnostics. Batch 4’s physical/mechanical inspection remains open.
