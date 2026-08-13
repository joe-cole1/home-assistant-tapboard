# Tapboard Rebuild Product Target

## 1. Purpose

Tapboard is a self-hosted draft-beverage management system.

Its public interface displays what is currently being served. Its authenticated administration interface manages beverages, physical kegs, fills, taps, competitions, integrations, display configuration, and operational health.

Tapboard must not fundamentally depend on Home Assistant, Brewfather, ESPHome, or any other external platform. Those systems are integrations around a Tapboard-owned core domain.

The rebuilt application should favor simplicity, predictable workflows, clear ownership of data, and a small number of concepts that accurately reflect the physical taproom.

---

# 2. Core Domain Model

The primary relationship is:

**Beverage → Fill → Physical Keg → optional Tap assignment**

External beverage sources such as Brewfather may supply source data to a Beverage, but they do not own the Tapboard Beverage itself.

## 2.1 Beverage

A Beverage represents the drink being served.

Examples include:

* Beer
* Cider
* Mead
* Seltzer
* Soda
* Water
* Cocktail
* Kombucha
* Coffee
* Other

A Beverage may be:

* **Custom**
* **Brewfather-linked**

Beverages persist independently of Fills.

Duplicate Beverage names are allowed.

A Brewfather batch may be linked to at most one Beverage.

### Beverage-owned presentation

The Beverage is the **single presentation/customization layer**.

Display-facing data belongs here rather than on Fills or Taps.

Possible fields include:

* name
* beverage type
* style
* ABV
* IBU
* OG
* FG
* SRM
* display color
* description
* default Fill Glass graphic
* sensory information
* recipe information where applicable

Fields that do not make sense for a Beverage type are nullable and should disappear from the UI rather than showing meaningless empty fields.

There must not be multiple competing presentation-override layers.

---

# 3. Brewfather-Linked Beverages

Brewfather is an optional Beverage data source.

Brewfather batches are **synchronized candidates**, not Tapboard Beverages until an administrator explicitly creates a Beverage from one.

The Brewfather integration allows the administrator to choose which batch statuses are included in candidate discovery.

The discovery filter controls which **new candidates** appear. Once a Beverage is linked to a Brewfather batch, that batch continues to synchronize regardless of whether its current status remains selected for candidate discovery.

## 3.1 Linking

When creating a Beverage, the administrator may select an available Brewfather batch from a dropdown.

One Brewfather batch may back only one Tapboard Beverage.

Deleting or unlinking a Beverage must never modify or delete the Brewfather batch.

## 3.2 Field overrides

Brewfather-linked Beverages inherit display-facing metadata from Brewfather.

Each supported display-facing field may have a nullable local override.

Effective value precedence is:

**Tapboard local override → Brewfather source value**

The UI should make inheritance obvious.

Inherited fields should normally appear read-only, with a pencil/edit action that enables a Tapboard override.

Removing the override immediately restores the current Brewfather value.

Brewfather updates continue beneath a local override.

## 3.3 Recipe ownership

Brewfather recipe and ingredient structures remain Brewfather-owned and read-only.

Tapboard may display them in Brew Story but does not provide a Brewfather recipe editor.

## 3.4 Unlinking

Unlinking a Brewfather-backed Beverage converts it into a Custom Beverage.

Tapboard copies its current effective display values into Tapboard-owned values before removing the Brewfather association.

Fills, pours, Tap assignments, and history remain intact.

## 3.5 Missing Brewfather data

If a linked Brewfather batch becomes unavailable:

* do not delete the Beverage
* do not unlink it automatically
* retain last-known source values
* retain local overrides
* clearly mark the source stale/unavailable in Admin
* allow explicit refresh or unlink actions

External source availability must never control physical Tapboard inventory.

## 3.6 Synchronization

Default Brewfather synchronization behavior:

* shortly after startup
* every 60 minutes
* manual **Refresh Now** from Admin
* overlapping syncs coalesce
* retries/backoff remain bounded
* linked Beverages take priority over unlinked candidates

