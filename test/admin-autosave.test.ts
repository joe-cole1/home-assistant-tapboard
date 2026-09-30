import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

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

class BrowserElement extends EventTarget {
  id = "";
  type = "";
  className = "";
  textContent = "";
  hidden = false;
  removed = false;
  dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly adjacent: BrowserElement[] = [];

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  insertAdjacentElement(_position: string, element: BrowserElement): void {
    this.adjacent.push(element);
  }

  remove(): void {
    this.removed = true;
  }

  click(): void {
    this.dispatchEvent(new Event("click"));
  }
}

class BrowserControl extends BrowserElement {
  name: string;
  value: string;
  checked = false;

  constructor(name: string, value: string, type = "text") {
    super();
    this.name = name;
    this.value = value;
    this.type = type;
  }
}

class BrowserForm extends BrowserElement {
  readonly action = "https://tapboard.test/admin/taps/one/edit";
  readonly status = new BrowserElement();
  readonly elements: BrowserControl[];

  constructor(values: Record<string, string>, revisionName = "updatedAt") {
    super();
    this.id = "test-autosave";
    this.dataset.autosave = "blur";
    this.dataset.autosaveFields = Object.keys(values).join(",");
    this.dataset.autosaveRevision = revisionName;
    this.dataset.autosaveResource = "tap:one";
    this.elements = Object.entries(values).map(([name, value]) => new BrowserControl(name, value));
    this.elements.push(new BrowserControl(revisionName, "1", "hidden"));
    this.elements.push(new BrowserControl("_csrf", "test-csrf", "hidden"));
  }

  control(name: string): BrowserControl {
    const control = this.elements.find((element) => element.name === name);
    assert.ok(control, `Missing control ${name}`);
    return control;
  }

  edit(name: string, value: string, eventType = "change"): void {
    const control = this.control(name);
    control.value = value;
    const event = new Event(eventType);
    Object.defineProperty(event, "target", { value: control });
    this.dispatchEvent(event);
  }

  submit(): void {
    const event = new Event("submit", { cancelable: true });
    this.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }

  querySelector(selector: string): BrowserElement | null {
    return selector === "[data-autosave-status]" ? this.status : null;
  }

  querySelectorAll(selector: string): BrowserElement[] {
    const field = /^\[data-autosave-field-error="([^"]+)"\]$/u.exec(selector)?.[1];
    return this.elements.flatMap((control) =>
      control.adjacent.filter(
        (element) =>
          !element.removed &&
          element.dataset.autosaveFieldError !== undefined &&
          (selector === "[data-autosave-field-error]" ||
            element.dataset.autosaveFieldError === field),
      ),
    );
  }

  get undoButton(): BrowserElement | undefined {
    return this.status.adjacent.find((element) => element.textContent === "Undo");
  }
}

interface DeferredSave {
  readonly url: unknown;
  readonly options: RequestInit | undefined;
  readonly payload: Record<string, unknown>;
  readonly respond: (status: number, body: unknown) => Promise<void>;
}

let browserImport = 0;

async function initializeBrowser(t: TestContext, forms: readonly BrowserForm[]) {
  const globals = {
    document: {
      querySelectorAll: () => forms,
      createElement: () => new BrowserElement(),
    },
    window: {
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const requests: DeferredSave[] = [];
  t.mock.method(globalThis, "fetch", (url: unknown, options?: RequestInit) => {
    return new Promise<Response>((resolve) => {
      assert.ok(typeof options?.body === "string");
      requests.push({
        url,
        options,
        payload: JSON.parse(options.body) as Record<string, unknown>,
        async respond(status, body) {
          resolve(new Response(JSON.stringify(body), { status }));
          await new Promise<void>((done) => setImmediate(done));
        },
      });
    });
  });
  await import(
    `${new URL("../public/js/admin-autosave.js", import.meta.url).href}?browser-test=${++browserImport}`
  );
  return requests;
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

void test("autosave value application announces preview resync fields", () => {
  const controls: FakeControl[] = [
    { name: "fillGlass", type: "radio", value: "", checked: true },
    { name: "fillGlass", type: "radio", value: "pint", checked: false },
  ];
  const events: { readonly type: string; readonly detail?: { readonly fields?: string[] } }[] = [];
  const form = {
    ...fakeForm("fillGlass", controls),
    dispatchEvent(event: { type: string; detail?: { readonly fields?: string[] } }): boolean {
      events.push(event);
      return true;
    },
  };

  autosaveBrowser.applyResource(form, { fillGlass: "pint" });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "tapboard:autosave-values-applied");
  assert.deepEqual(events[0]?.detail?.fields, ["fillGlass"]);
});

void test("autosave preserves the newest queued edit during a deferred save", async (t) => {
  for (const latest of ["A", "C"]) {
    await t.test(`A → B → ${latest}`, async (t) => {
      const form = new BrowserForm({ name: "A" });
      const requests = await initializeBrowser(t, [form]);

      form.edit("name", "B");
      form.edit("name", latest);
      form.edit("name", latest, "blur");
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.payload, { name: "B", updatedAt: "1" });
      assert.equal(form.status.textContent, "Saving…");

      await requests[0].respond(200, { resource: { name: "B" }, revision: "2" });
      assert.equal(form.control("name").value, latest);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1]?.payload, { name: latest, updatedAt: "2" });

      await requests[1].respond(200, { resource: { name: latest }, revision: "3" });
      form.submit();
      assert.equal(requests.length, 2);
      assert.equal(form.status.dataset.autosaveState, "saved");
      assert.equal(form.control("updatedAt").value, "3");
    });
  }
});

