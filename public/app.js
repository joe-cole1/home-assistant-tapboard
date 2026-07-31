// Tapboard v3.2 Client Engine
let appState = {
  settings: {},
  taps: [],
  batches: [],
  catalog: [],
  haStates: {},
  kegKickForecasts: {}
};

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

  if (isPouring) {
    card.classList.add('pouring-active');
  } else {
    card.classList.remove('pouring-active');
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

  // Resolve HA Sensor Data or Overrides
  const fillState = haStates[`sensor.tap_${tapId}_fill`]?.state || '0';
  const ozState = haStates[`sensor.tap_${tapId}_fl_oz`]?.state || '0';
  const pintsState = haStates[`sensor.tap_${tapId}_pints_remaining`]?.state || '0';
  const batchAttr = haStates[`sensor.tap_${tapId}_batch_info`]?.attributes || {};

  const fillPercent = Math.min(100, Math.max(0, parseFloat(fillState) || 0));

  let beerName = tap.override_enabled ? tap.override_name : (batchAttr.recipe_name || `Tap ${tapId}`);
  let style = tap.override_enabled ? tap.override_style : (batchAttr.style || 'Custom Craft');
  let abv = tap.override_enabled ? tap.override_abv : (batchAttr.abv || 0);
  let ibu = tap.override_enabled ? tap.override_ibu : (batchAttr.ibu || 0);

  const forecast = appState.kegKickForecasts[tapId] || {};
  const forecastText = forecast.estimatedDaysRemaining
    ? `⌛ ~${forecast.estimatedDaysRemaining} days remaining`
    : `⌛ Forecast calculating...`;

  const card = document.createElement('div');
  card.className = 'tap-card';
  card.setAttribute('data-tap-id', tapId);
  card.style.cursor = 'pointer';

  // Card Content
  card.innerHTML = `
    <div class="tap-card-header">
      <span class="tap-number">TAP ${tapId}</span>
      ${fillPercent <= (tap.badge_low_keg || 20) ? `<span class="badge badge-low">LOW KEG</span>` : ''}
    </div>

    <div class="tap-graphic-container" id="graphic-tap-${tapId}">
      <!-- SVG Rendered below -->
    </div>

    <div class="tap-info">
      <h2 class="beer-name">${beerName}</h2>
      <p class="beer-style">${style}</p>
      
      <div class="beer-stats">
        <span class="stat-pill">ABV: ${abv}%</span>
        <span class="stat-pill">IBU: ${ibu}</span>
      </div>

      <div class="keg-volume-container" style="margin-top:0.75rem;">
        <div class="keg-volume-bar" style="background:var(--bg-card); height:10px; border-radius:5px; overflow:hidden; border:1px solid var(--border-color);">
          <div style="background:var(--accent-color); width:${fillPercent}%; height:100%; transition:width 0.5s ease;"></div>
        </div>
        <div style="display:flex; justify-space-between; font-size:0.85rem; margin-top:0.35rem; color:var(--text-muted);">
          <span>${fillPercent.toFixed(0)}% (${pintsState} pints)</span>
          <span>${ozState} oz</span>
        </div>
      </div>

      <div style="font-size:0.8rem; color:var(--accent-color); margin-top:0.5rem; font-weight:600;">
        ${forecastText}
      </div>
    </div>
  `;

  // Render SVG Graphic
  const graphicContainer = card.querySelector(`#graphic-tap-${tapId}`);
  if (graphicContainer && typeof window.renderTapGraphic === 'function') {
    graphicContainer.innerHTML = window.renderTapGraphic(tap.graphic || 'default', fillPercent);
  }

  // Click Event: Open Recipe Detail Modal
  card.addEventListener('click', (e) => {
    openRecipeModal(tapId, beerName, style, abv, ibu, batchAttr);
  });

  return card;
}

// Open Recipe Detail Modal
function openRecipeModal(tapId, beerName, style, abv, ibu, batchAttr) {
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
      <div><strong>SRM Color:</strong> ${batchAttr.srm || batchAttr.color || 'N/A'}</div>
      <div><strong>Original Gravity:</strong> ${batchAttr.og || 'N/A'}</div>
      <div><strong>Final Gravity:</strong> ${batchAttr.fg || 'N/A'}</div>
    </div>
    
    ${batchAttr.brew_date ? `<div><strong>Brew Date:</strong> ${batchAttr.brew_date}</div>` : ''}
    
    <div style="margin-top:0.5rem;">
      <strong>Tasting Notes & Profile:</strong>
      <p style="color:var(--text-muted); margin-top:0.35rem; line-height:1.5;">
        ${batchAttr.tasting_notes || batchAttr.notes || 'Crafted with premium grains and fresh hops.'}
      </p>
    </div>
  `;

  modal.style.display = 'flex';
}

// Render On-Deck Ticker
function renderOnDeckTicker() {
  const itemsContainer = document.getElementById('onDeckItems');
  if (!itemsContainer) return;

  const onDeckBrews = appState.catalog.filter(c => c.on_deck === 1);
  if (onDeckBrews.length === 0) {
    itemsContainer.innerHTML = `<span class="ondeck-item">No upcoming brews scheduled</span>`;
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

  // Open Settings Modal (triggers PIN modal if unauthorized)
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (authToken) {
        openSettingsModal();
      } else {
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
          openSettingsModal();
        } else {
          alert(data.error || 'Invalid PIN');
        }
      } catch (err) {
        alert('Authentication request failed');
      }
    });
  }

  // Close Settings Modal
  const closeTapSettingsBtn = document.getElementById('closeTapSettingsBtn');
  if (closeTapSettingsBtn) {
    closeTapSettingsBtn.addEventListener('click', () => {
      document.getElementById('tapSettingsModal').style.display = 'none';
    });
  }

  // Save Settings
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
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
          document.getElementById('tapSettingsModal').style.display = 'none';
          showToast('Settings saved successfully!');
        } else {
          alert('Failed to save settings');
        }
      } catch (err) {
        alert('Request error saving settings');
      }
    });
  }
}

function openSettingsModal() {
  const modal = document.getElementById('tapSettingsModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

// Initialize Client Engine
window.addEventListener('DOMContentLoaded', () => {
  initSSE();
  initModalListeners();
});
