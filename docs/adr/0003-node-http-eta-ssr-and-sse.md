# ADR-0003: Node HTTP, Eta SSR, progressive enhancement, DTOs, and SSE

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

The v1 browser constructs a large client application around broad snapshots and combined public/Admin controls. V2 requires independently reachable Admin pages, an authoritative first render, clear privacy boundaries, and modest browser complexity.

## Decision

The server uses Node HTTP with the smallest readable routing abstraction and Eta file-based templates. Public and Admin pages are server-rendered with shared layouts and escaped templates. Admin uses normal form workflows under a common authenticated shell; page-specific JavaScript provides progressive enhancement rather than a hidden SPA.

Browser code uses semantic HTML, plain CSS, native ES modules, and small page-specific modules. No React, Vue, Svelte, Tailwind, Bootstrap, CSS-in-JS, or browser bundler is introduced without a separately demonstrated need.

Public and Admin responses use purpose-specific DTOs. Raw database rows, integration payloads, secrets, private telemetry, and Mystery-hidden fields are never serialized directly. Mystery redaction is enforced at every public projection boundary, including Brew Story and SSE.

Initial public HTML contains authoritative state. After paint, feature-specific SSE events update targeted regions. SSE is not a durable event log: reconnect performs an authoritative page/projection refresh and then resumes incremental events. The hub retains bounded framing, heartbeat, buffering, and slow-client behavior; mutations use normal HTTP.

## Consequences

- There is no giant client-side application snapshot or monolithic public/Admin controller.
- Public read APIs are minimal, purpose-built projections.
- Per-display preferences remain validated browser-local overrides over typed shared defaults.
- Foundation will add Eta and browser tooling; initialization adds no runtime dependencies or templates.
