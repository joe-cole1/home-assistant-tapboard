import { renderTapGraphic, srmToHex } from './graphics.js';
import { createLiveUpdateController, updateGraphicFill } from './liveUpdates.js';
import { buildOnDeckItems, buildTapCardContent, createSelectOption, createToast } from './domBuilders.js';
import { createBrewStoryController } from './brewStory.js';
import { shouldShowNewBadge } from './freshness.js';
import { createAutosaveController } from './autosave.js';
import { fitSingleLineText, formatVolumeReadout } from './cardPresentation.js';
import { createTickerAutoScroller } from './tickerScroll.js';
import {
  createCelebrationController,
  formatLifecycleLine,
  playCeremonySound,
  renderForecastDetails
} from './phase3Ui.js';
import { createTaproomStatusController, taproomHeaderBadgeText } from './taproomStatus.js';

let appState = {
  settings: {},
  taps: [],
  batches: [],
  onDeckBatches: [],
  customBeverage: null,
  tapStates: {},
  haConnected: true,
  kegKickForecasts: {},
  lifecycleMilestones: {},
  draftHealth: null,
  tapPlanning: null
};

let editingTapId = null;
let authToken = sessionStorage.getItem('tapboard_token') || null;
let liveUpdates;
let hasRenderedSnapshot = false;
let brewfatherStatusRequestId = 0;
let brewStory;
let celebration;
let tickerAutoScroller;
let taproomStatus;
let titleFitFrame = null;
const simulatedPourTimers = new Map();
const LONG_PRESS_MS = 600;
const SIMULATED_POUR_MS = 8000;
const THEME_COLORS = {
  modern_dark: { primary: '#FBC02D', secondary: '#38BDF8' },
  warm_pub: { primary: '#FBC02D', secondary: '#C5A880' },
  cyberpunk: { primary: '#FF007F', secondary: '#00F0FF' },
  light_minimal: { primary: '#D97706', secondary: '#2563EB' }
};
const displayPreferences = globalThis.TapboardDisplayPreferences;
const autosaveTimers = new Map();
const dirtyFields = new Set();
const autosaves = createAutosaveController({ onStatus: updateSaveStatus });

function getBrewStoryController() {
  if (brewStory) return brewStory;
  brewStory = createBrewStoryController({
    dialog: document.getElementById('recipeModal'),
    title: document.getElementById('recipeTitle'),
    body: document.getElementById('recipeBody'),
    status: document.getElementById('recipeStatus'),
    canEdit: () => Boolean(authToken),
    fetchStory: (id, windowName, signal, tapId) =>
      fetch(
        `/api/batches/${encodeURIComponent(id)}/story?window=${encodeURIComponent(windowName)}${tapId ? `&tap_id=${tapId}` : ''}`,
        {
          signal,
          ...(authToken ? { headers: authHeaders() } : {})
        }
      ),
    saveSensory: (id, payload) =>
      fetch(`/api/batches/${encodeURIComponent(id)}/sensory`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify(payload)
      })
  });
  return brewStory;
}

function getTapState(tapId) {
  return appState.tapStates[String(tapId)] || {};
}

function getBatchState(tapId) {
  const batch = getTapState(tapId).batch;
  return batch && typeof batch === 'object' ? batch : {};
}

function getBatchSelection(tapId) {
  const selection = getTapState(tapId).batchSelection;
  if (selection && typeof selection === 'object') return selection;
  return { value: selection || '', options: [] };
}

function scheduleTapUpdates(tapIds) {
  tapIds.forEach((tapId) => {
    const tap = appState.taps.find((item) => item.tap_id === Number(tapId));
    const card = document.querySelector(`.tap-card[data-tap-id="${tapId}"]`);
    if (tap && tap.enabled === 1 && card) updateTapCard(card, tap);
  });
}

liveUpdates = createLiveUpdateController({
  getState: () => appState,
  setState: (state) => {
    appState = state;
  },
  onDirty: scheduleTapUpdates,
  requestFrame: (callback) => requestAnimationFrame(callback)
});

function applyFullSnapshot(snapshot) {
  liveUpdates.replaceSnapshot(snapshot);
  hasRenderedSnapshot = true;
  updateClockStatus(appState.haConnected ? 'Live' : 'Disconnected');
  renderApp();
  refreshTaproomStatusUi();
}

function taproomCallbacks() {
  const actions = {
    acknowledge: async (check) => {
      if (!check?.incidentId) return;
      await postTaproom('/api/draft-health/acknowledge', {
        check_id: check.id,
        tap_id: check.tapId,
        incident_id: check.incidentId
      });
    },
    saveConfig: async () => {
      const checkId = prompt(
        'Health check ID: low_keg, scale_availability, suspected_leak, serving_temperature, or line_cleaning_due'
      );
      if (!checkId) return;
      const tapText = prompt('Tap number 1–6, or leave blank for the global default', '') ?? '';
      const enabled = confirm('Enable this health check?');
      const configText = prompt('Validated JSON configuration for this check', '{}');
      if (configText === null) return;
      await postTaproom('/api/draft-health/config', {
        check_id: checkId,
        tap_id: tapText.trim() ? Number(tapText) : null,
        enabled,
        config: JSON.parse(configText)
      });
    },
    recordMaintenance: async () => {
      const taps = prompt('Cleaned tap/line numbers, comma-separated', '1');
      if (!taps) return;
      const method = prompt('Cleaning method', 'Recirculated line cleaner');
      if (!method) return;
      const notes = prompt('Private maintenance notes (optional)', '') ?? '';
      await postTaproom('/api/maintenance', {
        completed_at: new Date().toISOString(),
        tap_ids: taps.split(',').map((value) => Number(value.trim())),
        method,
        notes,
        next_due_at: null
      });
    },
    saveReadiness: async () => {
      const batchId = prompt('Brewfather batch ID');
      if (!batchId) return;
      const earliest = prompt('Earliest serving date (YYYY-MM-DD), or leave blank', '') ?? '';
      const latest = earliest ? prompt('Latest serving date (YYYY-MM-DD)', earliest) : '';
      const capabilities = prompt(
        'Required capabilities, comma-separated: standard, nitro, high_carbonation, custom_non_beer',
        ''
      );
      await postTaproom(`/api/batches/${encodeURIComponent(batchId)}/readiness`, {
        earliest_date: earliest || null,
        latest_date: latest || null,
        confirmed: confirm('Confirm this scheduling range? This does not confirm physical keg inventory.'),
        required_capabilities: capabilities
          ? capabilities
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : []
      });
    },
    savePolicy: async () => {
      const conditioningMax = prompt('Maximum conditioning days', '14');
      if (conditioningMax === null) return;
      await postTaproom('/api/planning/policy', { conditioning_max_days: Number(conditioningMax) });
    },
    saveTapCapabilities: async () => {
      const tapId = prompt('Tap number 1–6');
      if (!tapId) return;
      const tap = appState.taps.find((item) => item.tap_id === Number(tapId));
      if (!tap) return;
      const capabilities = prompt(
        'Capabilities, comma-separated: standard, nitro, high_carbonation, custom_non_beer',
        (tap.capabilities || []).join(',')
      );
      if (capabilities === null) return;
      await postTaproom(`/api/taps/${tapId}`, {
        capabilities: capabilities
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      });
    }
  };
  return Object.fromEntries(
    Object.entries(actions).map(([key, action]) => [
      key,
      async (...args) => {
        try {
          return await action(...args);
        } catch (error) {
          alert(error?.message || 'Taproom update failed');
          return null;
        }
      }
    ])
  );
}

async function postTaproom(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Taproom update failed');
  if (result.draftHealth) appState.draftHealth = result.draftHealth;
  if (result.tapPlanning) appState.tapPlanning = result.tapPlanning;
  showToast('Taproom Status updated.');
  refreshTaproomStatusUi();
  return result;
}

function refreshTaproomStatusUi() {
  const badge = document.getElementById('taproomStatusBadge');
  if (badge) badge.textContent = taproomHeaderBadgeText(appState.draftHealth);
  const dialog = document.getElementById('taproomStatusDialog');
  if (!dialog) return;
  taproomStatus ||= createTaproomStatusController({ dialog });
  if (dialog.open) {
    taproomStatus.render({
      dialog,
      draftHealth: appState.draftHealth,
      tapPlanning: appState.tapPlanning,
      authenticated: Boolean(authToken),
      callbacks: taproomCallbacks()
    });
  }
}

function openTaproomStatus() {
  const dialog = document.getElementById('taproomStatusDialog');
  if (!dialog) return;
  taproomStatus ||= createTaproomStatusController({ dialog });
  taproomStatus.open({
    dialog,
    draftHealth: appState.draftHealth,
    tapPlanning: appState.tapPlanning,
    authenticated: Boolean(authToken),
    callbacks: taproomCallbacks()
  });
}

async function openKegeratorHealthModal() {
  if (!authToken) return;
  showModal('kegeratorHealthModal');
  try {
    const res = await fetch('/api/draft-health/config', {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    if (!res.ok) return;
    const data = await res.json();
    renderHealthOverview(data);

    const lowKegConfig = data.configs?.find((c) => c.check_id === 'low_keg' && c.tap_id === 0)?.config;
    if (lowKegConfig) {
      if (lowKegConfig.thresholdPercent !== undefined) {
        const warnEl = document.getElementById('globalLowKegWarningPct');
        if (warnEl) warnEl.value = lowKegConfig.thresholdPercent;
      }
      if (lowKegConfig.criticalPercent !== undefined) {
        const critEl = document.getElementById('globalLowKegCriticalPct');
        if (critEl) critEl.value = lowKegConfig.criticalPercent;
      }
    }

    const cleanConfig = data.configs?.find((c) => c.check_id === 'line_cleaning_due' && c.tap_id === 0)?.config;
    if (cleanConfig) {
      if (cleanConfig.intervalDays !== undefined) {
        const daysEl = document.getElementById('globalLineCleanDays');
        if (daysEl) daysEl.value = cleanConfig.intervalDays;
      }
      if (cleanConfig.intervalKegs !== undefined) {
        const kegsEl = document.getElementById('globalLineCleanKegs');
        if (kegsEl) kegsEl.value = cleanConfig.intervalKegs;
      }
    }

    const planRes = await fetch('/api/planning/config', {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
    });
    if (planRes.ok) {
      const planData = await planRes.json();
      if (planData.policy?.conditioning_max_days !== undefined) {
        const planEl = document.getElementById('globalTargetConditioningDays');
        if (planEl) planEl.value = planData.policy.conditioning_max_days;
      }
    }
  } catch (err) {
    console.warn('[Health Modal] Failed to load overview:', err);
  }
}

function renderHealthOverview(data) {
  const kpiGrid = document.getElementById('healthKpiGrid');
  if (kpiGrid) {
    kpiGrid.textContent = '';
    const records = data.maintenance || [];
    const kpis = [
      { label: 'Active Taps', value: '6', color: 'var(--accent-color)' },
      { label: 'System Health', value: 'Healthy', color: '#10b981' },
      { label: 'Line Cleaning Log', value: String(records.length), color: 'var(--text-primary)' }
    ];
    for (const item of kpis) {
      const card = document.createElement('div');
      card.style.cssText = 'background: var(--bg-header); border: 1px solid var(--border-color); padding: 1rem; border-radius: 0.5rem; text-align: center;';
      const label = document.createElement('div');
      label.style.cssText = 'font-size: 0.8rem; color: var(--text-muted);';
      label.textContent = item.label;
      const val = document.createElement('div');
      val.style.cssText = `font-size: 1.75rem; font-weight: bold; color: ${item.color};`;
      val.textContent = item.value;
      card.appendChild(label);
      card.appendChild(val);
      kpiGrid.appendChild(card);
    }
  }

  const timeline = document.getElementById('healthMaintenanceTimeline');
  if (timeline) {
    timeline.textContent = '';
    const records = data.maintenance || [];
    if (!records.length) {
      const p = document.createElement('p');
      p.style.cssText = 'font-size: 0.85rem; color: var(--text-muted); text-align: center;';
      p.textContent = 'No maintenance records found.';
      timeline.appendChild(p);
    } else {
      for (const r of records) {
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; justify-content: space-between; font-size: 0.85rem; padding: 0.4rem 0; border-bottom: 1px dashed var(--border-color);';
        const left = document.createElement('div');
        left.textContent = `Tap ${r.tap_ids?.join(', ') || 'All'} — ${r.method || 'Cleaned'}${r.notes ? ` (${r.notes})` : ''}`;
        const right = document.createElement('div');
        right.style.cssText = 'color: var(--text-muted);';
        right.textContent = new Date(r.completed_at).toLocaleDateString();
        item.appendChild(left);
        item.appendChild(right);
        timeline.appendChild(item);
      }
    }
  }
}

async function loadInitialSnapshot() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Unable to load Tapboard state');
    const snapshot = await response.json();
    if (!hasRenderedSnapshot) applyFullSnapshot(snapshot);
  } catch (error) {
    console.warn('[State] Initial snapshot fallback failed:', error);
  }
}

