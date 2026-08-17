import assert from "node:assert/strict";
import test from "node:test";

import { listActivity } from "../src/features/activity/repository.ts";
import { createDisplaySettingsService } from "../src/features/display/service.ts";
import { validateUpdateDisplaySettingsInput } from "../src/features/display/display-validation.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";

const input = (revision = 1) => ({
  expectedRevision: revision,
  tapboardName: "Tapboard",
  theme: "modern_dark",
  font: "system",
  accent: "amber",
  unitSystem: "us",
  showServingTemperature: false,
  layoutMode: "scroll",
});

void test("display settings defaults, exact validation, CAS, no-op, and Activity", () => {
  const database = openDatabase(":memory:");
  try {
    const service = createDisplaySettingsService(database);
    assert.deepEqual(service.getSettings(), {
      revision: 1,
      tapboardName: "Tapboard",
      theme: "modern_dark",
      font: "system",
      accent: "amber",
      unitSystem: "us",
      showServingTemperature: false,
      layoutMode: "scroll",
      updatedAt: service.getSettings().updatedAt,
    });
    for (const bad of [
      { ...input(), unknown: true },
      { ...input(), tapboardName: " x\n" },
      { ...input(), tapboardName: "" },
      { ...input(), tapboardName: "   " },
      { ...input(), theme: "nope" },
      { ...input(), accent: "#ABCDEF" },
      { ...input(), accent: "#abcde" },
      { ...input(), accent: "#abcdef0" },
      { ...input(), accent: "#abcde_" },
      { ...input(), accent: "#abcde\n" },
      { ...input(), accent: "#abcdef\u0000" },
      { ...input(), showServingTemperature: 0 },
      { ...input(), expectedRevision: 1.5 },
    ])
      assert.throws(() => validateUpdateDisplaySettingsInput(bad));
    const before = listActivity(database).length;
    assert.equal(service.updateSettings(input()).revision, 1);
    assert.equal(listActivity(database).length, before);
    const changed = service.updateSettings(
      { ...input(), tapboardName: "Main bar", accent: "#abcdef" },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    assert.equal(changed.revision, 2);
    assert.equal(changed.accent, "#abcdef");
    assert.equal(listActivity(database).at(-1)?.entityType, "display_settings");
    assert.throws(() => service.updateSettings(input(1)), /concurrently/);
  } finally {
    database.close();
  }
});

void test("Tap card display settings support shared defaults and tri-state Tap overrides", () => {
  const database = openDatabase(":memory:");
  const tapId = "00000000-0000-4000-8000-000000000001";
  try {
    database
      .prepare<[string, number, number, string, string]>(
        "INSERT INTO taps (id, tap_number, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(tapId, 1, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const service = createDisplaySettingsService(database);
    assert.deepEqual(service.getTapCardSettings(), {
      revision: 1,
      showAbv: true,
      showIbu: true,
      showOg: true,
      showFg: true,
      showSrm: false,
      remainingMode: "percent",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    const before = listActivity(database).length;
    assert.equal(
      service.updateTapCardSettings({
        expectedRevision: 1,
        showAbv: true,
        showIbu: true,
        showOg: true,
        showFg: true,
        showSrm: false,
        remainingMode: "percent",
      }).revision,
      1,
    );
    assert.equal(listActivity(database).length, before);
    assert.equal(
      service.updateTapCardSettings({
        expectedRevision: 1,
        showAbv: true,
        showIbu: false,
        showOg: true,
        showFg: true,
        showSrm: true,
        remainingMode: "pours",
      }).revision,
      2,
    );
    assert.throws(
      () =>
        service.updateTapCardSettings({
          expectedRevision: 1,
          showAbv: true,
          showIbu: false,
          showOg: true,
          showFg: true,
          showSrm: true,
          remainingMode: "pours",
        }),
      /concurrently/,
    );
    assert.equal(service.getEffectiveTapCardSettings(tapId).settings.showIbu, false);
    assert.equal(
      service.setTapCardOverride(tapId, { showIbu: true, showSrm: null })?.showIbu,
      true,
    );
    assert.equal(service.getEffectiveTapCardSettings(tapId).settings.showIbu, true);
    assert.equal(service.getEffectiveTapCardSettings(tapId).settings.showSrm, true);
    assert.equal(service.setTapCardOverride(tapId, { showIbu: true })?.showIbu, true);
    assert.equal(service.clearTapCardOverride(tapId), true);
    assert.equal(service.getTapCardOverride(tapId), undefined);
    assert.equal(service.getEffectiveTapCardSettings(tapId).settings.showIbu, false);
    database.prepare<[string]>("DELETE FROM taps WHERE id = ?").run(tapId);
    assert.equal(
      database
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM tap_card_display_overrides",
        )
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});
