# Home Assistant Tapboard v3.2 (Containerized)

A lightweight, high-performance brewery tap dashboard for Home Assistant, hosted as a standalone Docker container on your local NAS behind a reverse proxy (Pangolin/Traefik).

---

## Key Features

- **Zero Client HA Credentials**: Frontends connect via Server-Sent Events (`/events`) with zero tokens or HA setup required for viewers.
- **4-Stage Load-Cell Noise Filtering**: Eliminates load-cell voltage jitter ($\pm 0.1\text{ oz}$) and reboot/offline spikes (`unavailable`, `-102.1\text{ oz}`).
- **Event Queue Replay Sync**: Subscribes to HA WebSocket `state_changed` *before* `get_states`, buffering and replaying deltas to prevent startup race conditions.
- **Pangolin Proxy Bypass Headers**: Declares `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` for smooth SSE streaming.
- **SQLite WAL Mode**: Persistent SQLite storage running in Write-Ahead Logging mode for non-blocking concurrent reads.
- **Recipe Detail Modals**: Click any beer card to view full Brewfather recipe specs, OG/FG, ABV, IBU, SRM color, and tasting notes.
- **Keg Kick Forecast**: Automatically calculates estimated days remaining per tap based on rolling 7-day average pour logs.
- **On-Deck Sidebar Widget**: Displays upcoming brews currently conditioning in the fermentation pipeline.

---

## Quick Start (Docker Compose)

1. Clone repository and create a `.env` file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your Home Assistant URL and Long-Lived Access Token:
   ```env
   HA_URL=http://192.168.1.100:8123
   HA_TOKEN=your_long_lived_access_token
   PORT=3000
   ```

3. Launch with Docker Compose:
   ```bash
   docker compose up -d
   ```

4. Open `http://localhost:3000` in your browser. Default Admin PIN to unlock settings studio is `0000`.

---

## Architecture Overview

```
 Home Assistant ──[Persistent WS]──> Tapboard Container (Node.js + SQLite) ──[SSE /events]──> Browser Client
```