function updateAuthUI() {
  if (authToken) {
    document.body.classList.add('is-authenticated');
  } else {
    document.body.classList.remove('is-authenticated');
  }
  refreshTaproomStatusUi();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateAuthUI);
} else {
  updateAuthUI();
}

// Intelligent Beer Style Parser Fallback
function deriveBeerStyle(beerName, rawStyle) {
  if (rawStyle && rawStyle !== 'Craft Beer' && rawStyle.trim() !== '') {
    return rawStyle;
  }
  if (!beerName) return 'Craft Beer';

  const lower = beerName.toLowerCase();
  if (lower.includes('porter')) return 'Porter';
  if (lower.includes('stout')) return 'Stout';
  if (lower.includes('wit') || lower.includes('wheat')) return 'Witbier';
  if (lower.includes('oktoberfest') || lower.includes('märzen') || lower.includes('marzen')) return 'Oktoberfest';
  if (lower.includes('helles')) return 'Munich Helles';
  if (lower.includes('amber lager') || lower.includes('amber')) return 'Amber Lager';
  if (lower.includes('lager')) return 'Lager';
  if (lower.includes('hazy') || lower.includes('ipa')) return 'Hazy IPA';
  if (lower.includes('pilsner') || lower.includes('pils')) return 'Pilsner';
  if (lower.includes('pale ale')) return 'Pale Ale';
  if (lower.includes('cider')) return 'Hard Cider';
  if (lower.includes('water') || lower.includes('seltzer')) return 'Sparkling Water';

  return 'Craft Beer';
}

function customBeverageMatchesTap(tapId, tap) {
  const custom = appState.customBeverage;
  if (!custom) return false;
  const selected = getBatchSelection(tapId).value || tap.batch_id || '';
  const option = custom.assignmentOption || custom.assignment_option || custom.batch_option || '';
  const identity = custom.batch_id || custom.id || '';
  return Boolean(selected && (selected === option || selected === identity || selected.includes(identity)));
}

function customBeverageForTap(tapId, tap) {
  return customBeverageMatchesTap(tapId, tap) ? appState.customBeverage : null;
}

// Connect to Server-Sent Events (SSE) Stream
function initSSE() {
  const eventSource = new EventSource('/events');

  eventSource.onopen = () => {
    console.log('[SSE] Live stream connected.');
    updateClockStatus(appState.haConnected ? 'Live' : 'Disconnected');
  };

  eventSource.onerror = (err) => {
    console.warn('[SSE] Connection error/reconnecting...', err);
    updateClockStatus('Disconnected');
  };

  // 1. Initial Snapshot
  eventSource.addEventListener('snapshot', (e) => {
    applyFullSnapshot(JSON.parse(e.data));
  });

  // 2. HA Connection Status Change
  eventSource.addEventListener('ha_connection_status', (e) => {
    const { isConnected } = JSON.parse(e.data);
    appState.haConnected = isConnected;
    updateClockStatus(isConnected ? 'Live' : 'Disconnected');
  });

  // 3. HA State Changed
  eventSource.addEventListener('state_changed', (e) => {
    liveUpdates.applyStateChanged(JSON.parse(e.data));
  });

  eventSource.addEventListener('health_updated', (e) => {
    appState.draftHealth = JSON.parse(e.data);
    refreshTaproomStatusUi();
    scheduleTapUpdates(new Set(['1', '2', '3', '4', '5', '6']));
  });

  eventSource.addEventListener('planning_updated', (e) => {
    appState.tapPlanning = JSON.parse(e.data);
    refreshTaproomStatusUi();
    scheduleTapUpdates(new Set(['1', '2', '3', '4', '5', '6']));
  });

  // 4. Instant Pour Animation Start
  eventSource.addEventListener('pour_start', (e) => {
    const { tapId } = JSON.parse(e.data);
    console.log(`[Pour Start] Animating Tap ${tapId}`);
    setTapPouringAnimation(tapId, true);
  });

  // 5. Pour completion updates the forecast; durable receipts own the UI notice.
  eventSource.addEventListener('pour_complete', (e) => {
    const { tapId, kegKickForecast } = JSON.parse(e.data);
    setTapPouringAnimation(tapId, false);
    if (kegKickForecast) {
      appState = {
        ...appState,
        kegKickForecasts: {
          ...appState.kegKickForecasts,
          [tapId]: kegKickForecast
        }
      };
      scheduleTapUpdates(new Set([String(tapId)]));
    }
  });

  eventSource.addEventListener('pour_receipt', (e) => celebration?.receipt(JSON.parse(e.data)));
  eventSource.addEventListener('pour_receipt_updated', (e) => celebration?.receiptUpdated(JSON.parse(e.data)));
  eventSource.addEventListener('first_pour', (e) => celebration?.firstPour(JSON.parse(e.data)));
  eventSource.addEventListener('keg_kicked', (e) => {
    const event = JSON.parse(e.data);
    appState.lifecycleMilestones = {
      ...appState.lifecycleMilestones,
      [event.tapId]: {
        ...(appState.lifecycleMilestones?.[event.tapId] || {}),
        lifecycleId: event.lifecycleId,
        kickedAt: event.kickedAt,
        kickTrigger: event.trigger
      }
    };
    celebration?.kegKicked(event);
    scheduleTapUpdates(new Set([String(event.tapId)]));
  });

  // 6. Canceled Pour (rebound, disconnect, large change, or safety timeout)
  eventSource.addEventListener('pour_cancel', (e) => {
    const { tapId } = JSON.parse(e.data);
    setTapPouringAnimation(tapId, false);
  });

  // 7. Low Keg Alert
  eventSource.addEventListener('low_keg_alert', (e) => {
    const { tapId, currentPercent } = JSON.parse(e.data);
    showToast(`⚠️ Low Keg Warning: Tap ${tapId} at ${currentPercent}%!`);
  });

  // 8. Settings Updated
  eventSource.addEventListener('settings_updated', (e) => {
    applyFullSnapshot(JSON.parse(e.data));
  });

  eventSource.addEventListener('brewfather_batches_changed', (e) => {
    applyFullSnapshot(JSON.parse(e.data));
    if (isGlobalSettingsOpen()) loadBrewfatherStatus();
  });
}

function updateClockStatus(text) {
  const clockEl = document.getElementById('headerClock');
  const statusBadge = document.getElementById('liveStatusBadge');
  if (clockEl) {
    if (text.includes('Disconnected') || text.includes('Reconnecting') || text.includes('Offline')) {
      clockEl.textContent = 'Disconnected';
      clockEl.style.color = '#ffa726';
      statusBadge?.setAttribute('aria-label', 'Connection status: Disconnected');
    } else {
      clockEl.textContent = 'Live';
      clockEl.style.color = '';
      statusBadge?.setAttribute('aria-label', 'Connection status: Live');
    }
  }
}

// Show Toast Notification
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = createToast(message);

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s ease';
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// Toggle CodePen 8-Second Filling & Active Pour Visual Effect on Tap Card
function setTapPouringAnimation(tapId, isPouring) {
  const card = document.querySelector(`.tap-card[data-tap-id="${tapId}"]`);
  if (!card) return;

  const colorHex = card.getAttribute('data-color-hex') || '#FBC02D';
  const srmColor = colorHex === 'WATER' ? '#E0F7FA' : colorHex;
  card.style.setProperty('--beer-srm-color', srmColor);

  const streamGroup = card.querySelector('.pour-stream-group');
  const liquidRects = card.querySelectorAll('.beer-liquid-rect, .beer-liquid-shadow');
  const foamGroup = card.querySelector('.beer-cloud-foam');

  // Read untransformed SVG base Y coordinate for foam head
  const svgEl = card.querySelector('.tap-graphic-svg');
  const bottomY = svgEl ? parseFloat(svgEl.getAttribute('data-bottom-y')) || 220 : 220;
  const topRimY = svgEl ? parseFloat(svgEl.getAttribute('data-top-rim-y')) || 55 : 55;
  const fullHeight = bottomY - topRimY;

  const baseY = foamGroup ? parseFloat(foamGroup.getAttribute('data-base-y')) || bottomY : bottomY;

  if (isPouring) {
    card.classList.remove('is-settling');
    card.classList.add('is-pouring');

    if (streamGroup) streamGroup.classList.add('is-active');

    // 1. Snap to empty (0% fill at bottomY) without transition
    card.classList.add('no-anim');

    liquidRects.forEach((r) => {
      r.setAttribute('y', bottomY);
      r.setAttribute('height', 0);
    });
    if (foamGroup) {
      foamGroup.style.transform = `translateY(${bottomY - baseY}px)`;
    }

    // 2. Force DOM reflow
    void card.offsetHeight;

    // 3. Re-enable 8s transition and fill to 100% full
    card.classList.remove('no-anim');
    requestAnimationFrame(() => {
      liquidRects.forEach((r) => {
        r.setAttribute('y', topRimY);
        r.setAttribute('height', fullHeight);
      });
      if (foamGroup) {
        foamGroup.style.transform = `translateY(${topRimY - baseY}px)`;
      }
    });
  } else {
    // Pour Complete: Stream stops & calm 2s settle back to actual remaining keg volume
    if (streamGroup) streamGroup.classList.remove('is-active');

    card.classList.add('is-settling');

    // Calculate target Y & height for real remaining keg percentage
    const parsedFill = parseFloat(getTapState(tapId).fillPercent);
    const fillPct = Math.min(100, Math.max(0, isNaN(parsedFill) ? 0 : parsedFill));
    const targetY = bottomY - (fillPct / 100) * fullHeight;
    const targetHeight = bottomY - targetY;

    liquidRects.forEach((r) => {
      r.setAttribute('y', targetY);
      r.setAttribute('height', targetHeight);
    });
    if (foamGroup) {
      foamGroup.style.transform = `translateY(${targetY - baseY}px)`;
    }

    // After 2.0s settle animation completes, return card to standard state
    setTimeout(() => {
      card.classList.remove('is-pouring');
      card.classList.remove('is-settling');
    }, 2000);
  }
}

function simulatePour(tapId) {
  if (!authToken) return;

  const existingTimer = simulatedPourTimers.get(tapId);
  if (existingTimer) clearTimeout(existingTimer);

  setTapPouringAnimation(tapId, true);
  showToast(`🍺 Simulating a pour on Tap ${tapId}`);

  const timer = setTimeout(() => {
    setTapPouringAnimation(tapId, false);
    simulatedPourTimers.delete(tapId);
  }, SIMULATED_POUR_MS);
  simulatedPourTimers.set(tapId, timer);
}

