# AI Implementation Prompt: Phase 4 Kegerator Health Center & Scheduling Redesign (Ground Truth Spec - v3 Final)

## Task Overview

Implement a complete redesign of the **Phase 4 Kegerator Health Center** in **Tapboard**. The current draft health implementation is integrated into the public-facing touchscreen display and lacks configurable low-keg alert levels, hybrid line-cleaning scheduling, and tap-gap forecast alerts.

This task requires fully decoupling Kegerator Health from the public touchscreen UI, moving it into a dedicated, PIN-protected **Admin Kegerator Health Center** view with tabbed navigation between an **Overview Dashboard** and a **Health Settings Page**, extending the existing v10 database schema (via an idempotent v11 migration), implementing customizable multi-level low-keg alerts, hybrid line-cleaning triggers, and tap-gap conditioning lead-time warnings.

---

## Architectural Directives & Ground-Truth Specifications

### 1. Schema & Migration Robustness (v11 Migration)

Implement `migrateToV11(db)` in `src/dbMigrations.js`:

- **Atomicity & Idempotency**:
  - Wrap the entire migration in a single SQLite transaction (`BEGIN TRANSACTION` ... `COMMIT`).
  - Check `schema_version` or `PRAGMA table_info` before applying `ALTER TABLE` statements.
  - Bump `schema_version = 11` as the final statement inside the same transaction.
  - Test twice in `test/dbMigrations.test.js`: assert that re-running the migration against an already-migrated database is a clean no-op and does not throw errors.

- **Incident State Tracking & `current_incident_id`**:
  - Add `current_incident_id` (TEXT) to `health_check_state`.
  - When a check transitions from `healthy` to an unhealthy state (`warning` or `critical`), generate a stable UUID/timestamp string `current_incident_id`.
  - When the check recovers to `healthy`, rotate/clear `current_incident_id = NULL`.
  - Add `health_incident_actions` audit table:
    ```sql
    CREATE TABLE IF NOT EXISTS health_incident_actions (
      action_id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_id TEXT NOT NULL,
      tap_id INTEGER NOT NULL DEFAULT 0,
      incident_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('acknowledge', 'snooze', 'clear', 'redact')),
      snooze_until TEXT,
      action_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      operator_notes TEXT DEFAULT '',
      FOREIGN KEY(tap_id) REFERENCES taps(tap_id) ON UPDATE RESTRICT ON DELETE SET NULL
    );
    ```

- **Maintenance Schema Updates**:
  - Add `cleaning_type` (TEXT DEFAULT 'Caustic' CHECK(cleaning_type IN ('Caustic', 'Acid', 'Water Flush'))) and `style_swap` (INTEGER DEFAULT 0 CHECK(style_swap IN (0, 1))) to `maintenance_records`.
  - Backfill existing pre-v11 rows with `style_swap = 0` and `cleaning_type = 'Caustic'`.

- **Kegs-Served & Volume-Served Derivation**:
  - Derive kegs served dynamically per tap using SQL:
    ```sql
    SELECT COUNT(*) AS kegs_served
    FROM keg_lifecycles kl
    WHERE kl.tap_id = ?
      AND kl.created_at >= (
        SELECT COALESCE(MAX(mr.completed_at), '1970-01-01T00:00:00.000Z')
        FROM maintenance_records mr
        JOIN maintenance_record_taps mrt ON mr.maintenance_id = mrt.maintenance_id
        WHERE mrt.tap_id = ?
      );
    ```
  - Note: Counts both active and ended lifecycles assigned since the last line cleaning (`COALESCE` handles taps with no prior cleaning history).
  - Derive volume served since last cleaning from HX711 scale telemetry or pour log records.
  - Create composite indices: `CREATE INDEX IF NOT EXISTS idx_mrt_tap_completed ON maintenance_record_taps(tap_id, maintenance_id)` and `CREATE INDEX IF NOT EXISTS idx_kl_tap_created ON keg_lifecycles(tap_id, created_at)`.

