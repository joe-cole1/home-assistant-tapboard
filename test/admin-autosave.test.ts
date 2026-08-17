import assert from "node:assert/strict";
import test from "node:test";

import { listActivity } from "../src/features/activity/repository.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createDisplaySettingsService } from "../src/features/display/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createKegService } from "../src/features/kegs/service.ts";
import { createTapService } from "../src/features/taps/service.ts";

const at = (value: string) => () => new Date(value);

const autosaveBrowser = (await import(
  new URL("../public/js/admin-autosave.js", import.meta.url).href
)) as {
  readonly applyResource: (form: unknown, resource: unknown, onlyIfSentValues?: unknown) => void;
  readonly snapshot: (form: unknown) => Record<string, unknown>;
};

interface FakeControl {
  name: string;
  type: string;
  value: string;
  checked?: boolean;
}

function fakeForm(
  fields: string,
  controls: readonly FakeControl[],
): {
  readonly dataset: { readonly autosaveFields: string };
  readonly elements: readonly FakeControl[];
} {
  return { dataset: { autosaveFields: fields }, elements: controls };
}

void test("Beverage autosave uses updatedAt CAS and does not log no-op edits", () => {
  const database = openDatabase(":memory:");
  try {
    const service = createBeverageService(database, { now: at("2026-01-01T00:00:00.000Z") });
    const created = service.createCustomBeverage({ name: "Original", description: "Short" });
    const before = listActivity(database).length;
    const updated = service.autosaveCustomPresentation(
      created.beverage.id,
      created.beverage.updatedAt,
      { name: "Renamed", description: "Longer" },
      { now: at("2026-01-01T00:01:00.000Z") },
    );
    assert.equal(updated.effectivePresentation.name, "Renamed");
    assert.equal(updated.beverage.updatedAt, "2026-01-01T00:01:00.000Z");
    const afterChange = listActivity(database).length;
    assert.equal(afterChange, before + 1);
    const noOp = service.autosaveCustomPresentation(
      created.beverage.id,
      updated.beverage.updatedAt,
      { name: "Renamed", description: "Longer" },
      { now: at("2026-01-01T00:02:00.000Z") },
    );
    assert.equal(noOp.beverage.updatedAt, updated.beverage.updatedAt);
    assert.equal(listActivity(database).length, afterChange);
    assert.throws(
      () =>
        service.autosaveCustomPresentation(created.beverage.id, created.beverage.updatedAt, {
          name: "Stale",
        }),
      /changed elsewhere/,
    );
  } finally {
    database.close();
  }
});

void test("Keg and Tap autosave restrict fields and preserve parent revisions", () => {
  const database = openDatabase(":memory:");
  try {
    const kegService = createKegService(database, { now: at("2026-01-01T00:00:00.000Z") });
    const keg = kegService.createKeg({ kegNumber: 1, capacityMl: 19500 });
    const namedKeg = kegService.autosaveLabel(
      keg.id,
      keg.updatedAt,
      { label: "Back bar" },
      { now: at("2026-01-01T00:01:00.000Z") },
    );
    assert.equal(namedKeg.label, "Back bar");
    assert.throws(
      () => kegService.autosaveLabel(keg.id, keg.updatedAt, { capacityMl: 20 }),
      /Only/,
    );

    const tapService = createTapService(database, { now: at("2026-01-01T00:00:00.000Z") });
    const tap = tapService.createTap({ tapNumber: 1 });
    const namedTap = tapService.autosaveName(
      tap.id,
      tap.updatedAt,
      { name: "Main line" },
      { now: at("2026-01-01T00:02:00.000Z") },
    );
    assert.equal(namedTap.name, "Main line");
    assert.throws(() => tapService.autosaveName(tap.id, tap.updatedAt, { tapNumber: 2 }), /Only/);
  } finally {
    database.close();
  }
});

void test("Tap-card autosave advances the Tap parent revision atomically", () => {
  const database = openDatabase(":memory:");
  try {
    const tapService = createTapService(database, { now: at("2026-01-01T00:00:00.000Z") });
    const tap = tapService.createTap({ tapNumber: 1 });
    const display = createDisplaySettingsService(database);
    const saved = display.autosaveTapCardOverride(
      tap.id,
      tap.updatedAt,
      { showAbv: true, showIbu: false, showOg: null, showFg: null, showSrm: null },
      { now: at("2026-01-01T00:03:00.000Z") },
    );
    assert.equal(saved.changed, true);
    assert.equal(saved.current.settings.showIbu, false);
    assert.equal(saved.updatedAt, "2026-01-01T00:03:00.000Z");
    const noOp = display.autosaveTapCardOverride(tap.id, saved.updatedAt, {
      showAbv: true,
      showIbu: false,
      showOg: null,
      showFg: null,
      showSrm: null,
    });
    assert.equal(noOp.changed, false);
    assert.throws(
      () => display.autosaveTapCardOverride(tap.id, tap.updatedAt, { showIbu: true }),
      /concurrently/,
    );
  } finally {
    database.close();
  }
});

void test("autosave snapshots the checked value from radio groups", () => {
  const controls: FakeControl[] = [
    { name: "fillGlass", type: "radio", value: "", checked: false },
    { name: "fillGlass", type: "radio", value: "pint", checked: false },
    { name: "fillGlass", type: "radio", value: "mug", checked: true },
  ];
  const form = fakeForm("fillGlass", controls);

  assert.deepEqual(autosaveBrowser.snapshot(form), { fillGlass: "mug" });
  controls[2]!.checked = false;
  assert.deepEqual(autosaveBrowser.snapshot(form), { fillGlass: "" });
});

void test("authoritative radio apply selects options without mutating values", () => {
  const controls: FakeControl[] = [
    { name: "fillGlass", type: "radio", value: "", checked: true },
    { name: "fillGlass", type: "radio", value: "pint", checked: false },
    { name: "fillGlass", type: "radio", value: "mug", checked: false },
  ];
  const form = fakeForm("fillGlass", controls);
  const originalValues = controls.map((control) => control.value);

  autosaveBrowser.applyResource(form, { fillGlass: "mug" });
  assert.deepEqual(
    controls.map((control) => control.checked),
    [false, false, true],
  );
  assert.deepEqual(
    controls.map((control) => control.value),
    originalValues,
  );

  autosaveBrowser.applyResource(form, { fillGlass: "unsupported" });
  assert.deepEqual(
    controls.map((control) => control.checked),
    [false, false, false],
  );
});
