import WebSocket from 'ws';
import EventEmitter from 'events';
import db from './db.js';
import { PourDetector, normalizeVolumeToOz } from './pourDetector.js';
import { DisplayUpdateCoalescer } from './displayUpdateCoalescer.js';
import { createTapStatesProjection, projectTapStateChange } from './tapboardProjection.js';
import { captureActiveLifecycle, recordPour } from './kegLifecycle.js';

export class HAClient extends EventEmitter {
  constructor({
    detector, detectorOptions, displayUpdateCoalescer, displayCoalescerOptions,
    WebSocketImpl = WebSocket, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout,
    now = () => Date.now(), requestTimeoutMs = 10_000,
    captureLifecycle = tapId => captureActiveLifecycle(db, tapId),
    recordPourFn = pour => recordPour(db, pour)
  } = {}) {
    super();
    this.WebSocket = WebSocketImpl;
    this.setTimeout = schedule;
    this.clearTimeout = cancel;
    this.now = now;
    this.requestTimeoutMs = requestTimeoutMs;
    this.captureLifecycle = captureLifecycle;
    this.recordPour = recordPourFn;
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
    this.connectionState = 'disconnected';
    this.stopped = false;
    this.authInvalid = false;
    this.reconnectTimeout = null;
    this.authenticationTimeout = null;
    this.reconnectDelay = 1000;
    this.subscribedEventId = null;
    this.hydrationToken = 0;
    this.hydrationBytes = 0;
    this.primaryTapSensors = new Map();
    this.unitWarnings = new Map();
    this.activePourContexts = new Map();
    this.displayUpdateCoalescer = displayUpdateCoalescer || new DisplayUpdateCoalescer({
      ...displayCoalescerOptions,
      onFlush: payload => this.emit('state_changed', payload)
    });

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
    if (this.stopped || this.authInvalid) return false;
    if (!this.haToken) {
      console.warn('[HAClient] No HA_TOKEN provided in .env. Real-time HA WebSocket sync disabled.');
      this.setConnectionState('disconnected');
      return false;
    }

    // Do not replace an active or in-progress socket. This also makes calls from
    // both a close handler and a sync-failure handler harmless.
    if (this.ws) return false;
    this.clearReconnectTimer();

    console.log(`[HAClient] Connecting to Home Assistant WebSocket at ${this.wsUrl}...`);
    let socket;
    try {
      socket = new this.WebSocket(this.wsUrl, { handshakeTimeout: this.requestTimeoutMs });
    } catch (err) {
      this.setConnectionState('disconnected');
      this.scheduleReconnect();
      return false;
    }
    this.ws = socket;
    this.setConnectionState('connecting');

    socket.on('open', () => {
      console.log('[HAClient] WebSocket connection opened. Awaiting auth_required...');
      this.armAuthenticationTimeout(socket);
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg, socket);
      } catch (err) {
        console.error('[HAClient] Error parsing WebSocket frame:', err.message);
      }
    });

    socket.on('close', (code) => {
      if (socket !== this.ws) return;
      console.warn(`[HAClient] WebSocket closed (code: ${code}).`);
      this.failSocket(socket, new Error('WebSocket closed'), 'disconnect');
    });

    socket.on('error', (err) => {
      if (socket !== this.ws) return;
      console.error('[HAClient] WebSocket socket error:', err.message);
      // Some implementations do not guarantee a close event after an error.
      this.failSocket(socket, err, 'disconnect');
    });
    return true;
  }

  scheduleReconnect() {
    if (this.stopped || this.authInvalid || !this.haToken || this.reconnectTimeout !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectTimeout = this.setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnectDelay = Math.min(Math.ceil(this.reconnectDelay * 1.5), 30000);
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimeout !== null) this.clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  armAuthenticationTimeout(socket) {
    this.clearAuthenticationTimeout();
    this.authenticationTimeout = this.setTimeout(() => {
      if (socket === this.ws) this.failSocket(socket, new Error('Home Assistant authentication timed out'), 'auth_timeout');
    }, this.requestTimeoutMs);
  }

  clearAuthenticationTimeout() {
    if (this.authenticationTimeout !== null) this.clearTimeout(this.authenticationTimeout);
    this.authenticationTimeout = null;
  }

  setConnectionState(state) {
    const wasConnected = this.isConnected;
    this.connectionState = state;
    this.isConnected = state === 'connected';
    if (wasConnected !== this.isConnected) this.emit('connection_change', this.isConnected);
  }

  settleRequest(id, error, result) {
    const request = this.pendingRequests.get(id);
    if (!request) return false;
    this.pendingRequests.delete(id);
    this.clearTimeout(request.timeout);
    if (error) request.reject(error);
    else request.resolve(result);
    return true;
  }

  rejectPending(error) {
    for (const id of [...this.pendingRequests.keys()]) this.settleRequest(id, error);
  }

  failSocket(socket, error, reason, { reconnect = true } = {}) {
    if (socket && socket !== this.ws) return;
    this.ws = null;
    this.isHydrated = false;
    this.subscribedEventId = null;
    this.hydrationToken += 1;
    this.eventQueue = [];
    this.hydrationBytes = 0;
    this.clearAuthenticationTimeout();
    this.rejectPending(error);
    this.detector.reset(reason);
    this.setConnectionState(this.stopped ? 'stopped' : (this.authInvalid ? 'auth_invalid' : 'disconnected'));
    this.closeSocket(socket);
    if (reconnect && !this.stopped && !this.authInvalid) this.scheduleReconnect();
  }

  closeSocket(socket) {
    if (!socket) return;
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else if (typeof socket.close === 'function') socket.close();
    } catch (_) {}
  }

  restart() {
    this.stopped = false;
    this.authInvalid = false;
    this.reconnectDelay = 1000;
    return this.connect();
  }

  stop() {
    this.stopped = true;
    this.authInvalid = false;
    this.clearReconnectTimer();
    const socket = this.ws;
    this.failSocket(socket, new Error('HA client stopped'), 'shutdown', { reconnect: false });
    this.displayUpdateCoalescer.dispose?.();
  }

  send(msg, { onId } = {}) {
    return new Promise((resolve, reject) => {
      const socket = this.ws;
      if (!socket || socket.readyState !== this.WebSocket.OPEN) {
        return reject(new Error('WebSocket is not connected'));
      }
      const id = ++this.messageId;
      const payload = { ...msg, id };
      const timeout = this.setTimeout(() => this.settleRequest(id, new Error(`HA WebSocket request ${id} timed out`)), this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      onId?.(id);
      try {
        socket.send(JSON.stringify(payload), err => {
          if (err) {
            this.settleRequest(id, err);
            this.failSocket(socket, err, 'disconnect');
          }
        });
      } catch (err) {
        this.settleRequest(id, err);
        this.failSocket(socket, err, 'disconnect');
      }
    });
  }

  async handleMessage(msg, socket = this.ws) {
    if (socket !== this.ws) return;
    if (msg.type === 'auth_required') {
      console.log('[HAClient] Authenticating with HA token...');
      this.setConnectionState('authenticating');
      this.armAuthenticationTimeout(socket);
      try {
        socket.send(JSON.stringify({ type: 'auth', access_token: this.haToken }), err => {
          if (err) this.failSocket(socket, err, 'disconnect');
        });
      } catch (err) { this.failSocket(socket, err, 'disconnect'); }
      return;
    }

    if (msg.type === 'auth_ok') {
      console.log('[HAClient] Authentication successful! Initiating event replay sync...');
      this.clearAuthenticationTimeout();
      this.setConnectionState('hydrating');
      await this.initiateSync(socket);
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[HAClient] Authentication failed:', msg.message);
      this.clearAuthenticationTimeout();
      this.authInvalid = true;
      this.clearReconnectTimer();
      this.failSocket(socket, new Error(msg.message || 'Home Assistant authentication failed'), 'auth_invalid', { reconnect: false });
      return;
    }

    if (msg.type !== 'event' && msg.id && this.pendingRequests.has(msg.id)) {
      this.settleRequest(msg.id, msg.success ? null : new Error(msg.error ? msg.error.message : 'Unknown HA WS error'), msg.result);
      return;
    }

    if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
      // HA uses the subscribe request id as event identity. Events from an old
      // subscription must never be allowed into a new hydration generation.
      if (msg.id === this.subscribedEventId) this.handleStateChangedEvent(msg.event.data);
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

  async initiateSync(socket = this.ws) {
    if (socket !== this.ws || this.stopped || this.authInvalid) return;
    const token = ++this.hydrationToken;
    try {
      this.isHydrated = false;
      this.eventQueue = [];
      this.hydrationBytes = 0;
      this.subscribedEventId = null;

      console.log('[HAClient] Step 1: Subscribing to state_changed event stream...');
      await this.send({
        type: 'subscribe_events',
        event_type: 'state_changed'
      }, { onId: id => { this.subscribedEventId = id; } });
      if (token !== this.hydrationToken || socket !== this.ws) return;

      console.log('[HAClient] Step 2: Requesting initial get_states snapshot...');
      const states = await this.send({ type: 'get_states' });
      if (token !== this.hydrationToken || socket !== this.ws) return;
      if (!Array.isArray(states)) throw new Error('Home Assistant get_states returned an invalid snapshot');

      this.statesMap.clear();
      for (const entity of states) {
        this.statesMap.set(entity.entity_id, entity);
        this.syncBrewfatherBatchData(entity);
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

      console.log(`[HAClient] Step 3: Replaying ${this.eventQueue.length} buffered queue events...`);
      this.eventQueue.sort((a, b) => this.stateTimestamp(a.new_state || {}) - this.stateTimestamp(b.new_state || {}));
      for (const eventData of this.eventQueue) {
        // Buffered events establish the final state, but are deliberately not
        // fed to the detector: old transport data must not manufacture pours.
        const existing = this.statesMap.get(eventData.entity_id);
        if (existing && this.stateTimestamp(eventData.new_state || {}) < this.stateTimestamp(existing)) continue;
        this.processStateUpdate(eventData, { ingestDetector: false, enqueueDisplay: false });
      }
      this.eventQueue = [];
      this.hydrationBytes = 0;
      if (token !== this.hydrationToken || socket !== this.ws) return;
      // Hydrate once from the final snapshot-plus-deltas state, without events.
      this.rehydrateDetectorFromCurrentPrimaries('hydrate');
      this.isHydrated = true;
      this.reconnectDelay = 1000;
      this.setConnectionState('connected');

      console.log('[HAClient] Sync complete! Live stream active.');
      this.emit('hydrated', this.getFormattedState());

    } catch (err) {
      console.error('[HAClient] Failed to complete sync sequence:', err.message);
      if (token === this.hydrationToken && socket === this.ws) {
        this.failSocket(socket, err, 'hydration_failure');
      }
    }
  }

  handleStateChangedEvent(data) {
    if (!this.isHydrated) {
      const bytes = Buffer.byteLength(JSON.stringify(data));
      if (this.eventQueue.length >= 512 || this.hydrationBytes + bytes > 1024 * 1024) {
        // A partial replay is worse than a fresh snapshot. Drop it all and
        // reconnect for a new subscription/snapshot generation.
        const socket = this.ws;
        this.eventQueue = [];
        this.hydrationBytes = 0;
        this.isHydrated = false;
        this.hydrationToken += 1;
        this.failSocket(socket, new Error('Hydration event buffer overflow'), 'hydration_overflow');
        return;
      }
      this.eventQueue.push(data);
      this.hydrationBytes += bytes;
    } else {
      this.processStateUpdate(data);
    }
  }

  processStateUpdate(data, { ingestDetector = true, enqueueDisplay = true } = {}) {
    const { entity_id, new_state } = data;
    if (!new_state) return;

    this.statesMap.set(entity_id, new_state);
    this.syncBrewfatherBatchData(new_state);

    // Apply 4-Stage Noise Filtering strictly to each tap's designated primary scale sensor
    for (let tapId = 1; ingestDetector && tapId <= 6; tapId++) {
      const primaryId = this.getPrimaryTapSensor(tapId);
      const previousPrimaryId = this.primaryTapSensors.get(tapId);
      if (previousPrimaryId && previousPrimaryId !== primaryId) {
        this.rehydrateDetectorFromCurrentPrimaries('source_change');
        break;
      }
      this.primaryTapSensors.set(tapId, primaryId);
      if (ingestDetector && entity_id === primaryId) {
        this.apply4StageNoiseFilter(tapId, new_state);
      }
    }

    // Detector ingestion remains synchronous above; browser telemetry is only queued afterwards.
    const displayChange = enqueueDisplay ? projectTapStateChange(entity_id, new_state) : null;
    if (displayChange) {
      this.displayUpdateCoalescer.enqueue({
        ...displayChange,
        timestamp: this.stateTimestamp(new_state)
      });
    }
  }

  stateTimestamp(stateObj) {
    const timestamp = Date.parse(stateObj.last_updated || stateObj.last_changed || '');
    return Number.isFinite(timestamp) ? timestamp : this.now();
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
      const lifecycle = this.captureLifecycle(event.tapId);
      const tapInfo = db.prepare('SELECT override_name FROM taps WHERE tap_id = ?').get(event.tapId);
      this.activePourContexts.set(event.tapId, {
        lifecycleId: lifecycle?.lifecycle_id ?? null,
        beerName: tapInfo?.override_name || `Tap ${event.tapId}`
      });
      console.log(`[POUR EVENT] 🍺 Tap ${event.tapId} POUR STARTED! Baseline: ${event.startVolume.toFixed(1)} oz`);
      this.emit('pour_start', { tapId: event.tapId, startVolume: event.startVolume });
      return;
    }
    if (event.type === 'cancel') {
      this.activePourContexts.delete(event.tapId);
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
      const context = this.activePourContexts.get(tapId) || { lifecycleId: null, beerName: `Tap ${tapId}` };
      this.recordPour({
        tapId,
        lifecycleId: context.lifecycleId,
        volumePouredOz: finalPouredOz,
        timestamp: event.timestamp
      });
      this.activePourContexts.delete(tapId);

      this.emit('pour_complete', {
        tapId,
        volumePouredOz: finalPouredOz,
        beerName: context.beerName,
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
    return this.getPublicTapStates();
  }

  getPublicTapStates() {
    return createTapStatesProjection(this.statesMap);
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