Candidate data is disposable integration cache.

Full recipe data should be lazy-loaded when needed and cached for linked Beverages rather than fetched for every candidate.

Tapboard does not need Brewfather fermentation/readings history in the rebuilt core.

## 3.7 Completing Brewfather batches

The Brewfather integration may optionally control what happens when the last active Fill associated with a linked Beverage is kicked.

Supported behavior should include:

* Never
* Ask
* Automatically mark Completed

This is integration configuration and must not be hard-coded into Fill behavior.

---

# 4. Custom Beverages

Custom Beverages are fully Tapboard-owned.

There is no limit on the number of Custom Beverages.

Custom Beverages may optionally contain lightweight recipe information for Brew Story.

A custom ingredient entry may contain:

* name
* optional amount
* optional unit
* optional note

Tapboard must not attempt to become a full brewing recipe-management system.

---

# 5. Beverage Density

Tapboard may derive liquid volume from raw scale weight.

For fermented beverages with a known FG, density should be derived using FG relative to water density.

Density precedence:

1. known Beverage FG
2. explicit manual density override
3. installation fallback equivalent to FG **1.008**

The fallback FG is globally configurable.

The UI should be able to show which density source is being used.

---

# 6. Beverage Deletion

Beverages may be permanently deleted.

Deleting a Beverage with associated Fills requires an explicit destructive impact summary and confirmation.

Deletion removes:

* the Beverage
* its Fills
* Fill assignment lifecycles
* pour history for those Fills
* Tap Wars history dependent on those Fills
* Beverage-specific derived/history data

Deleting a Beverage must **never delete physical Keg inventory records**.

Physical Kegs become available for future Fills.

An optional setting may automatically delete a Beverage when its **last remaining Fill is permanently deleted**.

This setting:

* defaults OFF
* does not trigger when a Fill is merely kicked/ended
* does not trigger when a physical Keg is deleted or deactivated

---

# 7. Physical Kegs

A Physical Keg represents the actual reusable vessel.

Examples:

* Keg #1
* Keg #2
* Keg #10

Physical Kegs are permanent inventory objects until explicitly deleted.

The number is administrator-assigned and unique among currently existing physical Kegs.

Numbers may be reused after an old physical Keg has been permanently deleted because internal UUIDs distinguish the records.

There is no fixed limit on the number of physical Kegs.

## 7.1 Physical Keg properties

Each physical Keg includes at least:

* internal UUID
* administrator-assigned keg number
* optional friendly label
* nominal capacity
* current tare weight
* Active / Inactive inventory flag

The administrator can create additional physical Kegs at any time.

## 7.2 Capacity

Capacity belongs to the physical Keg.

Fills inherit the physical Keg's capacity.

Capacity may be corrected by the administrator.

If capacity changes during an active Fill:

* preserve historical calculations
* invalidate current live measurement baseline
* require a fresh telemetry baseline before pour detection resumes

Historical pours are not recalculated.

## 7.3 Tare weight

Tare weight belongs to the physical Keg.

Canonical internal mass unit should be neutral, with grams preferred.

UI/API boundaries may accept familiar units such as pounds/ounces or kilograms.

Tare weight may change over the life of the vessel.

Tapboard retains a dated tare-weight history including:

* previous value
* new value
* effective timestamp
* optional reason
* administrator actor

Tare corrections are prospective.

Historical completed pour calculations are not silently rewritten.

Changing tare weight during an active Fill requires re-baselining before pour detection resumes.

---

# 8. Physical Keg Maintenance

Physical Kegs have an append-only maintenance history tied permanently to the vessel.

Maintenance is informational and does not automatically derive a current health state or block Fill creation.

Suggested maintenance types include:

* Deep Clean
* Sanitize
* Suspected Infection
* Confirmed Infection
* Replace O-rings / Seals
* Repair
* Inspection
* Other

Each entry may contain optional notes.

Maintenance is displayed as a timeline on the physical Keg detail page.

Physical Kegs also have a simple explicit **Active / Inactive** inventory flag.

---

