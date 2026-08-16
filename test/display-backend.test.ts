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
      { ...input(), showServingTemperature: 0 },
      { ...input(), expectedRevision: 1.5 },
    ])
      assert.throws(() => validateUpdateDisplaySettingsInput(bad));
    const before = listActivity(database).length;
    assert.equal(service.updateSettings(input()).revision, 1);
    assert.equal(listActivity(database).length, before);
    const changed = service.updateSettings(
      { ...input(), tapboardName: "Main bar" },
      { now: () => new Date("2026-01-01T00:00:00.000Z") },
    );
    assert.equal(changed.revision, 2);
    assert.equal(listActivity(database).at(-1)?.entityType, "display_settings");
    assert.throws(() => service.updateSettings(input(1)), /concurrently/);
  } finally {
    database.close();
  }
});
