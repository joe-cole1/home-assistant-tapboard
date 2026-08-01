# Tapboard Security Operations

## Admin PIN initialization

Tapboard does not provide a usable default administrator PIN. New databases
and databases that still contain the legacy default remain publicly viewable,
but administrative authentication fails closed until a deliberate PIN is
provided.

1. Add a temporary, non-default four-digit value to the ignored `.env` file:

   ```env
   TAPBOARD_INITIAL_ADMIN_PIN=<choose-four-digits>
   ```

2. Rebuild and start Tapboard.
3. Confirm that the new PIN authenticates successfully.
4. Remove `TAPBOARD_INITIAL_ADMIN_PIN` from `.env`.
5. Recreate the container so the plaintext is no longer present in its
   environment.

The value is consumed only while `admin_pin_initialized` is false. It is never
logged or returned by the API. Changing the PIN or completing legacy
initialization revokes every prior administrator session.

Before migrating an existing installation, create a consistent SQLite backup.
Do not copy only the main database file while WAL writes may be active; use the
SQLite backup API or stop Tapboard before copying the database and WAL state.

## Reverse proxy

Tapboard permits browser requests only from its own origin. Direct HTTP access
derives that origin from the request Host. When TLS terminates at a reverse
proxy, configure the exact externally visible origin:

```env
TAPBOARD_PUBLIC_ORIGIN=https://tapboard.example.com
```

The reverse proxy must preserve the original Host, support long-lived SSE
responses without buffering, redirect HTTP to HTTPS, and add:

```text
Strict-Transport-Security: max-age=31536000
```

Only add `includeSubDomains` or HSTS preload after confirming every affected
hostname is permanently HTTPS. Tapboard intentionally does not emit HSTS over
its direct HTTP listener.

Tapboard denies iframe embedding. If Home Assistant iframe embedding is ever
required, the CSP `frame-ancestors` policy must be redesigned around an exact
trusted origin; do not replace it with a wildcard.

## Request and session behavior

- JSON request bodies are limited to 16 KiB and must use `application/json`.
- Unknown mutation fields and out-of-range values are rejected before any
  database or Home Assistant mutation.
- Administrator bearer tokens expire after 24 hours and are stored only as
  SHA-256 digests.
- A PIN change revokes all sessions, including the session making the change.
- Tapboard never logs PINs, hashes, bearer tokens, Authorization headers, or
  complete request bodies.

The four-digit PIN and process-local login rate limit are suitable for a
private household service but are not a replacement for authentication and
network controls at an Internet-facing reverse proxy.

## Container boundary

The supported Compose deployment binds only to `127.0.0.1:3005`, runs as the
non-root `node` UID/GID, uses a read-only root filesystem and a bounded `/tmp`
tmpfs, drops all Linux capabilities, enables `no-new-privileges`, and uses
Docker init for signal forwarding. Only the independent data and backup named
volumes are persistent and writable.

Production startup expects an existing database and refuses an empty named
volume. An older schema is migrated only after the database has been restored
and verified by the maintenance command, which writes a one-time approval
marker tied to the pre-migration schema version, table counts, and database
SHA-256.

`HA_TOKEN` remains an environment variable for local deployment compatibility.
Users with permission to inspect Docker container metadata may therefore read
it. Docker access must be treated as administrator-level access, and diagnostic
reports must include environment variable names only, never their values.
