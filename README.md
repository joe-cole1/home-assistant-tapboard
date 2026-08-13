# Tapboard v2 rebuild

This branch is the clean construction site for the approved Tapboard v2 rebuild. Rebuild initialization is complete only after its planning records, reuse manifest, legacy removal, architecture guardrails, GitHub issue structure, and validation have been reviewed.

There is deliberately no runnable Tapboard application on this branch yet. Foundation has not started, and no v2 runtime, schema, routes, dependencies, authentication, telemetry, or UI implementation exists here.

The frozen v1 application remains available from `main` at commit `429cf07e451b64ca1713655a34ffa5ebd376efae` and from Git history. Reusable v1 evidence is indexed in [`docs/rebuild/v1-reuse-manifest.json`](docs/rebuild/v1-reuse-manifest.json); it is not an active dependency of v2.

## Authoritative rebuild context

- [`docs/rebuild/TARGET.md`](docs/rebuild/TARGET.md)
- [`docs/rebuild/ARCHITECTURE-DECISIONS.md`](docs/rebuild/ARCHITECTURE-DECISIONS.md)
- [`docs/rebuild/V1-REUSE-CRITERIA.md`](docs/rebuild/V1-REUSE-CRITERIA.md)
- [`docs/rebuild/ARCHITECTURE-FREEZE.md`](docs/rebuild/ARCHITECTURE-FREEZE.md)
- [`docs/adr/`](docs/adr/)
- [`docs/rebuild/STATUS.md`](docs/rebuild/STATUS.md)

If these sources appear to conflict, follow the precedence in `ARCHITECTURE-FREEZE.md` and stop on any unresolved conflict.

## Initialization validation

Run the dependency-free construction-site gate:

```sh
bash scripts/check-architecture.sh
python3 scripts/check-reuse-manifest.py
git diff --check
```

The v1 `npm`, Docker, Home Assistant, database, and application test commands are intentionally unavailable after legacy removal. Foundation will establish the new canonical `npm run check` contract.
