# Tapboard Architecture & Technical Specifications

**Version**: 3.7.2  
**Repository**: `joe-cole1/home-assistant-tapboard`  
**Host & Local Path**: `C:\Users\Joe\OneDrive\Antigravity\home-assistant\tapboard`  
**Docker Deployment**: Containerized on loopback port `127.0.0.1:3005:3000` (`http://localhost:3005`) connected to Home Assistant (`http://192.168.0.35:8123`).

---

## 1. System Overview & Technology Stack

Tapboard is a real-time, low-latency homebrew taproom dashboard application built to monitor keg volumes, pour analytics, Brewfather batch data, and glassware graphics.

### Core Stack:
- **Runtime & Server**: Node.js (ES Modules, native `http` module, no heavy web frameworks).
- **Database**: SQLite via `better-sqlite3` with Write-Ahead Logging (`WAL` mode) for non-blocking concurrent reads/writes.
- **Home Assistant Sync**: Real-time WebSocket client (`ws://192.168.0.35:8123/api/websocket`) with 4-stage noise filtering and event queue buffering.
- **Client Push**: Server-Sent Events (SSE) live stream (`/events`) with automatic fallback reconnection and initial snapshot hydration.
- **Frontend Architecture**: Single-page application (`public/app.js`, `public/graphics.js`, `public/styles.css`) using native DOM manipulation, in-place element diffing, and dynamic vector SVG graphics.

---

## 2. Core Codebase Directory Structure

```
tapboard/
├── docker-compose.yml        # Loopback port plus independent data/backup named volumes
├── Dockerfile                # Pinned, non-root Node 22 Alpine production image
├── package.json              # Dependencies: better-sqlite3, bcryptjs, dotenv, ws
├── .env                      # Target HA URL (http://192.168.0.35:8123) and long-lived access token
├── architecture.md           # Authoritative system architecture baseline specification
├── src/
│   ├── db.js                 # SQLite connection, explicit pragmas, seeding
│   ├── dbMigrations.js       # Transactional schema versions and lifecycle migration
│   ├── kegLifecycle.js       # Immutable assignment ownership and pour attribution
│   ├── haClient.js           # Bounded HA WebSocket lifecycle and pour detector adapter
│   └── server.js             # HTTP server, SSE broadcast bus, REST endpoints & forecast engine
└── public/
    ├── app.js                # Client dashboard controller, SSE listener, in-place DOM engine
    ├── graphics.js           # SVG glassware renderer, 1-50 SRM interpolation, carbonation generator
    ├── styles.css            # Reference-matched visual styles, themes, responsive tap grid
    └── index.html            # Main HTML layout, PIN verification & settings modals
```

---

## 3. Database Schema (`src/db.js`)

SQLite database file path: `/app/data/tapboard.db`.

### 1. `taps` (Taps 1–6 Configuration)
- `tap_id` (INTEGER PRIMARY KEY 1-6)
- `enabled` (INTEGER 0/1) - Dashboard grid visibility flag
- `graphic` (TEXT) - Glassware style (`corny_keg`, `pint_glass`, `tulip_glass`, `wheat_glass`, `mug`, `stout_glass`, `snifter`)
- `display_unit` (TEXT) - Readout format (`percent`, `pints`, `oz`, `pours_12`, `pours_custom`)
- `custom_pour_size` (REAL) - Custom pour volume in fl. oz. (e.g., 5.0 oz for stouts)
- `override_enabled` (INTEGER 0/1) - Manual field override toggle
- `override_name`, `override_style`, `override_abv`, `override_ibu`, `override_og`, `override_fg`, `override_srm`, `override_description` - Field-level manual overrides
- `badge_low_keg` (REAL DEFAULT 20.0), `badge_fresh` (INTEGER DEFAULT 1)

### 2. `settings` (Global Studio Settings)
- `id` (INTEGER PRIMARY KEY 1)
- `theme` (TEXT) - Active theme preset (`modern_dark`, `warm_pub`, `cyberpunk`, `light_minimal`)
- `title` (TEXT) - Dashboard header title
- `font_title`, `font_body` (TEXT) - Custom Google Font selections
- `admin_pin_hash` (TEXT) - Bcrypt hashed 4-digit PIN (default: `0000`)

### 3. `batches` (Brewfather & Recipe Sync Cache)
- `batch_id` (TEXT PRIMARY KEY)
- `recipe_name`, `style`, `brew_date`, `og`, `fg`, `abv`, `ibu`, `srm`, `status`, `last_synced_at`

### 4. `keg_lifecycles` and `pour_logs` (Keg Identity and Durable History)
- Each explicit batch, custom, or override-only assignment receives an immutable internal lifecycle ID; only one lifecycle may be open per tap.
- Reusing a Brewfather batch ID after ending a keg creates a distinct lifecycle.
- `pour_logs` retains its original timestamp string and a normalized integer epoch, and references the lifecycle captured at pour start.
- Legacy and unassigned pours retain a nullable lifecycle and never contribute to an active forecast.
- Lifecycle/tap and pour/tap relationships use restrictive SQLite foreign keys enabled explicitly on every application connection.
- Schema changes use ordered transactional migrations and explicit schema versions; unexpected migration failures abort startup.