# 9. Physical Keg Deletion

Physical Kegs may be permanently deleted at any time through an explicit destructive workflow.

The confirmation must clearly explain that deletion also removes associated:

* Fills
* Tap assignment lifecycles
* pours
* maintenance history
* Tap Wars history tied to those Fills
* other dependent domain records

A minimal deletion audit record may remain.

Deleting a physical Keg does not delete the Beverage that had previously occupied it unless separate Beverage deletion rules apply.

---

# 10. Fill

A Fill represents one instance of a Beverage being placed into one physical Keg.

Every Fill must belong to:

* exactly one Beverage
* exactly one physical Keg

A physical Keg may have unlimited historical Fills but at most **one active Fill** at a time.

A Fill cannot exist without a physical Keg.

## 10.1 Fill properties

Fills are intentionally minimal and operational.

A Fill includes only information such as:

* Beverage
* Physical Keg
* fill date
* creation timestamp
* end timestamp
* optional end reason
* On Deck state/order
* Tap assignment lifecycle/history
* pour history

A Fill does **not** contain:

* display-name overrides
* description overrides
* color overrides
* Fill Glass overrides
* ABV/style overrides
* other presentation overrides

Presentation belongs exclusively to the Beverage.

## 10.2 Fill date

For Brewfather-linked Beverages, Fill creation may prefill the date from Brewfather's appropriate bottling/kegging date when available.

Otherwise it defaults sensibly, such as the current date.

Once created, the Fill date becomes Tapboard-owned and later Brewfather synchronization does not overwrite it.

## 10.3 Creating Fills

There is one shared Fill-creation workflow.

It may be entered from:

* Beverage detail → **Create Fill**
* Fills page → **New Fill**

The selected physical Keg must be Active and have no other active Fill.

New Fills start **Available** by default.

---

# 11. Fill State

Do not maintain redundant mutable status values where state can be derived cleanly.

A Fill may effectively be:

* **On Tap** — currently assigned to a Tap
* **On Deck** — active, unassigned, and explicitly marked On Deck
* **Available** — active, unassigned, not On Deck
* **Ended** — kicked/finished

## 11.1 On Deck

On Deck means a real Fill exists in a real physical Keg and is intentionally advertised as ready/next.

On Deck is explicit.

Rules:

* assigning a Fill to a Tap automatically removes it from On Deck
* unassigning it returns it to Available, not automatically On Deck
* ending it removes it from On Deck
* only active, unassigned Fills explicitly marked On Deck appear publicly

On Deck ordering is administrator-controlled.

The public footer supports an unlimited scrolling list.

Public On Deck items show:

**Name — Style**

A future **Upcoming** feature may show Brewfather Fermenting/Conditioning candidates separately.

Upcoming is not part of the initial rebuild.

---

# 12. Kick Keg

The administrator-facing action is called:

**Kick Keg**

Internally, this ends the active Fill.

Kick Keg:

* closes the active Fill
* closes any current Tap assignment lifecycle
* preserves Fill and pour history
* removes the Fill from On Deck
* removes it from its Tap
* frees the physical Keg for reuse immediately
* accepts an optional reason
* may invoke configured Brewfather Completed behavior
* records the action in the Activity Log

There is no distinct semantic difference between "kicked" and "ended."

Ended Fills remain accessible under an **Ended** view/filter.

Permanent Fill deletion is separate.

---

# 13. Fill Deletion

A Fill may be permanently deleted with explicit destructive confirmation.

Deletion removes:

* the Fill
* its Tap assignment lifecycles
* its pours
* dependent Tap Wars history
* other Fill-specific historical data

The physical Keg remains.

The Beverage remains unless the optional last-Fill auto-delete rule applies.

---

# 14. Taps

Taps represent physical serving positions.

There is no hard six-Tap application limit.

Six is the expected comfortable density for the primary display.

Admins may add arbitrary Taps.

Each Tap has:

* internal UUID
* unique human-facing Tap number
* optional custom name
* enabled/disabled display state
* selected telemetry source
* current Fill assignment
* Mystery Tap configuration
* inherited/overridden health configuration
* inherited/overridden pour-detection configuration
* optional serving metadata

Tap numbers default conceptually to Tap 1, Tap 2, etc.

The number is always visible even when a custom name exists.

Example:

**Tap 3 · Nitro**

## 14.1 Tap numbering

Telemetry APIs identify Taps by their Tap number.

Tap numbers:

* must be unique
* may contain gaps
* are editable
* are not automatically compacted
* changing the number requires an explicit warning that external telemetry endpoints may need updating

Public display order is ascending Tap number.

No separate display-order system is required.

## 14.2 Enabled/disabled

Disabling a Tap affects public visibility only.

A disabled Tap:

* disappears from the public dashboard
* may retain its Fill assignment
* continues telemetry ingestion
* continues pour detection
* continues health monitoring
* retains lifecycle/history

---

# 15. Tap Serving Metadata

Taps may contain optional informational serving metadata such as:

* gas type
* serving pressure
* line length
* line diameter
* notes

These fields do not enforce Keg/Tap compatibility.

There are no hard Keg/Tap compatibility rules in the initial rebuild.

---

# 16. Tap Assignment

A Fill can be assigned to at most one Tap at a time.

A Tap can serve at most one active Fill at a time.

Assignment opens a Tap assignment lifecycle.

Moving a Fill between Taps:

* closes the old lifecycle
* preserves old pours
* opens a new lifecycle
* requires a fresh telemetry baseline on the new Tap
* keeps the Fill itself active
* preserves Fill-level depletion history

Unassigning without kicking:

* closes the current lifecycle
* preserves history
* returns the Fill to Available
* does not automatically make it On Deck

Assigning a new Fill to an occupied Tap must require an explicit decision about the previous Fill rather than silently ending it.

---

# 17. Telemetry

Tapboard owns the canonical telemetry ingestion API.

Home Assistant is no longer the measurement source.

External systems may include:

* Home Assistant
* ESPHome
* custom microcontrollers
* smart keg scales
* future integrations

All feed Tapboard through the same versioned telemetry contract.

## 17.1 Telemetry sources

Admins may create named telemetry sources.

Each receives a strong randomly generated API key.

Keys:

* are shown once
* are stored only as cryptographic hashes
* are rotated rather than recovered
* are distinct from human Admin authentication

Every telemetry key may address any Tap.

Each Tap explicitly selects one authoritative telemetry source.

There is no automatic source failover.

## 17.2 Accepted measurements

The telemetry API may accept:

* raw total scale weight
* fill percentage
* remaining volume + unit
* optional temperature + unit
* measurement timestamp

At least one usable measurement must be supplied.

All representations normalize into Tapboard-owned canonical units.

Preferred canonical units:

* volume: milliliters
* mass: grams
* temperature: Celsius

Display/API boundaries may convert to user-friendly units.

## 17.3 Raw scale weight

Raw scale weight is first-class.

Tapboard derives beverage weight using:

**measured total weight − physical Keg tare weight**

It then converts beverage weight to volume using Beverage density rules.

## 17.4 Measurement timestamps

Telemetry is timestamp-driven.

`measured_at` is required.

Tapboard distinguishes measurement time from HTTP receipt time.

Stale, duplicate, and out-of-order samples must not create false pours.

## 17.5 Single and batch submissions

The API supports:

* normal single-sample ingestion
* small bounded batches for short reconnect buffering

Batch ingestion is not a historical time-series import system.

Batch size and processing are bounded.

Excess telemetry is rejected rather than placed into an unbounded queue.

Per-source rate limiting/backpressure protects Tapboard from misconfigured senders.

---

# 18. Telemetry Filtering and Baselines

Tapboard owns sensor filtering and stabilization.

Telemetry sources should not be responsible for implementing Tapboard's pour-detection semantics.

Global defaults exist with optional per-Tap overrides.

Configuration may include:

* noise/deadband tolerance
* minimum sustained decrease
* settling period
* quiet/completion window
* implausible jump threshold
* smoothing/stabilization behavior
* hard timeout