function addAdminLongPress(card, tapId) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let suppressClickUntil = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  card.addEventListener('pointerdown', (event) => {
    if (
      !authToken ||
      (event.button !== undefined && event.button !== 0) ||
      event.target.closest('button, input, select, textarea, label')
    )
      return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 1000;
      simulatePour(tapId);
    }, LONG_PRESS_MS);
  });

  card.addEventListener('pointermove', (event) => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointercancel', cancel);
  card.addEventListener('pointerleave', cancel);
  card.addEventListener('contextmenu', (event) => {
    if (authToken) event.preventDefault();
  });

  return () => Date.now() < suppressClickUntil;
}

// Helper: Format Volume Readout based on Per-Tap Display Setting
function getMeasurementView(tapState) {
  const volumeStatus = tapState.volumeStatus || 'unavailable';
  const volumeOz = Number(tapState.volumeOz);
  const fillPercent = Number(tapState.fillPercent);
  const pintsRemaining =
    tapState.pintsRemaining === null || tapState.pintsRemaining === undefined ? null : Number(tapState.pintsRemaining);
  const available = volumeStatus !== 'unavailable' && Number.isFinite(volumeOz) && Number.isFinite(fillPercent);

  return {
    volumeStatus,
    volumeOz,
    fillPercent,
    pintsRemaining,
    available,
    graphicFillPercent: available ? Math.min(100, Math.max(0, fillPercent)) : 0
  };
}

function volumeStatusText(status) {
  if (status === 'stale') return 'Stale measurement';
  if (status === 'unavailable') return 'Unavailable';
  return '';
}

function scheduleTitleFits() {
  if (titleFitFrame !== null) return;
  titleFitFrame = requestAnimationFrame(() => {
    titleFitFrame = null;
    document.querySelectorAll('.tap-card .beer-title').forEach((title) => fitSingleLineText(title));
  });
}

function updatePhase4Badges(card, tapId) {
  const badges = card.querySelector('.tap-card-badges');
  if (!badges) return;
  const healthBadge = badges.querySelector('.badge-health');
  healthBadge?.remove();
  const gapBadge = badges.querySelector('.badge-gap');
  gapBadge?.remove();
}

// Main Render Function with In-Place Targeted DOM Preservation
function renderApp() {
  const { taps } = appState;
  applySettingsPreview();

  const tapGrid = document.getElementById('tapGrid');
  if (!tapGrid) return;

  const activeTaps = taps.filter((t) => t.enabled === 1);
  const activeTapIds = new Set(activeTaps.map((t) => t.tap_id));
  tapGrid.setAttribute('data-count', activeTaps.length);

  // 1. Remove cards for disabled/hidden taps
  Array.from(tapGrid.querySelectorAll('.tap-card')).forEach((card) => {
    const tapId = parseInt(card.getAttribute('data-tap-id'), 10);
    if (!activeTapIds.has(tapId)) {
      card.remove();
    }
  });

  // 2. Add or update active tap cards in-place
  activeTaps.forEach((tap) => {
    const existingCard = tapGrid.querySelector(`.tap-card[data-tap-id="${tap.tap_id}"]`);
    if (existingCard) {
      updateTapCard(existingCard, tap);
    } else {
      const card = createTapCard(tap);
      tapGrid.appendChild(card);
    }
  });

  // Render On-Deck Ticker
  renderOnDeckTicker();
  scheduleTitleFits();
}

// Create Tap Card Element (Initial creation)
function createTapCard(tap) {
  const tapId = tap.tap_id;
  const tapState = getTapState(tapId);
  const batchAttr = getBatchState(tapId);

  // Recipe lookup hierarchy: Tapboard overrides -> native cached assignment.
  const cachedBatch =
    tap.batch_id && appState.batches ? appState.batches.find((b) => b.batch_id === tap.batch_id) : null;
  const customBeverage = customBeverageForTap(tapId, tap);

  const measurement = getMeasurementView(tapState);
  const fillPercent = measurement.graphicFillPercent;

  const bfName =
    customBeverage?.name || batchAttr.recipeName || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = customBeverage?.style || batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = customBeverage?.abv ?? batchAttr.abv ?? cachedBatch?.abv ?? '--';
  const bfIbu = customBeverage?.ibu ?? batchAttr.ibu ?? cachedBatch?.ibu ?? '--';
  const bfOg = customBeverage?.og ?? batchAttr.og ?? cachedBatch?.og ?? '--';
  const bfFg = customBeverage?.fg ?? batchAttr.fg ?? cachedBatch?.fg ?? '--';
  const bfSrm = customBeverage?.srm ?? batchAttr.srm ?? cachedBatch?.srm ?? 3;
  const bfDesc =
    customBeverage?.description || batchAttr.description || (cachedBatch ? cachedBatch.description : null) || '';

  const hasOverride = tap.override_enabled === 1;
  const beerName = hasOverride && tap.override_name && tap.override_name.trim() !== '' ? tap.override_name : bfName;
  const style = hasOverride && tap.override_style && tap.override_style.trim() !== '' ? tap.override_style : bfStyle;

  const isWaterOrSeltzer =
    beerName.toLowerCase().includes('water') ||
    style.toLowerCase().includes('water') ||
    style.toLowerCase().includes('seltzer') ||
    bfSrm === 0 ||
    (hasOverride && tap.override_srm === 0);

  const abv = isWaterOrSeltzer
    ? '0.0%'
    : hasOverride && tap.override_abv !== null && tap.override_abv !== undefined && tap.override_abv !== ''
      ? `${tap.override_abv}%`
      : bfAbv !== '--'
        ? `${bfAbv}%`
        : '--';
  const ibu = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_ibu !== null && tap.override_ibu !== undefined && tap.override_ibu !== ''
      ? tap.override_ibu
      : bfIbu;
  const og = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_og !== null && tap.override_og !== undefined && tap.override_og !== ''
      ? tap.override_og
      : bfOg;
  const fg = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_fg !== null && tap.override_fg !== undefined && tap.override_fg !== ''
      ? tap.override_fg
      : bfFg;
  const srm = isWaterOrSeltzer
    ? 0
    : hasOverride && tap.override_srm !== null && tap.override_srm !== undefined && tap.override_srm !== ''
      ? tap.override_srm
      : bfSrm;
  const description =
    hasOverride && tap.override_description && tap.override_description.trim() !== ''
      ? tap.override_description
      : bfDesc;

  const beerColorHex = isWaterOrSeltzer ? 'WATER' : srmToHex(srm);

  const forecast = appState.kegKickForecasts[tapId] || {};
  const milestone = appState.lifecycleMilestones?.[tapId] || {};
  const forecastText = formatLifecycleLine(forecast, milestone);
  const volumeReadoutText = formatVolumeReadout(tap, measurement);

  const card = document.createElement('div');
  card.className = 'tap-card';
  card.setAttribute('data-tap-id', tapId);
  card.setAttribute('data-graphic-style', tap.graphic || 'corny_keg');
  card.setAttribute('data-color-hex', beerColorHex);

  card.replaceChildren(
    buildTapCardContent({
      tapId,
      fillPercent,
      volumeStatus: measurement.volumeStatus,
      fresh: shouldShowNewBadge(tap),
      lowThreshold: measurement.volumeStatus === 'measured' && tap.badge_low_keg > 0 ? tap.badge_low_keg : null,
      beerName,
      style,
      description,
      abv,
      ibu,
      og,
      fg,
      volumeReadoutText,
      forecastText,
      kicked: Boolean(milestone.kickedAt)
    })
  );

  // Render SVG Graphic initially
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  if (graphicContainer && typeof renderTapGraphic === 'function') {
    graphicContainer.innerHTML = renderTapGraphic(
      tap.graphic || 'corny_keg',
      fillPercent,
      beerColorHex,
      false,
      `tap_${tapId}`
    );
  }
  updatePhase4Badges(card, tapId);

  // Cog Button Click: Open Per-Tap Settings
  const cogBtn = card.querySelector('.tap-cog-btn');
  if (cogBtn) {
    cogBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (authToken) {
        openTapSettings(tapId);
      } else {
        editingTapId = tapId;
        openPinModal();
      }
    });
  }

  const wasLongPress = addAdminLongPress(card, tapId);
  const storyBtn = card.querySelector('.tap-story-btn');
  storyBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    openRecipeModal(tapId);
  });
  card.querySelector('.lifecycle-forecast-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    openForecastDialog(forecast, milestone);
  });

  // Card Body Click: Open Recipe Detail Modal
  card.addEventListener('click', (event) => {
    if (wasLongPress()) {
      event.preventDefault();
      return;
    }
    openRecipeModal(tapId);
  });

  return card;
}

