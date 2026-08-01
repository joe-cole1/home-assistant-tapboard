// Tapboard v3.8.2 Client Engine
import { renderTapGraphic, srmToHex } from './graphics.js';
import { createLiveUpdateController, updateGraphicFill } from './liveUpdates.js';
import { buildOnDeckItems, buildRecipeModalContent, buildTapCardContent, createSelectOption, createToast } from './domBuilders.js';
import { shouldShowNewBadge } from './freshness.js';

let appState = {
  settings: {},
  taps: [],
  batches: [],
  catalog: [],
  tapStates: {},
  haConnected: true,
  kegKickForecasts: {}
};

let editingTapId = null;
let authToken = sessionStorage.getItem('tapboard_token') || null;
let liveUpdates;
const simulatedPourTimers = new Map();
const LONG_PRESS_MS = 600;
const SIMULATED_POUR_MS = 8000;

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
  tapIds.forEach(tapId => {
    const tap = appState.taps.find(item => item.tap_id === Number(tapId));
    const card = document.querySelector(`.tap-card[data-tap-id="${tapId}"]`);
    if (tap && tap.enabled === 1 && card) updateTapCard(card, tap);
  });
}

liveUpdates = createLiveUpdateController({
  getState: () => appState,
  setState: state => { appState = state; },
  onDirty: scheduleTapUpdates,
  requestFrame: callback => requestAnimationFrame(callback)
});

