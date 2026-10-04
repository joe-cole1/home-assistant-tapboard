# ADR-0008 — Built-in simulation workspace

Status: Accepted — explicitly requested by the operator on 2026-09-29.

## Decision and scope

Add Simulation to System and an authenticated Simulator page before the remaining System/final-acceptance issues. One deployable Node application serves the existing public and Admin interfaces using a separate, saved simulation database. This extends the frozen target with operator-approved QC tooling; it does not introduce a second implementation of domain behavior or finish issues #80/#81.

The normal database owns the installation-wide mode and revision. The simulation file is the normal database's absolute filename plus `.simulation.sqlite3`, with its own identical versioned schema. The original 2026-09-29 decision seeded fictional Custom Beverages, Physical Kegs, assigned Fills, six Taps, and one On Deck Fill. The operator-approved 2026-10-04 extension below replaces new-workspace samples with bounded offline-history snapshots. No inventory, credentials, integration endpoints, or historical records are copied from the normal database. Reset replaces only the fixed simulation file and SQLite sidecars, after draining requests and closing its connection. Symbolic links and multiply-linked files are rejected.

## Approved sample extension — 2026-10-04

New workspaces seed Oktoberfest (fixture B064), Saison (fixture B058), Porter (fixture B061), IPA (fixture B033), and Bourbon Barrel Stout (fixture B026) on five Taps, with Hefeweizen (fixture B052) and Spiced Lager (fixture B060) On Deck. Original names were anonymized; these labels state style and fixture identifiers without inventing names. Seven minimized snapshots retain selected historical batch values, normalized ingredients, and process facts. The full offline corpus, raw narrative notes, accounts, credentials, external links, and private URLs are not seeded. Historical fermentation volume does not set simulated physical keg volume.

An internal Beverage service attaches validated payload-schema-2 snapshots to Custom beverages as immutable detached sources using the synthetic `offline-history` provenance namespace. This creates no account or external link and exposes no HTTP route. It uses the existing snapshot contract and current schema 23 without another schema bump.

Saved samples upgrade transactionally in place only when each original profile exactly matches all original editable values and has no Custom recipe, source snapshot, or populated manual override. Customized, deleted, or ambiguous profiles remain unchanged. Only when all original profiles and the entire original topology are untouched does the sixth Fill move to On Deck and its Tap become disabled. The first five assignment IDs remain; the sixth Tap's sensor/source, control settings, physical volume, and Tap/Keg/Fill/pour history remain preserved. Changed layouts retain their assignments. Repeated entry does not reset or re-import samples. Normal inventory, installation authentication, and the persistent volume remain unchanged.

## Runtime and input ownership

A single HTTP listener selects a complete composition of the existing services. Each workspace owns its SQLite connection, domain services, detector, health evaluation, and SSE hubs. Enabling lazily opens the saved simulation composition; exiting stops its sensor runner and closes that composition. The normal runtime remains available to physical senders: `/api/v1/telemetry/*` always targets the normal workspace. Health readiness also describes the normal application/database.

Simulation generates timestamped total-weight and temperature samples, validates the external telemetry shape, authenticates its current source key, and uses the ordinary ingestion/detector pipeline. It does not fabricate pours, forecasts, health results, or browser data. Source identity and Fill-owned physical volume persist; plaintext source keys exist only in process memory. A bounded timer emits idle measurements and faster readings during a pour. Completed pours survive exit and restart; an interrupted pour stops at the volume actually submitted and the ordinary detector completes or cancels it. No automatic replay of its remaining requested volume occurs. Volume follows its Fill across Tap reassignment; new ordinary Fills start at their Keg capacity. Sensor state retains only the last delivered reading and control settings.

Simulation starts no outbound workers or Brewfather synchronization timers. Its Brewfather transport refuses network calls, it has no root integration key, and integration administration is unavailable while simulation is selected. Normal-workspace integrations retain their existing behavior.

## Authentication and switching

Both views use the normal installation's PIN and authentication service. A successful switch/reset atomically advances the normal mode revision and rotates the initiating Admin session/CSRF pair, revoking other sessions. This prevents a form left open in another workspace from mutating a new dataset; other devices may need to sign in again. The initiating browser stays signed in. Open displays observe the revision and reload; simulation pages carry a persistent banner. Per-browser display preferences use a separate simulation key. The simulator controls retain normal Origin, CSRF, bounded-form and Admin authorization requirements.

Mode changes serialize. Reset/exit reject while an old request cannot drain safely. A saved simulation that cannot open at startup leaves the normal workspace available and records a runtime error. A failed reset that can no longer retain its old runtime returns to normal mode and revokes stale sessions. Sample data remains separate from normal data in every failure path.

## Consequences

The simulator is reusable after hardware returns and uses the same UI and core services as production. It tests software behavior, not scale calibration or external Home Assistant automations. The first release provides saved setup, preset/custom pours, sensor pause/resume, idle noise, exit, and explicit reset. Automated activity, arbitrary remaining-volume controls, and external-integration receivers are separate future work.