// In-Place Update for existing Tap Card element
function updateTapCard(card, tap) {
  const tapId = tap.tap_id;
  const tapState = getTapState(tapId);
  const batchAttr = getBatchState(tapId);

  // 3-Tier Recipe Lookup Hierarchy (Overrides -> HA Attributes -> Local Batches Cache)
  const cachedBatch =
    tap.batch_id && appState.batches ? appState.batches.find((b) => b.batch_id === tap.batch_id) : null;
  const customBeverage = customBeverageForTap(tapId, tap);

  const measurement = getMeasurementView(tapState);
  const fillPercent = measurement.graphicFillPercent;

  const bfName =
    customBeverage?.name || batchAttr.recipeName || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = customBeverage?.style || batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = customBeverage?.abv ?? batchAttr.abv ?? cachedBatch?.abv ?? '--';
  const bfIbu = customBeverage?.ibu ?? batchAttr.ibu ?? cachedBatch?.ibu ?? '--';
  const bfOg = customBeverage?.og ?? batchAttr.og ?? cachedBatch?.og ?? '--';
  const bfFg = customBeverage?.fg ?? batchAttr.fg ?? cachedBatch?.fg ?? '--';
  const bfSrm = customBeverage?.srm ?? batchAttr.srm ?? cachedBatch?.srm ?? 3;

  const hasOverride = tap.override_enabled === 1;
  const beerName = hasOverride && tap.override_name && tap.override_name.trim() !== '' ? tap.override_name : bfName;
  const style = hasOverride && tap.override_style && tap.override_style.trim() !== '' ? tap.override_style : bfStyle;

  const isWaterOrSeltzer =
    beerName.toLowerCase().includes('water') ||
    style.toLowerCase().includes('water') ||
    style.toLowerCase().includes('seltzer') ||
    bfSrm === 0 ||
    (hasOverride && tap.override_srm === 0);

  const abv = isWaterOrSeltzer
    ? '0.0%'
    : hasOverride && tap.override_abv !== null && tap.override_abv !== undefined && tap.override_abv !== ''
      ? `${tap.override_abv}%`
      : bfAbv !== '--'
        ? `${bfAbv}%`
        : '--';
  const ibu = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_ibu !== null && tap.override_ibu !== undefined && tap.override_ibu !== ''
      ? tap.override_ibu
      : bfIbu;
  const og = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_og !== null && tap.override_og !== undefined && tap.override_og !== ''
      ? tap.override_og
      : bfOg;
  const fg = isWaterOrSeltzer
    ? '-'
    : hasOverride && tap.override_fg !== null && tap.override_fg !== undefined && tap.override_fg !== ''
      ? tap.override_fg
      : bfFg;
  const srm = isWaterOrSeltzer
    ? 0
    : hasOverride && tap.override_srm !== null && tap.override_srm !== undefined && tap.override_srm !== ''
      ? tap.override_srm
      : bfSrm;
  const beerColorHex = isWaterOrSeltzer ? 'WATER' : srmToHex(srm);

  const forecast = appState.kegKickForecasts[tapId] || {};
  const milestone = appState.lifecycleMilestones?.[tapId] || {};
  const forecastText = formatLifecycleLine(forecast, milestone);
  const newVolText = formatVolumeReadout(tap, measurement);

  // Update text content in-place
  const titleEl = card.querySelector('.beer-title');
  if (titleEl && titleEl.textContent !== beerName) titleEl.textContent = beerName;
  if (titleEl) titleEl.title = beerName;
  titleEl?.setAttribute('aria-label', `Open Brew Story for ${beerName}`);

  const styleEl = card.querySelector('.beer-style');
  if (styleEl && styleEl.textContent !== style) styleEl.textContent = style;
  if (styleEl) styleEl.title = style;

  let descriptionEl = card.querySelector('.beer-description');
  const description =
    hasOverride && tap.override_description && tap.override_description.trim() !== ''
      ? tap.override_description
      : customBeverage?.description || batchAttr.description || (cachedBatch ? cachedBatch.description : null) || '';
  if (description && !descriptionEl) {
    descriptionEl = document.createElement('p');
    descriptionEl.className = 'beer-description';
    card.querySelector('.metrics-row')?.before(descriptionEl);
  }
  if (descriptionEl) {
    descriptionEl.textContent = description;
    descriptionEl.hidden = !description;
  }

  const badges = card.querySelector('.tap-card-badges');
  if (badges) {
    let lowBadge = badges.querySelector('.badge-low');
    const isLow = measurement.volumeStatus === 'measured' && tap.badge_low_keg > 0 && fillPercent <= tap.badge_low_keg;
    if (isLow && !lowBadge) {
      lowBadge = document.createElement('span');
      lowBadge.className = 'badge badge-low';
      lowBadge.textContent = 'LOW KEG!';
      badges.prepend(lowBadge);
    } else if (!isLow && lowBadge) {
      lowBadge.remove();
    }

    let newBadge = badges.querySelector('.badge-fresh');
    const isNew = shouldShowNewBadge(tap);
    if (isNew && !newBadge) {
      newBadge = document.createElement('span');
      newBadge.className = 'badge badge-fresh';
      newBadge.textContent = 'NEW';
      badges.appendChild(newBadge);
    } else if (!isNew && newBadge) {
      newBadge.remove();
    }

    let sensorBadge = badges.querySelector('.badge-sensor-problem');
    const hasSensorProblem = measurement.volumeStatus === 'assumed_full';
    if (hasSensorProblem && !sensorBadge) {
      sensorBadge = document.createElement('span');
      sensorBadge.className = 'badge badge-sensor-problem';
      sensorBadge.textContent = '!';
      sensorBadge.setAttribute('role', 'img');
      sensorBadge.setAttribute('aria-label', 'Sensor problem');
      badges.appendChild(sensorBadge);
    } else if (!hasSensorProblem && sensorBadge) {
      sensorBadge.remove();
    }
  }
  updatePhase4Badges(card, tapId);

  const metrics = card.querySelectorAll('.metric-value');
  if (metrics.length >= 4) {
    if (metrics[0].textContent !== abv) metrics[0].textContent = abv;
    if (metrics[1].textContent !== String(ibu)) metrics[1].textContent = ibu;
    if (metrics[2].textContent !== String(og)) metrics[2].textContent = og;
    if (metrics[3].textContent !== String(fg)) metrics[3].textContent = fg;
  }

  const volReadout = card.querySelector('.volume-readout');
  if (volReadout && volReadout.textContent !== newVolText) {
    volReadout.textContent = newVolText;
  }

  const volumeStatusEl = card.querySelector('.volume-status');
  const statusText = volumeStatusText(measurement.volumeStatus);
  if (volumeStatusEl) {
    volumeStatusEl.textContent = statusText;
    volumeStatusEl.hidden = !statusText;
    volumeStatusEl.className = `volume-status volume-status-${measurement.volumeStatus}`;
  }

  const forecastEl = card.querySelector('.forecast-readout');
  if (forecastEl) {
    if (forecastEl.textContent !== forecastText) forecastEl.textContent = forecastText;
    forecastEl.hidden = !forecastText;
    forecastEl.setAttribute('aria-label', `${forecastText}. Open forecast details.`);
  }

  scheduleTitleFits();

  let kickedBadge = badges?.querySelector('.badge-kicked');
  if (milestone.kickedAt && !kickedBadge) {
    kickedBadge = document.createElement('span');
    kickedBadge.className = 'badge badge-kicked';
    kickedBadge.textContent = 'KICKED';
    badges?.appendChild(kickedBadge);
  } else if (!milestone.kickedAt) kickedBadge?.remove();

  // Numeric telemetry mutates the existing SVG so carbonation nodes keep animating.
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  const currentGraphicStyle = card.getAttribute('data-graphic-style');
  const currentColorHex = card.getAttribute('data-color-hex');

  if (
    !graphicContainer.firstChild ||
    currentGraphicStyle !== (tap.graphic || 'corny_keg') ||
    currentColorHex !== beerColorHex
  ) {
    card.setAttribute('data-graphic-style', tap.graphic || 'corny_keg');
    card.setAttribute('data-color-hex', beerColorHex);
    graphicContainer.innerHTML = renderTapGraphic(
      tap.graphic || 'corny_keg',
      fillPercent,
      beerColorHex,
      false,
      `tap_${tapId}`
    );
  } else {
    updateGraphicFill(card, fillPercent);
  }
}

// Open Recipe Detail Modal
function openRecipeModal(tapId) {
  const modal = document.getElementById('recipeModal');
  const title = document.getElementById('recipeTitle');
  const body = document.getElementById('recipeBody');

  if (!modal || !title || !body) return;

  const tap = appState.taps.find((item) => item.tap_id === tapId) || {};
  const batchAttr = getBatchState(tapId);
  const cachedBatch = tap.batch_id ? appState.batches.find((batch) => batch.batch_id === tap.batch_id) : null;
  const customBeverage = customBeverageForTap(tapId, tap);
  const hasOverride = tap.override_enabled === 1;
  const beerName =
    (hasOverride && tap.override_name) ||
    customBeverage?.name ||
    batchAttr.recipeName ||
    cachedBatch?.recipe_name ||
    `Tap ${tapId}`;
  const style =
    (hasOverride && tap.override_style) ||
    deriveBeerStyle(beerName, customBeverage?.style || batchAttr.style || cachedBatch?.style || 'Craft Beer');
  const projectedSrm = customBeverage?.srm ?? batchAttr.srm ?? cachedBatch?.srm ?? 3;
  const isWater =
    beerName.toLowerCase().includes('water') ||
    style.toLowerCase().includes('water') ||
    style.toLowerCase().includes('seltzer') ||
    projectedSrm === 0 ||
    (hasOverride && tap.override_srm === 0);
  const batchAbv = customBeverage?.abv ?? batchAttr.abv ?? cachedBatch?.abv;
  const abv = isWater
    ? '0.0%'
    : hasOverride && tap.override_abv !== '' && tap.override_abv !== null && tap.override_abv !== undefined
      ? `${tap.override_abv}%`
      : batchAbv !== null && batchAbv !== undefined
        ? `${batchAbv}%`
        : '--';
  const ibu = isWater
    ? '-'
    : hasOverride && tap.override_ibu !== '' && tap.override_ibu !== null && tap.override_ibu !== undefined
      ? tap.override_ibu
      : (customBeverage?.ibu ?? batchAttr.ibu ?? cachedBatch?.ibu ?? '--');
  const og = isWater
    ? '-'
    : hasOverride && tap.override_og !== '' && tap.override_og !== null && tap.override_og !== undefined
      ? tap.override_og
      : (customBeverage?.og ?? batchAttr.og ?? cachedBatch?.og ?? '--');
  const fg = isWater
    ? '-'
    : hasOverride && tap.override_fg !== '' && tap.override_fg !== null && tap.override_fg !== undefined
      ? tap.override_fg
      : (customBeverage?.fg ?? batchAttr.fg ?? cachedBatch?.fg ?? '--');
  const srm = isWater
    ? 0
    : hasOverride && tap.override_srm !== '' && tap.override_srm !== null && tap.override_srm !== undefined
      ? tap.override_srm
      : projectedSrm;
  const description =
    (hasOverride && tap.override_description) ||
    customBeverage?.description ||
    batchAttr.description ||
    cachedBatch?.description ||
    '';

  const batchId = customBeverage ? null : tap.batch_id || cachedBatch?.batch_id;
  const fallback = { style, abv, ibu, srm, og, fg, description };
  // Custom and local overrides have no authoritative Brewfather batch; keep their useful local detail.
  getBrewStoryController().open({ batchId, tapId, title: beerName, fallback });
}

function openForecastDialog(forecast, milestone) {
  if (!forecast?.lifecycle?.startedAt) return;
  renderForecastDetails({
    title: document.getElementById('forecastDialogTitle'),
    body: document.getElementById('forecastDialogBody'),
    forecast,
    milestone
  });
  showModal('forecastDialog');
}

function syncDisplaySettingsControls() {
  const displaySettings = effectiveDisplaySettings();

  if (displaySettings.theme) document.getElementById('themeSelect').value = displaySettings.theme;
  if (displaySettings.font_title) document.getElementById('titleFontSelect').value = displaySettings.font_title;
  if (displaySettings.font_body) document.getElementById('bodyFontSelect').value = displaySettings.font_body;
  document.getElementById('layoutModeSelect').value = displaySettings.layout_mode === 'compact' ? 'compact' : 'cozy';

  const colors = currentThemeColors(displaySettings);
  [
    ['primary', 'primaryColorPicker', 'primaryColorInput'],
    ['secondary', 'secondaryColorPicker', 'secondaryColorInput']
  ].forEach(([name, pickerId, hexId]) => {
    const value = colors[name];
    const picker = document.getElementById(pickerId);
    const hex = document.getElementById(hexId);
    if (picker) picker.value = value;
    if (hex) hex.value = value;
  });
  updateFontPreviews();
}

function isGlobalSettingsOpen() {
  const modal = document.getElementById('globalSettingsModal');
  return Boolean(modal?.open || modal?.style.display === 'flex');
}

function formatBrewfatherTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function renderBrewfatherStatus(status) {
  const connection = document.getElementById('brewfatherConnectionStatus');
  const cache = document.getElementById('brewfatherCacheStatus');
  const lastSuccess = document.getElementById('brewfatherLastSuccess');
  if (!connection || !cache || !lastSuccess) return;

  const configured = status?.configured === true;
  const syncStatus = typeof status?.status === 'string' ? status.status : 'never';
  const cacheStatus = ['empty', 'current', 'stale', 'refreshing'].includes(status?.cache_status)
    ? status.cache_status
    : status?.stale === true || syncStatus === 'stale_cache'
      ? 'stale'
      : syncStatus === 'ok'
        ? 'current'
        : 'empty';
  const hasCache = status?.has_cache === true;
  const errorCategory = typeof status?.error_category === 'string' ? status.error_category : '';
  const rawTimestamp = typeof status?.last_success_at === 'string' ? status.last_success_at : '';
  const formattedTimestamp = formatBrewfatherTimestamp(rawTimestamp);

  if (!configured) {
    connection.textContent = 'Not configured';
    connection.dataset.state = 'not-configured';
  } else if (syncStatus === 'ok') {
    connection.textContent = 'Connected — last synchronization succeeded';
    connection.dataset.state = 'connected';
  } else if (syncStatus === 'running') {
    connection.textContent = 'Synchronizing — refresh in progress';
    connection.dataset.state = 'running';
  } else if (syncStatus === 'never') {
    connection.textContent = 'Never connected — no successful synchronization yet';
    connection.dataset.state = 'never';
  } else {
    connection.textContent = `Last synchronization failed${errorCategory ? ` (${errorCategory})` : ''}`;
    connection.dataset.state = 'error';
  }

  const cacheStates = {
    empty: ['No synced data', 'never'],
    current: ['Current', 'current'],
    stale: [hasCache ? 'Stale — using cached data' : 'Stale', 'stale'],
    refreshing: [hasCache ? 'Cached data — refresh in progress' : 'Refresh in progress', 'running']
  };
  [cache.textContent, cache.dataset.state] = cacheStates[cacheStatus];

  lastSuccess.textContent = formattedTimestamp || 'Not available';
  lastSuccess.setAttribute('datetime', formattedTimestamp ? rawTimestamp : '');
}

