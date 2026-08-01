# Home Assistant Tapboard v3.2 (Containerized)

A lightweight, high-performance brewery tap dashboard for Home Assistant, hosted as a standalone Docker container on your local NAS behind a reverse proxy (Pangolin/Traefik).

---

## Key Features

- **Zero Client HA Credentials**: Frontends connect via Server-Sent Events (`/events`) with zero tokens or HA setup required for viewers.
- **4-Stage Load-Cell Noise Filtering**: Eliminates load-cell voltage jitter ($\pm 0.1\text{ oz}$) and reboot/offline spikes (`unavailable`, `-102.1\text{ oz}`).
- **Bounded Snapshot Sync**: Subscribes before `get_states`, overlays a bounded delta queue, then hydrates the detector once so stale reconnect telemetry cannot create pours.
- **Pangolin Proxy Bypass Headers**: Declares `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` for smooth SSE streaming.
- **SQLite WAL Mode**: Live WAL storage uses a Docker named volume, with verified online backups kept in an independent volume.
- **Recipe Detail Modals**: Click any beer card to view full Brewfather recipe specs, OG/FG, ABV, IBU, SRM color, and tasting notes.
- **Keg Kick Forecast**: Automatically calculates estimated days remaining per tap from up to 14 days of lifecycle-scoped pour logs and stays hidden until usage data exists.
- **On-Deck Sidebar Widget**: Displays upcoming brews currently conditioning in the fermentation pipeline.

---

## Quick Start (Docker Compose)

1. Clone repository and create a `.env` file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your Home Assistant URL, Long-Lived Access Token, and a
   one-time non-default admin PIN:
   ```env
   HA_URL=http://192.168.1.100:8123
   HA_TOKEN=your_long_lived_access_token
   PORT=3000
   TAPBOARD_INITIAL_ADMIN_PIN=<choose-four-digits>
   TAPBOARD_EXPECT_EXISTING_DATA=false
   ```

   Choose your own four digits; `0000` is rejected. Tapboard consumes this
   value only while the database is uninitialized. Never commit or share the
   `.env` file.

3. Launch with Docker Compose:
   ```bash
   docker compose up -d
   ```

4. Open `http://localhost:3005` in your browser and authenticate with the PIN
   you selected.

5. After successful authentication, remove `TAPBOARD_INITIAL_ADMIN_PIN`, set
   `TAPBOARD_EXPECT_EXISTING_DATA=true`, and run
   `docker compose up -d --force-recreate`. The PIN remains in the database
   only as a bcrypt hash, the plaintext is removed from the container
   environment, and later starts refuse an unexpectedly empty data volume.

For an HTTPS reverse proxy, set `TAPBOARD_PUBLIC_ORIGIN` to the exact external
origin, such as `https://tapboard.example.com`. See
[`docs/SECURITY.md`](docs/SECURITY.md) before exposing Tapboard outside the
local network.

Database backup, retention, restore rehearsal, live migration, and rollback
procedures are documented in [`docs/DATABASE-OPERATIONS.md`](docs/DATABASE-OPERATIONS.md).

---

## Architecture Overview

```
 Home Assistant ──[Persistent WS]──> Tapboard Container (Node.js + SQLite) ──[SSE /events]──> Browser Client
```
