// Tapboard v3.4 Client Engine
import { renderTapGraphic, srmToHex } from './graphics.js';

let appState = {
  settings: {},
  taps: [],
  batches: [],
  catalog: [],
  haStates: {},
  kegKickForecasts: {}
};

let editingTapId = null;
let authToken = sessionStorage.getItem('tapboard_token') || null;

// Connect to Server-Sent Events (SSE) Stream
function initSSE() {
  const eventSource = new EventSource('/events');

  eventSource.onopen = () => {
    console.log('[SSE] Live stream connected.');
    updateClockStatus('Live Connected');
  };

  eventSource.onerror = (err) => {
    console.warn('[SSE] Connection error/reconnecting...', err);
    updateClockStatus('Reconnecting...');
  };

  // 1. Initial Snapshot
  eventSource.addEventListener('snapshot', (e) => {
    appState = JSON.parse(e.data);
    renderApp();
  });

  // 2. HA State Changed
  eventSource.addEventListener('state_changed', (e) => {
    const { entity_id, state } = JSON.parse(e.data);
    appState.haStates[entity_id] = state;
    renderApp();
  });

  // 3. Instant Pour Animation Start
  eventSource.addEventListener('pour_start', (e) => {
    const { tapId } = JSON.parse(e.data);
    console.log(`[Pour Start] Animating Tap ${tapId}`);
    setTapPouringAnimation(tapId, true);
  });

  // 4. Pour Complete Summary & Toast Notification
  eventSource.addEventListener('pour_complete', (e) => {
    const { tapId, volumePouredOz, beerName } = JSON.parse(e.data);
    console.log(`[Pour Complete] Tap ${tapId}: ${volumePouredOz} oz`);
    setTapPouringAnimation(tapId, false);
    showToast(`🍺 Poured ${volumePouredOz} oz of ${beerName}!`);
  });

  // 5. Low Keg Alert
  eventSource.addEventListener('low_keg_alert', (e) => {
    const { tapId, currentPercent } = JSON.parse(e.data);
    showToast(`⚠️ Low Keg Warning: Tap ${tapId} at ${currentPercent}%!`);
  });

  // 6. Settings Updated
  eventSource.addEventListener('settings_updated', (e) => {
    appState = JSON.parse(e.data);
    renderApp();
  });
}

