// Tapboard v3.8.2 Client Engine
import { renderTapGraphic, srmToHex } from './graphics.js';

let appState = {
  settings: {},
  taps: [],
  batches: [],
  catalog: [],
  haStates: {},
  haConnected: true,
  kegKickForecasts: {}
};

let editingTapId = null;
let authToken = sessionStorage.getItem('tapboard_token') || null;

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
    updateClockStatus(appState.haConnected ? 'Live Stream Connected' : 'HA Disconnected (Cached Data)');
  };

  eventSource.onerror = (err) => {
    console.warn('[SSE] Connection error/reconnecting...', err);
    updateClockStatus('Reconnecting...');
  };

  // 1. Initial Snapshot
  eventSource.addEventListener('snapshot', (e) => {
    appState = JSON.parse(e.data);
    updateClockStatus(appState.haConnected ? 'Live Stream Connected' : 'HA Disconnected (Cached Data)');
    renderApp();
  });

  // 2. HA Connection Status Change
  eventSource.addEventListener('ha_connection_status', (e) => {
    const { isConnected } = JSON.parse(e.data);
    appState.haConnected = isConnected;
    updateClockStatus(isConnected ? 'Live Stream Connected' : 'HA Disconnected (Cached Data)');
  });

  // 3. HA State Changed
  eventSource.addEventListener('state_changed', (e) => {
    const { entity_id, state } = JSON.parse(e.data);
    appState.haStates[entity_id] = state;
    renderApp();
  });

  // 4. Instant Pour Animation Start
  eventSource.addEventListener('pour_start', (e) => {
    const { tapId } = JSON.parse(e.data);
    console.log(`[Pour Start] Animating Tap ${tapId}`);
    setTapPouringAnimation(tapId, true);
  });

  // 5. Pour Complete Summary & Toast Notification
  eventSource.addEventListener('pour_complete', (e) => {
    const { tapId, volumePouredOz, beerName } = JSON.parse(e.data);
    console.log(`[Pour Complete] Tap ${tapId}: ${volumePouredOz} oz`);
    setTapPouringAnimation(tapId, false);
    showToast(`🍺 Poured ${volumePouredOz} oz of ${beerName}!`);
  });

  // 6. Low Keg Alert
  eventSource.addEventListener('low_keg_alert', (e) => {
    const { tapId, currentPercent } = JSON.parse(e.data);
    showToast(`⚠️ Low Keg Warning: Tap ${tapId} at ${currentPercent}%!`);
  });

  // 7. Settings Updated
  eventSource.addEventListener('settings_updated', (e) => {
    appState = JSON.parse(e.data);
    renderApp();
  });
}

function updateClockStatus(text) {
  const clockEl = document.getElementById('headerClock');
  if (clockEl) {
    clockEl.textContent = text;
    if (text.includes('Disconnected') || text.includes('Reconnecting')) {
      clockEl.style.color = '#ffa726';
    } else {
      clockEl.style.color = '';
    }
  }
}

