/*
 * Per-browser display preferences. This is deliberately a classic script so it
 * can run synchronously as the first child of body, before the dashboard paints.
 * It contains only presentation preferences; never add credentials or HA data.
 */
(function installDisplayPreferences(global) {
  'use strict';

  const STORAGE_KEY = 'tapboard.display-preferences.v2';
  const LEGACY_STORAGE_KEY = 'tapboard.display-preferences.v1';
  const VERSION = 2;
  const THEMES = new Set(['modern_dark', 'warm_pub', 'cyberpunk', 'light_minimal']);
  const TITLE_FONTS = new Set([
    'Outfit',
    'Roboto',
    'Carter One',
    'Balsamiq Sans',
    'Fredoka',
    'Permanent Marker',
    'Montserrat'
  ]);
  const BODY_FONTS = new Set(['Inter', 'Roboto', 'Balsamiq Sans', 'Outfit', 'Fredoka', 'Montserrat']);
  const LAYOUTS = new Set(['cozy', 'compact']);
  const COLOR_FIELDS = new Set(['primary_color', 'secondary_color']);
  const FIELDS = new Set([
    'theme',
    'font_title',
    'font_body',
    'primary_color',
    'secondary_color',
    'layout_mode',
    'sound_enabled'
  ]);
  let memoryOverrides = {};
  let storageDegraded = false;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeColor(value) {
    const color = typeof value === 'string' ? value.trim() : '';
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : null;
  }

  function validateValue(field, value) {
    if (COLOR_FIELDS.has(field)) return value === null ? null : normalizeColor(value);
    if (field === 'theme') return THEMES.has(value) ? value : undefined;
    if (field === 'font_title') return TITLE_FONTS.has(value) ? value : undefined;
    if (field === 'font_body') return BODY_FONTS.has(value) ? value : undefined;
    if (field === 'layout_mode') return LAYOUTS.has(value) ? value : undefined;
    if (field === 'sound_enabled') return typeof value === 'boolean' ? value : undefined;
    return undefined;
  }

  function validateOverrides(overrides) {
    if (!isPlainObject(overrides)) return {};
    const valid = {};
    for (const [field, value] of Object.entries(overrides)) {
      if (!FIELDS.has(field)) continue;
      const normalized = validateValue(field, value);
      if (normalized !== undefined && (COLOR_FIELDS.has(field) ? normalized !== null || value === null : true)) {
        valid[field] = normalized;
      }
    }
    return valid;
  }

  function clone(overrides) {
    return { ...overrides };
  }

  function parse(raw) {
    if (typeof raw !== 'string') return {};
    try {
      const record = JSON.parse(raw);
      if (!isPlainObject(record) || record.version !== VERSION) return {};
      return validateOverrides(record.overrides);
    } catch (_error) {
      return {};
    }
  }

  function storage() {
    try {
      return global.localStorage || null;
    } catch (_error) {
      return null;
    }
  }

  function read() {
    if (storageDegraded) return { overrides: clone(memoryOverrides), persistence: 'memory' };
    const local = storage();
    if (!local) {
      storageDegraded = true;
      return { overrides: clone(memoryOverrides), persistence: 'memory' };
    }
    try {
      let overrides = parse(local.getItem(STORAGE_KEY));
      if (!local.getItem(STORAGE_KEY)) {
        const legacyRaw = local.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          try {
            const legacy = JSON.parse(legacyRaw);
            if (isPlainObject(legacy) && legacy.version === 1) {
              overrides = validateOverrides(legacy.overrides);
              local.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, overrides }));
              local.removeItem(LEGACY_STORAGE_KEY);
            }
          } catch (_error) {
            overrides = {};
          }
        }
      }
      memoryOverrides = overrides;
      return { overrides: clone(overrides), persistence: 'persistent' };
    } catch (_error) {
      storageDegraded = true;
      return { overrides: clone(memoryOverrides), persistence: 'memory' };
    }
  }

  function write(overrides) {
    memoryOverrides = validateOverrides(overrides);
    if (storageDegraded) return { overrides: clone(memoryOverrides), persistence: 'memory' };
    const local = storage();
    if (!local) {
      storageDegraded = true;
      return { overrides: clone(memoryOverrides), persistence: 'memory' };
    }
    try {
      local.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, overrides: memoryOverrides }));
      return { overrides: clone(memoryOverrides), persistence: 'persistent' };
    } catch (_error) {
      storageDegraded = true;
      return { overrides: clone(memoryOverrides), persistence: 'memory' };
    }
  }

  function setOverride(field, value) {
    if (!FIELDS.has(field)) return { ok: false, ...read() };
    const normalized = validateValue(field, value);
    if (normalized === undefined || (COLOR_FIELDS.has(field) && normalized === null && value !== null)) {
      return { ok: false, ...read() };
    }
    const state = read();
    return { ok: true, ...write({ ...state.overrides, [field]: normalized }) };
  }

  function clear(field) {
    if (field !== undefined && !FIELDS.has(field)) return { ok: false, ...read() };
    const state = read();
    if (field !== undefined) {
      const remaining = Object.fromEntries(Object.entries(state.overrides).filter(([key]) => key !== field));
      return { ok: true, ...write(remaining) };
    }
    memoryOverrides = {};
    if (storageDegraded) return { ok: true, overrides: {}, persistence: 'memory' };
    const local = storage();
    if (!local) {
      storageDegraded = true;
      return { ok: true, overrides: {}, persistence: 'memory' };
    }
    try {
      local.removeItem(STORAGE_KEY);
      local.removeItem(LEGACY_STORAGE_KEY);
      return { ok: true, overrides: {}, persistence: 'persistent' };
    } catch (_error) {
      storageDegraded = true;
      return { ok: true, overrides: {}, persistence: 'memory' };
    }
  }

  function effective(sharedSettings) {
    const shared = isPlainObject(sharedSettings) ? sharedSettings : {};
    return { ...shared, ...read().overrides };
  }

  function colorForeground(color) {
    const normalized = normalizeColor(color);
    if (!normalized) return '#000000';
    const values = [1, 3, 5].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16) / 255);
    const linear = values.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > 0.179 ? '#000000' : '#FFFFFF';
  }

  function setCustomColor(style, field, color) {
    const property = field === 'primary_color' ? '--primary-color' : '--secondary-color';
    const foreground = field === 'primary_color' ? '--primary-foreground' : '--secondary-foreground';
    if (color) {
      style.setProperty(property, color);
      style.setProperty(foreground, colorForeground(color));
      if (field === 'primary_color') style.setProperty('--accent-color', color);
    } else {
      style.removeProperty(property);
      style.removeProperty(foreground);
      if (field === 'primary_color') style.removeProperty('--accent-color');
    }
  }

  function apply(profile, options) {
    const documentRef = options && options.document ? options.document : global.document;
    if (!documentRef || !documentRef.body || !documentRef.documentElement) return null;
    const settings = isPlainObject(profile) ? profile : {};
    const theme = THEMES.has(settings.theme) ? settings.theme : 'modern_dark';
    const body = documentRef.body;
    const root = documentRef.documentElement;
    body.setAttribute('data-theme', theme);
    body.setAttribute('data-layout-mode', settings.layout_mode === 'cozy' ? 'cozy' : 'compact');
    root.style.setProperty('color-scheme', theme === 'light_minimal' ? 'light' : 'dark');

    if (TITLE_FONTS.has(settings.font_title)) {
      root.style.setProperty('--font-title', `'${settings.font_title}', sans-serif`);
    } else root.style.removeProperty('--font-title');
    if (BODY_FONTS.has(settings.font_body)) {
      root.style.setProperty('--font-body', `'${settings.font_body}', sans-serif`);
    } else root.style.removeProperty('--font-body');

    setCustomColor(body.style, 'primary_color', normalizeColor(settings.primary_color));
    setCustomColor(body.style, 'secondary_color', normalizeColor(settings.secondary_color));
    return { ...settings, theme, layout_mode: body.getAttribute('data-layout-mode') };
  }

  function applyOverrides(overrides, options) {
    const documentRef = options && options.document ? options.document : global.document;
    if (!documentRef || !documentRef.body || !documentRef.documentElement) return null;
    const settings = validateOverrides(overrides);
    const body = documentRef.body;
    const root = documentRef.documentElement;

    if (settings.theme !== undefined) {
      body.setAttribute('data-theme', settings.theme);
      root.style.setProperty('color-scheme', settings.theme === 'light_minimal' ? 'light' : 'dark');
    }
    if (settings.layout_mode !== undefined) body.setAttribute('data-layout-mode', settings.layout_mode);
    if (settings.font_title !== undefined)
      root.style.setProperty('--font-title', `'${settings.font_title}', sans-serif`);
    if (settings.font_body !== undefined) root.style.setProperty('--font-body', `'${settings.font_body}', sans-serif`);
    if (Object.hasOwn(settings, 'primary_color'))
      setCustomColor(body.style, 'primary_color', normalizeColor(settings.primary_color));
    if (Object.hasOwn(settings, 'secondary_color'))
      setCustomColor(body.style, 'secondary_color', normalizeColor(settings.secondary_color));
    return settings;
  }

  function subscribe(callback, options) {
    const target = options && options.target ? options.target : global;
    if (!target || typeof target.addEventListener !== 'function' || typeof callback !== 'function') return () => {};
    const listener = (event) => {
      if (!event || event.key !== STORAGE_KEY) return;
      memoryOverrides = parse(event.newValue);
      callback({ overrides: clone(memoryOverrides), persistence: 'persistent' });
    };
    target.addEventListener('storage', listener);
    return () => target.removeEventListener('storage', listener);
  }

  const api = Object.freeze({
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    VERSION,
    read,
    getState: read,
    parse,
    validateOverrides,
    setOverride,
    clear,
    effective,
    apply,
    applyOverrides,
    subscribe
  });
  Object.defineProperty(global, 'TapboardDisplayPreferences', {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false
  });

  // The script is loaded as the first body child. Apply the small, validated
  // local record now so a hard refresh does not flash the shared appearance.
  applyOverrides(read().overrides);
})(globalThis);
