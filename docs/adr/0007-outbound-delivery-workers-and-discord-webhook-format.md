# ADR-0007: Outbound delivery workers and bounded webhook formats

- Status: Accepted and frozen
- Date: 2026-08-17
- Amends: [ADR-0005](0005-integrations-events-and-bounded-outbox.md) only

## Context

Tapboard's transactional outbox now needs provider-facing delivery workers without moving network I/O into local domain transactions. The integration boundary must preserve immutable configuration history, rotate secrets without changing logical destination identity, and keep external failures from changing local domain truth.

## Decision

Outbound destinations are logical, provider-neutral records. Each destination has immutable configuration versions and immutable event subscriptions; editing creates a new version while the logical destination and its secret slots remain stable. Secret rotation changes the value in the logical destination slot, never the destination identity or historical configuration record. Delivery claims bind each attempt to the immutable version selected by the outbox admission record.

Home Assistant uses one injected/native WebSocket connection per logical destination, with the destination's current endpoint and token applied to the connection. Its event name is exactly `tapboard_event`; the adapter does not expose arbitrary Home Assistant service calls. Historical deliveries may use their bound version's endpoint while retaining the same logical connection boundary. LAN HTTP is allowed for Home Assistant destinations when explicitly configured.

Webhooks use the standard bounded event envelope. A single bounded Discord-message formatter may be selected as a webhook payload format, but Discord is not a dedicated adapter or plugin: there are no Discord-specific templates, scripts, or provider framework. Webhook requests resolve and validate every attempt, permit only public destinations, reject unsafe or mixed DNS answers, pin the actual dial to the validated lookup, follow no redirects, and enforce bounded connection, response, body, and abort limits. Endpoint material is bound to the immutable configuration version, while secret-header references resolve through logical destination slots at send time so rotation or removal applies immediately, including to historical retries. Secret values are never returned in Admin projections, errors, logs, Activity, or payload evidence.

The generic SQLite outbox remains the delivery authority. Claims are leased, completed with compare-and-set revision checks, and therefore provide at-least-once delivery. At most one unexpired in-flight claim is allowed per logical destination; global claiming remains bounded and deterministic. Retryable failures use deterministic exponential backoff capped at one hour and become terminal after 24 hours of an active failure window or the cycle-attempt bound. Permanent failures are terminal immediately. A required destination degrades application status only after five minutes of continuous failure; optional destinations do not degrade required status. Disabling a destination pauses due and failure-window clocks, and re-enabling shifts them forward without discarding history. Retry is available only for terminal deliveries; dismissed deliveries are final.

Workers are lifecycle-owned by the application composition boundary and use injected clocks, transports, secret stores, and schedulers for tests. No SQLite transaction remains open across a network operation: a worker claims in SQLite, performs the bounded network attempt outside the transaction, then records the CAS result, connectivity evidence, and any canonical status-change admission in one short SQLite transaction.

## Consequences

- Local domain writes and outbox admission remain atomic, while all network work is outside SQLite transactions.
- Historical configuration and delivery evidence remain auditable without exposing secrets or rewriting logical destination identity.
- At-least-once delivery, lease expiry, CAS completion, bounded retry, and one in-flight claim per destination make duplicate sends and terminal outcomes explicit rather than pretending to provide exactly-once delivery.
- Discord remains a bounded webhook serialization choice, not a new integration subsystem.
- Public SSR and Admin projections expose safe summaries and status only; secret values and network diagnostics remain privileged and bounded.
