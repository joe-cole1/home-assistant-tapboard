# Tapboard v2 Architecture Freeze

## Status

**FROZEN — Approved for rebuild initialization**

This document records the final approved architecture deltas that supersede earlier analysis where noted.

A fresh Codex thread must be able to reconstruct the approved architecture from repository files alone. Do not rely on conversational context from prior Codex threads.

Authoritative rebuild documents:

- `docs/rebuild/TARGET.md`
- `docs/rebuild/ARCHITECTURE-DECISIONS.md`
- `docs/rebuild/V1-REUSE-CRITERIA.md`
- this file

If these documents appear to conflict, stop and report the exact conflict rather than guessing.

Do not reopen frozen decisions unless repository evidence demonstrates an actual contradiction, impossibility, data-safety defect, or security defect.

---

# 1. Administrative PIN

The Admin PIN contract is exactly:

```text
[0-9]{4}
```

Rules:

- exactly four ASCII decimal digits
- all 10,000 values are valid
- no trimming
- no Unicode-digit normalization
- no default PIN
- PIN changes revoke existing sessions
- local operator-only reset is supported

Verification uses:

- versioned `scrypt`
- persistent atomic SQLite login throttling
- secure opaque sessions
- session rotation and revocation
- CSRF and strict Origin validation

The security ADR must explicitly state:

- a four-digit PIN is intended to protect online/local Admin access;
- throttling, session controls, and `scrypt` protect the online authentication path;
- the 10,000-value PIN space is **not** intended to provide strong offline resistance if an attacker obtains the SQLite verifier;
- the PIN never derives, encrypts, or protects `TAPBOARD_SECRET_KEY`;
- integration-secret confidentiality depends on the separately supplied `TAPBOARD_SECRET_KEY`.

A missing or incorrect `TAPBOARD_SECRET_KEY` degrades affected integrations but does not disable local authentication or Tapboard domain operation.

---

# 2. Tap Lifecycle: Enabled, Retired, Deleted

Tap public visibility and Tap lifecycle are separate concepts.

## Enabled / Disabled

`enabled=false` means:

- hidden from the public dashboard
- assignment may continue
- telemetry may continue
- pour detection may continue
- health evaluation may continue

Disabled does **not** mean retired.

## Retired

A historically used Tap is retired rather than hard-deleted.

Retirement:

- requires any open assignment to be resolved explicitly first;
- does not silently Kick, move, or end a Fill;
- sets the Tap out of service;
- prevents new assignments;
- prevents telemetry attribution;
- prevents pour detection;
- prevents normal health evaluation;
- retains UUID, number, lifecycle history, pours, maintenance, and historical references.

Retired Tap numbers remain reserved.

## Hard deletion

A Tap may be hard-deleted only if it has never been operationally used.

The Tap has a nullable, monotonic:

```text
first_used_at
```

`first_used_at` is set transactionally on the first committed:

- assignment lifecycle;
- newly accepted authoritative telemetry sample, including unassigned telemetry;
- Tap line-maintenance record;
- Tap Wars entry;
- durable health incident;
- other explicitly registered Tap-owned historical operation.

Rejected, duplicate, or conflicting telemetry does not set it.

Once set, it cannot be cleared or changed.

Hard deletion requires:

- `first_used_at IS NULL`; and
- no protected historical references.

Pruning telemetry, health, or other retained history can never make a previously used Tap become "never used" again.

Deleting a never-used Tap releases its Tap number.

---

# 3. Physical Keg Capacity and Tare History

Physical Kegs store current:

- nominal capacity
- tare weight

## Capacity

There is **no** dedicated physical-Keg capacity-history table.

Changing capacity during an active Fill must atomically:

1. update the current nominal capacity;
2. close the current telemetry epoch;
3. create a new epoch awaiting a fresh baseline;
4. record a meaningful Activity Log entry.

Historical pours are never recomputed.

Historical telemetry epochs preserve the capacity used for prior interpretation.

## Tare

Tare weight retains an explicit append-only history.

Tare changes during an active Fill also invalidate the current telemetry baseline and create a new telemetry epoch.

---

# 4. Beverage and Brewfather Ownership