This is important because real keg scales may fluctuate by several ounces due to temperature and refrigeration cycles.

Tapboard should distinguish:

* raw measurements
* normalized/validated measurements
* stabilized values used by domain logic

## 18.1 Assignment baseline

When a Fill is assigned to a Tap:

* do not assume it is full
* show **Waiting for measurement**
* require a fresh valid telemetry reading
* establish a new baseline
* do not begin pour detection before that baseline exists

Telemetry received while a Tap has no Fill may be retained as hardware status but must not be attributed to a later Fill until a fresh post-assignment sample arrives.

## 18.2 Out-of-range measurements

Public display values should remain sane.

Impossible values may be clamped for public presentation.

Admin diagnostics must show:

* raw measurement
* interpreted/clamped measurement
* relevant health warning

Repeated bad readings must not be silently hidden.

## 18.3 Sudden upward jumps

Large upward jumps are not automatically considered refills.

They should:

* trigger a diagnostic/baseline warning
* pause normal pour interpretation where needed
* require stabilization/re-baselining
* never silently create a new Fill or modify history

## 18.4 Manual re-baseline

Admins have a per-Tap **Re-baseline Sensor** action.

Re-baselining:

* keeps the same Fill
* keeps the same lifecycle
* preserves previous pour history
* accepts current stabilized telemetry as the new baseline
* clears appropriate baseline warnings
* is recorded in the Activity Log

---

# 19. Pour Detection

Tapboard is the sole authority for determining pours.

Telemetry sources report measurements, not pour events.

Preserve the valuable deterministic behavior of the v1 pour detector where verified, including concepts such as:

* timestamp-driven processing
* noise rejection
* duplicate/stale sample rejection
* settled baselines
* single-active-pour arbitration where appropriate
* quiet-period completion
* timeout/cancel behavior
* implausible-jump protection

Pour detection settings use:

**global defaults → optional per-Tap overrides**

Completed pours are attributed to the Fill and Tap assignment lifecycle active at pour start.

---

# 20. Pour History

Pour history is retained for the lifetime of the Fill.

Kicking a Keg preserves pour history.

Permanently deleting the Fill deletes its pour history.

Moving a Fill between Taps preserves the Fill's overall consumption history while assignment lifecycles retain Tap-specific attribution.

---

# 21. Depletion Forecasting

Keep the existing concept of days-remaining forecasting.

The forecast follows the **Fill**, not a particular Tap.

Moving a Fill to another Tap does not discard its consumption history.

Forecasts should communicate uncertainty and avoid false precision.

Existing proven forecast mathematics may be reused if validated.

Tap Planning/readiness forecasting against future Brewfather batches is **not** part of the initial rebuild.

---

# 22. Draft Health

Keep draft-health functionality.

Health configuration uses:

**global defaults → optional per-Tap overrides**

Retain useful checks including:

* low keg
* scale availability
* suspected leak
* serving temperature
* line-cleaning due

Health information appears in Admin Overview and relevant detail views.

---

# 23. Serving Temperature

Temperature belongs to Tap live telemetry, not to the Fill or Beverage.

It may be used for:

* health checks
* Admin diagnostics
* optional public display

Public serving temperature display is configurable per display and defaults **OFF**.

Mystery Tap does not suppress temperature.

---

# 24. Tap Line Maintenance

Line maintenance is tracked per Tap.

Each Tap supports append-only maintenance records including:

* maintenance type
* timestamp
* optional note
* actor
* resulting due date where applicable

Global defaults may define normal cleaning intervals, with per-Tap overrides.

Maintenance history is separate from the general Activity Log.

---

# 25. Mystery Tap

Mystery Tap belongs to the Tap assignment/display context, not to the Beverage or Fill.

Enabling Mystery Tap hides eligible identity/detail fields.

Mystery configuration resets when a different Fill is assigned.

The public title becomes:

**Mystery Tap**

Eligible information is hidden by default when Mystery mode is enabled, with the administrator able to selectively reveal fields.