async function loadBrewfatherStatus() {
  const feedback = document.getElementById('brewfatherRefreshStatus');
  const requestId = ++brewfatherStatusRequestId;
  try {
    const response = await fetch('/api/brewfather/status', { headers: authHeaders() });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load Brewfather status');
    if (!payload.brewfather || typeof payload.brewfather !== 'object') {
      throw new Error('Brewfather status was unavailable');
    }
    if (requestId === brewfatherStatusRequestId && isGlobalSettingsOpen()) {
      renderBrewfatherStatus(payload.brewfather);
      if (feedback?.dataset.source === 'status-load') {
        feedback.textContent = '';
        delete feedback.dataset.state;
        delete feedback.dataset.source;
      }
    }
  } catch (error) {
    if (requestId !== brewfatherStatusRequestId || !isGlobalSettingsOpen() || !feedback) return;
    feedback.textContent = error.message || 'Unable to load Brewfather status.';
    feedback.dataset.state = 'error';
    feedback.dataset.source = 'status-load';
  }
}

// Open Global Settings Modal
function openGlobalSettingsModal() {
  const { settings, taps } = appState;

  syncDisplaySettingsControls();
  if (settings.title) document.getElementById('headerTitleInput').value = settings.title;
  document.getElementById('showOnDeckCheckbox').checked = settings.show_ondeck !== false && settings.show_ondeck !== 0;
  document.getElementById('onDeckNewBatchDefaultCheckbox').checked =
    settings.ondeck_new_batch_default === true || settings.ondeck_new_batch_default === 1;
  document.getElementById('firstPourEffectsCheckbox').checked = settings.first_pour_effects !== 0;
  document.getElementById('kickEffectsCheckbox').checked = settings.kick_effects !== 0;
  document.getElementById('ceremonySoundSelect').value = settings.ceremony_sound || 'pub_bell';
  document.getElementById('browserSoundEnabledCheckbox').checked = effectiveDisplaySettings().sound_enabled === true;

  const custom = appState.customBeverage || {};
  const customFields = ['name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description'];
  customFields.forEach((field) => {
    const input = document.getElementById(`customBeverage${field[0].toUpperCase()}${field.slice(1)}`);
    if (input) input.value = custom[field] ?? '';
  });

  for (let i = 1; i <= 6; i++) {
    const check = document.getElementById(`globalTapCheck_${i}`);
    if (check) {
      const tapRow = taps.find((t) => t.tap_id === i);
      check.checked = tapRow ? tapRow.enabled === 1 : i <= 3;
    }
  }

  showModal('globalSettingsModal');
  loadBrewfatherStatus();
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  } else {
    modal.style.display = 'flex';
  }
}

function hideModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) modal.close();
  else modal.style.display = 'none';
}

// Open Per-Tap Settings Modal
function openTapSettings(tapId) {
  editingTapId = tapId;
  const tap = appState.taps.find((t) => t.tap_id === tapId) || {};
  const tapState = getTapState(tapId);
  const batchAttr = getBatchState(tapId);
  const batchSelection = getBatchSelection(tapId);
  const rawOptions = batchSelection.options || [];
  const selectedBatch = batchSelection.value || batchSelection.state || '';

  document.getElementById('tapSettingsTitle').textContent = `Tap ${tapId} Settings Studio`;

  const batchSelect = document.getElementById('tapSettingsBatchSelect');
  batchSelect.replaceChildren();

  const offTapOpt = createSelectOption('', '-- Empty / Off Tap --');
  batchSelect.appendChild(offTapOpt);

  const customOption = appState.customBeverage?.assignmentOption || appState.customBeverage?.assignment_option;
  rawOptions.forEach((optStr) => {
    if (!optStr || optStr.trim() === '') return;
    const parts = optStr.split('|');
    const label =
      customOption && optStr === customOption
        ? appState.customBeverage?.name || 'Custom beverage'
        : parts.length > 1
          ? parts[1].trim()
          : optStr;
    const opt = createSelectOption(
      optStr,
      label,
      selectedBatch === optStr ||
        (tap.batch_id && optStr.includes(tap.batch_id)) ||
        (batchAttr.batchId && optStr.includes(batchAttr.batchId))
    );
    batchSelect.appendChild(opt);
  });

  if (customOption && !rawOptions.includes(customOption)) {
    batchSelect.appendChild(
      createSelectOption(
        customOption,
        appState.customBeverage?.name || 'Custom beverage',
        selectedBatch === customOption
      )
    );
  }

  // Auto-check "Show Tap on Dashboard" whenever a non-empty brew batch is chosen
  batchSelect.onchange = () => {
    if (batchSelect.value !== '') {
      document.getElementById('tapSettingsEnabledCheckbox').checked = true;
    }
  };
  batchSelect.dataset.confirmedValue = batchSelect.value;

  // Set display fill graphic and enabled state.
  document.getElementById('tapSettingsGraphicSelect').value = tap.graphic || 'corny_keg';

  const isEnabled = tap.enabled === 1 || batchSelect.value !== '';
  document.getElementById('tapSettingsEnabledCheckbox').checked = isEnabled;

  // Set Display Unit & Custom Pour Input
  const unitSelect = document.getElementById('tapSettingsDisplayUnitSelect');
  unitSelect.value = tap.display_unit || 'percent';

  const customInput = document.getElementById('tapSettingsCustomPourInput');
  customInput.value = tap.custom_pour_size || 12.0;

  const capacityInput = document.getElementById('tapSettingsCapacityInput');
  if (capacityInput) {
    capacityInput.value =
      tapState.capacityOz !== null && tapState.capacityOz !== undefined && Number.isFinite(Number(tapState.capacityOz))
        ? String(tapState.capacityOz)
        : '';
  }
  const kickThresholdInput = document.getElementById('tapSettingsKickThresholdInput');
  kickThresholdInput.value = tap.kick_threshold_oz ?? '';

  toggleCustomPourSizeUI(unitSelect.value);

  // Set Overrides
  const hasOverride = tap.override_enabled === 1;
  const overrideToggle = document.getElementById('tapSettingsOverrideToggle');
  overrideToggle.checked = hasOverride;
  toggleOverrideFieldsUI(hasOverride);

  document.getElementById('overrideName').value = tap.override_name || '';
  document.getElementById('overrideStyle').value = tap.override_style || '';
  document.getElementById('overrideAbv').value =
    tap.override_abv !== null && tap.override_abv !== undefined ? tap.override_abv : '';
  document.getElementById('overrideIbu').value =
    tap.override_ibu !== null && tap.override_ibu !== undefined ? tap.override_ibu : '';
  document.getElementById('overrideOg').value =
    tap.override_og !== null && tap.override_og !== undefined ? tap.override_og : '';
  document.getElementById('overrideFg').value =
    tap.override_fg !== null && tap.override_fg !== undefined ? tap.override_fg : '';
  document.getElementById('overrideSrm').value =
    tap.override_srm !== null && tap.override_srm !== undefined ? tap.override_srm : '';
  document.getElementById('overrideDescription').value = tap.override_description || '';

  // Badges
  document.getElementById('badgeLowKegToggle').checked = tap.badge_low_keg !== 0;
  document.getElementById('badgeFreshToggle').checked = tap.badge_fresh === 1;

  document.getElementById('tapSettingsModal').style.display = 'flex';
}

function openPinModal() {
  const modal = document.getElementById('pinModal');
  const input = document.getElementById('pinInput');
  if (!modal) return;
  modal.style.display = 'flex';
  requestAnimationFrame(() => input?.focus());
}

function toggleCustomPourSizeUI(unitValue) {
  const container = document.getElementById('customPourSizeGroup');
  if (!container) return;
  if (unitValue === 'pours_custom') {
    container.style.display = 'flex';
  } else {
    container.style.display = 'none';
  }
}

function toggleOverrideFieldsUI(enabled) {
  const container = document.getElementById('tapSettingsOverrideFields');
  if (!container) return;
  if (enabled) {
    container.style.opacity = '1';
    container.style.pointerEvents = 'auto';
  } else {
    container.style.opacity = '0.5';
    container.style.pointerEvents = 'none';
  }
}

// Render On-Deck Ticker
function renderOnDeckTicker() {
  const ticker = document.getElementById('onDeckTicker');
  const itemsContainer = document.getElementById('onDeckItems');
  if (!ticker || !itemsContainer) return;

  const showOnDeck = appState.settings.show_ondeck !== false && appState.settings.show_ondeck !== 0;
  ticker.hidden = !showOnDeck;
  itemsContainer.replaceChildren();
  if (!showOnDeck) {
    tickerAutoScroller?.refresh();
    return;
  }

  const onDeckBrews = Array.isArray(appState.onDeckBatches) ? appState.onDeckBatches : [];
  const track = document.createElement('div');
  track.className = 'ondeck-track';
  track.appendChild(buildOnDeckItems(onDeckBrews));
  itemsContainer.replaceChildren(track);
  tickerAutoScroller?.refresh();
}

// Live Font Previews in Global Studio Settings
function updateFontPreviews() {
  const titleSelect = document.getElementById('titleFontSelect');
  const titlePreview = document.getElementById('titleFontPreview');
  const bodySelect = document.getElementById('bodyFontSelect');
  const bodyPreview = document.getElementById('bodyFontPreview');

  if (titleSelect && titlePreview) {
    titlePreview.style.fontFamily = `'${titleSelect.value}', sans-serif`;
  }
  if (bodySelect && bodyPreview) {
    bodyPreview.style.fontFamily = `'${bodySelect.value}', sans-serif`;
  }
}