There is no persisted "effective presentation" copy.

The model must avoid three concurrent mutable representations of the same display field.

## `beverages`

The core Beverage row contains:

- immutable Beverage identity
- ownership discriminator
- timestamps

It does not contain a second generic copy of all effective presentation fields.

## Custom Beverage

A Custom Beverage owns its presentation data in a dedicated one-to-one profile.

Conceptually:

```text
custom_beverage_profiles
```

This owns fields such as:

- name
- type
- style
- ABV
- IBU
- OG
- FG
- SRM
- display color
- Fill Glass
- description
- manual density override

This profile is absent while the Beverage is Brewfather-linked.

## Brewfather-linked Beverage

A linked Beverage uses three distinct concerns:

### Link identity

Conceptually:

```text
brewfather_beverage_links
```

Contains:

- Beverage identity
- Brewfather account/source namespace
- source batch ID
- link/sync state
- timestamps

`(account_id, source_batch_id)` is unique.

### Source presentation values

Conceptually:

```text
brewfather_source_profiles
```

Contains typed, sanitized last-known source values.

These survive temporary Brewfather unavailability.

### Local presentation overrides

Conceptually:

```text
brewfather_presentation_overrides
```

Overrides use:

- an explicit "present" flag per override field; and
- the typed value.

For nullable fields:

- `present=false` → inherit Brewfather source value
- `present=true, value=NULL` → explicitly clear
- `present=true, value=<value>` → explicit Tapboard override

Effective linked presentation is computed:

```text
present local override -> override value
otherwise              -> Brewfather source value
```

No third persisted effective-value representation exists.

## Candidate cache

Brewfather candidate discovery remains disposable integration cache and cannot own a Beverage.

---

# 5. Brewfather Unlink

Unlinking a Brewfather-backed Beverage occurs in one SQLite transaction:

1. resolve current effective presentation values;
2. materialize them as Custom-owned values;
3. convert the Beverage to Custom ownership;
4. mark the current sanitized Brewfather recipe snapshot detached and immutable;
5. preserve manual sensory overrides;
6. remove the active Brewfather link, source presentation row, and presentation overrides.

No Fill, Keg, Tap lifecycle, pour, or historical domain ownership is lost.

---

# 6. Recipe Ownership After Brewfather Unlink

Tapboard supports two conceptually separate recipe forms.

## Brewfather source recipe snapshot

Conceptually:

```text
beverage_source_recipe_snapshots
```

A snapshot is:

- bounded
- allowlisted/sanitized
- tied to source namespace/batch provenance
- fingerprinted
- versioned
- timestamped

State is one of:

- `linked_current`
- `detached`
- `superseded`

While linked, the current snapshot may be refreshed/replaced by Brewfather synchronization.

After unlink, the current snapshot becomes `detached` and immutable.

It remains available for Brew Story/reference.

## Custom lightweight recipe

Conceptually:

```text
custom_recipes
custom_recipe_ingredients
custom_recipe_steps
```

A detached Brewfather recipe is **never silently converted** into a Custom editable recipe.

Creating a Custom recipe after unlink is an explicit administrative action.

Doing so may mark the detached source snapshot `superseded`, but must not rewrite or destroy the detached source record.

---

# 7. Sensory Ownership

Brewer tasting is not a v2 sensory source.

Sensory precedence is:

```text
manual override
-> recipe prediction
-> style baseline
-> unavailable
```

Manual overrides are Beverage-owned.

Derived sensory provenance may be rebuildable state, but the schema must not persist a redundant second mutable "effective sensory value."

Manual sensory overrides survive Brewfather unlink.

---

# 8. Density Precedence

Density resolution is frozen as:

```text
manual density override
-> FG-derived density
-> installation fallback equivalent to FG 1.008
```

The fallback FG is globally configurable.

Telemetry interpretation records which density source was used.

---

# 9. Telemetry Authority and Epochs

Each Tap has one explicitly configured authoritative telemetry source.

External measurements enter through the versioned Tapboard telemetry API.

Canonical internal units:

- mass: grams
- volume: milliliters
- temperature: Celsius

