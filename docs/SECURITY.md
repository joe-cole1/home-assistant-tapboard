# Tapboard security operations

## Administrator initialization and sessions

Tapboard has no usable default administrator PIN. Public dashboard reads remain available, but administrator actions fail closed until a deliberate PIN is initialized.

1. Add a temporary, non-default four-digit value to the ignored `.env` file:

   ```env
   TAPBOARD_INITIAL_ADMIN_PIN=<choose-four-digits>
   ```

2. Start or recreate Tapboard and confirm that the PIN authenticates.
3. Remove `TAPBOARD_INITIAL_ADMIN_PIN` from `.env`.
4. Recreate the service so plaintext is no longer in the container environment.

The PIN is consumed only while `admin_pin_initialized` is false and is stored as a bcrypt hash. It is never returned by the API. Changing a PIN uses authenticated `POST /api/admin/pin` with the current PIN and two matching new PIN values; it rejects `0000` and an unchanged PIN, and deletes every administrator session. Failed current-PIN checks are limited to five attempts per client per 15 minutes and do not invalidate the existing bearer session.

Successful authentication returns an opaque random bearer value, not a JWT. Tapboard stores only a `sha256:` digest of that value and an expiry timestamp in SQLite. Sessions expire after 24 hours; a valid `Authorization: Bearer <token>` is required for administrator mutations.

## HTTP boundary

- API JSON responses are `Cache-Control: no-store`.
- JSON request bodies are limited to 16 KiB and require `application/json`.
- Unknown mutation fields and invalid/out-of-range values are rejected before database or Home Assistant mutation.
- Browser requests with an `Origin` header must match `TAPBOARD_PUBLIC_ORIGIN`, or the request host for direct loopback access.
- The service sends a restrictive CSP, frame-embedding denial, `nosniff`, no-referrer, restrictive permissions policy, and same-origin opener/resource policies.
- Static files are resolved beneath the public directory after realpath containment checks.

Tapboard does not log PINs, bearer values, token digests, Authorization headers, or complete request bodies. The four-digit PIN and process-local login rate limit are suitable only for a private household service; they do not replace a correctly configured private network and reverse proxy.

## Reverse proxy

The supported Compose deployment is loopback-only. To put an HTTPS reverse proxy in front of it, set the exact external origin:

```env
TAPBOARD_PUBLIC_ORIGIN=https://tapboard.example.com
```

The proxy must preserve the original Host, avoid buffering long-lived SSE responses, and redirect HTTP to HTTPS. It may add HSTS after all affected names are confirmed permanently HTTPS. Tapboard intentionally does not emit HSTS from its direct HTTP listener.

Tapboard denies iframe embedding. Do not weaken `frame-ancestors` or substitute a wildcard if an embedding integration is later needed; design a narrow trusted-origin policy first.

## Public voting security

Tapboard allows unauthenticated public voting via `POST /api/tap-wars/vote` to support frictionless taproom participant voting without PIN credentials. Security controls:

- Enforces Origin checking against `TAPBOARD_PUBLIC_ORIGIN` or request host.
- Enforces strict JSON body validation via `validateVote` (requires valid numeric `battle_id` and `contestant_side` as `'A'` or `'B'`).
- Burst protection rate limiter limits IP requests (100 votes per 5 seconds per IP) returning HTTP 429 if exceeded, protecting against machine flooding while ensuring touchscreen hit targets remain responsive for human taproom guests.
- Voting is active only when a Tap War battle is in `active` state. Attempts to vote on draft, ended, or revealed battles fail with HTTP 409.
- Administrative battle mutations (creating draft, starting battle, ending battle, revealing winner) require administrator session authentication.

## Container and secrets

Compose binds only `127.0.0.1:3005`; the application listens on container port `3000`. The service runs as non-root, has a read-only root filesystem, uses a bounded writable `/tmp` tmpfs, drops all capabilities, sets `no-new-privileges`, and uses Docker init. Only the independent `tapboard_data` and `tapboard_backups` named volumes are persistent and writable.

`HA_TOKEN`, `BREWFATHER_USER_ID`, and `BREWFATHER_API_KEY` remain environment-injected for local deployment compatibility. Docker metadata access can reveal environment variables, so Docker access is administrator-level access. Do not print, read back, commit, or include credentials or Basic authorization values in diagnostics. Reuse the existing Brewfather key shared with HA; do not regenerate it while HA fermentation consumers remain active.

Failed Brewfather calls emit one structured container-log record with an endpoint template, allowlisted method and error category, exact HTTP status, normalized content type, and numeric retry delay. Batch and recipe IDs, full URLs and queries, response status text and bodies, request headers and bodies, credentials, and Basic authorization values are never logged. A separate bounded sync-cycle record reports only the refresh reason, outcome, category, counts, and retry time.

Token rotation is an operator-owned deferred action: revoke the old token in Home Assistant, create and privately place a replacement in the ignored environment file, recreate Tapboard, and verify HA hydration without exposing values or authorization data.

## Brewfather and outbound-event boundary

The native client permits only the fixed HTTPS origin `https://api.brewfather.app`, validates JSON/content type, aborts timed-out requests, bounds response bytes, and exposes only sanitized error categories. Its rolling request budget defaults to 100/hour and cannot exceed 200/hour, preserving headroom for the HA client that shares the account key. A `429 Retry-After` blocks follow-up calls until the bounded delay expires.

Cached summaries and detail/reading snapshots are allowlisted and size bounded before entering SQLite. The compact public snapshot still excludes detail and readings. A separate cache-only Brew Story route exposes sanitized recipe, event, tasting, and bounded telemetry fields only for a currently assigned batch or a visible On Deck batch while On Deck is globally enabled. Authenticated administrators can read any present cached batch and write bounded sensory overrides; hidden guidance and raw override state are not included in public story responses. Failed synchronization preserves last-known-good data and never clears assignments.

Cached artwork is never embedded as an arbitrary remote URL. The same-origin image route rechecks story visibility and the exact cached URL, accepts credential-free default-port HTTPS only, pins DNS to a public address for each hop, bounds redirects to three, allows only JPEG/PNG/WebP/GIF responses, limits the body to 2 MiB and the request to five seconds, and forwards no cookies or authorization headers. This boundary prevents cached image metadata from becoming an unrestricted server-side request primitive.

The only Brewfather write is the explicit End Batch request body `{"status":"Completed"}` for the currently assigned non-custom batch. The client offers no arbitrary PATCH method. End Keg and custom beverages never call Brewfather. A completion failure leaves the assignment and lifecycle open.

Home Assistant outbound events are built from per-type allowlists. They never accept complete Brewfather objects, arbitrary notes, action targets, webhooks, notification destinations, generic service payloads, fermentation measurements, controller state, or credentials. Publishing happens after the associated local commit and is non-fatal if HA is disconnected.

The public Taproom Status projection exposes only bounded health states/evidence and potential planning ranges. Exact serving-temperature entity IDs, maintenance notes, readiness policy controls, and full configuration are available only through authenticated endpoints and are absent from public HTTP/SSE snapshots. Health and forecast notifications use strict `health_transition` and `forecast_gap` event payloads; all notification services, webhook destinations, scripts, and credentials remain Home Assistant-owned.

## Database safety

Production expects existing data and refuses an empty named volume. On startup, a database with an older supported schema is backed up and verified in the independent backup volume before its ordered migration runs transactionally. A backup-verification or migration failure aborts startup. A database from a future schema version is rejected rather than downgraded. Use the supported maintenance commands described in [Database operations](DATABASE-OPERATIONS.md); never copy only a live SQLite main database file while WAL writes may be active.
