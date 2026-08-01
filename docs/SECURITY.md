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

The PIN is consumed only while `admin_pin_initialized` is false and is stored as a bcrypt hash. It is never returned by the API. Changing a PIN or finishing legacy initialization deletes every administrator session.

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

## Container and secrets

Compose binds only `127.0.0.1:3005`; the application listens on container port `3000`. The service runs as non-root, has a read-only root filesystem, uses a bounded writable `/tmp` tmpfs, drops all capabilities, sets `no-new-privileges`, and uses Docker init. Only the independent `tapboard_data` and `tapboard_backups` named volumes are persistent and writable.

`HA_TOKEN` remains environment-injected for local deployment compatibility. Docker metadata access can reveal environment variables, so Docker access is administrator-level access. Do not print, read back, commit, or include the token in diagnostics.

Token rotation is an operator-owned deferred action: revoke the old token in Home Assistant, create and privately place a replacement in the ignored environment file, recreate Tapboard, and verify HA hydration without exposing values or authorization data.

## Database safety

Production expects existing data and refuses an empty named volume. An older schema is accepted only after a verified restore has written the one-time migration approval marker tied to the source schema, table counts, and database digest. Use the supported maintenance commands described in [Database operations](DATABASE-OPERATIONS.md); never copy only a live SQLite main database file while WAL writes may be active.