function updateClockStatus(text) {
  const clockEl = document.getElementById('headerClock');
  if (clockEl) {
    clockEl.textContent = text;
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

// Toggle Pouring Visual Effect on Tap Card
function setTapPouringAnimation(tapId, isPouring) {
  const card = document.querySelector(`.tap-card[data-tap-id="${tapId}"]`);
  if (!card) return;

  const wrapper = card.querySelector('.tap-graphic-wrapper');
  if (wrapper) {
    if (isPouring) {
      wrapper.classList.add('is-pouring');
    } else {
      wrapper.classList.remove('is-pouring');
    }
  }
}

// Main Render Function
function renderApp() {
  const { settings, taps } = appState;

  // Apply Theme & Fonts
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

  // Render Tap Grid
  const tapGrid = document.getElementById('tapGrid');
  if (!tapGrid) return;

  const activeTaps = taps.filter(t => t.enabled === 1);
  tapGrid.setAttribute('data-count', activeTaps.length);
  tapGrid.innerHTML = '';

  activeTaps.forEach(tap => {
    const card = createTapCard(tap);
    tapGrid.appendChild(card);
  });

  // Render On-Deck Ticker
  renderOnDeckTicker();
}

// Create Tap Card Element
function createTapCard(tap) {
  const tapId = tap.tap_id;
  const haStates = appState.haStates;

  // Resolve HA Sensor Data
  const fillState = haStates[`sensor.tap_${tapId}_fill`]?.state || '0';
  const ozState = haStates[`sensor.tap_${tapId}_fl_oz`]?.state || '0';
  const pintsState = haStates[`sensor.tap_${tapId}_pints_remaining`]?.state || '0';
  const batchAttr = haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};

  const fillPercent = Math.min(100, Math.max(0, parseFloat(fillState) || 0));

  // Base Brewfather values
  const bfName = batchAttr.recipe_name || batchAttr.name || `Tap ${tapId}`;
  const bfStyle = batchAttr.style || 'Custom Craft';
  const bfAbv = batchAttr.abv || 0;
  const bfIbu = batchAttr.ibu || 0;
  const bfOg = batchAttr.og || 'N/A';
  const bfFg = batchAttr.fg || 'N/A';
  const bfSrm = batchAttr.srm || batchAttr.color || 3;
  const bfDesc = batchAttr.tasting_notes || batchAttr.notes || '';

  // Field-Level Overrides: Use override if checked AND field is non-empty; else fallback to Brewfather!
  const hasOverride = tap.override_enabled === 1;
  const beerName = (hasOverride && tap.override_name && tap.override_name.trim() !== '') ? tap.override_name : bfName;
  const style = (hasOverride && tap.override_style && tap.override_style.trim() !== '') ? tap.override_style : bfStyle;
  const abv = (hasOverride && tap.override_abv !== null && tap.override_abv !== undefined) ? tap.override_abv : bfAbv;
  const ibu = (hasOverride && tap.override_ibu !== null && tap.override_ibu !== undefined) ? tap.override_ibu : bfIbu;
  const og = (hasOverride && tap.override_og !== null && tap.override_og !== undefined) ? tap.override_og : bfOg;
  const fg = (hasOverride && tap.override_fg !== null && tap.override_fg !== undefined) ? tap.override_fg : bfFg;
  const srm = (hasOverride && tap.override_srm !== null && tap.override_srm !== undefined) ? tap.override_srm : bfSrm;
  const description = (hasOverride && tap.override_description && tap.override_description.trim() !== '') ? tap.override_description : bfDesc;

  // Convert SRM to Hex Color
  const beerColorHex = srmToHex(srm);

  // 14-Day Rolling Keg Kick Forecast
  const forecast = appState.kegKickForecasts[tapId] || {};
  let forecastText = `⌛ Forecast calculating...`;
  if (forecast.estimatedDaysRemaining !== null && forecast.estimatedDaysRemaining !== undefined) {
    if (forecast.estimatedDaysRemaining < 1.0) {
      forecastText = `🔴 Kicking soon (< 1 day remaining)`;
    } else {
      forecastText = `⌛ ~${forecast.estimatedDaysRemaining} days remaining (${forecast.avgDailyOz} oz/day avg)`;
    }
  }

  const card = document.createElement('div');
  card.className = 'tap-card';
  card.setAttribute('data-tap-id', tapId);

  // Card Content
  card.innerHTML = `
    <div class="tap-card-header" style="display:flex; justify-content:space-between; align-items:center;">
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <span class="tap-number-badge">${tapId}</span>
        ${fillPercent <= (tap.badge_low_keg || 20) ? `<span class="badge badge-low">LOW KEG</span>` : ''}
        ${tap.badge_fresh === 1 ? `<span class="badge badge-fresh">FRESH!</span>` : ''}
      </div>
      <button class="btn-icon tap-cog-btn" title="Tap ${tapId} Settings" style="cursor:pointer; font-size:1.2rem; background:none; border:none;">⚙️</button>
    </div>

    <h2 class="beer-title" style="margin-top:0.5rem;">${beerName}</h2>
    <div class="beer-style">${style}</div>
    ${description ? `<p class="beer-description" style="margin-top:0.35rem; color:var(--text-muted); font-size:0.9rem; line-height:1.35;">${description}</p>` : ''}

    <div class="metrics-row" style="margin-top:0.85rem; display:flex; justify-content:space-around; background:rgba(0,0,0,0.2); padding:0.5rem; border-radius:0.5rem;">
      <div class="metric-item"><span class="metric-label" style="font-size:0.75rem; color:var(--text-muted);">ABV</span><br/><strong>${abv}%</strong></div>
      <div class="metric-item"><span class="metric-label" style="font-size:0.75rem; color:var(--text-muted);">IBU</span><br/><strong>${ibu}</strong></div>
      <div class="metric-item"><span class="metric-label" style="font-size:0.75rem; color:var(--text-muted);">OG</span><br/><strong>${og}</strong></div>
      <div class="metric-item"><span class="metric-label" style="font-size:0.75rem; color:var(--text-muted);">FG</span><br/><strong>${fg}</strong></div>
    </div>

    <div class="graphic-container" style="margin-top:1rem; text-align:center;">
      <div class="tap-graphic-wrapper" id="graphic-tap-${tapId}"></div>
      <div class="volume-readout" style="margin-top:0.5rem; font-weight:700; font-size:1rem;">
        ${fillPercent.toFixed(1)}% Full • ${pintsState} Pints (${parseFloat(ozState).toFixed(0)} oz)
      </div>
    </div>

    <div style="font-size:0.8rem; color:var(--accent-color); margin-top:0.6rem; font-weight:600; text-align:center;">
      ${forecastText}
    </div>
  `;

  // Render SVG Vector Glassware Graphic
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
      <div><strong>ABV:</strong> ${abv}%</div>
      <div><strong>IBU:</strong> ${ibu}</div>
      <div><strong>SRM Color:</strong> ${srm}</div>
      <div><strong>Original Gravity:</strong> ${og}</div>
      <div><strong>Final Gravity:</strong> ${fg}</div>
    </div>
    
    ${batchAttr.brew_date ? `<div style="margin-top:0.5rem;"><strong>Brew Date:</strong> ${batchAttr.brew_date}</div>` : ''}
    
    <div style="margin-top:0.75rem;">
      <strong>Tasting Notes & Profile:</strong>
      <p style="color:var(--text-muted); margin-top:0.35rem; line-height:1.4;">
        ${description || 'Crafted with premium grains and fresh hops.'}
      </p>
    </div>
  `;

  modal.style.display = 'flex';
}

// Open Per-Tap Settings Modal
function openTapSettings(tapId) {
  editingTapId = tapId;
  const tap = appState.taps.find(t => t.tap_id === tapId) || {};
  const batchAttr = appState.haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};

  document.getElementById('tapSettingsTitle').textContent = `Tap ${tapId} Settings Studio`;

  // Populate Batch Select Dropdown
  const batchSelect = document.getElementById('tapSettingsBatchSelect');
  batchSelect.innerHTML = '<option value="">-- Empty / Off Tap --</option>';

  const activeBatches = appState.batches || [];
  activeBatches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.batch_id;
    opt.textContent = `${b.recipe_name} (${b.style || 'Batch'})`;
    if (b.batch_id === batchAttr.batch_id) opt.selected = true;
    batchSelect.appendChild(opt);
  });

  // Set Graphic & Enabled
  document.getElementById('tapSettingsGraphicSelect').value = tap.graphic || 'corny_keg';
  document.getElementById('tapSettingsEnabledCheckbox').checked = tap.enabled === 1;

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
        document.getElementById('globalSettingsModal').style.display = 'flex';
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
            document.getElementById('globalSettingsModal').style.display = 'flex';
          }
        } else {
          alert(data.error || 'Invalid PIN');
        }
      } catch (err) {
        alert('Authentication request failed');
      }
    });
  }

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

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ theme, title, font_title, font_body, new_pin: new_pin || undefined })
      });
      if (res.ok) {
        document.getElementById('globalSettingsModal').style.display = 'none';
        showToast('✨ Studio settings saved!');
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
