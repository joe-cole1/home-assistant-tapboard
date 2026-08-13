# Tapboard v1 Reuse Criteria

## 1. Purpose

Tapboard v1 contains a mixture of:

* useful working behavior
* valuable assets
* well-tested algorithms
* historical architectural assumptions
* duplicated or tangled code
* functionality that no longer belongs in the product
* code whose correctness is uncertain

The v2 rebuild must use v1 intelligently without allowing v1 to become the new architecture by inertia.

The governing rule is:

> **v1 is evidence and reference material, not scaffolding.**

Existing code receives no presumption of correctness merely because it exists.

---

# 2. Required Classification

Before v2 implementation begins, Codex must inventory meaningful v1 subsystems, files, tests, and reusable assets.

Each must be classified into exactly one primary category.

## A. Port largely as-is

Use when:

* behavior is still required;
* module responsibility is cohesive;
* implementation fits the new architecture;
* meaningful tests establish correctness;
* dependencies remain justified;
* it does not import obsolete architecture;
* direct reuse is safer than rewriting.

Even here, the code may move to a new path and receive TypeScript/interface adaptation.

## B. Port concept/algorithm only

Use when:

* behavior is valuable;
* algorithm appears correct or substantially useful;
* implementation is coupled to v1 architecture;
* interfaces/ownership no longer fit;
* rewriting around the new domain boundary is cleaner.

The old implementation serves as an algorithmic reference.

## C. Reference only

Use when:

* code is useful for understanding desired behavior;
* UI/UX is worth reproducing;
* source contains examples or useful constants/assets;
* direct implementation reuse would import bad structure or obsolete assumptions.

No legacy module should be imported.

## D. Do not reproduce

Use when:

* feature was explicitly removed;
* code is broken or untrustworthy;
* functionality is redundant;
* architecture conflicts with the approved target;
* complexity no longer earns its place;
* behavior is obsolete.

Deletion is an intentional result, not a failure to preserve work.

---

# 3. Evidence Required for Direct Reuse

Anything classified **Port largely as-is** must include written justification covering:

1. What behavior it provides.
2. Why that behavior still belongs in v2.
3. Why the implementation is cohesive.
4. Which v1 assumptions it depends on.
5. Whether those assumptions remain valid.
6. Which tests demonstrate correctness.
7. Which dependencies it requires.
8. Whether those dependencies remain justified.
9. What adaptation is required for TypeScript/new interfaces.
10. Why rewrite would be riskier or less maintainable than reuse.

"Already implemented" is not sufficient justification.

---

# 4. Tests Are Evidence, Not Specification

Review the complete v1 test suite.

Classify meaningful tests as:

* **Carry forward**
* **Adapt**
* **Reference only**
* **Delete**

Existing tests do not automatically define required v2 behavior.

A test that protects obsolete architecture should be removed rather than forcing compatibility.

For a reused algorithm:

1. inspect existing tests;
2. understand the behavior they prove;
3. define the intended v2 contract;
4. port/adapt tests around the new contract;
5. add tests for new domain boundaries.

---

# 5. High-Priority Reuse Candidates

The following are specifically worth investigating.

Their inclusion here does **not** automatically authorize direct copying.

## Themes

The current themes are liked and should be preserved visually where practical.

Likely classification:

**Port assets/design intent; reorganize implementation.**

Inventory:

* theme definitions
* color variables
* fonts
* accent behavior
* dark/light presets
* local/shared display-preference behavior

Target:

move into the new shared CSS design-token system.

---

# 6. SVG / Fill Glass Graphics

Existing SVG Fill Glass graphics are valuable.

Likely classification:

**Port largely as assets.**

Verify:

* no unnecessary JS coupling
* accessibility behavior
* scaling/responsiveness
* style-selection mappings

Do not redraw working assets solely for architectural purity.

---

# 7. Pour Detection

The current deterministic pour detector is a high-value reuse candidate.

Likely classification:

**Port algorithm/concept; determine whether implementation itself can be reused.**

Investigate:

* timestamp handling
* stale/duplicate rejection
* noise handling
* settled baselines
* candidate arbitration
* quiet completion
* timeout/cancel behavior
* implausible jump handling
* test quality

Critical new boundary:

v2 receives canonical Tapboard telemetry API measurements rather than HA WebSocket state.

The detector must not retain HA-specific ownership assumptions.

---

# 8. Forecasting

Current depletion forecasting may contain valuable proven mathematics.

Likely classification:

**Port algorithm if tests validate it.**

Investigate:

* lifecycle assumptions
* Fill-level history
* uncertainty handling
* fallback behavior
* edge cases
* test coverage

Required semantic change:

forecast follows the **Fill** across Tap moves.

Do not port Tap Planning/readiness forecasting into the initial rebuild.

---

