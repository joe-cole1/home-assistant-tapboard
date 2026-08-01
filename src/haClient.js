import WebSocket from 'ws';
import EventEmitter from 'events';
import db from './db.js';
import { PourDetector, normalizeVolumeToOz } from './pourDetector.js';

export class HAClient extends EventEmitter {
  constructor({ detector, detectorOptions } = {}) {
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
    this.isConnected = false;
    this.reconnectTimeout = null;
    this.reconnectDelay = 1000;
    this.primaryTapSensors = new Map();
    this.unitWarnings = new Map();

    const handleDetectorEvent = event => this.handleDetectorEvent(event);
    if (detector) {
      this.detector = detector;
      // Keep an injected test detector observable while still adapting its
      // lifecycle to HAClient's public EventEmitter events.
      const priorHandler = detector.onEvent;
      detector.onEvent = event => {
        priorHandler?.(event);
        handleDetectorEvent(event);
      };
    } else {
      const priorHandler = detectorOptions?.onEvent;
      this.detector = new PourDetector({
        ...detectorOptions,
        onEvent: event => {
          priorHandler?.(event);
          handleDetectorEvent(event);
        }
      });
    }
  }

  connect() {
    if (!this.haToken) {
      console.warn('[HAClient] No HA_TOKEN provided in .env. Real-time HA WebSocket sync disabled.');
      this.isConnected = false;
      this.emit('connection_change', false);
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
      this.isConnected = false;
      this.detector.reset('disconnect');
      this.emit('connection_change', false);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[HAClient] WebSocket socket error:', err.message);
      this.isConnected = false;
      this.detector.reset('disconnect');
      this.emit('connection_change', false);
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
      this.isConnected = true;
      this.emit('connection_change', true);
      await this.initiateSync();
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[HAClient] Authentication failed:', msg.message);
      this.isConnected = false;
      this.emit('connection_change', false);
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

  getPrimaryTapSensor(tapId) {
    const candidates = [
      `sensor.brewery_brewery_taps_tap_${tapId}_fast`,
      `sensor.brewery_taps_tap_${tapId}_fast`,
      `sensor.tap_${tapId}_fast`,
      `sensor.tap_${tapId}_fl_oz`
    ];
    for (const id of candidates) {
      if (this.statesMap.has(id)) return id;
    }
    return `sensor.tap_${tapId}_fl_oz`;
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

      // Seed the pure detector from the snapshot. Hydration never produces pour events.
      for (let tapId = 1; tapId <= 6; tapId++) {
        const primaryId = this.getPrimaryTapSensor(tapId);
        this.primaryTapSensors.set(tapId, primaryId);
        const stateObj = this.statesMap.get(primaryId);
        if (stateObj && stateObj.state !== 'unavailable' && stateObj.state !== 'unknown') {
          const ozValue = normalizeVolumeToOz(stateObj.state, stateObj.attributes?.unit_of_measurement);
          if (ozValue !== null) {
            this.detector.hydrate(tapId, ozValue, this.stateTimestamp(stateObj));
            console.log(`[HAClient] Tap ${tapId} detector hydrated from ${primaryId} = ${ozValue.toFixed(1)} oz`);
          } else {
            console.warn(`[HAClient] Tap ${tapId} primary sensor ${primaryId} has no supported declared volume unit; detector left unseeded.`);
          }
        }
      }

      // Ensure HA input_boolean.tap_N_enabled matches active taps in database
      try {
        const activeTaps = db.prepare('SELECT tap_id FROM taps WHERE enabled = 1').all();
        for (const t of activeTaps) {
          this.callHAService('input_boolean', 'turn_on', {
            entity_id: `input_boolean.tap_${t.tap_id}_enabled`
          }).catch(err => {});
        }
      } catch (e) {}

      console.log(`[HAClient] Hydrated ${this.statesMap.size} entities from snapshot.`);

      console.log(`[HAClient] Step 3: Replaying ${this.eventQueue.length} buffered queue events...`);
      this.eventQueue.sort((a, b) => this.stateTimestamp(a.new_state || {}) - this.stateTimestamp(b.new_state || {}));
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

    // Apply 4-Stage Noise Filtering strictly to each tap's designated primary scale sensor
    for (let tapId = 1; tapId <= 6; tapId++) {
      const primaryId = this.getPrimaryTapSensor(tapId);
      const previousPrimaryId = this.primaryTapSensors.get(tapId);
      if (previousPrimaryId && previousPrimaryId !== primaryId) {
        this.rehydrateDetectorFromCurrentPrimaries('source_change');
        break;
      }
      this.primaryTapSensors.set(tapId, primaryId);
      if (entity_id === primaryId) {
        this.apply4StageNoiseFilter(tapId, new_state);
      }
    }

    this.emit('state_changed', { entity_id, state: new_state, fullState: this.getFormattedState() });
  }

  stateTimestamp(stateObj) {
    const timestamp = Date.parse(stateObj.last_updated || stateObj.last_changed || '');
    return Number.isFinite(timestamp) ? timestamp : Date.now();
  }

  rehydrateDetectorFromCurrentPrimaries(reason) {
    this.detector.reset(reason);
    for (let tapId = 1; tapId <= 6; tapId++) {
      const primaryId = this.getPrimaryTapSensor(tapId);
      this.primaryTapSensors.set(tapId, primaryId);
      const stateObj = this.statesMap.get(primaryId);
      if (!stateObj || stateObj.state === 'unavailable' || stateObj.state === 'unknown') continue;
      const ozValue = normalizeVolumeToOz(stateObj.state, stateObj.attributes?.unit_of_measurement);
      if (ozValue !== null) this.detector.hydrate(tapId, ozValue, this.stateTimestamp(stateObj));
    }
  }

  // HA adapter for the independently testable detector. No magnitude-based unit inference.
  apply4StageNoiseFilter(tapId, stateObj) {
    if (stateObj.state === 'unavailable' || stateObj.state === 'unknown') {
      return;
    }
    const ozValue = normalizeVolumeToOz(stateObj.state, stateObj.attributes?.unit_of_measurement);
    if (ozValue === null) {
      const unit = stateObj.attributes?.unit_of_measurement || '';
      if (this.unitWarnings.get(stateObj.entity_id) !== unit) {
        console.warn(`[HAClient] Ignoring ${stateObj.entity_id}: unsupported or missing declared unit "${unit}".`);
        this.unitWarnings.set(stateObj.entity_id, unit);
      }
      return;
    }
    this.unitWarnings.delete(stateObj.entity_id);
    this.detector.ingest(tapId, ozValue, this.stateTimestamp(stateObj));
  }

  handleDetectorEvent(event) {
    if (event.type === 'start') {
      console.log(`[POUR EVENT] 🍺 Tap ${event.tapId} POUR STARTED! Baseline: ${event.startVolume.toFixed(1)} oz`);
      this.emit('pour_start', { tapId: event.tapId, startVolume: event.startVolume });
      return;
    }
    if (event.type === 'cancel') {
      console.log(`[POUR EVENT] 🚫 Tap ${event.tapId} pour cancelled: ${event.reason}`);
      this.emit('pour_cancel', event);
      return;
    }
    if (event.type !== 'complete') return;

    const { tapId, volumePouredOz: finalPouredOz } = event;

    const fillState = this.statesMap.get(`sensor.tap_${tapId}_fill`)?.state;
    const currentPercent = fillState ? parseFloat(fillState).toFixed(1) : 'N/A';

    console.log(`[POUR EVENT] ✅ Tap ${tapId} POUR FINALIZED! Total Dispensed: ${finalPouredOz} oz. Remaining Keg Fill: ${currentPercent}%`);

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
        timestamp: new Date(event.timestamp).toISOString()
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
    } catch (e) {}
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