void test("autosave coalesces pending edits that return to the successful in-flight value", async (t) => {
  const form = new BrowserForm({ name: "A" });
  const requests = await initializeBrowser(t, [form]);

  form.edit("name", " B ");
  form.edit("name", "C");
  form.edit("name", " B ");
  form.submit();
  await requests[0]!.respond(200, { resource: { name: "B" }, revision: "2" });

  assert.equal(requests.length, 1);
  assert.equal(form.control("name").value, "B");
  assert.equal(form.status.dataset.autosaveState, "saved");
  assert.equal(form.undoButton?.hidden, false);
  form.submit();
  assert.equal(requests.length, 1);
});

void test("autosave deduplicates canonical server values across control representations", async (t) => {
  const form = new BrowserForm({ name: "A", abv: "5", label: "Old", showAbv: "true" });
  form.control("showAbv").type = "checkbox";
  const requests = await initializeBrowser(t, [form]);
  form.control("abv").value = "6.00";
  form.control("label").value = "";
  form.control("showAbv").checked = true;
  form.edit("name", " B ");

  await requests[0]!.respond(200, {
    resource: { name: "B", abv: 6, label: null, showAbv: true },
    revision: "2",
  });
  assert.deepEqual(autosaveBrowser.snapshot(form), {
    name: "B",
    abv: "6",
    label: "",
    showAbv: "true",
    updatedAt: "2",
  });
  form.submit();
  form.edit("name", "B", "blur");
  assert.equal(requests.length, 1);

  form.edit("name", "C");
  await requests[1]!.respond(200, { resource: { name: "C" }, revision: "3" });
  assert.equal(form.undoButton?.hidden, false);
  form.undoButton.click();
  assert.deepEqual(requests[2]?.payload, {
    name: "B",
    abv: "6",
    label: "",
    showAbv: "true",
    updatedAt: "3",
  });
  await requests[2].respond(200, { resource: { name: "B" }, revision: "4" });
});

void test("autosave carries normalization into pending fields without overwriting newer edits", async (t) => {
  const form = new BrowserForm({ name: "A", description: "Original" });
  const requests = await initializeBrowser(t, [form]);
  form.edit("name", " B ");
  form.edit("description", "Queued");
  form.edit("description", "Still typing", "input");

  await requests[0]!.respond(200, {
    resource: { name: "B", description: "Original" },
    revision: "2",
  });
  assert.equal(form.control("name").value, "B");
  assert.equal(form.control("description").value, "Still typing");
  assert.deepEqual(requests[1]?.payload, {
    name: "B",
    description: "Queued",
    updatedAt: "2",
  });
  await requests[1].respond(200, {
    resource: { name: "B", description: "Queued" },
    revision: "3",
  });
  assert.equal(form.control("description").value, "Still typing");
  form.edit("description", "Still typing", "blur");
  assert.deepEqual(requests[2]?.payload, {
    name: "B",
    description: "Still typing",
    updatedAt: "3",
  });
  await requests[2].respond(200, { resource: {}, revision: "4" });
});

void test("Undo reflects the acknowledged change even when newer input matches the old baseline", async (t) => {
  const form = new BrowserForm({ name: "A" });
  const requests = await initializeBrowser(t, [form]);
  form.edit("name", "B");
  form.edit("name", "A", "input");
  await requests[0]!.respond(200, { resource: { name: "B" }, revision: "2" });

  assert.equal(form.control("name").value, "A");
  assert.equal(requests.length, 1);
  assert.equal(form.undoButton?.hidden, false);
  form.undoButton.click();
  assert.deepEqual(requests[1]?.payload, { name: "A", updatedAt: "2" });
  await requests[1].respond(200, { resource: { name: "A" }, revision: "3" });
});

