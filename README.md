# Tapboard v2

Tapboard v2 is being rebuilt as an ESM modular monolith. Issues #66 and #67 are on `main`: #66 establishes the first runnable Foundation on Node 24 (native erasable TypeScript executed directly by Node, static checking with `tsc --noEmit`, Node HTTP, file-based Eta rendering, and a controlled `better-sqlite3` database boundary), while #67 adds the security, Activity, event, secret, machine-key, and bounded-outbox primitives. Issue #85 adds a development-only container workflow for local use; production deployment remains deferred to #81.

The current implementation includes the local Foundation, #67 primitives, and the #85 development container. No production deployment, Admin page, provider adapter, delivery worker, or domain workflow is included.

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

The runtime creates the database parent directory when needed. `GET /healthz` is the only registered route. A ready process returns HTTP 200 with `{"status":"ok","schemaVersion":2}`. This reports only local application and database readiness; it does not check external integrations or feature health.

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

Schema version 2 contains typed security/session primitives, encrypted-secret storage, machine API-key storage, Activity and immutable deletion-audit records, stable event envelopes, and bounded outbox tables. Activity retention never prunes domain history or deletion audit, and Activity writes never recursively create outbox rows.

The event registry is an explicit allowlist with durable IDs and canonical UTC envelopes. Outbox admission uses hard global/per-destination row and UTF-8 byte bounds, bounded terminal pruning, restricted semantic coalescing, fixed overflow slots, and explicit `not_queued_capacity` degradation semantics. Delivery state is designed for at-least-once processing with leases and compare-and-set results; it does not claim exactly-once network delivery. Providers, workers, webhooks, Home Assistant delivery, and domain producers remain deferred.

Playwright/browser E2E is intentionally not introduced because no feature UI or workflow exists; that tier is deferred to issue #76. The canonical local and CI gate above is authoritative.

## Authoritative rebuild context

- [`docs/rebuild/TARGET.md`](docs/rebuild/TARGET.md)
- [`docs/rebuild/ARCHITECTURE-DECISIONS.md`](docs/rebuild/ARCHITECTURE-DECISIONS.md)
- [`docs/rebuild/V1-REUSE-CRITERIA.md`](docs/rebuild/V1-REUSE-CRITERIA.md)
- [`docs/rebuild/ARCHITECTURE-FREEZE.md`](docs/rebuild/ARCHITECTURE-FREEZE.md)
- [`docs/adr/`](docs/adr/)
- [`architecture.md`](architecture.md)
- [`docs/rebuild/STATUS.md`](docs/rebuild/STATUS.md)

If these sources appear to conflict, follow the precedence in `ARCHITECTURE-FREEZE.md` and stop on any unresolved conflict.
