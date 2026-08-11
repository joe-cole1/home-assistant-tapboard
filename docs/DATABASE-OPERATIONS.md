# Tapboard database operations

The live SQLite database and WAL files are in the `tapboard_data` named volume. Verified backups are in the independent `tapboard_backups` named volume. Neither is part of the container writable layer.

Use only the supported maintenance surface:

```sh
npm run db:backup
npm run db:verify -- <database-file>
npm run db:restore -- <backup-file> <empty-data-directory>
npm run db:prune-pours
```

For the deployed service, prepend `docker compose exec -T tapboard`. Commands emit maintenance metadata such as paths, schema version, integrity results, and table counts. Do not paste database contents, settings, PIN hashes, session digests, batch data, or pour rows into logs or reports.

Never copy only `tapboard.db` while Tapboard is running. Use the backup command, which uses SQLite’s online backup API and verifies the result, or establish a full quiesce boundary before handling database files.

## Backup and verification

Create and verify a backup:

```sh
docker compose exec -T tapboard npm run db:backup
```

Backup publication is atomic after `integrity_check` and `foreign_key_check` pass. Backups use UTC timestamp names, mode `0600` in the Linux backup volume, and SQLite rollback-journal format. Rotation retains the newest 14 daily backups plus one backup from each of the next eight distinct ISO weeks. Files outside the generated timestamp pattern, including retained pre-Batch-5 artifacts, are not rotated.

Verify a particular database file with an isolated helper environment and a read-only backup mount. The CLI requires an explicit target path:

```sh
npm run db:verify -- <database-file>
```

The repository does not install a scheduler. Configure Windows Task Scheduler or another operator-owned scheduler to run the supported backup command daily only after the deployment has been verified.

## Two-year pour retention

Retention is an explicit maintenance operation, never a startup side effect:

```sh
docker compose exec -T tapboard npm run db:prune-pours
```

The command first creates and verifies a new online backup. It then deletes, in one transaction, pours whose normalized timestamp is older than two calendar years, followed by integrity and foreign-key checks. If backup or verification fails, it deletes no pour rows.

## Disposable restore rehearsal

Use a disposable restore rehearsal to test recovery or a candidate image before a production rollout. It is optional: normal startup handles supported schema upgrades automatically.

1. Create a disposable empty data volume; never reuse the live `tapboard_data` volume.
2. Restore a verified backup into it:

   ```sh
   npm run db:restore -- <backup-file> <empty-data-directory>
   ```

   Restore verifies the backup and produces a standalone restored database without WAL/SHM sidecars. It is a recovery and testing mechanism, not a migration-approval step.

3. Start the candidate against that disposable volume with `HA_TOKEN` empty, a random loopback port, the read-only root filesystem, and the approved hardening. If its schema is older but supported, startup creates and verifies its own pre-migration backup before applying the transactional migration.
4. Verify `integrity_check`, `foreign_key_check`, schema version 6 and migration ledger (including `brewfather-cache` and `brew-story`), durable counts, lifecycle relationships, Brewfather cache/On Deck/custom-beverage records, reading pH and history-sync state, sensory overrides, nullable accent overrides, administrator initialization, digest-only sessions, HA hydration where appropriate, and HTTP 200 from `/healthz`.
5. Remove only the disposable container. Keep a useful rehearsal volume until the rollout is complete.

## Live named-volume migration and rollback

For a supported schema upgrade, use the live named volume in place. Normal startup provides the migration gate:

1. Record the running image, Compose revision, health, loopback binding, mounts, schema, integrity result, and durable counts.
2. Retain the current image as a rollback image and keep the pre-migration Compose definition.
3. Optionally create and verify a preflight backup or complete a disposable restore rehearsal before the rollout.
4. Start the candidate against the existing data volume. If it finds an older supported schema, it first creates and verifies a fresh backup in `tapboard_backups`, then applies all ordered migrations in one transaction. The application does not start if that backup fails verification or the migration fails.
5. Verify schema version, migration ledger, `integrity_check`, zero foreign-key violations, durable counts, open lifecycle count, forecast index, administrator initialization, container hardening, named volumes, loopback port `3005`, HA hydration, and `/healthz` HTTP 200.

Tapboard rejects a database from a future schema version rather than attempting to open or downgrade it. The production empty-volume guard remains in effect; do not bypass it by creating an empty volume for an existing deployment.

Rollback immediately if startup/migration checks fail, durable counts change unexpectedly, the container is unhealthy, hydration cannot recover, port scope is wrong, or required paths are not writable. Stop the candidate, restore the retained Compose definition and rollback image, and use the verified pre-migration backup to restore into a separate empty recovery volume if the original database needs replacement. Do not overwrite the original source volume; retain it and any failed candidate volume for diagnosis.

The verified pre-migration backup, rollback image, and rehearsal or recovery volumes are rollback artifacts. Do not retire them without separate destructive approval and an observation period.