void test("an unsuccessful second autosave never becomes the Undo baseline", async (t) => {
  for (const failureStatus of [409, 422, 500]) {
    await t.test(`second save returns ${failureStatus}`, async (t) => {
      const form = new BrowserForm({ name: "A" });
      const requests = await initializeBrowser(t, [form]);
      form.edit("name", " B ");
      form.edit("name", "C");
      await requests[0]!.respond(200, { resource: { name: "B" }, revision: "2" });
      await requests[1]!.respond(failureStatus, {
        message: "The second save failed",
        fields: { name: "Invalid value" },
        current: { name: "Elsewhere" },
        revision: "99",
      });
      assert.equal(form.control("name").value, "C");
      assert.equal(form.control("updatedAt").value, "2");
      assert.notEqual(form.undoButton?.hidden, false);
      assert.equal(form.status.dataset.autosaveState, failureStatus === 409 ? "conflict" : "error");
      if (failureStatus === 422) {
        assert.equal(form.control("name").getAttribute("aria-invalid"), "true");
        assert.equal(
          form.querySelectorAll("[data-autosave-field-error]")[0]?.textContent,
          "Invalid value",
        );
      }

      form.edit("name", "D");
      assert.equal(form.control("name").getAttribute("aria-invalid"), null);
      assert.equal(form.querySelectorAll("[data-autosave-field-error]").length, 0);
      assert.deepEqual(requests[2]?.payload, { name: "D", updatedAt: "2" });
      await requests[2].respond(200, { resource: { name: "D" }, revision: "3" });
      assert.equal(form.undoButton?.hidden, false);
      form.undoButton.click();
      assert.equal(form.control("name").value, "B");
      assert.deepEqual(requests[3]?.payload, { name: "B", updatedAt: "3" });
      await requests[3].respond(200, { resource: { name: "B" }, revision: "4" });
    });
  }
});

void test("autosave continues queued corrections after validation failure", async (t) => {
  const form = new BrowserForm({ name: "A" });
  const requests = await initializeBrowser(t, [form]);
  form.edit("name", "Invalid");
  form.edit("name", "Corrected");
  await requests[0]!.respond(422, { message: "Invalid value", fields: { name: "Invalid value" } });
  assert.deepEqual(requests[1]?.payload, { name: "Corrected", updatedAt: "1" });
  await requests[1].respond(200, { resource: { name: "Corrected" }, revision: "2" });
  assert.equal(form.control("name").getAttribute("aria-invalid"), null);
  assert.equal(form.querySelectorAll("[data-autosave-field-error]").length, 0);
  assert.equal(form.status.dataset.autosaveState, "saved");
  form.undoButton!.click();
  assert.deepEqual(requests[2]?.payload, { name: "A", updatedAt: "2" });
  await requests[2].respond(200, { resource: { name: "A" }, revision: "3" });
});

void test("autosave shares acknowledged revisions with sibling forms and preserves their edits", async (t) => {
  const nameForm = new BrowserForm({ name: "A" });
  const displayForm = new BrowserForm({ showAbv: "inherit" }, "expectedRevision");
  const requests = await initializeBrowser(t, [nameForm, displayForm]);
  displayForm.edit("showAbv", "show", "input");
  nameForm.edit("name", "B");
  await requests[0]!.respond(200, { resource: { name: "B" }, revision: 2 });

  assert.equal(displayForm.control("showAbv").value, "show");
  assert.equal(displayForm.control("expectedRevision").value, "2");
  displayForm.edit("showAbv", "show", "blur");
  assert.deepEqual(requests[1]?.payload, { showAbv: "show", expectedRevision: "2" });
  assert.equal(requests[1]?.options?.method, "POST");
  assert.equal(requests[1]?.options?.credentials, "same-origin");
  assert.equal(new Headers(requests[1]?.options?.headers).get("X-CSRF-Token"), "test-csrf");
  await requests[1].respond(200, { resource: { showAbv: "show" }, revision: 3 });
  assert.equal(nameForm.control("updatedAt").value, "3");
  nameForm.undoButton!.click();
  assert.deepEqual(requests[2]?.payload, { name: "A", updatedAt: "3" });
  await requests[2].respond(200, { resource: { name: "A" }, revision: 4 });
});
