import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
  adminFillPageHref,
  adminFillPageQueryFromRequest,
  adminKegPageHref,
  adminKegPageQueryFromRequest,
  adminTapPageHref,
  adminTapPageQueryFromRequest,
} from "../src/features/web/admin/list-query.ts";
import {
  safeDisplayResource,
  safeTapCardResource,
  safeTapOverrideResource,
} from "../src/features/web/presenters/display.ts";
import type {
  DisplaySettings,
  TapCardDisplaySettings,
  UpdateDisplaySettingsInput,
  UpdateTapCardDisplaySettingsInput,
  EffectiveTapCardDisplaySettings,
} from "../src/features/display/types.ts";
import { ApplicationError } from "../src/shared/errors.ts";

const request = (query = ""): IncomingMessage => ({ url: `/admin?${query}` }) as IncomingMessage;

void test("pagination retains search values even when they match another key's default", () => {
  for (const q of ["active", "state", "number", "all", "한글 & + ?"]) {
    for (const page of [1, 2, 3]) {
      for (const href of [
        adminFillPageHref({ q, state: "active", sort: "state", page: 99 }, page),
        adminKegPageHref({ q, status: "active", sort: "number", page: 99 }, page),
        adminTapPageHref({ q, state: "all" }, page),
      ]) {
        const url = new URL(href, "http://local");
        assert.equal(url.searchParams.get("q"), q);
        assert.equal(url.searchParams.get("page"), page === 1 ? null : String(page));
        assert.deepEqual([...url.searchParams.keys()], page === 1 ? ["q"] : ["q", "page"]);
      }
    }
  }
  assert.equal(
    adminFillPageHref({ q: "", state: "ended", sort: "number" }, 1),
    "/admin/keg-room?state=ended&sort=number",
  );
  assert.equal(
    adminKegPageHref({ q: "", status: "retired", sort: "state" }, 1),
    "/admin/keg-room/kegs?status=retired&sort=state",
  );
  assert.equal(adminTapPageHref({ q: "", state: "disabled" }, 1), "/admin/taps?state=disabled");
  assert.equal(adminFillPageHref({ q: "", state: "active", sort: "state" }, 1), "/admin/keg-room");
  assert.equal(
    adminKegPageHref({ q: "", status: "active", sort: "number" }, 1),
    "/admin/keg-room/kegs",
  );
  assert.equal(adminTapPageHref({ q: "", state: "all" }, 1), "/admin/taps");
});

void test("list parsers preserve defaults, bounded searches/pages, history aliases and validation", () => {
  assert.deepEqual(adminFillPageQueryFromRequest(request()), {
    q: "",
    state: "active",
    sort: "state",
    page: 1,
  });
  assert.deepEqual(adminKegPageQueryFromRequest(request()), {
    q: "",
    status: "active",
    sort: "number",
    page: 1,
  });
  assert.deepEqual(adminTapPageQueryFromRequest(request()), { q: "", state: "all", page: 1 });
  for (const parser of [
    adminFillPageQueryFromRequest,
    adminKegPageQueryFromRequest,
    adminTapPageQueryFromRequest,
  ]) {
    assert.equal(
      parser(request(`q=${encodeURIComponent("  " + "x".repeat(81) + "  ")}`)).q,
      "x".repeat(80),
    );
    for (const [raw, expected] of [
      ["0", 1],
      ["-5", 1],
      ["1.5", 1],
      ["Infinity", 1],
      ["NaN", 1],
      ["", 1],
      ["10001", 10000],
      ["10000", 10000],
      ["2", 2],
      ["1e2", 100],
    ] as const) {
      assert.equal(parser(request(`page=${raw}`)).page, expected, raw);
    }
  }
  for (const history of ["1", "true"])
    assert.equal(
      adminFillPageQueryFromRequest(request(`history=${history}&state=on_tap`)).state,
      "ended",
    );
  assert.equal(
    adminFillPageQueryFromRequest(request("history=TRUE&state=INVALID&sort=WRONG")).state,
    "invalid",
  );
  assert.equal(adminFillPageQueryFromRequest(request("sort=WRONG")).sort, "wrong");
  assert.equal(
    adminKegPageQueryFromRequest(request("status=INVALID&sort=WRONG")).status,
    "invalid",
  );
  assert.equal(adminKegPageQueryFromRequest(request("sort=WRONG")).sort, "wrong");
  for (const state of ["all", "assigned", "unassigned", "disabled", "retired"] as const)
    assert.equal(
      adminTapPageQueryFromRequest(request(`state=${state.toUpperCase()}`)).state,
      state,
    );
  assert.throws(
    () => adminTapPageQueryFromRequest(request("state=invalid")),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.category, "validation");
      assert.equal(error.code, "request.invalid");
      assert.equal(
        error.clientMessage,
        "Tap state must be all, assigned, unassigned, disabled, or retired.",
      );
      assert.equal(error.details, undefined);
      return true;
    },
  );
});

const display: DisplaySettings = {
  revision: 1,
  updatedAt: "private",
  tapboardName: "Board",
  theme: "modern_dark",
  font: "system",
  accent: "amber",
  unitSystem: "us",
  showServingTemperature: false,
  layoutMode: "scroll",
};
const card: TapCardDisplaySettings = {
  revision: 1,
  updatedAt: "private",
  showAbv: true,
  showIbu: false,
  showOg: true,
  showFg: false,
  showSrm: true,
  remainingMode: "percent",
};
const metrics = ["showAbv", "showIbu", "showOg", "showFg", "showSrm"] as const;
void test("display presenters construct only the explicit safe fields", () => {
  assert.deepEqual(safeDisplayResource({ ...display, secret: "extra" } as DisplaySettings), {
    tapboardName: "Board",
    theme: "modern_dark",
    font: "system",
    accent: "amber",
    unitSystem: "us",
    showServingTemperature: false,
    layoutMode: "scroll",
  });
  assert.deepEqual(safeTapCardResource({ ...card, secret: "extra" } as TapCardDisplaySettings), {
    showAbv: true,
    showIbu: false,
    showOg: true,
    showFg: false,
    showSrm: true,
    remainingMode: "percent",
  });
  assert.deepEqual(
    safeTapOverrideResource({ tapId: "private", settings: card, override: null }),
    Object.fromEntries(metrics.map((key) => [key, "inherit"])),
  );
  for (const [value, expected] of [
    [null, "inherit"],
    [undefined, "inherit"],
    [false, "hide"],
    [true, "show"],
  ] as const) {
    const effective = {
      tapId: "private",
      settings: card,
      override: {
        tapId: "private",
        updatedAt: "private",
        secret: "extra",
        ...Object.fromEntries(metrics.map((key) => [key, value])),
      },
    } as unknown as EffectiveTapCardDisplaySettings;
    assert.deepEqual(
      safeTapOverrideResource(effective),
      Object.fromEntries(metrics.map((key) => [key, expected])),
    );
  }
});

// Type equality prevents accidental additions or removals from either writable contract.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const displayKeys: Equal<
  keyof UpdateDisplaySettingsInput,
  | "expectedRevision"
  | "tapboardName"
  | "theme"
  | "font"
  | "accent"
  | "unitSystem"
  | "showServingTemperature"
  | "layoutMode"
> = true;
const cardKeys: Equal<
  keyof UpdateTapCardDisplaySettingsInput,
  "expectedRevision" | "showAbv" | "showIbu" | "showOg" | "showFg" | "showSrm" | "remainingMode"
> = true;
assert.equal(displayKeys && cardKeys, true);
