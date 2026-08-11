import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/displayPreferences.js', import.meta.url), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStorage({ getThrows = false, setThrows = false, removeThrows = false } = {}) {
  const values = new Map();
  return {
    values,
    getItem(key) {
      if (getThrows) throw new Error('storage unavailable');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (setThrows) throw new Error('storage unavailable');
      values.set(key, value);
    },
    removeItem(key) {
      if (removeThrows) throw new Error('storage unavailable');
      values.delete(key);
    }
  };
}

function createStyle() {
  const values = new Map();
  return {
    values,
    setProperty(name, value) {
      values.set(name, value);
    },
    removeProperty(name) {
      values.delete(name);
    }
  };
}

function createDocument() {
  const bodyAttributes = new Map();
  return {
    body: {
      style: createStyle(),
      setAttribute(name, value) {
        bodyAttributes.set(name, value);
      },
      getAttribute(name) {
        return bodyAttributes.get(name) ?? null;
      }
    },
    documentElement: { style: createStyle() }
  };
}

function loadApi({ storage = createStorage(), document } = {}) {
  const listeners = new Map();
  const context = {
    localStorage: storage,
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    document
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { api: context.TapboardDisplayPreferences, listeners, storage };
}

test('validates versioned sparse records and normalizes colors', () => {
  const { api } = loadApi();
  const overrides = api.parse(
    JSON.stringify({
      version: 2,
      overrides: {
        theme: 'cyberpunk',
        font_body: 'Inter',
        primary_color: '#aBc123',
        secondary_color: null,
        sound_enabled: false,
        bad: 'x'
      }
    })
  );
  assert.deepEqual(plain(overrides), {
    theme: 'cyberpunk',
    font_body: 'Inter',
    primary_color: '#ABC123',
    secondary_color: null,
    sound_enabled: false
  });
  assert.deepEqual(plain(api.parse('{')), {});
  assert.deepEqual(plain(api.parse(JSON.stringify({ version: 1, overrides }))), {});
  assert.deepEqual(
    plain(
      api.parse(JSON.stringify({ version: 2, overrides: { theme: 'x', primary_color: '#abc', font_title: 'Inter' } }))
    ),
    {}
  );
});

test('migrates v1 preferences into v2 before the application starts', () => {
  const storage = createStorage();
  storage.setItem(
    'tapboard.display-preferences.v1',
    JSON.stringify({ version: 1, overrides: { theme: 'warm_pub', layout_mode: 'compact' } })
  );
  const document = createDocument();
  loadApi({ storage, document });
  assert.equal(document.body.getAttribute('data-theme'), 'warm_pub');
  assert.equal(document.body.getAttribute('data-layout-mode'), 'compact');
  assert.equal(document.documentElement.style.values.get('color-scheme'), 'dark');
  assert.equal(storage.values.has('tapboard.display-preferences.v1'), false);
  assert.deepEqual(JSON.parse(storage.values.get('tapboard.display-preferences.v2')), {
    version: 2,
    overrides: { theme: 'warm_pub', layout_mode: 'compact' }
  });
});

test('bootstrap leaves non-overridden shared fields untouched until the snapshot resolves them', () => {
  const storage = createStorage();
  storage.setItem(
    'tapboard.display-preferences.v2',
    JSON.stringify({ version: 2, overrides: { primary_color: '#112233' } })
  );
  const document = createDocument();
  document.body.setAttribute('data-theme', 'warm_pub');
  document.body.setAttribute('data-layout-mode', 'compact');
  document.documentElement.style.setProperty('--font-body', "'Roboto', sans-serif");
  loadApi({ storage, document });
  assert.equal(document.body.getAttribute('data-theme'), 'warm_pub');
  assert.equal(document.body.getAttribute('data-layout-mode'), 'compact');
  assert.equal(document.documentElement.style.values.get('--font-body'), "'Roboto', sans-serif");
  assert.equal(document.body.style.values.get('--primary-color'), '#112233');
});

test('persists sparse overrides and overlays them onto shared settings', () => {
  const { api, storage } = loadApi();
  const saved = api.setOverride('primary_color', '#c0ffee');
  assert.equal(saved.ok, true);
  assert.equal(saved.persistence, 'persistent');
  assert.equal(JSON.parse(storage.values.get(api.STORAGE_KEY)).overrides.primary_color, '#C0FFEE');
  assert.deepEqual(plain(api.effective({ theme: 'warm_pub', primary_color: null, layout_mode: 'cozy' })), {
    theme: 'warm_pub',
    primary_color: '#C0FFEE',
    layout_mode: 'cozy'
  });
  assert.equal(api.setOverride('font_title', 'Inter').ok, false);
  assert.equal(api.setOverride('primary_color', '#bad').ok, false);
  assert.equal(api.setOverride('primary_color', null).ok, true);
  assert.equal(api.read().overrides.primary_color, null);
  assert.equal(api.setOverride('sound_enabled', false).ok, true);
  assert.equal(api.read().overrides.sound_enabled, false);
});

test('local overrides retain precedence when shared snapshot settings change', () => {
  const { api } = loadApi();
  api.setOverride('theme', 'light_minimal');
  api.setOverride('layout_mode', 'compact');
  assert.deepEqual(plain(api.effective({ theme: 'modern_dark', layout_mode: 'cozy', font_body: 'Inter' })), {
    theme: 'light_minimal',
    layout_mode: 'compact',
    font_body: 'Inter'
  });
  assert.deepEqual(plain(api.effective({ theme: 'cyberpunk', layout_mode: 'cozy', font_body: 'Roboto' })), {
    theme: 'light_minimal',
    layout_mode: 'compact',
    font_body: 'Roboto'
  });
  api.clear('theme');
  assert.equal(api.effective({ theme: 'cyberpunk' }).theme, 'cyberpunk');
});

test('falls back to memory when browser storage is unavailable and clears safely', () => {
  const { api } = loadApi({ storage: createStorage({ getThrows: true }) });
  const saved = api.setOverride('layout_mode', 'compact');
  assert.equal(saved.persistence, 'memory');
  assert.deepEqual(plain(api.read().overrides), { layout_mode: 'compact' });
  assert.equal(api.clear().persistence, 'memory');
  assert.deepEqual(plain(api.read().overrides), {});
});

test('retains the session fallback when a write fails after a successful read', () => {
  const storage = createStorage({ setThrows: true });
  storage.values.set(
    'tapboard.display-preferences.v2',
    JSON.stringify({ version: 2, overrides: { theme: 'warm_pub' } })
  );
  const { api } = loadApi({ storage });
  assert.equal(api.read().persistence, 'persistent');
  assert.equal(api.setOverride('layout_mode', 'compact').persistence, 'memory');
  assert.deepEqual(plain(api.read()), {
    overrides: { theme: 'warm_pub', layout_mode: 'compact' },
    persistence: 'memory'
  });
  assert.deepEqual(plain(api.clear()), { ok: true, overrides: {}, persistence: 'memory' });
});

test('applies only allowlisted display properties and clears theme defaults correctly', () => {
  const { api } = loadApi();
  const document = createDocument();
  api.apply(
    {
      theme: 'light_minimal',
      layout_mode: 'compact',
      font_title: 'Outfit',
      font_body: 'Inter',
      primary_color: '#fbc02d'
    },
    { document }
  );
  assert.equal(document.body.getAttribute('data-theme'), 'light_minimal');
  assert.equal(document.body.getAttribute('data-layout-mode'), 'compact');
  assert.equal(document.documentElement.style.values.get('color-scheme'), 'light');
  assert.equal(document.body.style.values.get('--primary-color'), '#FBC02D');
  assert.equal(document.body.style.values.get('--accent-color'), '#FBC02D');
  assert.equal(document.documentElement.style.values.get('--font-body'), "'Inter', sans-serif");
  api.apply({ theme: 'modern_dark', primary_color: null, secondary_color: null }, { document });
  assert.equal(document.documentElement.style.values.get('color-scheme'), 'dark');
  assert.equal(document.body.style.values.has('--primary-color'), false);
  assert.equal(document.body.style.values.has('--secondary-color'), false);
  assert.equal(document.documentElement.style.values.has('--font-body'), false);
});

test('notifies other same-origin tabs through storage events', () => {
  const { api, listeners } = loadApi();
  let received;
  const unsubscribe = api.subscribe((state) => {
    received = state;
  });
  listeners.get('storage')({
    key: api.STORAGE_KEY,
    newValue: JSON.stringify({ version: 2, overrides: { theme: 'warm_pub' } })
  });
  assert.deepEqual(plain(received), { overrides: { theme: 'warm_pub' }, persistence: 'persistent' });
  unsubscribe();
  assert.equal(listeners.has('storage'), false);
});
