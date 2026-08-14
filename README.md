# Tapboard v2

Tapboard v2 is being rebuilt as an ESM modular monolith. Issue #66 establishes the first runnable Foundation on Node 24: native erasable TypeScript executed directly by Node, static checking with `tsc --noEmit`, Node HTTP, file-based Eta rendering, and a controlled `better-sqlite3` database boundary.

This branch is a local/development implementation of the #66 Foundation plus the #67 security, Activity, event, secret, machine-key, and bounded-outbox primitives. It remains awaiting review and shipping; no production deployment, Admin page, provider adapter, delivery worker, or domain workflow is included.

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

The runtime has no backend transpiler, application bundler, SPA framework, or HTTP framework. Docker and Compose deployment remain deferred to issue #81.

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