// Show Toast Notification
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-message';
  toast.style.cssText = `
    background: var(--bg-header);
    color: var(--text-main);
    border: 1px solid var(--accent-color);
    padding: 1rem 1.25rem;
    border-radius: 0.75rem;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    font-weight: 600;
    margin-bottom: 0.75rem;
    animation: fadeIn 0.3s ease;
  `;
  toast.textContent = message;

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

    // Add dynamic "NOW POURING" header badge if not present
    if (headerBadges && !headerBadges.querySelector('.badge-pouring')) {
      const badge = document.createElement('span');
      badge.className = 'badge-pouring';
      badge.innerHTML = '🍺 NOW POURING';
      headerBadges.insertBefore(badge, headerBadges.firstChild);
    }
  } else {
    // Pour Complete: Stream stops & calm 2s settle back to actual remaining keg volume
    if (streamGroup) streamGroup.classList.remove('is-active');

    card.classList.add('is-settling');

    // Calculate target Y & height for real remaining keg percentage
    const fillState = appState.haStates[`sensor.tap_${tapId}_fill`]?.state;
    const parsedFill = parseFloat(fillState);
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

      if (headerBadges) {
        const badge = headerBadges.querySelector('.badge-pouring');
        if (badge) badge.remove();
      }
    }, 2000);
  }
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
    return `⌛ Forecast calculating...`;
  }

  if (forecast.estimatedDaysRemaining < 1.0) {
    return `🔴 Kicking soon`;
  }

  if (forecast.isEstimatedBaseline) {
    return `⌛ ${forecast.estimatedDaysRemaining} days remaining`;
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
  const haStates = appState.haStates;

  const fillState = haStates[`sensor.tap_${tapId}_fill`]?.state || '0';
  const ozState = haStates[`sensor.tap_${tapId}_fl_oz`]?.state || '0';
  const pintsState = haStates[`sensor.tap_${tapId}_pints_remaining`]?.state || '0';
  const batchAttr = haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};

  // 3-Tier Recipe Lookup Hierarchy (Overrides -> HA Attributes -> Local Batches Cache)
  const cachedBatch = (tap.batch_id && appState.batches) ? appState.batches.find(b => b.batch_id === tap.batch_id) : null;

  const fillPercent = Math.min(100, Math.max(0, parseFloat(fillState) || 0));
  const currentOz = parseFloat(ozState) > 0 ? parseFloat(ozState) : (fillPercent / 100.0) * 640.0;
  const pintsRemaining = parseFloat(pintsState) || (currentOz / 16.0);

  const bfName = batchAttr.recipe_name || batchAttr.name || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = batchAttr.abv || (cachedBatch ? cachedBatch.abv : null) || '--';
  const bfIbu = batchAttr.ibu || (cachedBatch ? cachedBatch.ibu : null) || '--';
  const bfOg = batchAttr.og || (cachedBatch ? cachedBatch.og : null) || '--';
  const bfFg = batchAttr.fg || (cachedBatch ? cachedBatch.fg : null) || '--';
  const bfSrm = batchAttr.srm || batchAttr.color || (cachedBatch ? cachedBatch.srm : null) || 3;
  const bfDesc = batchAttr.tasting_notes || batchAttr.notes || (cachedBatch ? cachedBatch.description : null) || '';

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

  card.innerHTML = `
    <div class="tap-card-header">
      <div class="tap-number-badge">${tapId}</div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        ${fillPercent <= (tap.badge_low_keg || 20) ? `<span class="badge badge-low">LOW KEG!</span>` : ''}
        ${tap.badge_fresh === 1 ? `<span class="badge badge-fresh">FRESH!</span>` : ''}
        <button class="btn-icon tap-cog-btn" title="Tap ${tapId} Settings">⚙️</button>
      </div>
    </div>

    <h2 class="beer-title">${beerName}</h2>
    <div class="beer-style">${style}</div>
    ${description ? `<p class="beer-description" style="margin-bottom:0.75rem;">${description}</p>` : ''}

    <div class="metrics-row">
      <div class="metric-item"><span class="metric-label">ABV</span><span class="metric-value">${abv}</span></div>
      <div class="metric-item"><span class="metric-label">IBU</span><span class="metric-value">${ibu}</span></div>
      <div class="metric-item"><span class="metric-label">OG</span><span class="metric-value">${og}</span></div>
      <div class="metric-item"><span class="metric-label">FG</span><span class="metric-value">${fg}</span></div>
    </div>

    <div class="graphic-container">
      <div class="tap-graphic-wrapper" id="graphic-tap-${tapId}"></div>
      <div class="volume-readout">${volumeReadoutText}</div>
    </div>

    <div class="forecast-readout" style="font-size:0.8rem; color:var(--accent-color); margin-top:0.6rem; font-weight:600; text-align:center;">
      ${forecastText}
    </div>

    <button class="btn-simulate-pour" title="Simulate Pour on Tap ${tapId}">🍺 Simulate Pour</button>
  `;

  // Render SVG Graphic initially
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  if (graphicContainer && typeof renderTapGraphic === 'function') {
    graphicContainer.innerHTML = renderTapGraphic(tap.graphic || 'corny_keg', fillPercent, beerColorHex, false, `tap_${tapId}`);
  }

  // Simulate Pour Button Click
  const simBtn = card.querySelector('.btn-simulate-pour');
  if (simBtn) {
    simBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fetch(`/api/taps/${tapId}/simulate-pour`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
          showToast(`⚡ Triggering test pour on Tap ${tapId}...`);
        })
        .catch(err => console.error('[Simulate Pour Error]', err));
    });
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
        document.getElementById('pinModal').style.display = 'flex';
      }
    });
  }

  // Card Body Click: Open Recipe Detail Modal
  card.addEventListener('click', () => {
    openRecipeModal(tapId, beerName, style, abv, ibu, og, fg, srm, description, batchAttr);
  });

  return card;
}

