# Rebuild architecture guardrails

## Active during initialization

`scripts/check-architecture.sh` is dependency-free and currently enforces:

- required authoritative rebuild records remain present;
- known v1 runtime, database, Home Assistant telemetry, backup, SPA, and deployment paths do not return;
- no top-level or active-source `v1`, `v2`, or `legacy` shadow runtime tree is introduced;
- source files do not import named legacy v1 runtime modules;
- core domain directories do not import integration-specific modules;
- browser directories do not import server or infrastructure source;
- raw SQL in application source is limited to repository, migration, or database-infrastructure ownership.

`scripts/check-reuse-manifest.py` uses only the Python standard library and enforces the exact immutable frozen v1 commit, manifest schema/classifications, required entry fields, unique entry IDs, and every source/test path's recorded Git blob.

The guardrail intentionally excludes `docs/` from legacy-name scans because the rebuild records and manifest must discuss v1 paths.

The exact path bans are construction-site checks, not permanent bans on v2 files. During Foundation, the package/runtime bans must be replaced with v2 topology- and content-aware checks before the new package manifest or runtime is added. The clean Docker/Compose files remain absent until their frozen deployment phase; that phase must replace the initialization Docker path bans with v2 deployment-content checks in the same change that introduces those files.

## Pending Foundation topology

Foundation must review and tighten the import and SQL allowlists after it establishes the approved TypeScript feature tree. It must also:

- replace initialization-only package/runtime path bans before adding legitimate v2 manifests or runtime paths;
- make the architecture gate part of the canonical `npm run check`;
- prohibit integration-specific imports from every finalized core-domain location;
- prohibit browser imports from finalized server-only paths;
- permit raw SQL only in the finalized feature repository and migration ownership paths;
- add tests proving violations fail with concise path/rule output.

The deployment/final-acceptance phase must replace the initialization-only Docker/Compose path bans before adding the approved clean v2 deployment files, while continuing to reject legacy Node, backup-volume, HA-telemetry, and secret-handling configuration.

These are explicit pending checks, not claims that an absent runtime has already proven the final topology.