function updateAuthUI() {
  if (authToken) {
    document.body.classList.add('is-authenticated');
  } else {
    document.body.classList.remove('is-authenticated');
  }
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
  if (lower.includes('topo chico') || lower.includes('water') || lower.includes('seltzer')) return 'Sparkling Water';

  return 'Craft Beer';
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
    liveUpdates.replaceSnapshot(JSON.parse(e.data));
    updateClockStatus(appState.haConnected ? 'Live' : 'Disconnected');
    pulseLiveIndicator();
    renderApp();
  });

  // 2. HA Connection Status Change
  eventSource.addEventListener('ha_connection_status', (e) => {
    const { isConnected } = JSON.parse(e.data);
    appState.haConnected = isConnected;
    updateClockStatus(isConnected ? 'Live' : 'Disconnected');
    pulseLiveIndicator();
  });

  // 3. HA State Changed
  eventSource.addEventListener('state_changed', (e) => {
    liveUpdates.applyStateChanged(JSON.parse(e.data));
    pulseLiveIndicator();
  });

  // 4. Instant Pour Animation Start
  eventSource.addEventListener('pour_start', (e) => {
    const { tapId } = JSON.parse(e.data);
    pulseLiveIndicator();
    console.log(`[Pour Start] Animating Tap ${tapId}`);
    setTapPouringAnimation(tapId, true);
  });

  // 5. Pour Complete Summary & Toast Notification
  eventSource.addEventListener('pour_complete', (e) => {
    const { tapId, volumePouredOz, beerName, kegKickForecast } = JSON.parse(e.data);
    pulseLiveIndicator();
    showToast(`🍺 Poured ${volumePouredOz} oz of ${beerName}!`);
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

  // 6. Canceled Pour (rebound, disconnect, large change, or safety timeout)
  eventSource.addEventListener('pour_cancel', (e) => {
    const { tapId } = JSON.parse(e.data);
    pulseLiveIndicator();
    setTapPouringAnimation(tapId, false);
  });

  // 7. Low Keg Alert
  eventSource.addEventListener('low_keg_alert', (e) => {
    const { tapId, currentPercent } = JSON.parse(e.data);
    pulseLiveIndicator();
    showToast(`⚠️ Low Keg Warning: Tap ${tapId} at ${currentPercent}%!`);
  });

  // 8. Settings Updated
  eventSource.addEventListener('settings_updated', (e) => {
    liveUpdates.replaceSnapshot(JSON.parse(e.data));
    pulseLiveIndicator();
    renderApp();
  });
}

function pulseLiveIndicator() {
  if (!appState.haConnected) return;
  const badge = document.getElementById('liveStatusBadge');
  if (!badge) return;

  badge.classList.remove('is-updating');
  void badge.offsetWidth;
  badge.classList.add('is-updating');
}

function updateClockStatus(text) {
  const clockEl = document.getElementById('headerClock');
  if (clockEl) {
    if (text.includes('Disconnected') || text.includes('Reconnecting') || text.includes('Offline')) {
      clockEl.textContent = 'Disconnected';
      clockEl.style.color = '#ffa726';
    } else {
      clockEl.textContent = 'Live';
      clockEl.style.color = '';
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

  const headerBadges = card.querySelector('.tap-card-header > div:last-child');
  const streamGroup = card.querySelector('.pour-stream-group');
  const liquidRects = card.querySelectorAll('.beer-liquid-rect, .beer-liquid-shadow');
  const foamGroup = card.querySelector('.beer-cloud-foam');

  // Read untransformed SVG base Y coordinate for foam head
  const svgEl = card.querySelector('.tap-graphic-svg');
  const bottomY = svgEl ? (parseFloat(svgEl.getAttribute('data-bottom-y')) || 220) : 220;
  const topRimY = svgEl ? (parseFloat(svgEl.getAttribute('data-top-rim-y')) || 55) : 55;
  const fullHeight = bottomY - topRimY;

  const baseY = foamGroup ? (parseFloat(foamGroup.getAttribute('data-base-y')) || bottomY) : bottomY;

  if (isPouring) {
    card.classList.remove('is-settling');
    card.classList.add('is-pouring');

    if (streamGroup) streamGroup.classList.add('is-active');

    // 1. Snap to empty (0% fill at bottomY) without transition
    card.classList.add('no-anim');

    liquidRects.forEach(r => {
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
      liquidRects.forEach(r => {
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

    liquidRects.forEach(r => {
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

  card.addEventListener('pointerdown', event => {
    if (!authToken || (event.button !== undefined && event.button !== 0) || event.target.closest('button, input, select, textarea, label')) return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 1000;
      simulatePour(tapId);
    }, LONG_PRESS_MS);
  });

  card.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  card.addEventListener('pointerup', cancel);
  card.addEventListener('pointercancel', cancel);
  card.addEventListener('pointerleave', cancel);
  card.addEventListener('contextmenu', event => {
    if (authToken) event.preventDefault();
  });

  return () => Date.now() < suppressClickUntil;
}

// Helper: Format Volume Readout based on Per-Tap Display Setting
function formatVolumeReadout(tap, fillPercent, currentOz, pintsRemaining) {
  const unit = tap.display_unit || 'percent';
  const customSize = Math.max(0.5, parseFloat(tap.custom_pour_size) || 12.0);

  switch (unit) {
    case 'pints':
      return `${(currentOz / 16.0).toFixed(1)} Pints Remaining`;
    case 'oz':
      return `${currentOz.toFixed(0)} oz Remaining`;
    case 'pours_12':
      return `${(currentOz / 12.0).toFixed(1)} Pours (12oz)`;
    case 'pours_custom':
      return `${(currentOz / customSize).toFixed(1)} Pours (${customSize}oz)`;
    case 'percent':
    default:
      return `${fillPercent.toFixed(1)}% Remaining`;
  }
}

// Helper: Clean Format Forecast Readout
function formatForecastText(forecast) {
  if (forecast.estimatedDaysRemaining === null || forecast.estimatedDaysRemaining === undefined) {
    return '';
  }

  if (forecast.estimatedDaysRemaining < 1.0) {
    return `🔴 Kicking soon`;
  }

  return `⌛ ${forecast.estimatedDaysRemaining} days remaining (${forecast.avgDailyOz} oz/day avg)`;
}

// Main Render Function with In-Place Targeted DOM Preservation
function renderApp() {
  const { settings, taps } = appState;

  if (settings.theme) {
    document.body.setAttribute('data-theme', settings.theme);
  }
  if (settings.title) {
    document.getElementById('headerTitle').textContent = settings.title;
  }
  if (settings.font_title) {
    document.documentElement.style.setProperty('--font-title', `'${settings.font_title}', sans-serif`);
  }
  if (settings.font_body) {
    document.documentElement.style.setProperty('--font-body', `'${settings.font_body}', sans-serif`);
  }

  const tapGrid = document.getElementById('tapGrid');
  if (!tapGrid) return;

  const activeTaps = taps.filter(t => t.enabled === 1);
  const activeTapIds = new Set(activeTaps.map(t => t.tap_id));
  tapGrid.setAttribute('data-count', activeTaps.length);

  // 1. Remove cards for disabled/hidden taps
  Array.from(tapGrid.querySelectorAll('.tap-card')).forEach(card => {
    const tapId = parseInt(card.getAttribute('data-tap-id'), 10);
    if (!activeTapIds.has(tapId)) {
      card.remove();
    }
  });

  // 2. Add or update active tap cards in-place
  activeTaps.forEach(tap => {
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
}

// Create Tap Card Element (Initial creation)
function createTapCard(tap) {
  const tapId = tap.tap_id;
  const tapState = getTapState(tapId);
  const batchAttr = getBatchState(tapId);

  // 3-Tier Recipe Lookup Hierarchy (Overrides -> HA Attributes -> Local Batches Cache)
  const cachedBatch = (tap.batch_id && appState.batches) ? appState.batches.find(b => b.batch_id === tap.batch_id) : null;

  const fillPercent = Math.min(100, Math.max(0, parseFloat(tapState.fillPercent) || 0));
  const currentOz = parseFloat(tapState.volumeOz) > 0 ? parseFloat(tapState.volumeOz) : (fillPercent / 100.0) * 640.0;
  const pintsRemaining = parseFloat(tapState.pintsRemaining) || (currentOz / 16.0);

  const bfName = batchAttr.recipeName || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = batchAttr.abv ?? cachedBatch?.abv ?? '--';
  const bfIbu = batchAttr.ibu ?? cachedBatch?.ibu ?? '--';
  const bfOg = batchAttr.og ?? cachedBatch?.og ?? '--';
  const bfFg = batchAttr.fg ?? cachedBatch?.fg ?? '--';
  const bfSrm = batchAttr.srm ?? cachedBatch?.srm ?? 3;
  const bfDesc = batchAttr.description || (cachedBatch ? cachedBatch.description : null) || '';

  const hasOverride = tap.override_enabled === 1;
  const beerName = (hasOverride && tap.override_name && tap.override_name.trim() !== '') ? tap.override_name : bfName;
  const style = (hasOverride && tap.override_style && tap.override_style.trim() !== '') ? tap.override_style : bfStyle;

  const isWaterOrTopo = beerName.toLowerCase().includes('topo chico') ||
                        beerName.toLowerCase().includes('water') ||
                        style.toLowerCase().includes('water') ||
                        style.toLowerCase().includes('seltzer') ||
                        bfSrm === 0 ||
                        (hasOverride && tap.override_srm === 0);

  const abv = isWaterOrTopo ? '0.0%' : ((hasOverride && tap.override_abv !== null && tap.override_abv !== undefined && tap.override_abv !== '') ? `${tap.override_abv}%` : (bfAbv !== '--' ? `${bfAbv}%` : '--'));
  const ibu = isWaterOrTopo ? '-' : ((hasOverride && tap.override_ibu !== null && tap.override_ibu !== undefined && tap.override_ibu !== '') ? tap.override_ibu : bfIbu);
  const og = isWaterOrTopo ? '-' : ((hasOverride && tap.override_og !== null && tap.override_og !== undefined && tap.override_og !== '') ? tap.override_og : bfOg);
  const fg = isWaterOrTopo ? '-' : ((hasOverride && tap.override_fg !== null && tap.override_fg !== undefined && tap.override_fg !== '') ? tap.override_fg : bfFg);
  const srm = isWaterOrTopo ? 0 : ((hasOverride && tap.override_srm !== null && tap.override_srm !== undefined && tap.override_srm !== '') ? tap.override_srm : bfSrm);
  const description = (hasOverride && tap.override_description && tap.override_description.trim() !== '') ? tap.override_description : bfDesc;

  const beerColorHex = isWaterOrTopo ? 'WATER' : srmToHex(srm);

  const forecast = appState.kegKickForecasts[tapId] || {};
  const forecastText = formatForecastText(forecast);
  const volumeReadoutText = formatVolumeReadout(tap, fillPercent, currentOz, pintsRemaining);

  const card = document.createElement('div');
  card.className = 'tap-card';
  card.setAttribute('data-tap-id', tapId);
  card.setAttribute('data-graphic-style', tap.graphic || 'corny_keg');
  card.setAttribute('data-color-hex', beerColorHex);

  card.replaceChildren(buildTapCardContent({
    tapId, fillPercent, fresh: shouldShowNewBadge(tap), lowThreshold: tap.badge_low_keg || 20,
    beerName, style, description, abv, ibu, og, fg, volumeReadoutText, forecastText
  }));

  // Render SVG Graphic initially
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  if (graphicContainer && typeof renderTapGraphic === 'function') {
    graphicContainer.innerHTML = renderTapGraphic(tap.graphic || 'corny_keg', fillPercent, beerColorHex, false, `tap_${tapId}`);
  }

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

  // Card Body Click: Open Recipe Detail Modal
  card.addEventListener('click', event => {
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
  const cachedBatch = (tap.batch_id && appState.batches) ? appState.batches.find(b => b.batch_id === tap.batch_id) : null;

  const fillPercent = Math.min(100, Math.max(0, parseFloat(tapState.fillPercent) || 0));
  const currentOz = parseFloat(tapState.volumeOz) > 0 ? parseFloat(tapState.volumeOz) : (fillPercent / 100.0) * 640.0;
  const pintsRemaining = parseFloat(tapState.pintsRemaining) || (currentOz / 16.0);

  const bfName = batchAttr.recipeName || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = batchAttr.abv ?? cachedBatch?.abv ?? '--';
  const bfIbu = batchAttr.ibu ?? cachedBatch?.ibu ?? '--';
  const bfOg = batchAttr.og ?? cachedBatch?.og ?? '--';
  const bfFg = batchAttr.fg ?? cachedBatch?.fg ?? '--';
  const bfSrm = batchAttr.srm ?? cachedBatch?.srm ?? 3;

  const hasOverride = tap.override_enabled === 1;
  const beerName = (hasOverride && tap.override_name && tap.override_name.trim() !== '') ? tap.override_name : bfName;
  const style = (hasOverride && tap.override_style && tap.override_style.trim() !== '') ? tap.override_style : bfStyle;

  const isWaterOrTopo = beerName.toLowerCase().includes('topo chico') ||
                        beerName.toLowerCase().includes('water') ||
                        style.toLowerCase().includes('water') ||
                        style.toLowerCase().includes('seltzer') ||
                        bfSrm === 0 ||
                        (hasOverride && tap.override_srm === 0);

  const abv = isWaterOrTopo ? '0.0%' : ((hasOverride && tap.override_abv !== null && tap.override_abv !== undefined && tap.override_abv !== '') ? `${tap.override_abv}%` : (bfAbv !== '--' ? `${bfAbv}%` : '--'));
  const ibu = isWaterOrTopo ? '-' : ((hasOverride && tap.override_ibu !== null && tap.override_ibu !== undefined && tap.override_ibu !== '') ? tap.override_ibu : bfIbu);
  const og = isWaterOrTopo ? '-' : ((hasOverride && tap.override_og !== null && tap.override_og !== undefined && tap.override_og !== '') ? tap.override_og : bfOg);
  const fg = isWaterOrTopo ? '-' : ((hasOverride && tap.override_fg !== null && tap.override_fg !== undefined && tap.override_fg !== '') ? tap.override_fg : bfFg);
  const srm = isWaterOrTopo ? 0 : ((hasOverride && tap.override_srm !== null && tap.override_srm !== undefined && tap.override_srm !== '') ? tap.override_srm : bfSrm);
  const beerColorHex = isWaterOrTopo ? 'WATER' : srmToHex(srm);

  const forecast = appState.kegKickForecasts[tapId] || {};
  const forecastText = formatForecastText(forecast);
  const newVolText = formatVolumeReadout(tap, fillPercent, currentOz, pintsRemaining);

  // Update text content in-place
  const titleEl = card.querySelector('.beer-title');
  if (titleEl && titleEl.textContent !== beerName) titleEl.textContent = beerName;

  const styleEl = card.querySelector('.beer-style');
  if (styleEl && styleEl.textContent !== style) styleEl.textContent = style;

  let descriptionEl = card.querySelector('.beer-description');
  const description = (hasOverride && tap.override_description && tap.override_description.trim() !== '')
    ? tap.override_description
    : (batchAttr.description || (cachedBatch ? cachedBatch.description : null) || '');
  if (description && !descriptionEl) {
    descriptionEl = document.createElement('p');
    descriptionEl.className = 'beer-description';
    card.querySelector('.metrics-row')?.before(descriptionEl);
  }
  if (descriptionEl) {
    descriptionEl.textContent = description;
    descriptionEl.hidden = !description;
  }

  const badges = card.querySelector('.tap-card-header > div:last-child');
  if (badges) {
    let lowBadge = badges.querySelector('.badge-low');
    const isLow = fillPercent <= (tap.badge_low_keg || 20);
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
      badges.querySelector('.tap-cog-btn')?.before(newBadge);
    } else if (!isNew && newBadge) {
      newBadge.remove();
    }
  }

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

  const forecastEl = card.querySelector('.forecast-readout');
  if (forecastEl) {
    if (forecastEl.textContent !== forecastText) forecastEl.textContent = forecastText;
    forecastEl.hidden = !forecastText;
  }

  // Numeric telemetry mutates the existing SVG so carbonation nodes keep animating.
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  const currentGraphicStyle = card.getAttribute('data-graphic-style');
  const currentColorHex = card.getAttribute('data-color-hex');

  if (!graphicContainer.firstChild || currentGraphicStyle !== (tap.graphic || 'corny_keg') || currentColorHex !== beerColorHex) {
    card.setAttribute('data-graphic-style', tap.graphic || 'corny_keg');
    card.setAttribute('data-color-hex', beerColorHex);
    graphicContainer.innerHTML = renderTapGraphic(tap.graphic || 'corny_keg', fillPercent, beerColorHex, false, `tap_${tapId}`);
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

  const tap = appState.taps.find(item => item.tap_id === tapId) || {};
  const batchAttr = getBatchState(tapId);
  const cachedBatch = tap.batch_id ? appState.batches.find(batch => batch.batch_id === tap.batch_id) : null;
  const hasOverride = tap.override_enabled === 1;
  const beerName = (hasOverride && tap.override_name) || batchAttr.recipeName || cachedBatch?.recipe_name || `Tap ${tapId}`;
  const style = (hasOverride && tap.override_style) || deriveBeerStyle(beerName, batchAttr.style || cachedBatch?.style || 'Craft Beer');
  const projectedSrm = batchAttr.srm ?? cachedBatch?.srm ?? 3;
  const isWater = beerName.toLowerCase().includes('water') ||
    beerName.toLowerCase().includes('topo chico') ||
    style.toLowerCase().includes('water') ||
    style.toLowerCase().includes('seltzer') ||
    projectedSrm === 0 ||
    (hasOverride && tap.override_srm === 0);
  const batchAbv = batchAttr.abv ?? cachedBatch?.abv;
  const abv = isWater ? '0.0%' : (hasOverride && tap.override_abv !== '' && tap.override_abv != null ? `${tap.override_abv}%` : (batchAbv != null ? `${batchAbv}%` : '--'));
  const ibu = isWater ? '-' : (hasOverride && tap.override_ibu !== '' && tap.override_ibu != null ? tap.override_ibu : (batchAttr.ibu ?? cachedBatch?.ibu ?? '--'));
  const og = isWater ? '-' : (hasOverride && tap.override_og !== '' && tap.override_og != null ? tap.override_og : (batchAttr.og ?? cachedBatch?.og ?? '--'));
  const fg = isWater ? '-' : (hasOverride && tap.override_fg !== '' && tap.override_fg != null ? tap.override_fg : (batchAttr.fg ?? cachedBatch?.fg ?? '--'));
  const srm = isWater ? 0 : (hasOverride && tap.override_srm !== '' && tap.override_srm != null ? tap.override_srm : projectedSrm);
  const description = (hasOverride && tap.override_description) || batchAttr.description || cachedBatch?.description || '';

  title.textContent = `${beerName}`;
  body.replaceChildren(buildRecipeModalContent({ style, abv, ibu, srm, og, fg, brewDate: batchAttr.brewDate, description }));

  modal.style.display = 'flex';
}

// Open Global Settings Modal
function openGlobalSettingsModal() {
  const { settings, taps } = appState;
  
  if (settings.theme) document.getElementById('themeSelect').value = settings.theme;
  if (settings.title) document.getElementById('headerTitleInput').value = settings.title;
  if (settings.font_title) document.getElementById('titleFontSelect').value = settings.font_title;
  if (settings.font_body) document.getElementById('bodyFontSelect').value = settings.font_body;

  for (let i = 1; i <= 6; i++) {
    const check = document.getElementById(`globalTapCheck_${i}`);
    if (check) {
      const tapRow = taps.find(t => t.tap_id === i);
      check.checked = tapRow ? tapRow.enabled === 1 : (i <= 3);
    }
  }

  updateFontPreviews();
  document.getElementById('globalSettingsModal').style.display = 'flex';
}

// Open Per-Tap Settings Modal
function openTapSettings(tapId) {
  editingTapId = tapId;
  const tap = appState.taps.find(t => t.tap_id === tapId) || {};
  const batchAttr = getBatchState(tapId);
  const batchSelection = getBatchSelection(tapId);
  const rawOptions = batchSelection.options || [];
  const selectedBatch = batchSelection.value || batchSelection.state || '';

  document.getElementById('tapSettingsTitle').textContent = `Tap ${tapId} Settings Studio`;

  const batchSelect = document.getElementById('tapSettingsBatchSelect');
  batchSelect.replaceChildren();

  const offTapOpt = createSelectOption('', '-- Empty / Off Tap --');
  batchSelect.appendChild(offTapOpt);

  const conditioningBatches = [];
  let topoChicoOption = null;

  rawOptions.forEach(optStr => {
    if (!optStr || optStr.trim() === '') return;

    if (optStr.toLowerCase().includes('topo_chico') || optStr.toLowerCase().includes('topo chico')) {
      topoChicoOption = optStr;
    } else if (optStr.includes('(Conditioning)') || optStr.includes('Conditioning')) {
      conditioningBatches.push(optStr);
    }
  });

  conditioningBatches.forEach(optStr => {
    const parts = optStr.split('|');
    const label = parts.length > 1 ? parts[1].trim() : optStr;
    const opt = createSelectOption(optStr, label,
      selectedBatch === optStr || (tap.batch_id && optStr.includes(tap.batch_id)) || (batchAttr.batchId && optStr.includes(batchAttr.batchId)));
    batchSelect.appendChild(opt);
  });

  const topoVal = topoChicoOption || 'custom:topo_chico | Topo Chico 0%';
  const topoOpt = createSelectOption(topoVal, 'Topo Chico 0%',
    selectedBatch === topoVal || selectedBatch === 'custom:topo_chico' || (batchAttr.recipeName && batchAttr.recipeName.toLowerCase().includes('topo chico')));
  batchSelect.appendChild(topoOpt);

  // Auto-check "Show Tap on Dashboard" whenever a non-empty brew batch is chosen
  batchSelect.onchange = () => {
    if (batchSelect.value !== '') {
      document.getElementById('tapSettingsEnabledCheckbox').checked = true;
    }
  };

  // Set Graphic & Enabled
  document.getElementById('tapSettingsGraphicSelect').value = tap.graphic || 'corny_keg';

  const isEnabled = tap.enabled === 1 || (batchSelect.value !== '');
  document.getElementById('tapSettingsEnabledCheckbox').checked = isEnabled;

  // Set Display Unit & Custom Pour Input
  const unitSelect = document.getElementById('tapSettingsDisplayUnitSelect');
  unitSelect.value = tap.display_unit || 'percent';
  
  const customInput = document.getElementById('tapSettingsCustomPourInput');
  customInput.value = tap.custom_pour_size || 12.0;

  toggleCustomPourSizeUI(unitSelect.value);

  // Set Overrides
  const hasOverride = tap.override_enabled === 1;
  const overrideToggle = document.getElementById('tapSettingsOverrideToggle');
  overrideToggle.checked = hasOverride;
  toggleOverrideFieldsUI(hasOverride);

  document.getElementById('overrideName').value = tap.override_name || '';
  document.getElementById('overrideStyle').value = tap.override_style || '';
  document.getElementById('overrideAbv').value = tap.override_abv !== null && tap.override_abv !== undefined ? tap.override_abv : '';
  document.getElementById('overrideIbu').value = tap.override_ibu !== null && tap.override_ibu !== undefined ? tap.override_ibu : '';
  document.getElementById('overrideOg').value = tap.override_og !== null && tap.override_og !== undefined ? tap.override_og : '';
  document.getElementById('overrideFg').value = tap.override_fg !== null && tap.override_fg !== undefined ? tap.override_fg : '';
  document.getElementById('overrideSrm').value = tap.override_srm !== null && tap.override_srm !== undefined ? tap.override_srm : '';
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
  const itemsContainer = document.getElementById('onDeckItems');
  if (!itemsContainer) return;

  const onDeckBrews = appState.catalog.filter(c => c.on_deck === 1);
  if (onDeckBrews.length === 0) {
    itemsContainer.replaceChildren(buildOnDeckItems(onDeckBrews));
    return;
  }

  itemsContainer.replaceChildren(buildOnDeckItems(onDeckBrews));
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

// Modal Listeners Setup
function initModalListeners() {
  // Font Select Live Preview Listeners
  document.getElementById('titleFontSelect')?.addEventListener('change', updateFontPreviews);
  document.getElementById('titleFontSelect')?.addEventListener('input', updateFontPreviews);
  document.getElementById('bodyFontSelect')?.addEventListener('change', updateFontPreviews);
  document.getElementById('bodyFontSelect')?.addEventListener('input', updateFontPreviews);
  // Close Recipe Modal
  const closeRecipeBtn = document.getElementById('closeRecipeBtn');
  if (closeRecipeBtn) {
    closeRecipeBtn.addEventListener('click', () => {
      document.getElementById('recipeModal').style.display = 'none';
    });
  }

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
  if (pinSubmitBtn) {
    pinSubmitBtn.addEventListener('click', submitPin);
  }
  document.getElementById('pinInput')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitPin();
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

  // Close Settings Modals
  document.getElementById('closeGlobalSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('globalSettingsModal').style.display = 'none';
  });
  document.getElementById('closeTapSettingsBtn')?.addEventListener('click', () => {
    document.getElementById('tapSettingsModal').style.display = 'none';
  });

  ['recipeModal', 'pinModal', 'globalSettingsModal', 'tapSettingsModal'].forEach(id => {
    const modal = document.getElementById(id);
    modal?.addEventListener('click', event => {
      if (event.target === modal) modal.style.display = 'none';
    });
  });

  // Save Global Settings
  document.getElementById('saveGlobalSettingsBtn')?.addEventListener('click', async () => {
    const theme = document.getElementById('themeSelect').value;
    const title = document.getElementById('headerTitleInput').value;
    const font_title = document.getElementById('titleFontSelect').value;
    const font_body = document.getElementById('bodyFontSelect').value;
    const new_pin = document.getElementById('pinInputSetting').value;

    const tap_visibilities = {};
    for (let i = 1; i <= 6; i++) {
      const check = document.getElementById(`globalTapCheck_${i}`);
      if (check) {
        tap_visibilities[i] = check.checked;
      }
    }

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ theme, title, font_title, font_body, tap_visibilities, new_pin: new_pin || undefined })
      });
      if (res.ok) {
        const result = await res.json();
        document.getElementById('globalSettingsModal').style.display = 'none';
        document.getElementById('pinInputSetting').value = '';
        if (result.sessionsRevoked) {
          authToken = null;
          sessionStorage.removeItem('tapboard_token');
          updateAuthUI();
          showToast('🔑 PIN updated. Sign in again to manage Tapboard.');
        } else {
          showToast('✨ Global studio settings saved!');
        }
      } else {
        alert('Failed to save settings');
      }
    } catch (err) {
      alert('Error saving settings');
    }
  });

  // Save Per-Tap Settings
  document.getElementById('saveTapSettingsBtn')?.addEventListener('click', async () => {
    if (!editingTapId) return;

    const graphic = document.getElementById('tapSettingsGraphicSelect').value;
    const enabled = document.getElementById('tapSettingsEnabledCheckbox').checked;
    const display_unit = document.getElementById('tapSettingsDisplayUnitSelect').value;
    const custom_pour_size = document.getElementById('tapSettingsCustomPourInput').value;

    const override_enabled = document.getElementById('tapSettingsOverrideToggle').checked;
    const override_name = document.getElementById('overrideName').value;
    const override_style = document.getElementById('overrideStyle').value;
    const override_abv = document.getElementById('overrideAbv').value;
    const override_ibu = document.getElementById('overrideIbu').value;
    const override_og = document.getElementById('overrideOg').value;
    const override_fg = document.getElementById('overrideFg').value;
    const override_srm = document.getElementById('overrideSrm').value;
    const override_description = document.getElementById('overrideDescription').value;

    const badge_low_keg = document.getElementById('badgeLowKegToggle').checked ? 20 : 0;
    const badge_fresh = document.getElementById('badgeFreshToggle').checked;
    const batch_option = document.getElementById('tapSettingsBatchSelect').value;

    try {
      const res = await fetch(`/api/taps/${editingTapId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          graphic,
          enabled,
          display_unit,
          custom_pour_size,
          override_enabled,
          override_name,
          override_style,
          override_abv,
          override_ibu,
          override_og,
          override_fg,
          override_srm,
          override_description,
          badge_low_keg,
          badge_fresh,
          batch_option
        })
      });

      if (res.ok) {
        document.getElementById('tapSettingsModal').style.display = 'none';
        showToast(`✨ Tap ${editingTapId} settings saved!`);
      } else {
        alert('Failed to save tap settings');
      }
    } catch (err) {
      alert('Error saving tap settings');
    }
  });

  // Action Button: End Batch
  document.getElementById('tapSettingsEndBatchBtn')?.addEventListener('click', async () => {
    if (!editingTapId) return;
    if (confirm(`Complete Brewfather batch for Tap ${editingTapId}? This will set the batch to Completed and unassign the tap.`)) {
      try {
        const res = await fetch(`/api/taps/${editingTapId}/end-batch`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
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

  // Action Button: End Keg
  document.getElementById('tapSettingsEndKegBtn')?.addEventListener('click', async () => {
    if (!editingTapId) return;
    if (confirm(`End keg on Tap ${editingTapId}? This will unassign the tap without marking the Brewfather batch completed.`)) {
      try {
        const res = await fetch(`/api/taps/${editingTapId}/end-keg`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
          document.getElementById('tapSettingsModal').style.display = 'none';
          showToast(`🍺 Tap ${editingTapId} keg ended / off-tap.`);
        } else {
          alert('Failed to end keg');
        }
      } catch (err) {
        alert('Error executing end keg');
      }
    }
  });
}

// Initialize Client Engine
window.addEventListener('DOMContentLoaded', () => {
  initSSE();
  initModalListeners();
});
