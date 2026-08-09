import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('General Settings is an accessible full-page disclosure workspace', () => {
  const { document } = parseHTML(html);
  const dialog = document.getElementById('globalSettingsModal');
  const disclosures = [...dialog.querySelectorAll(':scope details.settings-disclosure')];

  assert.equal(dialog.localName, 'dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'generalSettingsTitle');
  assert.equal(disclosures.length, 5);
  assert.equal(disclosures[0].hasAttribute('open'), true);
  assert.ok(disclosures.slice(1).every((details) => !details.hasAttribute('open')));
  assert.deepEqual(
    disclosures.map((details) => details.querySelector('summary')?.firstChild?.textContent.trim()),
    ['Appearance', 'Dashboard', 'On Deck', 'Custom Beverage', 'Security']
  );
  for (const removedId of ['saveGlobalSettingsBtn', 'saveCustomBeverageBtn', 'saveTapSettingsBtn', 'saveOnDeckBtn']) {
    assert.equal(document.getElementById(removedId), null);
  }
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
});