# 9. Brewfather Transport

The current Brewfather API client, request budgeting, pagination, retries, coalescing, and cache behavior may contain substantial reusable engineering.

Likely classification:

**Port transport concepts and tested helpers; rewrite storage/domain coupling as needed.**

Investigate:

* API authentication
* endpoint handling
* pagination
* retry/backoff
* request budgeting
* sync coalescing
* error sanitization
* detail/recipe fetch logic
* existing test coverage

Do not automatically port:

* old Tap-centric Brewfather ownership
* full historical readings cache
* old On Deck semantics
* HA selector compatibility
* obsolete public projections

---

# 10. SSE

The existing SSE hub may contain valuable behavior around:

* heartbeats
* stalled clients
* backpressure
* bounded buffering
* targeted updates

Likely classification:

**Evaluate for direct or conceptual reuse.**

Required new behavior:

* server-rendered initial state
* feature-specific event names/payloads
* page-level authoritative resync after reconnect

---

# 11. Sensory Engine

The sensory engine may remain useful.

Likely classification:

**Port algorithm if cohesive/tested.**

Required target precedence:

**Manual override → Recipe prediction → Style baseline**

Do not preserve brewer tasting as a source.

Do not preserve behavior merely because it existed if its data source was removed.

---

# 12. Brew Story

The existing Brew Story is primarily a behavioral/UI reference.

Likely classification:

**Reference + selective logic reuse.**

Target is simpler:

* Beverage details
* recipe
* ingredients
* sensory
* Fill/pour history

Do not port:

* Brewfather reading-history charts
* artwork proxy
* brewer tasting source

---

# 13. Draft Health

Review all current health checks.

Target checks retained:

* low keg
* scale availability
* suspected leak
* serving temperature
* line-cleaning due

Likely classification:

**Port rule concepts/tested logic; adapt ownership to new Tap/telemetry model.**

Health configuration becomes:

**global defaults → optional per-Tap overrides**

---

# 14. Authentication

Existing PIN/session code may contain useful security behavior.

Likely classification:

**Reference/concept only unless implementation cleanly fits new cookie-session architecture.**

v2 target changes include:

* HttpOnly cookie
* SQLite-backed sessions
* configurable expiry
* CSRF
* strict Origin validation
* local reset command

Do not preserve bearer-token browser architecture merely because it works today.

---

# 15. Docker Hardening

Current Docker deployment contains deliberate security work.

Likely classification:

**Port security posture, rebuild configuration cleanly.**

Preserve principles such as:

* non-root
* read-only filesystem
* dropped capabilities
* `no-new-privileges`
* health check
* graceful shutdown

Do not automatically preserve:

* Node version
* old paths
* old DB initialization
* backup volume
* obsolete scripts

---

# 16. Database Backup Tooling

Classification:

**Do not reproduce.**

The rebuilt application will not carry Tapboard-owned backup/restore/rotation tooling.

---

# 17. Tap Planning

Classification:

**Do not reproduce in initial rebuild.**

A future Upcoming/Planning feature may be designed separately.

Do not port the current subsystem simply because forecasting logic already exists.

---

# 18. Artwork / Image Proxy

Classification:

**Do not reproduce.**

No remote artwork proxy or custom upload subsystem is required initially.

---

# 19. Home Assistant Telemetry

Classification:

**Do not reproduce.**

Home Assistant is no longer the source of Tap state/scale telemetry.

Do not port:

* HA hydration
* HA state subscription for measurement ownership
* HA capacity helper ownership
* exact HA entity naming contract

Home Assistant remains only as an optional outbound integration.

---

# 20. Home Assistant Outbound Events

Current event-contract concepts may be valuable.

Likely classification:

**Port contract ideas, adapt to v2 domain/outbox architecture.**

Retain the concept of:

* one versioned `tapboard_event`
* bounded data
* stable domain meaning

Delivery becomes durable/retriable through the v2 outbox instead of best-effort-only behavior.

---

# 21. On Deck

v1 On Deck behavior must not be reused blindly.

Target meaning changed fundamentally.

v2:

**On Deck = an actual active Fill in a physical Keg that is explicitly marked On Deck.**

Brewfather batches are not On Deck inventory.

Any v1 code assuming otherwise should be classified Reference or Do Not Reproduce.

---

# 22. Keg Lifecycle

v1 lifecycle concepts are valuable.

Likely classification:

**Port semantics/algorithm; adapt domain ownership.**

v2 hierarchy:

**Beverage → Fill → Physical Keg → Tap lifecycle**

Assignment opens a lifecycle for:

**Fill + Tap**

Moving a Fill closes one lifecycle and opens another.

Pour history follows Fill while preserving lifecycle attribution.

---

# 23. Custom Beverage

The v1 one-custom-beverage constraint is obsolete.

