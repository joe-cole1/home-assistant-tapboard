# Tapboard Database Operations

Tapboard stores the live SQLite database and its WAL files in the Docker named
volume `tapboard_data`. Verified backups are stored independently in
`tapboard_backups`. Neither volume is part of the container writable layer.

Never copy only `tapboard.db` while Tapboard is running. Use the maintenance
command, which uses SQLite's online backup API and verifies the resulting file.
Commands print paths, schema versions, integrity results, and table counts; they
do not print settings, PIN hashes, session digests, batch data, or pour rows.

The supported Compose service sets `TAPBOARD_EXPECT_EXISTING_DATA=true` and
requires a verified restore marker before upgrading an older schema. This
prevents either an accidentally empty named volume or an unverified legacy
database from being accepted as production state. A genuinely new install must
set `TAPBOARD_EXPECT_EXISTING_DATA=false` only for its first successful start,
then set it back to `true`.

## Backup and verification

Create and verify a backup:

```sh
docker compose exec -T tapboard npm run db:backup
```

Backups use UTC timestamp names, mode `0600` inside the Linux backup volume,
the standalone SQLite rollback-journal format, and atomic publication after
`integrity_check` and `foreign_key_check` pass.
Rotation retains the newest 14 daily backups plus one backup from each of the
next eight distinct ISO weeks. Files outside the generated timestamp pattern,
including pre-Batch-5 artifacts, are never rotated.

The repository does not install a host scheduler. Configure Windows Task
Scheduler or another operator-owned scheduler to run the command daily after
the live migration is verified.

To verify a specific file from inside an isolated helper container, run the
maintenance CLI with the backup volume mounted read-only. Do not paste database
contents into issue reports or logs.

## Two-year pour retention

Pour retention is an explicit maintenance operation, not a startup side effect:

```sh
docker compose exec -T tapboard npm run db:prune-pours
```

The command first creates and verifies a new online backup. Only then does it
delete rows whose normalized timestamp is older than two calendar years, in a
single transaction, followed by integrity and foreign-key verification. If the
backup or verification fails, no pour rows are deleted.

## Disposable restore rehearsal

Before a production storage or schema migration:

1. Create a disposable data volume, never the live `tapboard_data` volume.
2. Restore a verified backup to the empty volume with
   `npm run db:restore -- <backup-file> <empty-target-directory>`.
   A successful restore writes a mode-`0600` approval marker containing the
   verified pre-migration schema version, table counts, and database SHA-256.
   The approval gate also rejects SQLite WAL/SHM sidecars, proving that the
   restored input is quiescent. Do not create or edit this marker manually.
3. Start the candidate image with the disposable volume, `HA_TOKEN` empty, a
   random loopback port, the read-only root filesystem, and approved hardening.
4. Verify `integrity_check`, `foreign_key_check`, schema version and migration
   ledger, durable table counts, lifecycle relationships, administrator
   initialization state, digest-only sessions, and HTTP 200 from `/healthz`.
5. Remove only the disposable container. Retain the rehearsal volume until the
   live rollout is complete if it may help diagnose a failure.

## Live named-volume migration

The migration window is limited to ten minutes:

1. Record the running image ID, Compose revision, health, port binding, mount,
   database/WAL sizes, schema version, integrity result, and durable counts.
2. Tag the current image as the rollback image and retain the pre-Batch-5
   Compose definition.
3. Create and verify an online preflight backup while Tapboard is running.
4. Stop Tapboard to establish the quiesce boundary.
5. Create and verify a final backup from the now-quiescent OneDrive source.
6. Restore that final backup into the empty `tapboard_data` volume. Confirm the
   restore approval marker exists, then start the candidate so it validates and
   consumes the marker while running the migration. Never migrate or overwrite
   the original OneDrive database.
7. Verify schema version, migration ledger, integrity, foreign keys, durable
   counts, open lifecycle count, indexes, and administrator initialization.
8. Start the approved Compose service and verify non-root UID/GID, read-only
   root, writable data/backup/tmp paths, dropped capabilities,
   `no-new-privileges`, init, named-volume mounts, loopback-only port 3005,
   Home Assistant hydration, and `/healthz` HTTP 200.

Rollback immediately if migration or integrity fails, durable counts change
unexpectedly, the container is unhealthy, HA cannot hydrate for a transient
reason, port scope is wrong, or required paths are not writable. Stop the new
container, restore the pre-Batch-5 Compose definition and rollback image, and
start against the untouched OneDrive database. Do not delete the new volume;
retain it for diagnosis.

The original OneDrive database, final backup, and rollback image must remain
available after a successful rollout. Removing or retiring them requires a
separate approval and observation period.