// In-Place Update for existing Tap Card element
function updateTapCard(card, tap) {
  const tapId = tap.tap_id;
  const haStates = appState.haStates;

  const fillState = haStates[`sensor.tap_${tapId}_fill`]?.state || '0';
  const ozState = haStates[`sensor.tap_${tapId}_fl_oz`]?.state || '0';
  const pintsState = haStates[`sensor.tap_${tapId}_pints_remaining`]?.state || '0';
  const batchAttr = haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};

  // 3-Tier Recipe Lookup Hierarchy (Overrides -> HA Attributes -> Local Batches Cache)
  const cachedBatch = (tap.batch_id && appState.batches) ? appState.batches.find(b => b.batch_id === tap.batch_id) : null;

  const fillPercent = Math.min(100, Math.max(0, parseFloat(fillState) || 0));
  const currentOz = parseFloat(ozState) > 0 ? parseFloat(ozState) : (fillPercent / 100.0) * 640.0;
  const pintsRemaining = parseFloat(pintsState) || (currentOz / 16.0);

  const bfName = batchAttr.recipe_name || batchAttr.name || (cachedBatch ? cachedBatch.recipe_name : null) || `Tap ${tapId}`;
  const rawStyle = batchAttr.style || (cachedBatch ? cachedBatch.style : null) || 'Craft Beer';
  const bfStyle = deriveBeerStyle(bfName, rawStyle);
  const bfAbv = batchAttr.abv || (cachedBatch ? cachedBatch.abv : null) || '--';
  const bfIbu = batchAttr.ibu || (cachedBatch ? cachedBatch.ibu : null) || '--';
  const bfOg = batchAttr.og || (cachedBatch ? cachedBatch.og : null) || '--';
  const bfFg = batchAttr.fg || (cachedBatch ? cachedBatch.fg : null) || '--';
  const bfSrm = batchAttr.srm || batchAttr.color || (cachedBatch ? cachedBatch.srm : null) || 3;

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
  if (forecastEl && forecastEl.textContent !== forecastText) {
    forecastEl.textContent = forecastText;
  }

  // Re-render SVG if graphic style, color hex, or fill percent changed
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  const currentGraphicStyle = card.getAttribute('data-graphic-style');
  const currentColorHex = card.getAttribute('data-color-hex');

  if (!graphicContainer.innerHTML || currentGraphicStyle !== (tap.graphic || 'corny_keg') || currentColorHex !== beerColorHex) {
    card.setAttribute('data-graphic-style', tap.graphic || 'corny_keg');
    card.setAttribute('data-color-hex', beerColorHex);
    graphicContainer.innerHTML = renderTapGraphic(tap.graphic || 'corny_keg', fillPercent, beerColorHex, false, `tap_${tapId}`);
  }
}