Mystery Tap does **not** suppress:

* beverage/display color
* Fill Glass graphic
* remaining amount
* days remaining
* optional serving temperature

Mystery Tap may participate in Tap Wars.

Voting does not reveal its identity.

---

# 26. Tap Wars

Tap Wars is a first-class competition feature with its own Admin page.

Only one competition may be active at a time.

A competition has:

* description
* start timestamp
* end timestamp
* active/ended state
* 2–N entries
* vote counts

A competition must have at least two participating Taps.

There is no fixed maximum beyond the number of eligible Taps.

## 26.1 Competition entries

Each entry snapshots:

* participating Tap
* active Fill at contest start

The public concept remains a competition between **Taps**, but the Fill snapshot ensures the voted-on Beverage remains unambiguous.

If a participating Fill leaves its Tap, is kicked, or is otherwise removed, the active competition ends automatically.

Historical results remain while dependent Fills exist.

Deleting a dependent Fill removes related historical Tap Wars data.

## 26.2 Voting

Voting happens on the public kiosk.

There is:

* no voter identity
* no anti-abuse machinery
* no cookies for vote ownership
* no vote changing semantics
* no individual vote records required

Votes are simple incrementing counters.

Each participating Tap card displays an accent-color button directly below the Beverage description:

**Vote for this tap**

Tapping the rest of the card still opens Brew Story.

Vote totals and percentages may be shown live.

Tap Wars results/history are available in Admin.

---

# 27. Public Dashboard

The public dashboard is primarily read-only.

It contains:

1. Header
2. Enabled Tap cards
3. Optional Tap Wars banner
4. On Deck footer

## 27.1 Header

Header contains:

* configurable Tapboard name
* one aggregate connectivity icon

Connectivity:

* healthy/connected → lightning-bolt style connected state
* any enabled required integration/telemetry issue → `!`/degraded state

The public UI does not enumerate individual failures.

Tapping the connectivity icon opens Admin so kiosk browsers retain a direct administration path.

There are no other Admin/settings controls on the public display.

## 27.2 Tap cards

Default public Tap cards are intentionally simplified.

Show when available:

* Tap number + optional name
* Beverage name
* style
* ABV
* Fill Glass / Beverage color
* fill percentage
* estimated servings remaining
* estimated days remaining
* description
* optional serving temperature when enabled

Detailed brewing information such as OG, FG, IBU, recipe, and sensory detail belongs in Brew Story rather than the primary card.

Fields irrelevant to the Beverage type disappear.

## 27.3 Interaction

Tapping a normal Tap card opens a read-only Brew Story.

No configuration controls are exposed.

Tap Wars entries additionally show the dedicated accent-color vote button.

## 27.4 More than six Taps

Six should display comfortably.

If more Taps are enabled, Admin → Display allows a choice between:

* responsive layout with scrolling
* automatic pagination/rotation

Default should be responsive + scroll.

---

# 28. Brew Story

Keep Brew Story, but simplify it around the new domain.

A Brew Story may contain:

* Beverage identity
* type/style
* full description
* ABV / IBU / OG / FG / color where applicable
* recipe and ingredients
* sensory profile
* current Fill information
* pour/lifecycle history

No Brewfather fermentation/readings chart is required.

No brewer tasting-source integration is required.

Sensory precedence becomes:

**Manual override → Recipe prediction → Style baseline**

Brew Story is read-only on the public interface.

---

# 29. Artwork

Do not carry the current artwork/image-proxy subsystem into the initial rebuild.

No custom image upload is required.

No Brewfather remote artwork proxy is required.

Visual presentation should rely on:

* Beverage display color
* existing/reusable Fill Glass SVGs
* typography/theme/design system

---

# 30. Fill Glass

Fill Glass is Beverage-owned presentation.

Each Beverage has one effective Fill Glass graphic.

For Brewfather-linked Beverages, style may provide an initial suggestion.

The administrator may override the Beverage's selected graphic.

There is no Fill-level or Tap-level presentation override.