function authHeaders(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${authToken}`
  };
}

function updateSaveStatus(key, { state, error }) {
  const statusIds = {
    theme: 'themeSaveStatus',
    title: 'headerTitleSaveStatus',
    'font-title': 'titleFontSaveStatus',
    'font-body': 'bodyFontSaveStatus',
    'layout-mode': 'layoutModeSaveStatus',
    'show-ondeck': 'showOnDeckSaveStatus',
    'ondeck-default': 'onDeckNewBatchDefaultSaveStatus',
    'primary-color': 'primaryColorSaveStatus',
    'secondary-color': 'secondaryColorSaveStatus',
    'theme-colors': 'accentColorsSaveStatus',
    'browser-display-preferences': 'browserDisplayPreferencesSaveStatus',
    'shared-display-defaults': 'sharedDisplayDefaultsSaveStatus',
    'first-pour-effects': 'firstPourEffectsSaveStatus',
    'kick-effects': 'kickEffectsSaveStatus',
    'ceremony-sound': 'ceremonySoundSaveStatus',
    'browser-sound-enabled': 'browserSoundEnabledSaveStatus',
    'custom-beverage': 'customBeverageSaveStatus',
    pin: 'pinChangeSaveStatus',
    'tap-assignment': 'tapSettingsBatchSaveStatus',
    tapSettingsGraphicSelect: 'tapSettingsGraphicSaveStatus',
    tapSettingsDisplayUnitSelect: 'tapSettingsDisplayUnitSaveStatus',
    tapSettingsCustomPourInput: 'tapSettingsCustomPourSaveStatus',
    tapSettingsCapacityInput: 'tapSettingsCapacitySaveStatus',
    tapSettingsKickThresholdInput: 'tapSettingsKickThresholdSaveStatus',
    tapSettingsEnabledCheckbox: 'tapSettingsEnabledSaveStatus',
    tapSettingsOverrideToggle: 'tapSettingsOverrideToggleSaveStatus',
    badgeLowKegToggle: 'badgeLowKegSaveStatus',
    badgeFreshToggle: 'badgeFreshSaveStatus'
  };
  if (/^tap-visibility-\d+$/.test(key))
    statusIds[key] = `globalTapCheck_${key.slice('tap-visibility-'.length)}SaveStatus`;
  const status =
    document.querySelector(`[data-save-status="${key}"]`) ||
    document.getElementById(statusIds[key] || '') ||
    document.getElementById(`${key}SaveStatus`) ||
    document.getElementById(`${key}Status`) ||
    document.getElementById(`${key.replace(/[^a-zA-Z0-9_-]/g, '')}Status`);
  if (!status) return;
  const messages = {
    queued: 'Saving…',
    saving: 'Saving…',
    saved: 'Saved',
    'local-saved': 'Saved in this browser',
    'local-memory': 'Applied for this page — browser storage unavailable',
    'shared-saved': 'Shared defaults saved',
    error: 'Not saved — Retry'
  };
  const displayState = key === 'shared-display-defaults' && state === 'saved' ? 'shared-saved' : state;
  status.textContent = messages[displayState] || '';
  status.dataset.state = state;
  status.title = error?.message || '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  if (state === 'saved') dirtyFields.delete(key);
}

function debounceAutosave(key, callback, delay = 600) {
  dirtyFields.add(key);
  clearTimeout(autosaveTimers.get(key));
  autosaveTimers.set(key, setTimeout(callback, delay));
}

function flushDebounce(key) {
  clearTimeout(autosaveTimers.get(key));
  autosaveTimers.delete(key);
}

function queueAutosave(key, callback) {
  dirtyFields.add(key);
  autosaves.save(key, callback);
}

function displayPreferenceStatus(result) {
  return result.persistence === 'persistent' ? 'local-saved' : 'local-memory';
}

function saveDisplayPreference(field, value, statusKey) {
  if (!displayPreferences?.setOverride) {
    updateSaveStatus(statusKey, { state: 'error', error: new Error('Browser display preferences are unavailable') });
    return false;
  }
  const result = displayPreferences.setOverride(field, value);
  if (!result.ok) {
    updateSaveStatus(statusKey, { state: 'error', error: new Error('Invalid display preference') });
    return false;
  }
  applySettingsPreview();
  updateSaveStatus(statusKey, { state: displayPreferenceStatus(result) });
  return true;
}

function resetBrowserDisplayPreferences() {
  if (!displayPreferences?.clear) return;
  const result = displayPreferences.clear();
  applySettingsPreview();
  syncDisplaySettingsControls();
  updateSaveStatus('browser-display-preferences', { state: displayPreferenceStatus(result) });
}

function sharedDisplayDefaultsPayload() {
  const settings = effectiveDisplaySettings();
  return {
    theme: settings.theme,
    font_title: settings.font_title,
    font_body: settings.font_body,
    primary_color: settings.primary_color ?? null,
    secondary_color: settings.secondary_color ?? null,
    layout_mode: settings.layout_mode === 'compact' ? 'compact' : 'cozy'
  };
}

async function postAutosave(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      authToken = null;
      sessionStorage.removeItem('tapboard_token');
      updateAuthUI();
      openPinModal();
    }
    throw new Error(result.error || 'Unable to save this setting');
  }
  return result;
}

function normalizeHex(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
}

function colorForeground(hex) {
  const color = normalizeHex(hex);
  if (!color) return '#000000';
  const values = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16) / 255);
  const linear = values.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > 0.179 ? '#000000' : '#FFFFFF';
}

function previewThemeColors(primary, secondary) {
  const validPrimary = normalizeHex(primary);
  const validSecondary = normalizeHex(secondary);
  if (validPrimary) {
    document.body.style.setProperty('--primary-color', validPrimary);
    document.body.style.setProperty('--accent-color', validPrimary);
    document.body.style.setProperty('--primary-foreground', colorForeground(validPrimary));
  }
  if (validSecondary) {
    document.body.style.setProperty('--secondary-color', validSecondary);
    document.body.style.setProperty('--secondary-foreground', colorForeground(validSecondary));
  }
  const advisory = document.getElementById('accentContrastAdvisory');
  if (advisory && validPrimary && validSecondary) {
    advisory.textContent =
      colorForeground(validPrimary) === colorForeground(validSecondary)
        ? 'Tip: verify both accent colors remain easy to distinguish on your dashboard.'
        : '';
    advisory.hidden = advisory.textContent === '';
  }
}

function effectiveDisplaySettings() {
  return displayPreferences?.effective ? displayPreferences.effective(appState.settings) : appState.settings;
}

function currentThemeColors(settings = effectiveDisplaySettings()) {
  const fallback = THEME_COLORS[settings.theme] || THEME_COLORS.modern_dark;
  return {
    primary: normalizeHex(settings.primary_color) || fallback.primary,
    secondary: normalizeHex(settings.secondary_color) || fallback.secondary
  };
}

function applySettingsPreview() {
  const settings = effectiveDisplaySettings();
  if (displayPreferences?.apply) {
    displayPreferences.apply(settings, { document });
  } else {
    if (settings.theme) document.body.setAttribute('data-theme', settings.theme);
    const colors = currentThemeColors(settings);
    previewThemeColors(colors.primary, colors.secondary);
    if (settings.font_title)
      document.documentElement.style.setProperty('--font-title', `'${settings.font_title}', sans-serif`);
    if (settings.font_body)
      document.documentElement.style.setProperty('--font-body', `'${settings.font_body}', sans-serif`);
    document.body.setAttribute('data-layout-mode', settings.layout_mode === 'compact' ? 'compact' : 'cozy');
  }
  if (appState.settings.title) document.getElementById('headerTitle').textContent = appState.settings.title;
}

function renderOnDeckManager(batches) {
  const list = document.getElementById('onDeckBatchList');
  if (!list) return;
  list.replaceChildren();
  if (batches.length === 0) {
    list.textContent = 'No eligible batches are currently available.';
    return;
  }
  batches.forEach((batch) => {
    const row = document.createElement('div');
    row.className = 'ondeck-batch-row';
    const selection = document.createElement('label');
    selection.className = 'ondeck-batch-selection';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = batch.visible === true;
    checkbox.dataset.batchId = batch.batch_id || batch.id || '';
    const details = document.createElement('span');
    details.className = 'ondeck-batch-details';
    const name = document.createElement('strong');
    name.textContent = batch.name || batch.recipe_name || 'Untitled batch';
    name.title = name.textContent;
    const meta = document.createElement('span');
    meta.textContent = [batch.status, batch.style].filter(Boolean).join(' · ') || 'Brewfather batch';
    const saveStatus = document.createElement('span');
    saveStatus.className = 'setting-save-status';
    saveStatus.dataset.saveStatus = `ondeck-${checkbox.dataset.batchId}`;
    saveStatus.setAttribute('aria-live', 'polite');
    details.append(name, meta, saveStatus);
    selection.append(checkbox, details);

    const tapSelect = document.createElement('select');
    tapSelect.className = 'form-select ondeck-target-tap-select';
    tapSelect.style.cssText = 'padding: 0.25rem 0.5rem; font-size: 0.8rem; width: auto; background-color: var(--bg-dark); color: var(--text-main); border: 1px solid var(--border-color); border-radius: 0.4rem; margin-right: 0.5rem;';
    tapSelect.dataset.batchId = checkbox.dataset.batchId;
    const optAny = document.createElement('option');
    optAny.value = '';
    optAny.textContent = 'Any Tap';
    tapSelect.appendChild(optAny);
    for (let t = 1; t <= 6; t++) {
      const opt = document.createElement('option');
      opt.value = String(t);
      opt.textContent = `Tap ${t}`;
      if (batch.target_tap_id === t) opt.selected = true;
      tapSelect.appendChild(opt);
    }

    const story = document.createElement('button');
    story.type = 'button';
    story.className = 'btn-secondary ondeck-manager-story';
    story.dataset.openStory = checkbox.dataset.batchId;
    story.textContent = 'Story';
    row.append(selection, tapSelect, story);
    list.appendChild(row);
  });
}

async function openOnDeckModal() {
  if (!authToken) {
    editingTapId = null;
    openPinModal();
    return;
  }
  const modal = document.getElementById('onDeckModal');
  const status = document.getElementById('onDeckRefreshStatus');
  modal.style.display = 'flex';
  status.textContent = 'Loading eligible Brewfather batches…';
  try {
    const res = await fetch('/api/ondeck', { headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Unable to load On Deck batches');
    const batches = Array.isArray(data) ? data : data.batches || [];
    const showOnDeck = data.show_ondeck ?? appState.settings.show_ondeck;
    document.getElementById('onDeckFooterEnabledCheckbox').checked = showOnDeck === true || showOnDeck === 1;
    renderOnDeckManager(batches);
    const brewfatherState = data.brewfather?.configured
      ? data.brewfather.stale
        ? `Brewfather cache stale${data.brewfather.error_category ? ` (${data.brewfather.error_category})` : ''}`
        : 'Brewfather cache current'
      : 'Brewfather credentials not configured';
    const haState = data.haConnected ? 'HA connected' : 'HA disconnected';
    status.textContent = `${batches.length} eligible batch${batches.length === 1 ? '' : 'es'} · ${brewfatherState} · ${haState}${
      showOnDeck === true || showOnDeck === 1 ? '' : ' · footer currently hidden'
    }`;
  } catch (error) {
    status.textContent = error.message || 'Unable to load On Deck batches.';
  }
}

function bindAutosaveInput(id, key, payload, { immediate = false, preview, endpoint = '/api/settings' } = {}) {
  const input = document.getElementById(id);
  if (!input) return;
  const save = () => {
    if (!input.checkValidity()) {
      updateSaveStatus(key, { state: 'error', error: new Error(input.validationMessage) });
      return;
    }
    queueAutosave(key, async () => {
      const result = await postAutosave(endpoint, payload(input));
      if (endpoint === '/api/settings') {
        appState.settings = { ...appState.settings, ...(result.settings || payload(input)) };
        renderApp();
      }
    });
  };
  input.addEventListener(immediate ? 'change' : 'input', () => {
    preview?.(input);
    if (immediate) save();
    else debounceAutosave(key, save);
  });
  if (!immediate)
    input.addEventListener('blur', () => {
      flushDebounce(key);
      save();
    });
}

function bindDisplayPreferenceInput(id, key, field, { preview } = {}) {
  const input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('change', () => {
    if (!input.checkValidity()) {
      updateSaveStatus(key, { state: 'error', error: new Error(input.validationMessage) });
      return;
    }
    if (saveDisplayPreference(field, input.value, key)) preview?.(input);
  });
}

function collectCustomBeverage() {
  const fields = ['name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description'];
  const payload = Object.fromEntries(
    fields.map((field) => {
      const id = `customBeverage${field[0].toUpperCase()}${field.slice(1)}`;
      return [field, document.getElementById(id)?.value ?? ''];
    })
  );
  ['abv', 'ibu', 'og', 'fg', 'srm'].forEach((field) => {
    payload[field] = payload[field] === '' ? null : Number(payload[field]);
  });
  return payload;
}

function customBeverageIsValid() {
  return ['name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description'].every((field) => {
    const input = document.getElementById(`customBeverage${field[0].toUpperCase()}${field.slice(1)}`);
    return input?.checkValidity();
  });
}

function queueTapAutosave(key, payloadFactory) {
  if (!editingTapId) return;
  const tapId = editingTapId;
  queueAutosave(key, async () => {
    const result = await postAutosave(`/api/taps/${tapId}`, payloadFactory());
    if (result.tap) {
      appState.taps = appState.taps.map((tap) => (tap.tap_id === tapId ? { ...tap, ...result.tap } : tap));
      renderApp();
    }
  });
}

function bindTapField(id, field, { immediate = false, transform = (value) => value, validate } = {}) {
  const input = document.getElementById(id);
  if (!input) return;
  const key = id;
  const save = () => {
    if ((validate && !validate(input)) || !input.checkValidity()) {
      updateSaveStatus(key, { state: 'error', error: new Error(input.validationMessage || 'Enter a valid value') });
      return;
    }
    queueTapAutosave(key, () => ({ [field]: transform(input.type === 'checkbox' ? input.checked : input.value) }));
  };
  input.addEventListener(immediate ? 'change' : 'input', () => (immediate ? save() : debounceAutosave(key, save)));
  if (!immediate)
    input.addEventListener('blur', () => {
      flushDebounce(key);
      save();
    });
}

function setupAutosaveListeners() {
  bindDisplayPreferenceInput('themeSelect', 'theme', 'theme', {
    preview: (input) => {
      document.body.setAttribute('data-theme', input.value);
      syncDisplaySettingsControls();
    }
  });
  bindAutosaveInput('headerTitleInput', 'title', (input) => ({ title: input.value }), {
    preview: (input) => {
      const title = document.getElementById('headerTitle');
      if (title) title.textContent = input.value;
    }
  });
  bindDisplayPreferenceInput('titleFontSelect', 'font-title', 'font_title', {
    preview: () => updateFontPreviews()
  });
  bindDisplayPreferenceInput('bodyFontSelect', 'font-body', 'font_body', {
    preview: () => updateFontPreviews()
  });
  bindDisplayPreferenceInput('layoutModeSelect', 'layout-mode', 'layout_mode');
  bindAutosaveInput('showOnDeckCheckbox', 'show-ondeck', (input) => ({ show_ondeck: input.checked }), {
    immediate: true
  });
  bindAutosaveInput(
    'onDeckNewBatchDefaultCheckbox',
    'ondeck-default',
    (input) => ({ ondeck_new_batch_default: input.checked }),
    { immediate: true }
  );
  bindAutosaveInput(
    'firstPourEffectsCheckbox',
    'first-pour-effects',
    (input) => ({ first_pour_effects: input.checked }),
    {
      immediate: true
    }
  );
  bindAutosaveInput('kickEffectsCheckbox', 'kick-effects', (input) => ({ kick_effects: input.checked }), {
    immediate: true
  });
  bindAutosaveInput('ceremonySoundSelect', 'ceremony-sound', (input) => ({ ceremony_sound: input.value }), {
    immediate: true
  });
  document.getElementById('browserSoundEnabledCheckbox')?.addEventListener('change', (event) => {
    const enabled = event.currentTarget.checked;
    if (saveDisplayPreference('sound_enabled', enabled, 'browser-sound-enabled') && enabled) {
      void playCeremonySound(appState.settings.ceremony_sound || 'pub_bell');
    }
  });

  for (let id = 1; id <= 6; id += 1) {
    bindAutosaveInput(
      `globalTapCheck_${id}`,
      `tap-visibility-${id}`,
      (input) => ({
        tap_visibilities: { [id]: input.checked }
      }),
      { immediate: true }
    );
  }

  bindAutosaveInput(
    'globalLowKegWarningPct',
    'low-keg-config',
    (input) => ({
      check_id: 'low_keg',
      tap_id: 0,
      enabled: true,
      config: {
        thresholdPercent: Number(input.value),
        criticalPercent: Number(document.getElementById('globalLowKegCriticalPct')?.value || 5)
      }
    }),
    { endpoint: '/api/draft-health/config' }
  );

  bindAutosaveInput(
    'globalLowKegCriticalPct',
    'low-keg-config',
    (input) => ({
      check_id: 'low_keg',
      tap_id: 0,
      enabled: true,
      config: {
        thresholdPercent: Number(document.getElementById('globalLowKegWarningPct')?.value || 20),
        criticalPercent: Number(input.value)
      }
    }),
    { endpoint: '/api/draft-health/config' }
  );

  bindAutosaveInput(
    'globalTargetConditioningDays',
    'planning-policy-config',
    (input) => ({
      conditioning_min_days: Math.max(1, Math.floor(Number(input.value) / 2)),
      conditioning_max_days: Number(input.value)
    }),
    { endpoint: '/api/planning/policy' }
  );

  bindAutosaveInput(
    'globalLineCleanDays',
    'line-cleaning-config',
    (input) => ({
      check_id: 'line_cleaning_due',
      tap_id: 0,
      enabled: true,
      config: {
        intervalDays: Number(input.value),
        intervalKegs: Number(document.getElementById('globalLineCleanKegs')?.value || 3)
      }
    }),
    { endpoint: '/api/draft-health/config' }
  );

  bindAutosaveInput(
    'globalLineCleanKegs',
    'line-cleaning-config',
    (input) => ({
      check_id: 'line_cleaning_due',
      tap_id: 0,
      enabled: true,
      config: {
        intervalDays: Number(document.getElementById('globalLineCleanDays')?.value || 14),
        intervalKegs: Number(input.value)
      }
    }),
    { endpoint: '/api/draft-health/config' }
  );

  [
    ['primary', 'primaryColorPicker', 'primaryColorInput'],
    ['secondary', 'secondaryColorPicker', 'secondaryColorInput']
  ].forEach(([name, pickerId, hexId]) => {
    const picker = document.getElementById(pickerId);
    const hex = document.getElementById(hexId);
    const apply = (value) => {
      const normalized = normalizeHex(value);
      if (!normalized) {
        updateSaveStatus(`${name}-color`, { state: 'error', error: new Error('Use #RRGGBB') });
        return;
      }
      if (picker) picker.value = normalized;
      if (hex) hex.value = normalized;
      const primary = name === 'primary' ? normalized : document.getElementById('primaryColorInput')?.value;
      const secondary = name === 'secondary' ? normalized : document.getElementById('secondaryColorInput')?.value;
      previewThemeColors(primary, secondary);
      saveDisplayPreference(`${name}_color`, normalized, `${name}-color`);
    };
    picker?.addEventListener('input', () => {
      const normalized = normalizeHex(picker.value);
      if (!normalized) return;
      if (hex) hex.value = normalized;
      const primary = name === 'primary' ? normalized : document.getElementById('primaryColorInput')?.value;
      const secondary = name === 'secondary' ? normalized : document.getElementById('secondaryColorInput')?.value;
      previewThemeColors(primary, secondary);
    });
    picker?.addEventListener('change', () => apply(picker.value));
    hex?.addEventListener('input', () => debounceAutosave(`${name}-color-input`, () => apply(hex.value)));
    hex?.addEventListener('blur', () => {
      flushDebounce(`${name}-color-input`);
      apply(hex.value);
    });
  });
  document.getElementById('resetAccentColorsBtn')?.addEventListener('click', () => {
    const fallback = THEME_COLORS[document.getElementById('themeSelect')?.value] || THEME_COLORS.modern_dark;
    ['primary', 'secondary'].forEach((name) => {
      const picker = document.getElementById(`${name}ColorPicker`);
      const hex = document.getElementById(`${name}ColorInput`);
      if (picker) picker.value = fallback[name];
      if (hex) hex.value = fallback[name];
    });
    const primaryResult = displayPreferences?.setOverride('primary_color', null);
    const secondaryResult = displayPreferences?.setOverride('secondary_color', null);
    applySettingsPreview();
    const result = secondaryResult || primaryResult;
    if (!primaryResult?.ok || !secondaryResult?.ok) {
      updateSaveStatus('theme-colors', { state: 'error', error: new Error('Unable to reset theme colors') });
    } else {
      updateSaveStatus('theme-colors', { state: displayPreferenceStatus(result) });
    }
  });

  document
    .getElementById('resetBrowserDisplayPreferencesBtn')
    ?.addEventListener('click', resetBrowserDisplayPreferences);
  document.getElementById('setSharedDisplayDefaultsBtn')?.addEventListener('click', () => {
    if (!confirm('Set this display profile as the shared default for new and reset browsers?')) return;
    queueAutosave('shared-display-defaults', async () => {
      const result = await postAutosave('/api/settings', sharedDisplayDefaultsPayload());
      appState.settings = { ...appState.settings, ...(result.settings || {}) };
      renderApp();
    });
  });

  ['name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description'].forEach((field) => {
    const input = document.getElementById(`customBeverage${field[0].toUpperCase()}${field.slice(1)}`);
    const key = input?.id;
    input?.addEventListener('input', () =>
      debounceAutosave(key, () => {
        if (!customBeverageIsValid()) return;
        queueAutosave(key, async () => {
          const result = await postAutosave('/api/custom-beverage', collectCustomBeverage());
          if (result.customBeverage) appState.customBeverage = result.customBeverage;
        });
      })
    );
    input?.addEventListener('blur', () => {
      flushDebounce(key);
      if (customBeverageIsValid()) {
        queueAutosave(key, async () => {
          const result = await postAutosave('/api/custom-beverage', collectCustomBeverage());
          if (result.customBeverage) appState.customBeverage = result.customBeverage;
        });
      }
    });
  });

  bindTapField('tapSettingsGraphicSelect', 'graphic', { immediate: true });
  bindTapField('tapSettingsEnabledCheckbox', 'enabled', { immediate: true });
  bindTapField('tapSettingsDisplayUnitSelect', 'display_unit', { immediate: true });
  bindTapField('tapSettingsCustomPourInput', 'custom_pour_size', { transform: Number });
  bindTapField('tapSettingsCapacityInput', 'capacity_oz', {
    transform: Number,
    validate: (input) =>
      Number.isInteger(Number(input.value)) && Number(input.value) >= 16 && Number(input.value) <= 2048
  });
  bindTapField('tapSettingsKickThresholdInput', 'kick_threshold_oz', {
    transform: (value) => (value === '' ? null : Number(value)),
    validate: (input) =>
      input.value === '' ||
      (Number(input.value) >= 0 && Number(input.value) <= 128 && Number.isFinite(Number(input.value)))
  });
  bindTapField('tapSettingsOverrideToggle', 'override_enabled', { immediate: true });
  bindTapField('badgeLowKegToggle', 'badge_low_keg', { immediate: true, transform: (checked) => (checked ? 20 : 0) });
  bindTapField('badgeFreshToggle', 'badge_fresh', { immediate: true });
  [
    ['overrideName', 'override_name'],
    ['overrideStyle', 'override_style'],
    ['overrideAbv', 'override_abv'],
    ['overrideIbu', 'override_ibu'],
    ['overrideOg', 'override_og'],
    ['overrideFg', 'override_fg'],
    ['overrideSrm', 'override_srm'],
    ['overrideDescription', 'override_description']
  ].forEach(([id, field]) => bindTapField(id, field));

  document.getElementById('tapSettingsBatchSelect')?.addEventListener('change', (event) => {
    const input = event.currentTarget;
    const previous = input.dataset.confirmedValue || '';
    const tapId = editingTapId;
    if (
      previous &&
      input.value !== previous &&
      !confirm('Change this tap assignment? This may create or close a keg lifecycle.')
    ) {
      input.value = previous;
      return;
    }
    queueTapAutosave('tap-assignment', async () => {
      await postAutosave(`/api/taps/${tapId}`, {
        batch_option: input.value,
        enabled: input.value !== '' || document.getElementById('tapSettingsEnabledCheckbox')?.checked
      });
      input.dataset.confirmedValue = input.value;
    });
  });

  document
    .getElementById('onDeckFooterEnabledCheckbox')
    ?.addEventListener('change', () => queueOnDeckAutosave('onDeckFooterEnabled'));
  document.getElementById('onDeckBatchList')?.addEventListener('change', (event) => {
    if (event.target.matches('input[data-batch-id], select[data-batch-id]')) {
      queueOnDeckAutosave(`ondeck-${event.target.dataset.batchId}`);
    }
  });
  document.getElementById('changePinBtn')?.addEventListener('click', changePin);
}

function queueOnDeckAutosave(key) {
  queueAutosave(key, async () => {
    const batches = Array.from(document.querySelectorAll('#onDeckBatchList input[data-batch-id]')).map((input) => {
      const batchId = input.dataset.batchId;
      const select = document.querySelector(`#onDeckBatchList select[data-batch-id="${batchId}"]`);
      const targetTap = select?.value ? Number(select.value) : null;
      return {
        batch_id: batchId,
        visible: input.checked,
        target_tap_id: targetTap
      };
    });
    const result = await postAutosave('/api/ondeck', {
      batches,
      show_ondeck: document.getElementById('onDeckFooterEnabledCheckbox')?.checked
    });
    appState.settings = { ...appState.settings, show_ondeck: result.show_ondeck ? 1 : 0 };
    appState.onDeckBatches = result.show_ondeck ? (result.batches || []).filter((batch) => batch.visible) : [];
    renderOnDeckTicker();
  });
}

