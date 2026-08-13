# ADR-0004: Canonical telemetry, epochs, idempotency, and pour detection

- Status: Accepted and frozen
- Date: 2026-08-13

## Context

V1 treats Home Assistant as telemetry truth. V2 must accept measurements from independent systems without importing their concepts into the domain, and retries or replay must never duplicate a measurement or pour.

## Decision

Tapboard owns a versioned telemetry API. Named telemetry sources authenticate with strong randomly generated keys that are shown once and stored only as hashes. Each Tap explicitly selects one authoritative source; no automatic failover occurs. Boundaries normalize mass to grams, volume to milliliters, temperature to Celsius, and preserve required measurement time separately from receipt time.

Every interpretation period is an immutable telemetry epoch that snapshots its Tap, source, Fill, assignment, Keg capacity/tare, effective density, normalization version, detector configuration version, reason, and baseline state. Assignment, Fill move, source/capacity/tare/density/configuration changes, and manual re-baseline close the prior epoch and create a new one awaiting a fresh baseline.

Idempotency uses `(source_id, client_sample_id)` when supplied, otherwise `(source_id, tap_id, measured_at_epoch_ms)`. A SHA-256 digest covers the normalized semantic payload. Same identity and digest returns the original durable outcome without rerunning side effects; same identity with a different digest is a conflict with no domain effects. Receipt retention outlives the accepted retry horizon, and closed epochs cannot be re-entered after receipt expiry.

Single and bounded batch ingestion share deterministic ordering and the same transaction pipeline. A newly accepted sample may atomically persist its receipt and measurement, advance projections and detector state, create one qualifying pour, record meaningful Activity, and admit an outbound event. Ordinary samples and retries are not Activity Log entries.

Pour detection is deterministic and durable per Tap/epoch. Independent Taps may pour simultaneously; cross-Tap arbitration exists only for explicitly configured hardware/noise groups. Completed pours capture immutable Fill, Tap, assignment, epoch, volume, and timestamps. A separate deterministic durable terminal `effect_key` prevents HTTP retry, batch retry, restart recovery, or replay from creating the same pour twice.

## Consequences

- Home Assistant is not inbound telemetry truth and no HA entity naming contract enters core code.
- Raw telemetry and dedup receipts use separate bounded retention horizons.
- Historical interpretation and pours are never recalculated with current settings.
- The proven v1 detector is an algorithm reference, not an imported runtime dependency.
