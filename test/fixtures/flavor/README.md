# Offline flavor fixtures

These files are the allowlisted, reduced development material supplied with the approved flavor-profile handoff. They contain 61 batch fixtures, 46 saved recipes, thirteen behavior contracts, and small synthetic process cases. Names and opaque IDs are replaced; selected brewing amounts, metadata, missing fields, duplicate inventory representations, anomalies, one short barrel statement, and intentionally shifted inconsistent chronology remain.

The wrappers are development fixtures. `corpus.ts` passes each `input` through the production sanitizer with the explicit `brewfather-export-v3` adapter, then reads the persisted versioned brewing input envelope and runs the production pure engine. Inventory/calculated mirrors are never additional additions. These are normalization and behavior contracts, not measured tasting scores or a training dataset.

Nothing here is a live API request, credential, or full account export. Use the isolated preview database, never import this corpus into the operator's normal beverage list. Original fixture source: `tapboard-sensory-codex-handoff.zip`, verified against its SHA-256 manifest before adaptation.

Regenerate the machine report with `node scripts/report-flavor-corpus.ts`. It records coverage, source, availability, bands, diagnostics, snapshot sizes, and explicit reasons for priority-case missing/zero axes. Score distributions are diagnostic observations, not targets for tuning.
