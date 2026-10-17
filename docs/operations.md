# Tapboard v2 operator and security guide

Application version 2.0.0 uses canonical schema 23. The telemetry wire API remains v1. [README](../README.md) covers setup and manual workflows; the archived [rebuild STATUS](history/rebuild/STATUS.md) records the rebuild's acceptance evidence. Build/review, merge, image publication, and deployment are separate operator actions.

## Select the deployment boundary

Use Docker Compose2.24.0 or later with `compose.production.example.yaml`. Keep a stable, separate project name such as `tapboard-prod`; changing it creates another named data volume. The example builds the reviewed root Dockerfile locally. It publishes 127.0.0.1:3005 by default and keeps the root filesystem read-only, UID/GID 1000, restricted writable `/tmp`, dropped capabilities, and no-new-privileges. Only `/app/data` persists. A fresh named volume takes the image directory ownership; existing bind mounts need appropriate UID/GID 1000 permissions.

Keep the encryption key and deployment settings in an ignored mode 0600 `.env`. For an external file, export `TAPBOARD_ENV_FILE` and also pass that file through Compose's `--env-file` option on every operation, including `up`, `ps`, `exec`, and recreate. `TAPBOARD_ENV_FILE` selects runtime variables; `--env-file` supplies interpolation for the image, published address/port, and external origin. Without both, an external file's HTTPS/LAN origin can be overridden by the loopback default. Shell variables take precedence over interpolation-file values. Never commit a real key or put it in a build argument. Avoid printing interpolated Compose configuration because it can contain secrets. Configure one exact browser-visible origin. Container host/port/database settings are fixed by the service intentionally.

```sh
export TAPBOARD_ENV_FILE=/absolute/path/to/tapboard.env
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml up -d --build
docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml ps
```

The remaining commands use `${TAPBOARD_ENV_FILE:-.env}` so the same interpolation file accompanies the runtime file. Create the selected configuration file before using these commands.

For direct LAN HTTP, put the selected host address and exact reachable URL in operator configuration:

```dotenv
TAPBOARD_PUBLISH_ADDRESS=192.168.1.50
TAPBOARD_PUBLISH_PORT=3005
TAPBOARD_EXTERNAL_ORIGIN=http://192.168.1.50:3005
```

For a same-host HTTPS reverse proxy, keep loopback publishing and set the HTTPS origin, for example `https://tapboard.example.com`. Set `TAPBOARD_TRUSTED_PROXIES` to the exact source address actually observed from the proxy; no wildcard or CIDR trust is accepted. The origin controls strict Origin validation and Secure cookies. Forwarded headers do not replace that authority. The proxy must preserve the intended host, support SSE without buffering, and permit long-lived event connections.