Mystery Tap does not suppress Fill Glass.

---

# 31. Beverage Color

SRM and display color are separate concepts.

SRM is brewing metadata.

Display color is presentation data.

For beer-like Beverages:

* Brewfather SRM may populate brewing metadata
* SRM may suggest a display color
* the administrator may override the display color without changing SRM

Non-beer Beverages may have a display color with no SRM.

Display color is Beverage-level only.

---

# 32. On Deck vs. Upcoming

**On Deck** always means a real active Fill exists in a physical Keg.

Do not mix Brewfather fermentation candidates into On Deck.

A separate **Upcoming** capability may be designed later.

It is explicitly out of scope for the initial rebuild.

---

# 33. Admin Application

Admin uses real independently reachable pages under a common authenticated shell.

Target navigation:

* Overview
* Integrations
* Beverages
* Kegs
* Fills
* Taps
* Tap Wars
* Display
* System

Major concepts must not be hidden inside one giant Settings page or a collection of nested modals.

## 33.1 Overview

Overview should summarize:

* current Taps/Fills
* health state
* integration status
* important warnings/issues
* useful operational status

## 33.2 Integrations

Manage:

* telemetry sources/API keys
* Brewfather
* Home Assistant outbound
* generic webhooks
* future supported integrations

Secrets are replace/remove operations and are never revealed after storage.

## 33.3 Beverages

Manage:

* Custom Beverages
* Brewfather-linked Beverages
* source inheritance/overrides
* recipe viewing
* create Fill
* permanent deletion

## 33.4 Kegs

Manage permanent physical inventory:

* Keg number
* label
* capacity
* tare weight
* Active/Inactive
* maintenance history
* Fill history
* create/edit/delete Keg

## 33.5 Fills

Manage operational contents:

* Available
* On Deck
* On Tap
* Ended
* create Fill
* change On Deck status/order
* Kick Keg
* permanent deletion

## 33.6 Taps

Manage:

* Tap number/name
* enabled/disabled
* current Fill
* telemetry source
* Mystery Tap
* pour detection overrides
* health overrides
* line maintenance
* serving metadata
* manual re-baseline

## 33.7 Tap Wars

Manage:

* current competition
* participants
* description
* Start / Stop
* vote totals
* historical competitions

## 33.8 Display

Manage:

* themes
* fonts
* colors
* units
* layout behavior
* serving-temperature display
* local display settings
* shared defaults

## 33.9 System

Manage/show:

* application version/status
* Activity Log
* session management/revocation
* calculation defaults
* retention settings
* diagnostics
* other installation-wide operational configuration

---

# 34. Display Preferences

Keep the current theme/font/color capability.

Existing v1 themes are specifically valuable and should be evaluated for reuse.

Use the model:

**Shared Defaults → This Display local overrides**

The public dashboard contains no visible display-settings controls.

Admin → Display on the kiosk can modify that browser's local settings.

Per-display preferences include:

* theme
* fonts
* accent colors
* units
* public temperature visibility
* layout behavior

Unit preferences are per display with shared defaults.

Supported presentation choices include US customary and metric representations.

---

# 35. Activity Log

System includes a meaningful Activity Log.

Record meaningful actions and state transitions, including examples such as:

* Admin authentication events
* configuration changes
* Beverage/Keg/Fill/Tap changes
* assignments
* Kick Keg
* Mystery Tap changes
* Tap Wars actions/votes/results
* pours
* health transitions
* integration refresh/failure
* outbound delivery failures
* manual re-baselines
* destructive actions

Do not record every:

* telemetry sample
* SSE frame
* page view
* ordinary GET request

Activity Log retention is configurable, with a sensible default such as 90 days.

Automatic pruning applies only to the Activity Log, not domain history.

Destructive actions leave a minimal immutable deletion audit record without preserving the deleted domain data itself.

---

# 36. Authentication

Tapboard has:

* one administrator
* PIN authentication
* no usernames
* no roles
* no account-management subsystem

Admin pages require authentication.