async function changePin() {
  const current = document.getElementById('currentPinInput');
  const next = document.getElementById('newPinInput');
  const confirmInput = document.getElementById('confirmNewPinInput');
  if (!current || !next || !confirmInput) return;
  if (!/^\d{4}$/.test(current.value) || !/^\d{4}$/.test(next.value) || next.value !== confirmInput.value) {
    updateSaveStatus('pin', {
      state: 'error',
      error: new Error('Enter the current PIN and matching four-digit new PINs')
    });
    return;
  }
  queueAutosave('pin', async () => {
    await postAutosave('/api/admin/pin', {
      current_pin: current.value,
      new_pin: next.value,
      confirm_new_pin: confirmInput.value
    });
    [current, next, confirmInput].forEach((input) => {
      input.value = '';
    });
    authToken = null;
    sessionStorage.removeItem('tapboard_token');
    updateAuthUI();
    hideModal('globalSettingsModal');
    showToast('PIN updated. Sign in again to manage Tapboard.');
  });
}

// Modal Listeners Setup
function initModalListeners() {
  setupAutosaveListeners();
  // Font Select Live Preview Listeners
  document.getElementById('titleFontSelect')?.addEventListener('change', updateFontPreviews);
  document.getElementById('titleFontSelect')?.addEventListener('input', updateFontPreviews);
  document.getElementById('bodyFontSelect')?.addEventListener('change', updateFontPreviews);
  document.getElementById('bodyFontSelect')?.addEventListener('input', updateFontPreviews);
  // Close Recipe Modal
  const closeRecipeBtn = document.getElementById('closeRecipeBtn');
  if (closeRecipeBtn) {
    closeRecipeBtn.addEventListener('click', () => {
      brewStory?.close();
    });
  }
  document.querySelectorAll('[data-story-window]').forEach((button) => {
    button.addEventListener('click', () => {
      document
        .querySelectorAll('[data-story-window]')
        .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      brewStory?.load(button.dataset.storyWindow);
    });
  });

  // Open Global Settings Modal
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (authToken) {
        openGlobalSettingsModal();
      } else {
        editingTapId = null;
        openPinModal();
      }
    });
  }

  document.getElementById('taproomStatusBtn')?.addEventListener('click', openTaproomStatus);

  document.getElementById('onDeckSettingsBtn')?.addEventListener('click', openOnDeckModal);
  document.getElementById('onDeckItems')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-batch-id]');
    if (!button) return;
    getBrewStoryController().open({ batchId: button.dataset.batchId, title: button.textContent, fallback: {} });
  });
  document.getElementById('onDeckBatchList')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-story]');
    if (!button) return;
    const title = button.closest('.ondeck-batch-row')?.querySelector('strong')?.textContent || 'Brew Story';
    getBrewStoryController().open({ batchId: button.dataset.openStory, title, fallback: {} });
  });
  document.getElementById('closeOnDeckBtn')?.addEventListener('click', () => {
    document.getElementById('onDeckModal').style.display = 'none';
  });
  document.getElementById('closeForecastBtn')?.addEventListener('click', () => hideModal('forecastDialog'));

  // PIN Submit
  const pinSubmitBtn = document.getElementById('pinSubmitBtn');
  const submitPin = async () => {
    if (!pinSubmitBtn || pinSubmitBtn.disabled) return;
    pinSubmitBtn.disabled = true;
    try {
      const pin = document.getElementById('pinInput').value;
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        authToken = data.token;
        sessionStorage.setItem('tapboard_token', authToken);
        updateAuthUI();
        document.getElementById('pinModal').style.display = 'none';
        document.getElementById('pinInput').value = '';

        if (editingTapId) {
          openTapSettings(editingTapId);
        } else {
          openGlobalSettingsModal();
        }
      } else {
        alert(data.error || 'Invalid PIN');
      }
    } catch (err) {
      alert('Authentication request failed');
    } finally {
      pinSubmitBtn.disabled = false;
    }
  };
  document.getElementById('pinForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitPin();
  });

  // Display Unit Selector Change Listener
  document.getElementById('tapSettingsDisplayUnitSelect')?.addEventListener('change', (e) => {
    toggleCustomPourSizeUI(e.target.value);
  });

  // Override Toggle Listener
  const overrideToggle = document.getElementById('tapSettingsOverrideToggle');
  if (overrideToggle) {
    overrideToggle.addEventListener('change', (e) => {
      toggleOverrideFieldsUI(e.target.checked);
    });
  }

  document.getElementById('adminHealthBtn')?.addEventListener('click', () => {
    openKegeratorHealthModal();
  });
  document.getElementById('closeKegeratorHealthBtn')?.addEventListener('click', () => {
    hideModal('kegeratorHealthModal');
  });

  document.getElementById('logLineCleaningQuickBtn')?.addEventListener('click', async () => {
    const tapsInput = prompt('Cleaned tap numbers (comma-separated, e.g. 1, 2, 3)', '1, 2, 3, 4, 5, 6');
    if (!tapsInput) return;
    const method = prompt('Cleaning method (Caustic, Acid, Water Flush)', 'Caustic');
    if (!method) return;
    const notes = prompt('Maintenance notes (optional)', 'Routine line cleaning') ?? '';
    const tapIds = tapsInput.split(',').map((val) => Number(val.trim())).filter((n) => !isNaN(n) && n > 0);
    if (!tapIds.length) {
      alert('Please enter valid tap numbers');
      return;
    }
    try {
      const res = await fetch('/api/maintenance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          completed_at: new Date().toISOString(),
          tap_ids: tapIds,
          method,
          notes,
          next_due_at: null
        })
      });
      if (res.ok) {
        alert('Line cleaning recorded successfully!');
        await openKegeratorHealthModal();
      } else {
        const err = await res.json();
        alert(`Failed to record line cleaning: ${err.error || 'Server error'}`);
      }
    } catch (err) {
      alert('Network error recording line cleaning');
    }
  });

  const overviewTabBtn = document.getElementById('healthTabOverviewBtn');
  const settingsTabBtn = document.getElementById('healthTabSettingsBtn');
  overviewTabBtn?.addEventListener('click', () => {
    overviewTabBtn.classList.add('active');
    settingsTabBtn?.classList.remove('active');
    document.getElementById('healthOverviewTab').style.display = 'block';
    document.getElementById('healthSettingsTab').style.display = 'none';
  });
  settingsTabBtn?.addEventListener('click', () => {
    settingsTabBtn.classList.add('active');
    overviewTabBtn?.classList.remove('active');
    document.getElementById('healthOverviewTab').style.display = 'none';
    document.getElementById('healthSettingsTab').style.display = 'grid';
  });

  document.getElementById('closeGlobalSettingsBtn')?.addEventListener('click', () => {
    hideModal('globalSettingsModal');
  });
  document.getElementById('closeTapSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('tapSettingsModal').style.display = 'none';
  });

  ['recipeModal', 'pinModal', 'globalSettingsModal', 'tapSettingsModal', 'onDeckModal'].forEach((id) => {
    const modal = document.getElementById(id);
    modal?.addEventListener('click', (event) => {
      if (event.target !== modal) return;
      if (id === 'recipeModal') brewStory?.close();
      else hideModal(id);
    });
  });

  document.getElementById('refreshOnDeckBtn')?.addEventListener('click', async () => {
    const status = document.getElementById('onDeckRefreshStatus');
    status.textContent = 'Refreshing Brewfather…';
    try {
      const res = await fetch('/api/brewfather/refresh', { method: 'POST', headers: authHeaders() });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(result.error || result.errorCategory || 'Brewfather refresh failed');
      }
      status.textContent =
        result.outcome === 'succeeded'
          ? `Native refresh completed (${result.summaries} batches, ${result.requestCount} requests).`
          : `Refresh completed with stale cached data (${result.errorCategory || 'partial failure'}).`;
    } catch (error) {
      status.textContent = error.message || 'Brewfather refresh failed.';
    }
  });

  document.getElementById('refreshBrewfatherBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const feedback = document.getElementById('brewfatherRefreshStatus');
    ++brewfatherStatusRequestId;
    button.disabled = true;
    delete feedback.dataset.source;
    feedback.textContent = 'Refreshing Brewfather…';
    feedback.dataset.state = 'saving';
    try {
      const response = await fetch('/api/brewfather/refresh', { method: 'POST', headers: authHeaders() });
      const result = await response.json().catch(() => ({}));
      if (result.brewfather) renderBrewfatherStatus(result.brewfather);

      if (result.outcome === 'succeeded') {
        feedback.textContent = `Refresh completed (${result.summaries ?? 0} batches, ${result.requestCount ?? 0} requests).`;
        feedback.dataset.state = 'saved';
      } else if (result.outcome === 'stale_cache') {
        feedback.textContent = `Refresh completed with stale cached data${result.errorCategory ? ` (${result.errorCategory})` : ''}.`;
        feedback.dataset.state = 'error';
      } else {
        feedback.textContent = result.error || result.errorCategory || 'Brewfather refresh failed.';
        feedback.dataset.state = 'error';
      }
    } catch (error) {
      feedback.textContent = error.message || 'Brewfather refresh failed.';
      feedback.dataset.state = 'error';
    } finally {
      button.disabled = false;
    }
  });

  // Action Button: End Batch
  document.getElementById('tapSettingsEndBatchBtn')?.addEventListener('click', async () => {
    if (!editingTapId) return;
    if (
      confirm(
        `Complete Brewfather batch for Tap ${editingTapId}? This will set the batch to Completed and unassign the tap.`
      )
    ) {
      try {
        const res = await fetch(`/api/taps/${editingTapId}/end-batch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` }
        });
        if (res.ok) {
          document.getElementById('tapSettingsModal').style.display = 'none';
          showToast(`🍺 Batch completed and Tap ${editingTapId} cleared.`);
        } else {
          alert('Failed to complete batch');
        }
      } catch (err) {
        alert('Error executing end batch');
      }
    }
  });

  document.getElementById('tapSettingsEndKegBtn')?.addEventListener('click', () => {
    if (!editingTapId) return;
    showModal('endKegReasonDialog');
  });
  document.getElementById('endKegReasonDialog')?.addEventListener('close', async (event) => {
    const reason = event.currentTarget.returnValue;
    if (!editingTapId || !['kicked', 'removed', 'other'].includes(reason)) return;
    const tapId = editingTapId;
    try {
      const res = await fetch(`/api/taps/${tapId}/end-keg`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ reason })
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Failed to end keg');
      document.getElementById('tapSettingsModal').style.display = 'none';
      showToast(reason === 'kicked' ? `🍺 Tap ${tapId} kicked and cleared.` : `Tap ${tapId} cleared.`);
    } catch (error) {
      alert(error.message || 'Error executing end keg');
    }
  });
}

function initDisplayPreferenceSync() {
  displayPreferences?.subscribe?.((state) => {
    if (!hasRenderedSnapshot) {
      displayPreferences.applyOverrides?.(state.overrides, { document });
      return;
    }
    applySettingsPreview();
    syncDisplaySettingsControls();
  });
}

// Initialize Client Engine
window.addEventListener('DOMContentLoaded', () => {
  const onDeckItems = document.getElementById('onDeckItems');
  if (onDeckItems) tickerAutoScroller = createTickerAutoScroller({ element: onDeckItems });
  window.addEventListener(
    'resize',
    () => {
      scheduleTitleFits();
      tickerAutoScroller?.refresh({ reset: false });
    },
    { passive: true }
  );
  document.fonts?.ready
    .then(() => {
      scheduleTitleFits();
      tickerAutoScroller?.refresh({ reset: false });
    })
    .catch(() => {});
  celebration = createCelebrationController({
    layer: document.getElementById('celebrationLayer'),
    getSettings: () => appState.settings,
    soundEnabled: () => effectiveDisplaySettings().sound_enabled === true
  });
  loadInitialSnapshot();
  initSSE();
  initModalListeners();
  initDisplayPreferenceSync();
});