For an existing containerized proxy, use a private network and remove Tapboard's host port in an operator-owned override. Docker's [merge reference](https://docs.docker.com/reference/compose-file/merge/) documents `!reset` port removal. This fragment assumes an already-created external proxy network; adapt its name and connect the existing proxy to it:

```yaml
services:
  tapboard:
    ports: !reset []
    networks: [proxy]
networks:
  proxy:
    external: true
    name: tapboard-proxy
```

Pass both files in order: `docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml -f <operator-proxy-override> up -d --build`. The proxy forwards to `tapboard:3005`, and only the proxy publishes browser-facing ports. Keep its upstream network private. Trusted-proxy configuration still uses the proxy's exact observed address. Tapboard's optional external adapters need outbound network access; do not mark their only network internal without a separate egress path.

## Initialize and update safely

A clean volume starts an empty v2 database with no default PIN. Initialize through the stdin-only reset command with hidden input:

```bash
IFS= read -r -s TAPBOARD_NEW_PIN; printf '\n'
printf '%s\n' "$TAPBOARD_NEW_PIN" | docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml exec -T tapboard npm run operator:reset-pin
unset TAPBOARD_NEW_PIN
```

Before following README's stdin-only root-key rotation sequence, replace both development Compose invocations with `docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml`. Its file-update step uses the exported `TAPBOARD_ENV_FILE` path, defaulting to `.env`. After successful rotation and configuration update, recreate this same production project. Never place a PIN or key in a command argument. System changes require the current PIN and revoke sessions. Lost-PIN recovery requires local host/container access.

Normal updates preserve the project and data volume:

```sh
git fetch --prune
git pull --ff-only
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml up -d --build --force-recreate
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml ps
curl -fsS http://127.0.0.1:3005/healthz
```

Use the LAN/proxy URL instead when selected. GET and HEAD readiness report local application/database status with schema 23. Integration outages can degrade public connectivity while local readiness and domain administration remain available. After an update, follow the issue-specific MANUAL DEV TEST in README with disposable entities for destructive actions. Never use `down --volumes` as an update step.

The normal database is `/app/data/tapboard-v2.sqlite3`; Simulation uses a separate saved sibling. V1 `tapboard.db` is neither imported nor migrated. Do not point v2 at a v1 database or rewrite a rejected ledger. Canonical earlier v2 schemas upgrade transactionally; an unpublished divergent schema needs an explicit preservation/migration plan.

## Protect and recover operator state

The four-ASCII-digit PIN provides local/online authentication with scrypt and durable throttling; it has limited offline resistance if its verifier is stolen. The encryption root key is independent. Missing/wrong key material preserves encrypted rows and disables affected secrets, while local domain and authentication functions remain available. Restore the correct external key rather than deleting rows.

Use the supported verify-before-commit stdin key rotation. After it succeeds, atomically update only `TAPBOARD_SECRET_KEY` in the ignored environment file, preserving all other configuration, then recreate the service. README provides that sequence. Keep the new key secure through this operation; do not copy decrypted credentials into logs, screenshots, issues, or fixtures.

## Back up and restore

`npm run operator:backup [target-directory]` takes an online snapshot while Tapboard keeps running. The database uses SQLite's rollback journal, so copying the file directly can capture a half-written transaction. The command instead runs SQLite's `VACUUM INTO` on a read-only connection: it copies one committed state and never migrates or modifies the source. Application writes wait while the snapshot reads, roughly a second per 100 MB, and fail only if that exceeds SQLite's 5-second busy timeout. Each copy must pass SQLite's `quick_check` and foreign-key check before it gets its final name; otherwise the command exits nonzero. The saved Simulation database is copied too when it exists. The default target is `<database directory>/backups`, which in the production container is `/app/data/backups` on the persistent volume, because the root filesystem is read-only. An existing `/app/backups` mount can be the target when it's writable by UID 1000 and its filesystem supports hard links, which publish each finished copy without replacing anything.

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml exec -T tapboard npm run operator:backup
```

The command prints only each copy's path and size, such as `/app/data/backups/tapboard-v2-20261017T031500Z.sqlite3 (1048576 bytes)`; a Simulation copy has the same name plus `.simulation.sqlite3`. Names carry a UTC timestamp, and an existing file is never overwritten. If any copy fails, the command exits 1 and removes that copy, so every file under a backup name passed the check; a killed run can leave `*.partial` and `*.partial-journal` files to delete. A failure prints one stderr line with a fixed reason, such as `Operator command failed: the database stayed locked for 5 seconds.`, `… a backup with this name already exists.`, or `… the copy of the Simulation database failed its integrity check.`, so cron mail tells lock contention, a full disk, and corruption apart. Reasons never include error text, paths, or secrets; an unexpected error prints only `Operator command failed.` The copies contain the Admin PIN verifier and encrypted integration credentials, so each is created with mode 0600. A missing target directory is created with mode 0700; its parent must already exist.

Copy a backup out of the container, then move it off the host with your own tooling. `docker compose cp` keeps the 0600 mode:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml cp tapboard:/app/data/backups/tapboard-v2-20261017T031500Z.sqlite3 /secure/tapboard-backups/
```

Tapboard has no backup scheduler or retention engine; schedule backups with the operator's own cron. This script, run from a crontab entry such as `15 3 * * * /usr/local/bin/tapboard-backup`, takes a backup and then keeps the newest seven copies and their Simulation siblings. `set -e` skips pruning when the backup fails. Copy new backups off the host in the same script if you rely on them for disaster recovery.

```sh
#!/bin/sh
set -eu
cd /path/to/home-assistant-tapboard
export TAPBOARD_ENV_FILE=.env # or the absolute path of an external file; cron has no shell variables
tapboard() {
  docker compose --env-file "$TAPBOARD_ENV_FILE" -p tapboard-prod -f compose.production.example.yaml "$@"
}
tapboard exec -T tapboard npm run --silent operator:backup
tapboard exec -T tapboard sh -c 'cd /app/data/backups && ls -1r tapboard-v2-*Z.sqlite3 | tail -n +8 |
  while IFS= read -r f; do rm -f -- "$f" "$f.simulation.sqlite3"; done'
```

Backups never contain `TAPBOARD_SECRET_KEY`. Store the key separately from them, for example in a password manager: anyone holding both a backup and its key can decrypt the stored credentials, and a restored database without the matching key keeps its encrypted credentials but cannot use them until that key is configured. Root-key rotation re-encrypts only the live database, so keep each key for as long as you keep backups made under it.

To restore, stop Tapboard, replace the database file, and start it again; run the backup command first if the current database might still be needed. This one-off container uses the same volume and UID 1000, so the restored file keeps the expected owner. It renames the copy into place only after the whole transfer arrives, and removes any rollback journal left by the replaced database, which must never be applied to the restored copy:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml stop tapboard
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml run --rm -T tapboard \
  sh -c 'cat > /app/data/restore.partial && rm -f /app/data/tapboard-v2.sqlite3-journal && mv /app/data/restore.partial /app/data/tapboard-v2.sqlite3' \
  < /secure/tapboard-backups/tapboard-v2-20261017T031500Z.sqlite3
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml start tapboard
curl -fsS http://127.0.0.1:3005/healthz
```

Restore a Simulation copy the same way, to `/app/data/tapboard-v2.sqlite3.simulation.sqlite3`. A backup from an earlier schema upgrades when Tapboard starts; an older image refuses a backup with a newer schema. A restore also brings back the PIN and Admin sessions from backup time: if the PIN changed or sessions were revoked since, run `operator:reset-pin` afterwards, which sets the PIN and revokes every session. Never use `down --volumes` as part of a restore. Browser restore, key escrow, and v1 user-data migration remain outside Tapboard.

## Reproduce acceptance

Run `npm run check`, then install Chromium and run `npm run test:e2e`. `bash scripts/check-production-container.sh` builds a fresh image and checks hardened execution, clean-volume initialization, health/SSR, stdin PIN setup, the online backup command, persistent domain state after restart/recreate, degraded integration behavior, and graceful SIGTERM. It uses only a uniquely named disposable project/volume and removes only what it created. CI runs these as three independent gates.

Actual VPS deployment, other CPU architectures, and live Brewfather/Home Assistant mutations are operator checks beyond the disposable acceptance run. They are not substitutes for the canonical, browser, migration, and container gates.

## Diagnose Admin and integration failures

Recoverable integration API keys remain encrypted in server SQLite. Configure the external encryption key once on the server; browsers and displays do not receive it. Startup diagnostics distinguish absent/invalid server key configuration from existing credentials that cannot be decrypted. Preserve encrypted rows and restore the matching external key or use the supported rotation procedure.

Authenticated Admin operational errors carry a reference matching a structured JSON log event. Known failures explain the recovery step; unexpected exceptions use a safe fallback. The event includes a static operation identifier, error code/category, HTTP status, and bounded provider status/retry delay where available. Routine validation and authorization rejections do not create operational error noise. Brewfather background failures are reported on changes and reset suppression after verified recovery.

Inspect production logs using the same deployment environment file and project:

```sh
docker compose --env-file "${TAPBOARD_ENV_FILE:-.env}" -p tapboard-prod -f compose.production.example.yaml logs -f --tail=200 tapboard
```

Diagnostics exclude credential values, request bodies and headers, raw provider responses, and exception text/stack/cause. A form error reference is sufficient to locate its corresponding event; avoid copying secret-containing input or interpolated Compose configuration into support reports. Logging is best effort and never changes mutation success, transaction rollback, or shutdown behavior.
