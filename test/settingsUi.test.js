import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('General Settings is an accessible, collapsed disclosure workspace with the required section layout', () => {
  const { document } = parseHTML(html);
  const dialog = document.getElementById('globalSettingsModal');
  const disclosures = [...dialog.querySelectorAll(':scope details.settings-disclosure')];

  assert.equal(dialog.localName, 'dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'generalSettingsTitle');
  assert.equal(disclosures.length, 6);
  assert.ok(disclosures.every((details) => !details.hasAttribute('open')));
  assert.deepEqual(
    disclosures.map((details) => details.querySelector('summary')?.firstChild?.textContent.trim()),
    ['Dashboard', 'Appearance', 'Celebrations', 'Custom Beverage', 'Brewfather', 'Security']
  );
  const dashboard = disclosures[0];
  const appearance = disclosures[1];
  const layout = document.getElementById('layoutModeSelect');
  const onDeckFooter = document.getElementById('showOnDeckCheckbox');
  const onDeckDefault = document.getElementById('onDeckNewBatchDefaultCheckbox');

  assert.equal(appearance.querySelector('.settings-disclosure-content').firstElementChild, layout.parentElement);
  assert.equal(dashboard.contains(layout), false);
  assert.ok(dashboard.contains(document.querySelector('.tap-visibility-fieldset')));
  assert.equal(dashboard.querySelector('.settings-disclosure-content').lastElementChild, onDeckDefault.parentElement);
  assert.ok(dashboard.contains(onDeckFooter));
  assert.ok(dashboard.contains(onDeckDefault));
  assert.equal(
    [...dialog.querySelectorAll('summary')].some((summary) => /^On Deck\b/.test(summary.textContent.trim())),
    false
  );
  for (const removedId of ['saveGlobalSettingsBtn', 'saveCustomBeverageBtn', 'saveTapSettingsBtn', 'saveOnDeckBtn']) {
    assert.equal(document.getElementById(removedId), null);
  }
});

test('Brewfather settings expose accessible cache status and manual refresh controls', () => {
  const { document } = parseHTML(html);
  const section = document.getElementById('brewfatherStatusSection');
  const refresh = document.getElementById('refreshBrewfatherBtn');
  const feedback = document.getElementById('brewfatherRefreshStatus');
  const lastSuccess = document.getElementById('brewfatherLastSuccess');

  assert.ok(section);
  assert.equal(section.hasAttribute('open'), false);
  assert.match(section.querySelector('summary').textContent, /connection, cache health, and refresh/i);
  assert.ok(document.getElementById('brewfatherConnectionStatus'));
  assert.ok(document.getElementById('brewfatherCacheStatus'));
  assert.equal(lastSuccess.localName, 'time');
  assert.equal(refresh.getAttribute('type'), 'button');
  assert.equal(feedback.getAttribute('aria-live'), 'polite');
});

test('theme and PIN controls expose reset, warning, verification, and inline status semantics', () => {
  const { document } = parseHTML(html);
  for (const id of [
    'primaryColorPicker',
    'primaryColorInput',
    'primaryColorSaveStatus',
    'secondaryColorPicker',
    'secondaryColorInput',
    'secondaryColorSaveStatus',
    'resetAccentColorsBtn',
    'accentContrastAdvisory'
  ]) {
    assert.ok(document.getElementById(id), `missing ${id}`);
  }

  const current = document.getElementById('currentPinInput');
  const next = document.getElementById('newPinInput');
  const confirmation = document.getElementById('confirmNewPinInput');
  assert.equal(current.getAttribute('autocomplete'), 'current-password');
  assert.equal(next.getAttribute('autocomplete'), 'new-password');
  assert.equal(confirmation.getAttribute('autocomplete'), 'new-password');
  assert.ok([current, next, confirmation].every((input) => input.getAttribute('inputmode') === 'numeric'));
  assert.match(document.querySelector('.pin-warning').textContent, /signs out every administrator/i);
  assert.ok(document.getElementById('changePinBtn'));
  assert.ok(document.getElementById('pinChangeSaveStatus'));
});

test('PIN unlock uses a numeric masked form that submits from the keyboard', () => {
  const { document } = parseHTML(html);
  const form = document.getElementById('pinForm');
  const input = document.getElementById('pinInput');
  const submit = document.getElementById('pinSubmitBtn');

  assert.equal(form.localName, 'form');
  assert.equal(form.parentElement.parentElement.id, 'pinModal');
  assert.equal(input.getAttribute('type'), 'password');
  assert.equal(input.getAttribute('aria-label'), '4-digit administrator PIN');
  assert.equal(input.getAttribute('inputmode'), 'numeric');
  assert.equal(input.getAttribute('pattern'), '[0-9]{4}');
  assert.equal(input.getAttribute('autocomplete'), 'current-password');
  assert.equal(input.getAttribute('enterkeyhint'), 'done');
  assert.equal(input.hasAttribute('required'), true);
  assert.equal(submit.getAttribute('type'), 'submit');
  assert.equal(form.contains(input), true);
  assert.equal(form.contains(submit), true);
});

test('per-browser display controls load before visible content and communicate their scope', () => {
  const { document } = parseHTML(html);
  const bodyChildren = [...document.body.children];
  const preferenceScript = document.querySelector('script[src="displayPreferences.js"]');
  const fonts = document.querySelector('link[href*="fonts.googleapis.com/css2"]');

  assert.equal(bodyChildren[0], preferenceScript, 'display preference bootstrap must be the first body element');
  assert.equal(preferenceScript.getAttribute('type'), null, 'bootstrap must be a synchronous classic script');
  assert.match(fonts.getAttribute('href'), /family=Inter/);
  assert.ok(document.querySelectorAll('.browser-setting-scope').length >= 6);
  assert.match(document.querySelector('.display-preferences-help').textContent, /only in this browser/i);
  assert.match(document.querySelector('#layoutModeSelect').parentElement.textContent, /This browser/i);
});

test('per-browser display controls retain reset, theme-default, and explicit shared-default actions', () => {
  const { document } = parseHTML(html);
  const reset = document.getElementById('resetBrowserDisplayPreferencesBtn');
  const resetStatus = document.getElementById('browserDisplayPreferencesSaveStatus');
  const shared = document.getElementById('setSharedDisplayDefaultsBtn');
  const sharedStatus = document.getElementById('sharedDisplayDefaultsSaveStatus');

  assert.equal(document.getElementById('resetAccentColorsBtn').textContent.trim(), 'Use theme defaults');
  assert.equal(reset.getAttribute('type'), 'button');
  assert.equal(resetStatus.getAttribute('aria-live'), 'polite');
  assert.equal(shared.getAttribute('type'), 'button');
  assert.equal(sharedStatus.getAttribute('aria-live'), 'polite');
  assert.match(shared.parentElement.parentElement.textContent, /shared default/i);
  assert.ok(
    document.getElementById('globalSettingsModal').contains(shared),
    'actions remain behind the admin-gated dialog'
  );
});

test('celebrations separate shared visual policy from explicit browser sound consent', () => {
  const { document } = parseHTML(html);
  const sound = document.getElementById('browserSoundEnabledCheckbox');
  assert.ok(document.getElementById('firstPourEffectsCheckbox'));
  assert.ok(document.getElementById('kickEffectsCheckbox'));
  assert.deepEqual(
    [...document.getElementById('ceremonySoundSelect').options].map((option) => option.value),
    ['pub_bell', 'fanfare', 'last_call']
  );
  assert.equal(sound.hasAttribute('checked'), false);
  assert.match(sound.parentElement.textContent, /This browser/);
  assert.ok(document.getElementById('endKegReasonDialog'));
});

test('tap and custom-beverage settings provide an inline autosave result beside every editable field', () => {
  const { document } = parseHTML(html);
  const controlStatusPairs = [
    ['customBeverageName', 'customBeverageNameSaveStatus'],
    ['customBeverageStyle', 'customBeverageStyleSaveStatus'],
    ['customBeverageAbv', 'customBeverageAbvSaveStatus'],
    ['customBeverageIbu', 'customBeverageIbuSaveStatus'],
    ['customBeverageSrm', 'customBeverageSrmSaveStatus'],
    ['customBeverageOg', 'customBeverageOgSaveStatus'],
    ['customBeverageFg', 'customBeverageFgSaveStatus'],
    ['customBeverageDescription', 'customBeverageDescriptionSaveStatus'],
    ['tapSettingsBatchSelect', 'tapSettingsBatchSaveStatus'],
    ['tapSettingsGraphicSelect', 'tapSettingsGraphicSaveStatus'],
    ['tapSettingsDisplayUnitSelect', 'tapSettingsDisplayUnitSaveStatus'],
    ['tapSettingsCustomPourInput', 'tapSettingsCustomPourSaveStatus'],
    ['tapSettingsCapacityInput', 'tapSettingsCapacitySaveStatus'],
    ['tapSettingsEnabledCheckbox', 'tapSettingsEnabledSaveStatus'],
    ['tapSettingsOverrideToggle', 'tapSettingsOverrideToggleSaveStatus'],
    ['overrideName', 'overrideNameSaveStatus'],
    ['overrideStyle', 'overrideStyleSaveStatus'],
    ['overrideAbv', 'overrideAbvSaveStatus'],
    ['overrideIbu', 'overrideIbuSaveStatus'],
    ['overrideOg', 'overrideOgSaveStatus'],
    ['overrideFg', 'overrideFgSaveStatus'],
    ['overrideSrm', 'overrideSrmSaveStatus'],
    ['overrideDescription', 'overrideDescriptionSaveStatus'],
    ['badgeLowKegToggle', 'badgeLowKegSaveStatus'],
    ['badgeFreshToggle', 'badgeFreshSaveStatus']
  ];

  for (const [controlId, statusId] of controlStatusPairs) {
    const control = document.getElementById(controlId);
    const status = document.getElementById(statusId);
    assert.ok(control, `missing ${controlId}`);
    assert.ok(status, `missing ${statusId}`);
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.ok(control.parentElement.contains(status), `${statusId} is not inline with ${controlId}`);
  }
  assert.equal(document.getElementById('tapSettingsServingGlassSelect'), null);
  assert.match(
    document.getElementById('tapSettingsGraphicSelect').parentElement.textContent,
    /auto-selects a display fill glass/i
  );
});