Tapboard owns:

- validation
- normalization
- ordering
- duplicate handling
- filtering/stabilization
- baselines
- raw-weight interpretation
- pour detection
- forecast inputs
- health inputs

Home Assistant is not telemetry truth.

## Telemetry epochs

A telemetry epoch is the immutable interpretation context for a period of serving.

An epoch snapshots as applicable:

- Tap
- telemetry source
- Fill
- assignment
- Keg capacity
- Keg tare
- effective density
- normalization version
- detector configuration version
- start/end timestamps
- reason
- baseline state

A new epoch is required when interpretation provenance changes materially, including:

- new Tap assignment
- Fill move
- telemetry source change
- Keg capacity correction
- Keg tare correction
- density change
- detector-configuration change
- manual re-baseline

Historical pours and measurements retain the epoch they were interpreted under.

Historical calculations are never silently recomputed using current configuration.

---

# 10. Telemetry Idempotency and Deduplication

`client_sample_id` is optional unless a future explicit OpenAPI revision makes it required.

Telemetry ingestion uses one of two mutually exclusive identities.

## Supplied client identity

When `client_sample_id` is present:

```text
(source_id, client_sample_id)
```

is the idempotency identity.

## Fallback identity

When `client_sample_id` is absent:

```text
(source_id, tap_id, measured_at_epoch_ms)
```

is the idempotency identity.

## Canonical payload digest

The SHA-256 semantic payload digest includes:

- resolved Tap UUID
- canonical measurement timestamp
- normalized primary measurement
- optional normalized temperature
- other accepted semantic fields

Transport metadata is excluded.

## Outcome rules

Same identity + same digest:

- duplicate
- return the original durable outcome
- do not rerun projection, detector, pour, Activity, SSE side effects, or outbox side effects

Same identity + different digest:

- conflict
- create no domain effects

Durable ingest receipts outlive raw telemetry pruning for the configured dedup horizon.

The accepted retry/backfill horizon must never exceed the receipt-retention horizon.

Samples outside the accepted horizon, or samples that would incorrectly re-enter a closed interpretation epoch after receipt expiry, must not re-enter pour detection.

---

# 11. Telemetry Batches

The external telemetry API supports:

- single sample submission
- bounded batch submission

For a batch:

1. validate/normalize samples;
2. establish deterministic processing order;
3. process using the same idempotent pipeline as single samples.

Batch retries must not duplicate measurements or pours.

Batch size, timestamp skew, reconnect horizon, and rate limits are operationally configurable/bounded and must be represented in OpenAPI behavior once finalized.

Tapboard is not a historical bulk-ingestion/time-series platform.

---

# 12. Activity Log vs Raw Telemetry

Ordinary telemetry ingestion is **not** Activity Log material.

The following do not create Activity Log rows merely because they occurred:

- accepted ordinary measurements
- duplicate measurements
- conflicting measurements
- retry handling
- latest-state projection updates
- SSE frames

Activity entries are reserved for meaningful domain/operational transitions, such as:

- eligible completed pour
- selected detector cancellation/warning
- manual re-baseline
- significant sensor/baseline warning
- telemetry stale/healthy transition
- health transition
- administrative correction

A telemetry transaction may create an Activity entry only when one of those meaningful events actually occurs.

---

# 13. Pour Detection

Pour detection remains Tapboard-owned.

The default model is:

- one durable detector state per Tap/epoch
- independent simultaneous pours across Taps are valid

Cross-Tap arbitration exists only for explicitly configured hardware/noise groups.

Optional concepts:

```text
detector_arbitration_groups
detector_arbitration_members
```

Absence from a group means no cross-Tap arbitration.

The detector receives canonical Tapboard-owned input, not HA-specific state or units.

---

# 14. Pour Attribution and Terminal Effect Keys

A pour is attributed to:

- Fill
- Tap
- assignment lifecycle
- telemetry epoch

captured by the detector session.

Completed pours store immutable canonical volume and timestamps.

Automatic pour completion must have a separate deterministic durable terminal `effect_key`.

The key must uniquely represent the assignment/detector-session/terminal transition such that the same terminal effect cannot create multiple pours.

