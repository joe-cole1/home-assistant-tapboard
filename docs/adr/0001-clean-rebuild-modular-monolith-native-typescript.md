# ADR-0001: Clean rebuild, modular monolith, native TypeScript, and repository strategy

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

Tapboard v1 contains useful behavior and assets, but its runtime ownership, schema, and browser structure conflict with the approved v2 domain. Keeping both applications active would invite compatibility shims and accidental legacy imports.

## Decision

Tapboard v2 is a clean rebuild in this repository on a dedicated rebuild branch. The frozen v1 remains recoverable from `main`, Git history, and the reuse manifest; no permanent parallel v1/v2 runtime trees are kept.

The application will be one Node 24 LTS modular monolith. Backend and domain code use native, erasable TypeScript syntax executed directly by Node, with `tsc --noEmit` for static checking and no backend bundler, Babel, or `ts-node`. Browser code remains small modern JavaScript modules unless later evidence justifies a change.

Source is organized primarily by domain feature. Cross-domain workflows use explicit use cases and dependency passing. The design uses plain typed data and pure functions, feature-owned repositories, and small shared infrastructure. It does not use microservices, a service locator, a dependency-injection framework, or a compatibility layer for v1 storage or APIs.

## Consequences

- Obsolete v1 runtime and deployment paths are removed from the rebuild branch before Foundation.
- Proven algorithms and assets are deliberately reintroduced only through approved v2 boundaries.
- Foundation will establish the new application runtime and development/validation configuration. The frozen deployment phase will later establish the production Docker and Compose configuration.
- `architecture.md` must describe implemented reality rather than the future target.