// Open Recipe Detail Modal
function openRecipeModal(tapId, beerName, style, abv, ibu, og, fg, srm, description, batchAttr) {
  const modal = document.getElementById('recipeModal');
  const title = document.getElementById('recipeTitle');
  const body = document.getElementById('recipeBody');

  if (!modal || !title || !body) return;

  title.textContent = `${beerName}`;
  body.innerHTML = `
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; background:var(--bg-card); padding:1rem; border-radius:0.75rem;">
      <div><strong>Style:</strong> ${style}</div>
      <div><strong>ABV:</strong> ${abv}</div>
      <div><strong>IBU:</strong> ${ibu}</div>
      <div><strong>SRM Color:</strong> ${srm}</div>
      <div><strong>Original Gravity:</strong> ${og}</div>
      <div><strong>Final Gravity:</strong> ${fg}</div>
    </div>
    
    ${batchAttr.brew_date ? `<div style="margin-top:0.5rem;"><strong>Brew Date:</strong> ${batchAttr.brew_date}</div>` : ''}
    
    <div style="margin-top:0.75rem;">
      <strong>Tasting Notes & Profile:</strong>
      <p style="color:var(--text-muted); margin-top:0.35rem; line-height:1.4;">
        ${description || 'Crafted with premium ingredients.'}
      </p>
    </div>
  `;

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

  document.getElementById('globalSettingsModal').style.display = 'flex';
}

// Open Per-Tap Settings Modal
function openTapSettings(tapId) {
  editingTapId = tapId;
  const tap = appState.taps.find(t => t.tap_id === tapId) || {};
  const batchAttr = appState.haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};
  const selectEntity = appState.haStates[`select.tap_${tapId}_batch_select`];
  const rawOptions = selectEntity?.attributes?.options || [];

  document.getElementById('tapSettingsTitle').textContent = `Tap ${tapId} Settings Studio`;

  const batchSelect = document.getElementById('tapSettingsBatchSelect');
  batchSelect.innerHTML = '';

  const offTapOpt = document.createElement('option');
  offTapOpt.value = '';
  offTapOpt.textContent = '-- Empty / Off Tap --';
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
    const opt = document.createElement('option');
    opt.value = optStr;
    const parts = optStr.split('|');
    const label = parts.length > 1 ? parts[1].trim() : optStr;
    opt.textContent = label;

    if (selectEntity?.state === optStr || (tap.batch_id && optStr.includes(tap.batch_id)) || (batchAttr.batch_id && optStr.includes(batchAttr.batch_id))) {
      opt.selected = true;
    }
    batchSelect.appendChild(opt);
  });

  const topoOpt = document.createElement('option');
  const topoVal = topoChicoOption || 'custom:topo_chico | Topo Chico 0%';
  topoOpt.value = topoVal;
  topoOpt.textContent = 'Topo Chico 0%';
  if (selectEntity?.state === topoVal || selectEntity?.state === 'custom:topo_chico' || (batchAttr.name && batchAttr.name.toLowerCase().includes('topo chico'))) {
    topoOpt.selected = true;
  }
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
    itemsContainer.innerHTML = `<span class="ondeck-item">All fermenters available</span>`;
    return;
  }

  itemsContainer.innerHTML = onDeckBrews.map(brew => `
    <span class="ondeck-item" style="margin-right:1.5rem;">
      🍺 <strong>${brew.name}</strong> (${brew.style || 'Craft'}) - ${brew.abv}% ABV
    </span>
  `).join('');
}

// Modal Listeners Setup
function initModalListeners() {
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
        document.getElementById('pinModal').style.display = 'flex';
      }
    });
  }

  // PIN Submit
  const pinSubmitBtn = document.getElementById('pinSubmitBtn');
  if (pinSubmitBtn) {
    pinSubmitBtn.addEventListener('click', async () => {
      const pin = document.getElementById('pinInput').value;
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (res.ok && data.token) {
          authToken = data.token;
          sessionStorage.setItem('tapboard_token', authToken);
          document.getElementById('pinModal').style.display = 'none';

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
      }
    });
  }

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
        document.getElementById('globalSettingsModal').style.display = 'none';
        showToast('✨ Global studio settings saved!');
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