Public dashboard does not.

Admin sessions may use long configurable lifetimes appropriate to trusted kiosks/tablets.

Both inactivity timeout and absolute lifetime are configurable up to one year.

PIN changes revoke sessions.

Individual sessions may be revoked from System.

Forgotten PIN recovery is local/operator-only through a supported command.

There is no browser-based "forgot PIN" identity-recovery workflow.

---

# 37. Integrations

Tapboard integrations are optional adapters around the core system.

External outages must not prevent normal local Tapboard operation.

## 37.1 Telemetry

Canonical inbound machine integration.

## 37.2 Home Assistant

Home Assistant is **not** the measurement source in the rebuilt architecture.

It remains an optional first-class outbound event destination.

Tapboard maintains an HA WebSocket only when the integration is enabled.

It sends one versioned event type:

**`tapboard_event`**

Home Assistant owns downstream automations, notifications, Discord delivery, lights, scripts, etc.

Tapboard does not directly call arbitrary HA services.

## 37.3 Generic webhooks

Generic webhook destinations may subscribe to selected event types.

They receive Tapboard's standard versioned event envelope.

Static headers/secrets are allowed.

No custom payload templating or arbitrary scripts are required.

## 37.4 Discord

No dedicated Discord integration is required.

Use Home Assistant or another external automation system when Discord delivery is desired.

---

# 38. Outbound Events

Tapboard owns stable domain events.

Examples may include:

* pour completed
* low keg
* Fill assigned
* Fill kicked
* Tap assignment changed
* health transition
* Tap Wars started
* Tap Wars ended
* integration failure

Each destination chooses which event types it receives.

External event envelopes include:

* stable event ID
* event type
* schema version
* occurrence timestamp
* relevant Tap/Fill/Keg/Beverage identifiers
* bounded type-specific data

Retries reuse the same event ID.

External delivery failure must never roll back or block the original Tapboard action.

---

# 39. Connectivity

The aggregate public connectivity state represents all enabled/required integrations and telemetry sources.

Healthy only when all required configured pieces are healthy.

Disabled integrations are ignored.

Examples that degrade status:

* Brewfather unavailable
* HA outbound disconnected
* selected Tap telemetry stale
* required integration failure

Detailed diagnosis belongs in Admin.

---

# 40. Offline / Degraded Operation

Tapboard must remain usable from its own durable state.

Examples:

* Brewfather offline → use last-known linked metadata
* HA offline → core actions continue; outbound events retry
* telemetry stale → affected measurement state degrades but administration remains functional
* public display continues showing everything Tapboard safely knows

External integrations must not become hidden hard dependencies.

---

# 41. Public API Scope

Public read APIs should be minimal and purpose-built.

Expose only projections with real consumers, such as:

* current public Tap projection
* On Deck
* Brew Story
* intentionally public connectivity/health state

Do not automatically expose generic database-like APIs for all Beverages, Kegs, Fills, or raw telemetry.

---

# 42. External Machine API Scope

The supported machine API is telemetry-focused.

External systems may submit measurements.

They may not initially:

* create/edit Beverages
* create/kick Fills
* assign Taps
* mutate physical Kegs
* start Tap Wars
* change settings

Tapboard remains the sole authority for domain mutations.

---

# 43. Removed / Deferred v1 Capabilities

Do not carry these into the initial rebuild unless the architecture review identifies a compelling contradiction:

* Tap Planning / Brewfather readiness matching
* Upcoming Brewfather display
* Brewfather fermentation/readings history
* brewer tasting source
* remote artwork/image proxy
* custom artwork upload
* dedicated Discord integration
* HA-owned telemetry
* HA capacity helpers
* Tapboard-owned backup/restore subsystem
* old database migration chain
* legacy Admin/settings organization

---

# 44. Data Reset

The rebuild starts with a new SQLite database.

There is **no migration of existing Tapboard user data**.

Backward compatibility with the v1 database or internal HTTP APIs is not a requirement.

The new schema should be designed for the system described here rather than shaped around old storage decisions.
