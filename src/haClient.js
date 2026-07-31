import WebSocket from 'ws';
import EventEmitter from 'events';
import db from './db.js';

export class HAClient extends EventEmitter {
  constructor() {
    super();
    this.haUrl = process.env.HA_URL || 'http://192.168.0.35:8123';
    this.haToken = process.env.HA_TOKEN || '';
    this.wsUrl = this.haUrl.replace(/^http/i, 'ws').replace(/\/$/, '') + '/api/websocket';
    this.ws = null;
    this.messageId = 1;
    this.pendingRequests = new Map();
    this.statesMap = new Map();
    this.eventQueue = [];
    this.isHydrated = false;
    this.reconnectTimeout = null;
    this.reconnectDelay = 1000;

    // Per-tap pour session tracker
    this.pourTracker = new Map();
    for (let i = 1; i <= 6; i++) {
      this.pourTracker.set(i, {
        isPouring: false,
        startVolume: 0,
        currentVolume: 0,
        lastVolume: 0,
        totalPoured: 0,
        lastDropTime: 0,
        settleTimer: null
      });
    }
  }

  connect() {
    if (!this.haToken) {
      console.warn('[HAClient] No HA_TOKEN provided in .env. Real-time HA WebSocket sync disabled.');
      return;
    }

    console.log(`[HAClient] Connecting to Home Assistant WebSocket at ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('[HAClient] WebSocket connection opened. Awaiting auth_required...');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error('[HAClient] Error parsing WebSocket frame:', err.message);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`[HAClient] WebSocket closed (code: ${code}). Reconnecting...`);
      this.isHydrated = false;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[HAClient] WebSocket socket error:', err.message);
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket is not connected'));
      }
      const id = ++this.messageId;
      const payload = { ...msg, id };
      this.pendingRequests.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async handleMessage(msg) {
    if (msg.type === 'auth_required') {
      console.log('[HAClient] Authenticating with HA token...');
      this.ws.send(JSON.stringify({
        type: 'auth',
        access_token: this.haToken
      }));
      return;
    }

    if (msg.type === 'auth_ok') {
      console.log('[HAClient] Authentication successful! Initiating event replay sync...');
      this.reconnectDelay = 1000;
      await this.initiateSync();
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[HAClient] Authentication failed:', msg.message);
      return;
    }

    if (msg.id && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      if (msg.success) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error ? msg.error.message : 'Unknown HA WS error'));
      }
      return;
    }

    if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
      this.handleStateChangedEvent(msg.event.data);
    }
  }

  async initiateSync() {
    try {
      this.isHydrated = false;
      this.eventQueue = [];

      console.log('[HAClient] Step 1: Subscribing to state_changed event stream...');
      const subRes = await this.send({
        type: 'subscribe_events',
        event_type: 'state_changed'
      });
      this.subscribedEventId = subRes;

      console.log('[HAClient] Step 2: Requesting initial get_states snapshot...');
      const states = await this.send({ type: 'get_states' });

      for (const entity of states) {
        this.statesMap.set(entity.entity_id, entity);
        this.syncBrewfatherBatchData(entity);
      }

      // Initialize pour trackers from snapshot states to prevent initial volume deltas
      for (let tapId = 1; tapId <= 6; tapId++) {
        const ozState = this.statesMap.get(`sensor.tap_${tapId}_fl_oz`)?.state;
        const parsedOz = parseFloat(ozState);
        if (!isNaN(parsedOz) && parsedOz > 0) {
          const tracker = this.pourTracker.get(tapId);
          tracker.lastVolume = parsedOz;
          tracker.currentVolume = parsedOz;
        }
      }

      console.log(`[HAClient] Hydrated ${this.statesMap.size} entities from snapshot.`);

      console.log(`[HAClient] Step 3: Replaying ${this.eventQueue.length} buffered queue events...`);
      for (const eventData of this.eventQueue) {
        this.processStateUpdate(eventData);
      }
      this.eventQueue = [];
      this.isHydrated = true;

      console.log('[HAClient] Sync complete! Live stream active.');
      this.emit('hydrated', this.getFormattedState());

    } catch (err) {
      console.error('[HAClient] Failed to complete sync sequence:', err.message);
    }
  }

  handleStateChangedEvent(data) {
    if (!this.isHydrated) {
      this.eventQueue.push(data);
    } else {
      this.processStateUpdate(data);
    }
  }

  processStateUpdate(data) {
    const { entity_id, new_state } = data;
    if (!new_state) return;

    this.statesMap.set(entity_id, new_state);
    this.syncBrewfatherBatchData(new_state);

    // Apply 4-Stage Noise Filtering strictly to sensor.tap_N_fl_oz (DO NOT pass fill percentage)
    for (let tapId = 1; tapId <= 6; tapId++) {
      if (entity_id === `sensor.tap_${tapId}_fl_oz`) {
        this.apply4StageNoiseFilter(tapId, new_state);
      }
    }

    this.emit('state_changed', { entity_id, state: new_state, fullState: this.getFormattedState() });
  }

  // 4-Stage Noise Filtering & Pour Session Tracking Algorithm
  apply4StageNoiseFilter(tapId, stateObj) {
    const rawValue = parseFloat(stateObj.state);
    const tracker = this.pourTracker.get(tapId);

    // Stage 1: Outlier & Glitch Suppression
    if (isNaN(rawValue) || stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      return;
    }

    if (tracker.lastVolume === 0) {
      tracker.lastVolume = rawValue;
      tracker.currentVolume = rawValue;
      return;
    }

    const delta = rawValue - tracker.lastVolume;

    // Reject extreme instantaneous spikes (> 50 oz jump)
    if (Math.abs(delta) > 50) {
      return;
    }

    // Stage 2: Noise Floor Hysteresis (Ignore micro-jitter |ΔV| < 0.5 oz)
    if (Math.abs(delta) < 0.5 && !tracker.isPouring) {
      return;
    }

    // Stage 3: Pour Trigger Window (Detect drop >= 0.8 oz within 3s)
    if (delta <= -0.8 && !tracker.isPouring) {
      tracker.isPouring = true;
      tracker.startVolume = tracker.lastVolume;
      tracker.totalPoured = 0;
      console.log(`[Tap ${tapId}] Pour started! Initial volume: ${tracker.startVolume} oz`);

      this.emit('pour_start', { tapId, startVolume: tracker.startVolume });
    }

    if (tracker.isPouring) {
      if (delta < 0) {
        tracker.totalPoured += Math.abs(delta);
        tracker.lastDropTime = Date.now();
      }

      // Stage 4: Settling & Session Finalization (5s quiet period)
      if (tracker.settleTimer) clearTimeout(tracker.settleTimer);
      tracker.settleTimer = setTimeout(() => {
        this.finalizePourSession(tapId);
      }, 5000);
    }

    tracker.lastVolume = rawValue;
    tracker.currentVolume = rawValue;
  }

  finalizePourSession(tapId) {
    const tracker = this.pourTracker.get(tapId);
    if (!tracker.isPouring) return;

    tracker.isPouring = false;
    const finalPouredOz = Math.round(tracker.totalPoured * 10) / 10;

    console.log(`[Tap ${tapId}] Pour finalized: ${finalPouredOz} oz poured.`);

    if (finalPouredOz >= 1.0) {
      db.prepare(`
        INSERT INTO pour_logs (tap_id, volume_poured_oz) VALUES (?, ?)
      `).run(tapId, finalPouredOz);

      const tapInfo = db.prepare('SELECT override_name FROM taps WHERE tap_id = ?').get(tapId);
      const beerName = tapInfo?.override_name || `Tap ${tapId}`;

      this.emit('pour_complete', {
        tapId,
        volumePouredOz: finalPouredOz,
        beerName,
        timestamp: new Date().toISOString()
      });

      this.checkLowKegAlert(tapId);
    }
  }

  checkLowKegAlert(tapId) {
    const tapRow = db.prepare('SELECT badge_low_keg FROM taps WHERE tap_id = ?').get(tapId);
    const fillState = this.statesMap.get(`sensor.tap_${tapId}_fill`);
    if (!tapRow || !fillState) return;

    const currentPercent = parseFloat(fillState.state);
    if (!isNaN(currentPercent) && currentPercent <= tapRow.badge_low_keg) {
      console.log(`[Alert] Tap ${tapId} volume (${currentPercent}%) dipped below threshold (${tapRow.badge_low_keg}%).`);
      this.emit('low_keg_alert', { tapId, currentPercent, threshold: tapRow.badge_low_keg });
    }
  }

  syncBrewfatherBatchData(entity) {
    if (!entity.entity_id.startsWith('sensor.tap_') || !entity.entity_id.endsWith('_batch_info')) return;
    const attr = entity.attributes;
    if (!attr || (!attr.batch_id && !attr.id)) return;

    const batchId = attr.batch_id || attr.id;
    const recipeName = attr.recipe_name || attr.name || 'Unknown Brew';
    const style = attr.style || 'Craft Beer';
    const brewDate = attr.brew_date || null;
    const og = parseFloat(attr.og) || null;
    const fg = parseFloat(attr.fg) || null;
    const abv = parseFloat(attr.abv) || null;
    const ibu = parseInt(attr.ibu, 10) || null;
    const srm = parseInt(attr.srm || attr.color, 10) || null;
    const status = attr.status || 'Active';

    try {
      db.prepare(`
        INSERT INTO batches (batch_id, recipe_name, style, brew_date, og, fg, abv, ibu, srm, status, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(batch_id) DO UPDATE SET
          recipe_name = excluded.recipe_name,
          style = excluded.style,
          brew_date = excluded.brew_date,
          og = excluded.og,
          fg = excluded.fg,
          abv = excluded.abv,
          ibu = excluded.ibu,
          srm = excluded.srm,
          status = excluded.status,
          last_synced_at = datetime('now')
      `).run(batchId, recipeName, style, brewDate, og, fg, abv, ibu, srm, status);
    } catch (e) {
      // Safe fallback if optional fields are missing
    }
  }

  getFormattedState() {
    const formatted = {};
    for (const [entityId, entityObj] of this.statesMap.entries()) {
      formatted[entityId] = {
        state: entityObj.state,
        attributes: entityObj.attributes
      };
    }
    return formatted;
  }

  async callHAService(domain, service, serviceData = {}) {
    console.log(`[HAClient] Calling service ${domain}.${service} with:`, serviceData);
    return await this.send({
      type: 'call_service',
      domain,
      service,
      service_data: serviceData
    });
  }
}
