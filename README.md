# Tapboard v2

Tapboard v2 is being rebuilt as an ESM modular monolith. Issue #66 establishes the first runnable Foundation on Node 24: native erasable TypeScript executed directly by Node, static checking with `tsc --noEmit`, Node HTTP, file-based Eta rendering, and a controlled `better-sqlite3` database boundary.

This branch is a local/development Foundation awaiting review and shipping. It does not contain a production deployment, product feature UI, authentication, telemetry, integrations, or any domain feature from #67 onward.

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

| Environment variable         | Default                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `TAPBOARD_HOST`              | `127.0.0.1`                                                  |
| `TAPBOARD_PORT`              | `3000`                                                       |
| `TAPBOARD_DATABASE_PATH`     | `data/tapboard-v2.sqlite3` relative to the working directory |
| `TAPBOARD_SHUTDOWN_GRACE_MS` | `5000`                                                       |

The runtime creates the database parent directory when needed. `GET /healthz` is the only registered route. A ready process returns HTTP 200 with `{"status":"ok","schemaVersion":1}`. This reports only local application and database readiness; it does not check external integrations or feature health.

The runtime has no backend transpiler, application bundler, SPA framework, or HTTP framework. Docker and Compose deployment remain deferred to issue #81.

## Canonical validation

Run the complete local gate with Node 24:

```sh
npm run check
```

The gate runs Prettier checking, ESLint, `tsc --noEmit`, architecture and reuse-manifest checks, and the `node:test` suite. CI installs with `npm ci`, runs this same gate under Node 24, and checks changed-line whitespace.

Playwright/browser E2E is intentionally not introduced in #66 because no feature UI or workflow exists. No E2E tests ran or passed; that tier is deferred to the later UI work in issue #76. The canonical local and CI gate above is authoritative for this Foundation.

## Authoritative rebuild context

- [`docs/rebuild/TARGET.md`](docs/rebuild/TARGET.md)
- [`docs/rebuild/ARCHITECTURE-DECISIONS.md`](docs/rebuild/ARCHITECTURE-DECISIONS.md)
- [`docs/rebuild/V1-REUSE-CRITERIA.md`](docs/rebuild/V1-REUSE-CRITERIA.md)
- [`docs/rebuild/ARCHITECTURE-FREEZE.md`](docs/rebuild/ARCHITECTURE-FREEZE.md)
- [`docs/adr/`](docs/adr/)
- [`architecture.md`](architecture.md)
- [`docs/rebuild/STATUS.md`](docs/rebuild/STATUS.md)

If these sources appear to conflict, follow the precedence in `ARCHITECTURE-FREEZE.md` and stop on any unresolved conflict.