The effect key and resulting pour remain durable for the Fill lifetime.

HTTP retry, batch retry, restart recovery, and telemetry replay must never create a second pour for the same terminal detector effect.

---

# 15. Telemetry Transaction Boundary

For a newly accepted sample, the idempotent SQLite transaction may include, where applicable:

- ingest receipt
- immutable accepted measurement
- projection advancement
- detector state transition
- pour creation
- meaningful Activity entry
- admitted durable outbound event

Ordinary accepted measurements do not require an Activity entry or outbound event.

The transaction must preserve correct ordering across assignment changes, re-baselines, corrections, and detector terminal states.

---

# 16. Raw Telemetry Retention

Raw telemetry retention is bounded.

Tapboard retains only what is required for:

- current diagnostics
- pour detection
- health
- forecast support
- short-term troubleshooting

Dedup receipts are retained on a separate bounded horizon.

Telemetry epochs and pours referenced by durable history are retained according to their domain lifetime.

Tapboard must not become a general-purpose time-series database.

---

# 17. Outbound Events and Hard Admission Bound

Externally delivered events use SQLite transactional outbox semantics **while admission capacity exists**.

The older statement that every externally relevant event is always persisted is superseded by this section.

## Normal admission

When capacity exists:

- domain mutation and durable outbound event intent are recorded transactionally
- outbound delivery occurs after commit
- delivery is at-least-once
- stable event IDs support receiver deduplication

Tapboard must never claim exactly-once network delivery.

## Admission quotas

Outbox capacity is bounded by:

- row limits
- serialized-byte limits
- global limits
- per-destination limits

Admission is serialized inside the domain write transaction.

Eligible terminal state is pruned in bounded batches before denying admission.

Only registry-approved, supersedable, unattempted event types may be semantically coalesced.

## Capacity rejection

If capacity is still unavailable:

- the local domain mutation remains authoritative and commits;
- no individual `outbound_event` row is created for the unadmittable delivery intent;
- no individual per-target delivery row is created;
- the result is explicitly `not_queued_capacity`;
- Tapboard never represents the omitted delivery as queued or delivered;
- a bounded durable overflow incident is created or updated;
- Admin enters a prominent degraded state.

## Overflow incident

Overflow state is itself strictly bounded.

It may aggregate:

- destination
- event class/type
- first occurrence
- last occurrence
- omitted count
- bounded representative IDs/digests
- operator state

A catch-all aggregate slot must prevent destination/event churn from growing overflow state without bound.

Only one coalesced Activity entry should open the degraded incident, with another meaningful entry when it recovers.

Overflow Activity does not enter the outbox.

SQLite exhaustion, corruption, or unrecoverable write failure remains a storage/system failure and may abort the domain transaction. It must not be mislabeled as ordinary outbox capacity rejection.

---

# 18. Outbound Delivery

For admitted events:

- event ID is stable across retries
- network sending occurs outside SQLite transactions
- worker claims use leases
- completion uses compare-and-set semantics
- retries use bounded exponential backoff
- terminal failures remain visible
- manual retry/dismiss may be supported
- pending deliveries protect referenced event/destination-version data from pruning

Destination configuration versions referenced by events are immutable.

---

# 19. Home Assistant and Webhooks

Home Assistant is an optional outbound adapter.

It is not Tapboard telemetry truth.

HA receives one versioned `tapboard_event` contract.

Generic webhooks use Tapboard's standard event envelope.

No custom payload scripting/template language is required.

Webhook delivery must include appropriate SSRF, redirect, timeout, size, and secret-redaction protections.

---

# 20. Mystery Configuration

Mystery reveal state belongs to the Tap assignment lifecycle.

It must not survive into a later Fill assignment.

Use an explicit allowlist of revealable fields.

Public DTOs, Brew Story, SSE, and other public projections must all enforce Mystery redaction at the projection boundary so no alternate endpoint leaks hidden identity.

Mystery does not suppress the fields explicitly exempted in `TARGET.md`.

---

# 21. Tap Wars

Tap Wars entries snapshot:

- Tap
- Fill
- assignment

A competition must begin with at least two eligible entries.