---

### 2. Strict Public vs. Admin Boundary & Security

- **Public UI**: Remove `#taproomStatusBtn` header badge from `public/index.html`. Remove `HEALTH` and `TAP GAP` badges from public tap cards in `public/app.js` and `public/cardPresentation.js`.
- **Public API & SSE Stream**:
  - `/api/state` exposes categorical keg volume levels (`On Tap`, `Low`, `Empty`) instead of raw volume ounces or velocity metrics to prevent external scraping.
  - Strictly isolate Server-Sent Events into two channels: `/events/public` (touchscreen displays, zero health/maintenance events) and `/events/admin` (protected by admin session auth, streams health alerts and maintenance updates).
- **Admin Endpoints & Rate Limiting**:
  - All admin health endpoints (`/api/admin/health/*`) require `requireAdmin` bearer session authentication.
  - Add rate-limiting middleware to `/api/auth/pin` (max 5 attempts per 15-minute window) to prevent PIN brute-forcing.
- **HA Notification Payload Sanitize**:
  - Outbound `tapboard_event` payload sent to Home Assistant contains strictly `tap_id`, `check_id`, `severity`, `title`, and generic `message` — free-text `operator_notes` are never broadcast to HA.

---

### 3. Tap-Gap Forecast Model & Pressure Telemetry

- **Tap-Gap Forecast Integration**:
  - Reuse `tapPlanning.js` confidence-range depletion forecasts and `forecast_gap_state`.
  - Candidate batch matching: Match candidate batch on `On Deck` or `Fermenting` stage by assigned tap or tap capability tags (`Standard`, `Nitro`, `High carbonation`).
  - Warning trigger: Fires when the upper bound of active keg depletion date is earlier than the lower bound of candidate serving readiness date.
  - Equality ($D === C$) is treated as on-schedule (no gap alert).
- **Pressure Telemetry Model Readiness**:
  - Add structure for `serving_pressure` check (`currentPsi`, `minPsi`, `maxPsi`, `status`, `excursionDurationMs`) matching the serving temperature model structure for future CO2 pressure transducer sensors.

---

### 4. Overview Dashboard & Health Settings UX Architecture

- **Triage-Driven Overview Inbox**:
  - Sort active alerts by severity: **Critical > Warning > Degraded > Info**, with unacknowledged alerts pinned to top.
  - 1-Click Action: Clicking a line-cleaning alert opens a pre-filled "Log Maintenance" modal with today's date, current tap ID, and chemical selection.
- **Health Settings & Inheritance**:
  - Display "Using global default (X)" badge alongside setting fields with an explicit "Override" toggle button.
  - Validate `Critical < Warning` inline on user input.
  - Group low-keg threshold inputs under a single card with a visible "OR" connector tag.
  - Visual Tap-Gap Timeline: Render visual horizontal bar charts showing active keg depletion date range vs candidate batch readiness date range.

---

## Verification & Definition of Done

1. **Automated Tests**:
   - `npm test` passes all test suites:
     - `test/dbMigrations.test.js`: Idempotent v11 migration test (running migration twice is a no-op).
     - `test/draftHealth.test.js`: Unit tests for low keg thresholds, tap-gap forecast evaluation, hybrid line cleaning (days vs kegs vs volume), and scale settling cooldown.
     - `test/serverSmoke.test.js`: API smoke tests for `/api/admin/health/*`.
     - `test/serverSecurity.test.js`: Verifies 401 unauthenticated access, rate-limiting on PIN auth, and public state/SSE stream data masking.

2. **Docker Build & Health Probe**:
   - Rebuild Docker container: `docker compose up --build -d`.
   - Verify `/healthz` endpoint returns `200 OK`.

3. **Manual Verification**:
   - Touchscreen display remains clean and un-polluted by admin health badges.
   - Admin settings unlock opens Kegerator Health Center.
   - Line cleaning modal logs maintenance, resets kegs-served counter, and clears alert.
