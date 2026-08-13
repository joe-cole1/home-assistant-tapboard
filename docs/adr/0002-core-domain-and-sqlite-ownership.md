# ADR-0002: Core domain and normalized SQLite ownership

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

The physical taproom requires durable identities for beverages, reusable Kegs, individual Fills, serving Taps, and assignment history. External source data must not own physical inventory or become a competing presentation layer.

## Decision

The core relationship is Beverage → Fill → Physical Keg → optional Tap assignment. SQLite is Tapboard's normalized system of record, with foreign keys, constraints, ordered post-baseline migrations, and feature-owned repositories. Raw SQL does not belong in HTTP, domain, or integration modules.

A Beverage has immutable identity and an ownership discriminator. Custom presentation lives in a one-to-one Custom profile. A Brewfather-linked Beverage has a unique source link, typed sanitized last-known source values, and per-field overrides with explicit presence so inherit, clear, and override are distinct. No third effective-presentation copy is persisted. Unlinking transactionally materializes effective Custom values, detaches an immutable source recipe snapshot, preserves manual sensory overrides, and leaves Fills and history intact. Density resolves manual override → FG-derived → configurable FG 1.008 equivalent.

A Physical Keg owns current capacity, current tare, an append-only tare history, inventory state, and maintenance history. A Fill belongs to exactly one Beverage and Keg; a Keg has at most one active Fill. Presentation never belongs to a Fill or Tap. Assignment opens an immutable Fill–Tap lifecycle, and moving or unassigning closes it without losing Fill-level history.

Enabled controls public Tap visibility only. A used Tap is retired, not deleted. `first_used_at` is monotonic and is set by the first committed registered Tap operation. Hard deletion is permitted only while it is null and no protected reference exists; a retired Tap number remains reserved.

Deletion follows the frozen impact rules: Beverage deletion cascades through its Fills but not physical Kegs; Keg deletion removes its dependent Fills/history but not Beverages; Fill deletion removes its dependent history. Tap Wars history tied to a deleted Fill is removed as a whole. Destructive actions require explicit impact confirmation and a minimal deletion audit.

## Consequences

- v1 schema and migrations are not extended or migrated.
- Domain mutations spanning records are atomic use cases.
- Capacity changes during an active Fill and tare changes start a new telemetry epoch; historical pours are never recomputed.
- Brewfather candidate cache is disposable and never owns a Beverage.
