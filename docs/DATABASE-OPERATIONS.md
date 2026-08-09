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

Before a production storage or schema migration:

1. Create a disposable empty data volume; never reuse the live `tapboard_data` volume.
2. Restore a verified backup into it:

   ```sh
   npm run db:restore -- <backup-file> <empty-data-directory>
   ```

   Restore rejects non-quiescent WAL/SHM sidecars and writes a mode-`0600` approval marker containing the verified pre-migration schema version, table counts, and database digest. Do not create or edit this marker manually.

3. Start the candidate against that disposable volume with `HA_TOKEN` empty, a random loopback port, the read-only root filesystem, and the approved hardening.
4. Verify `integrity_check`, `foreign_key_check`, schema version 4 and migration ledger (including `theme-accent-overrides`), durable counts, lifecycle relationships, On Deck/custom-beverage records, nullable accent overrides, administrator initialization, digest-only sessions, HA hydration where appropriate, and HTTP 200 from `/healthz`.
5. Remove only the disposable container. Keep a useful rehearsal volume until the rollout is complete.

## Live named-volume migration and rollback

Keep a migration window within ten minutes:

1. Record the running image, Compose revision, health, loopback binding, mounts, schema, integrity result, and durable counts.
2. Retain the current image as a rollback image and keep the pre-migration Compose definition.
3. Create and verify an online preflight backup.
4. Stop Tapboard to establish a quiesce boundary, then create and verify the final backup from the source database.
5. Restore the final backup into an empty `tapboard_data` volume. Start the candidate so it validates and consumes the restore approval marker while applying any approved schema migration. Never overwrite the original source database.
6. Verify schema version, migration ledger, `integrity_check`, zero foreign-key violations, durable counts, open lifecycle count, forecast index, administrator initialization, container hardening, named volumes, loopback port `3005`, HA hydration, and `/healthz` HTTP 200.

Rollback immediately if migration/integrity checks fail, durable counts change unexpectedly, the container is unhealthy, hydration cannot recover, port scope is wrong, or required paths are not writable. Stop the candidate and restore the retained Compose definition and rollback image against the untouched source database. Retain the failed new volume for diagnosis.

The original OneDrive database, final quiesced backup, rollback image, and rehearsal volumes are retained rollback artifacts. Do not retire them without separate destructive approval and an observation period.
