# ADR-0005: Integration capabilities, stable events, and bounded outbox delivery

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

External systems are optional around Tapboard's local domain. Delivery failures must not roll back local actions, while durable delivery cannot be allowed to grow storage without a hard limit.

## Decision

Integrations implement explicit capabilities such as Beverage data source, telemetry source, and outbound destination. Integration-specific payloads terminate at adapter boundaries; core domain modules never import Brewfather- or Home Assistant-specific types. This is not a dynamic plugin system.

Stable, versioned domain event envelopes contain a durable event ID, type, occurrence time, relevant Tap/Fill/Keg/Beverage identifiers, and bounded type-specific data. Local handlers use an in-process dispatcher. Externally delivered intents use a SQLite transactional outbox when admission capacity exists; delivery is at-least-once, outside the domain transaction, and retries reuse the same event ID.

Admission is serialized with the domain write and bounded by row and serialized-byte quotas globally and per destination. Eligible terminal records are pruned in bounded batches. Only registry-approved, unattempted, supersedable events may coalesce. If capacity is still unavailable, the local mutation commits, no event/delivery row is created, the result is `not_queued_capacity`, and a strictly bounded overflow incident records aggregated omission evidence and degrades Admin status. Storage corruption or exhaustion is a storage failure, not ordinary capacity rejection.

Workers use leases, compare-and-set completion, bounded exponential backoff, immutable destination configuration versions, and visible terminal failures. Pending deliveries protect referenced versions from pruning. Home Assistant is an optional outbound `tapboard_event` adapter. Generic webhooks receive the standard envelope with SSRF, redirect, timeout, size, and secret-redaction protections. Tapboard performs no arbitrary HA service calls or custom webhook scripting.

## Consequences

- External failure never controls physical inventory or local availability.
- Tapboard never claims exactly-once network delivery or reports an omitted event as queued.
- Dedicated Discord delivery is not implemented; downstream automation owns it.
- Outbox overflow state and its Activity transitions remain bounded and never feed the outbox recursively.
