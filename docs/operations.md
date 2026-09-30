# Tapboard v2 operator and security guide

Application version 2.0.0 uses canonical schema 22. The telemetry wire API remains v1. [README](../README.md) covers setup and manual workflows; [STATUS](rebuild/STATUS.md) records exact acceptance evidence. Build/review, merge, image publication, and deployment are separate operator actions.

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

Use the LAN/proxy URL instead when selected. GET and HEAD readiness report local application/database status with schema 22. Integration outages can degrade public connectivity while local readiness and domain administration remain available. After an update, follow the issue-specific MANUAL DEV TEST in README with disposable entities for destructive actions. Never use `down --volumes` as an update step.

The normal database is `/app/data/tapboard-v2.sqlite3`; Simulation uses a separate saved sibling. V1 `tapboard.db` is neither imported nor migrated. Do not point v2 at a v1 database or rewrite a rejected ledger. Canonical earlier v2 schemas upgrade transactionally; an unpublished divergent schema needs an explicit preservation/migration plan.

## Protect and recover operator state

The four-ASCII-digit PIN provides local/online authentication with scrypt and durable throttling; it has limited offline resistance if its verifier is stolen. The encryption root key is independent. Missing/wrong key material preserves encrypted rows and disables affected secrets, while local domain and authentication functions remain available. Restore the correct external key rather than deleting rows.

Use the supported verify-before-commit stdin key rotation. After it succeeds, atomically update only `TAPBOARD_SECRET_KEY` in the ignored environment file, preserving all other configuration, then recreate the service. README provides that sequence. Keep the new key secure through this operation; do not copy decrypted credentials into logs, screenshots, issues, or fixtures.

Backups, snapshot consistency, key escrow, and restore rehearsal belong to the deployment operator. Tapboard has no backup volume, backup scheduler, browser restore, or v1 user-data migration. Protect both the normal and saved Simulation databases and the separate encryption key through the chosen external process.

## Reproduce acceptance

Run `npm run check`, then install Chromium and run `npm run test:e2e`. `bash scripts/check-production-container.sh` builds a fresh image and checks hardened execution, clean-volume initialization, health/SSR, stdin PIN setup, persistent domain state after restart/recreate, degraded integration behavior, and graceful SIGTERM. It uses only a uniquely named disposable project/volume and removes only what it created. CI runs these as three independent gates.

Actual VPS deployment, other CPU architectures, and live Brewfather/Home Assistant mutations are operator checks beyond the disposable acceptance run. They are not substitutes for the canonical, browser, migration, and container gates.