Classification of the constraint:

**Do not reproduce.**

Useful display metadata behavior may still be referenced.

v2 supports unlimited Custom Beverages.

---

# 24. Existing Admin UI

Use primarily as behavioral reference.

The current scattered modals/sections are explicitly not the target architecture.

Likely classification:

**Reference only / Do not reproduce structurally.**

Potentially reuse:

* field labels
* useful validation text
* visual components
* interaction details that remain desirable

Do not transplant the old page organization.

---

# 25. Existing Public Dashboard

Use as visual/behavioral reference.

Potentially preserve:

* themes
* typography
* SVG presentation
* responsive lessons
* useful card details
* targeted SVG updates
* animations worth retaining

Do not preserve:

* settings controls on public surface
* unnecessary card density
* old state ownership
* giant client-side rendering architecture

---

# 26. CSS

Codex must audit existing CSS for:

* reusable design tokens
* reusable component styles
* duplicates
* dead selectors
* one-off overrides
* conflicting media queries
* theme duplication

Reuse visually valuable work.

Do not carry forward CSS merely because deleting it is difficult.

---

# 27. Dependencies

Inventory every direct npm dependency.

For each, classify:

* keep
* replace with platform capability
* remove
* uncertain / needs justification

For anything proposed to remain, explain what problem it solves.

For new dependencies, explain:

* what problem requires it;
* why Node/browser/platform capabilities are insufficient;
* operational/security cost;
* maintenance status;
* whether it reduces more complexity than it adds.

Minimum dependencies is a strong preference, not dogma.

---

# 28. Known Preferred New Dependencies / Tools

The approved architecture currently expects or prefers:

* `better-sqlite3`
* TypeScript as development/static-analysis tooling
* Eta as preferred server template engine
* ESLint
* Prettier
* minimal pre-commit/staged-file tooling
* Playwright for browser/E2E tests

Codex must still inspect current versions/maintenance and justify final selections during planning.

Do not treat this list as permission to add larger frameworks.

---

# 29. Reuse Must Respect New Ownership Boundaries

No reusable module may violate these core boundaries.

## Domain

Must not know:

* HTTP
* Home Assistant
* Brewfather response shapes
* templates
* SQLite-specific query details

## Repository

Owns persistence.

Must not become the location of unrelated business orchestration.

## Integration adapter

Owns external-system shape/protocol.

Must translate into Tapboard-owned types.

## HTTP handler

Owns HTTP translation.

Must not contain core business workflows or raw SQL.

## Use case

Owns business orchestration across domains.

---

# 30. No Legacy Compatibility Shims by Default

Do not create:

* v1 DB adapters
* v1 route aliases
* v1 response-shape compatibility
* v1 configuration translation
* v1 HA entity compatibility
* dual old/new domain objects

unless a specific approved implementation phase proves one is temporarily necessary.

Any compatibility shim must include a removal plan.

---

# 31. Legacy Removal Timing

The first Codex pass is analysis-only.

Do not delete v1 during analysis.

After:

* reuse inventory
* architecture plan
* user approval

the rebuild branch should remove obsolete v1 application code before actual v2 implementation.

Anything added back afterward must be deliberate.

---

# 32. Required Inventory Output

For each significant v1 subsystem, Codex should report:

| Field                  | Requirement                           |
| ---------------------- | ------------------------------------- |
| Subsystem              | Human-readable name                   |
| Files                  | Relevant paths                        |
| Approximate size       | Lines/modules                         |
| Responsibilities       | What it currently does                |
| Coupling               | Major dependencies                    |
| Tests                  | Relevant tests/coverage               |
| Correctness confidence | High / Medium / Low                   |
| v2 requirement         | Keep / Modify / Remove                |
| Classification         | Port / Algorithm / Reference / Delete |
| Rationale              | Why                                   |
| Risks                  | Important caveats                     |
| Proposed v2 home       | Target feature/module                 |

---

# 33. God-File Analysis

Codex must identify files/modules mixing multiple unrelated responsibilities.

`server.js` is a known historical example, but it is not assumed to be the only one.

Do not classify solely by line count.

Explain the actual responsibility collision.

---

# 34. Reuse Review Standard

The test for reuse is not:

> "Can this code technically still run?"

The test is:

> "Does this code implement required v2 behavior cleanly enough that preserving the implementation is safer and more maintainable than preserving only its behavior?"

If the answer is uncertain, prefer:

**Port concept/algorithm only**

rather than direct architectural inheritance.

---

# 35. Final Principle

The rebuild is allowed to discard substantial engineering effort.

Past effort is not a reason to preserve a bad abstraction.

At the same time, a clean rebuild is not permission to rewrite proven algorithms and valuable assets for aesthetic reasons.

The goal is:

> **Preserve proven value. Discard accidental architecture.**