Move, Kick, or other removal of a participating Fill from its Tap ends the affected active competition transactionally.

Permanent deletion of a Fill removes the entire dependent competition/history rather than leaving a misleading partial result.

Votes remain simple atomic counters with no voter identity.

Public vote POSTs still require normal same-origin security despite having no per-voter anti-abuse semantics.

---

# 22. Health and Maintenance

Physical Keg maintenance and Tap line maintenance are distinct append-only domain histories.

Health retains the five approved checks:

- low Keg
- telemetry/scale freshness
- serving temperature
- suspected leak
- line-cleaning due

Use typed defaults and per-Tap overrides rather than generic configuration JSON.

Health current state may be rebuildable; meaningful health incidents/history remain durable according to retention/domain rules.

---

# 23. Display Settings

Shared display defaults are server-owned typed settings.

Per-display overrides remain validated browser-local settings unless a future explicit server-side display identity is introduced.

Effective per-display preferences are not persisted as another server-side duplicate row.

Public initial HTML remains server-rendered.

SSE provides targeted live updates after paint.

---

# 24. Docker and Network Exposure

Inside the container, the application listens on:

```text
0.0.0.0:<PORT>
```

Host exposure is deployment-controlled.

Supported deployment patterns include:

## LAN-local HTTP

Explicitly publish the application port on the selected host/LAN address.

## Same-host HTTPS reverse proxy

Publish the application port on host loopback and proxy externally through the HTTPS terminator.

## Containerized reverse proxy

Place Tapboard and proxy on a private Docker network and publish only the proxy.

The configured canonical external origin controls:

- cookie security behavior
- Origin validation

Forwarded headers are trusted only from explicitly configured proxies.

Preserve the approved container hardening posture:

- non-root
- read-only root filesystem
- dedicated writable data volume
- tmpfs where needed
- dropped Linux capabilities
- `no-new-privileges`
- health check
- graceful shutdown
- minimal production image
- externalized secrets

---

# 25. Rebuild Order

The approved rebuild sequence begins with a clean construction site.

After architecture approval:

1. create the dedicated rebuild branch;
2. retain committed rebuild documentation;
3. create a machine-readable reuse manifest;
4. preserve only approved reusable assets, algorithms, fixtures, and behavioral evidence;
5. remove obsolete v1 application structure from the rebuild branch;
6. add architecture guardrails preventing legacy imports/parallel v1-v2 runtime trees;
7. build Foundation;
8. proceed through vertical feature slices.

v1 remains available through `main` and Git history.

Do not allow v2 to grow beside the legacy runtime for most of the rebuild.

---

# 26. Frozen Implementation Sequence

Current approved high-level order:

1. Rebuild initialization / clean construction site
2. Foundation/runtime/schema baseline
3. Security, Activity, secrets, and outbox primitives
4. Physical Kegs
5. Custom and Brewfather-linked Beverages
6. Fills and On Deck
7. Taps and assignment lifecycles
8. Telemetry sources/API/idempotency
9. Telemetry epochs/baselines/pour detector
10. Pour history and Fill forecasting
11. Draft health and Tap maintenance
12. SSR Admin/public dashboard/SSE/display preferences
13. Brew Story/sensory/Mystery
14. Tap Wars
15. Outbound HA/webhook delivery workers
16. System/operator functions
17. Deployment/docs/final acceptance

Exact GitHub issue slicing may subdivide these further, but must not silently change architectural ownership or dependency order.

---

# 27. Architecture Freeze Rule

From this point forward:

- product behavior is defined by `TARGET.md`;
- technical architecture is defined by `ARCHITECTURE-DECISIONS.md` plus this freeze;
- v1 reuse policy is defined by `V1-REUSE-CRITERIA.md`;
- this file wins where it explicitly supersedes an earlier architectural statement.

Implementation agents may identify a real contradiction or impossibility.

They may not silently redesign the system.

A proposed deviation must state:

```text
DECISION:
EVIDENCE:
CONCERN:
RECOMMENDATION:
IMPACT:
```

and stop for approval when the deviation is material.

No unresolved architecture blocker exists at freeze.