---

## 4. Key Subsystems & Algorithms

### A. 4-Stage Load-Cell Scale Noise Filtering (`src/haClient.js`)
Scale sensors from Home Assistant (`sensor.tap_N_fl_oz`) exhibit continuous micro-weight jitter. The `apply4StageNoiseFilter` prevents false pour alerts:
1. **Outlier Suppression**: Rejects `NaN`, `unavailable`, `unknown`, or instantaneous volume jumps $> 50\text{ oz}$.
2. **Noise Floor Hysteresis**: Ignores volume fluctuations $|\Delta V| < 0.5\text{ oz}$ when no active pour session is underway.
3. **Pour Trigger Window**: Triggers an active pour session (`pour_start`) when volume drops $\ge 0.8\text{ oz}$ within 3 seconds. Strictly evaluates `sensor.tap_N_fl_oz` (never fill percentage) to avoid unit conflict spikes.
4. **Settling & Session Finalization**: Wait for a 5-second quiet period after liquid flow stops, then finalize total poured volume (`pour_complete`), log to `pour_logs`, and check low-keg alert threshold (`badge_low_keg`).

### B. 14-Day Rolling Keg Kick Forecast Engine (`src/server.js`)
Calculates estimated days remaining for each active tap:
- Queries only the open lifecycle through the `(lifecycle_id, timestamp_epoch)` index for up to the last 14 elapsed days.
- Changing, clearing, or ending a keg closes its lifecycle without deleting durable pour history.
- If no logged pours exist for the active tap, the forecast is omitted instead of inventing a baseline rate.
- Output format: `⌛ 16.3 days remaining` or `🔴 Kicking soon`.

### C. In-Place Targeted DOM Preservation Engine (`public/app.js`)
- **Problem**: Rebuilding card HTML on every 2-second scale update destroys `<svg>` DOM nodes, resetting CSS animation timers to 0s and preventing bubbles from rising past 10% height.
- **Solution**: `renderApp()` and `updateTapCard()` update text nodes and attributes in-place. The `<svg>` element and its internal `<circle>` carbonation bubbles remain continuously attached to the document, allowing bubbles to float smoothly all the way to the liquid surface line uninterrupted.

### D. Full 1–50 SRM Color Interpolation (`public/graphics.js`)
- `srmToHex(srmVal)` provides exact hex color shades across the full 1–50 SRM spectrum for Porters, Stouts, IPAs, Wheat beers, and Lagers.
- Nearest-neighbor interpolation ensures unmapped decimal or integer values map to their correct dark/light beer shade.
- Topo Chico / Sparkling Water / Seltzer automatically set SRM 0 / `WATER` for transparent liquid rendering with white carbonation bubbles.

---

## 5. API Endpoints & Live Events

- `GET /events`: SSE stream emitting `snapshot`, `state_changed`, `pour_start`, `pour_complete`, `low_keg_alert`, and `settings_updated`.
- `POST /api/auth`: PIN authentication endpoint returning JSON Web Token.
- `GET /api/state`: Returns complete formatted application state snapshot.
- `POST /api/settings`: Save global studio settings (Theme, Title, Fonts, Active Taps visibilities 1–6, PIN update).
- `POST /api/taps/:id`: Save per-tap settings (Batch assignment, Glassware style, Volume display unit, Custom pour size, Overrides). Automatically sets `enabled = 1` when a batch is assigned.
- `POST /api/taps/:id/end-batch`: Complete Brewfather batch call via `script.end_tap_batch`.
- `POST /api/taps/:id/end-keg`: Unassign tap / set off-tap.

---

## 6. Development Guidelines & Learned Invariants

1. **ES Module HTML Invariant**: When loading JavaScript files containing ES module syntax (`export`, `import`), never add duplicate classic `<script src="file.js"></script>` tags in `index.html` unless explicitly declared with `type="module"`, or rely solely on ES module imports inside `app.js`.
2. **Live Telemetry DOM Element Preservation**: In real-time WebSocket/SSE dashboard interfaces featuring CSS keyframe animations, implement in-place element diffing (`updateTapCard()`). Update text nodes and numerical attributes directly without recreating or tearing down SVG/DOM wrapper elements.
3. **Telemetry Unit Isolation Invariant**: Never pass entities measuring different physical units (e.g., fluid ounces vs. fill percentages) into a single volume tracking or noise filtering state machine. Isolate noise filtering strictly to dedicated single-unit telemetry entities (`sensor.tap_N_fl_oz`).
4. **Reconnect Safety Invariant**: Hydration events are bounded and merged into a fresh snapshot without detector replay. The detector hydrates once from the final state so stale reconnect telemetry cannot synthesize a pour.
5. **Lifecycle Attribution Invariant**: Capture the immutable keg lifecycle synchronously at pour start. Reassignment before completion must not move the pour to the new keg.
6. **Persistence Invariant**: The live SQLite database and WAL reside in a Docker named volume, while verified backups use an independent named volume and a rehearsed restore path.
