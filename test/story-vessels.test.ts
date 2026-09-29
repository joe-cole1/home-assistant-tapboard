import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_VESSEL_ID,
  SAFE_DISPLAY_COLOR,
  VESSEL_IDS,
  displayColorForSrm,
  getVesselDescriptor,
  normalizeDisplayColor,
  resolveDisplayColor,
  resolveVessel,
  resolveVesselId,
} from "../src/features/story/vessels.ts";
import {
  MAX_PUBLIC_RECIPE_INGREDIENTS,
  MAX_PUBLIC_RECIPE_STEPS,
  MAX_SOURCE_JSON_BYTES,
  projectCustomRecipe,
  projectSourceRecipe,
} from "../src/features/story/recipe.ts";

type Point = readonly [number, number];

/** Evaluate the actual curves, so bounds assertions do not mistake controls for extrema. */
function curvePoint(points: readonly Point[], t: number): Point {
  if (points.length === 1) return points[0]!;
  return curvePoint(
    points
      .slice(1)
      .map((point, index): Point => [
        points[index]![0] * (1 - t) + point[0] * t,
        points[index]![1] * (1 - t) + point[1] * t,
      ]),
    t,
  );
}

function curveExtrema(points: readonly Point[]): number[] {
  const result: number[] = [];
  for (const axis of [0, 1] as const) {
    const [a, b, c, d] = points.map((point) => point[axis]);
    if (points.length === 3) {
      const denominator = a! - 2 * b! + c!;
      if (denominator !== 0) result.push((a! - b!) / denominator);
    } else if (points.length === 4) {
      const quadratic = -a! + 3 * b! - 3 * c! + d!;
      const linear = 2 * (a! - 2 * b! + c!);
      const constant = b! - a!;
      if (Math.abs(quadratic) < 1e-10) {
        if (linear !== 0) result.push(-constant / linear);
      } else {
        const discriminant = linear * linear - 4 * quadratic * constant;
        if (discriminant >= 0) {
          const root = Math.sqrt(discriminant);
          result.push((-linear + root) / (2 * quadratic));
          result.push((-linear - root) / (2 * quadratic));
        }
      }
    }
  }
  return result.filter((t) => t > 0 && t < 1);
}

function tracePath(d: string) {
  assert.match(d, /^M /u);
  assert.ok(d.length <= 1200, "a path remains within the renderer's finite size budget");
  assert.match(
    d,
    /^[MLHVCQZ0-9.\s-]+$/u,
    "only the artwork's finite absolute SVG grammar is accepted",
  );
  const tokens = d.match(/[MLHVCQZ]|-?(?:\d+\.?\d*|\.\d+)/gu) ?? [];
  const subpaths: Point[][] = [];
  const extrema: Point[] = [];
  let position: Point = [0, 0];
  let start: Point = position;
  let active: Point[] = [];
  let closed = 0;
  let index = 0;
  const number = () => {
    const token = tokens[index++];
    assert.ok(token !== undefined && /^-?(?:\d+\.?\d*|\.\d+)$/u.test(token));
    const value = Number(token);
    assert.ok(Number.isFinite(value));
    return value;
  };
  const point = (): Point => [number(), number()];
  const segment = (points: readonly Point[]) => {
    extrema.push(points[0]!, points.at(-1)!);
    for (const t of curveExtrema(points)) extrema.push(curvePoint(points, t));
    for (let sample = 1; sample <= 48; sample += 1) active.push(curvePoint(points, sample / 48));
    position = points.at(-1)!;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    switch (command) {
      case "M":
        position = point();
        start = position;
        active = [position];
        subpaths.push(active);
        extrema.push(position);
        break;
      case "L":
        segment([position, point()]);
        break;
      case "H":
        segment([position, [number(), position[1]]]);
        break;
      case "V":
        segment([position, [position[0], number()]]);
        break;
      case "Q":
        segment([position, point(), point()]);
        break;
      case "C":
        segment([position, point(), point(), point()]);
        break;
      case "Z":
        segment([position, start]);
        closed += 1;
        break;
      default:
        assert.fail(`unexpected path command ${command}`);
    }
  }
  assert.ok(subpaths.length > 0);
  return {
    subpaths,
    closed,
    minX: Math.min(...extrema.map(([x]) => x)),
    maxX: Math.max(...extrema.map(([x]) => x)),
    minY: Math.min(...extrema.map(([, y]) => y)),
    maxY: Math.max(...extrema.map(([, y]) => y)),
  };
}

function contains(polygon: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function widthAt(d: string, y: number): number {
  const intersections: number[] = [];
  for (const polygon of tracePath(d).subpaths) {
    for (let i = 1; i < polygon.length; i += 1) {
      const [ax, ay] = polygon[i - 1]!;
      const [bx, by] = polygon[i]!;
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        intersections.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
    }
  }
  return intersections.length < 2 ? 0 : Math.max(...intersections) - Math.min(...intersections);
}

const ORIGINAL_VIEWPORTS = {
  corny_keg: "0 0 160 250",
  pint_glass: "0 40 160 190",
  tulip_glass: "0 35 160 205",
  wheat_glass: "0 25 160 200",
  mug: "0 45 160 180",
  stout_glass: "0 40 160 185",
  snifter: "0 45 160 180",
  nonic_pint: "0 40 160 190",
  shaker_pint: "0 40 160 190",
  pilsner_flute: "0 25 160 205",
  stange: "0 35 160 200",
  goblet: "0 40 160 200",
  teku: "0 40 160 200",
  thistle: "0 40 160 200",
  ipa_glass: "0 30 160 205",
  tasting_glass: "0 45 160 195",
  stemmed_lager: "0 35 160 205",
} as const;

void test("all 17 sculpted vessels preserve their exact viewports and bounded safe paints", () => {
  assert.equal(VESSEL_IDS.length, 17);
  assert.equal(new Set(VESSEL_IDS).size, 17);
  const descriptors = VESSEL_IDS.map((id) => getVesselDescriptor(id));
  assert.equal(new Set(descriptors.map((item) => item.token)).size, 17);
  assert.equal(new Set(descriptors.map((item) => item.bodyPath)).size, 17);
  const paint = /^(?:none|#[0-9A-F]{6}|glass|handle|base|rim|facet|shine|metal)$/u;
  const classes = new Set(["glass-detail", "glass-stem", "glass-base", "glass-highlight"]);
  for (const descriptor of descriptors) {
    const label = descriptor.id;
    assert.equal(descriptor.viewBox, ORIGINAL_VIEWPORTS[label], label);
    assert.equal(descriptor.token, `vessel/${label.replaceAll("_", "-")}`);
    assert.ok(Object.isFrozen(descriptor));
    const [x, y, width, height] = descriptor.viewBox.split(" ").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    for (const path of [descriptor.bodyPath, descriptor.clipPath, descriptor.rimPath]) {
      const bounds = tracePath(path);
      assert.equal(bounds.closed, bounds.subpaths.length, `${label}: closed contour`);
      assert.ok(bounds.minX >= x && bounds.maxX <= x + width, `${label}: horizontal bounds`);
      assert.ok(bounds.minY >= y && bounds.maxY <= y + height, `${label}: vertical bounds`);
    }
    assert.equal(
      tracePath(descriptor.rimPath).subpaths.length,
      2,
      `${label}: a hollow dimensional rim`,
    );
    assert.ok(descriptor.frontPaths.length > 0, `${label}: reflections above the liquid`);
    for (const layer of [descriptor.detailPaths, descriptor.frontPaths]) {
      assert.ok(layer.length <= 24);
      assert.ok(Object.isFrozen(layer));
      for (const item of layer) {
        const bounds = tracePath(item.d);
        assert.ok(Object.isFrozen(item));
        assert.ok(classes.has(item.className));
        assert.match(item.fill, paint);
        assert.match(item.stroke, paint);
        assert.ok(
          Number.isFinite(item.strokeWidth) && item.strokeWidth >= 0 && item.strokeWidth <= 3,
        );
        assert.ok(Number.isFinite(item.opacity) && item.opacity >= 0 && item.opacity <= 1);
        const inset = item.stroke === "none" ? 0 : item.strokeWidth / 2;
        assert.ok(
          bounds.minX - inset >= x && bounds.maxX + inset <= x + width,
          `${label}: detail horizontal bounds`,
        );
        assert.ok(
          bounds.minY - inset >= y && bounds.maxY + inset <= y + height,
          `${label}: detail vertical bounds`,
        );
      }
    }
  }
});

void test("liquid bounds are the true glass interior and never include stems or feet", () => {
  const stemmed = new Set([
    "tulip_glass",
    "snifter",
    "goblet",
    "teku",
    "thistle",
    "tasting_glass",
    "stemmed_lager",
  ]);
  for (const id of VESSEL_IDS) {
    const descriptor = getVesselDescriptor(id);
    const interior = tracePath(descriptor.clipPath);
    const body = tracePath(descriptor.bodyPath);
    for (const value of [
      descriptor.topY,
      descriptor.bottomY,
      descriptor.fillX,
      descriptor.fillWidth,
    ]) {
      assert.ok(Number.isFinite(value));
    }
    assert.equal(interior.subpaths.length, 1, `${id}: only one liquid compartment`);
    assert.ok(
      Math.abs(interior.minY - descriptor.topY) < 1e-8,
      `${id}: full starts at the interior top`,
    );
    assert.ok(
      Math.abs(interior.maxY - descriptor.bottomY) < 1e-8,
      `${id}: empty stops at the actual bowl bottom`,
    );
    assert.ok(descriptor.bottomY > descriptor.topY && descriptor.fillWidth > 0);
    assert.ok(
      descriptor.fillX <= interior.minX && descriptor.fillX + descriptor.fillWidth >= interior.maxX,
      `${id}: liquid spans the entire interior`,
    );
    for (const point of interior.subpaths[0]!) {
      assert.ok(
        contains(body.subpaths[0]!, point),
        `${id}: liquid clip remains inside the glass wall`,
      );
    }
    // At zero fill the surface is exactly the lowest interior point, with no
    // positive-area liquid compartment left below it.
    assert.equal(widthAt(descriptor.clipPath, descriptor.bottomY + 0.01), 0, id);
    const stems = descriptor.detailPaths.filter((item) => item.className === "glass-stem");
    assert.equal(stems.length, stemmed.has(id) ? 1 : 0, `${id}: intentional support structure`);
    for (const stem of stems) {
      const bounds = tracePath(stem.d);
      assert.ok(
        bounds.minY > descriptor.bottomY,
        `${id}: stem begins below the liquid compartment`,
      );
      assert.ok(bounds.maxY - descriptor.bottomY > 20, `${id}: visible, unfilled stem`);
    }
  }
});

void test("sculpted silhouettes retain the physical features of each vessel family", () => {
  const body = (id: string) => getVesselDescriptor(id).bodyPath;
  const width = (id: string, y: number) => widthAt(body(id), y);
  assert.ok(width("nonic_pint", 88) > width("nonic_pint", 60) + 10, "nonic has a real upper bulge");
  assert.ok(width("nonic_pint", 88) > width("nonic_pint", 112) + 10);
  assert.ok(
    width("pilsner_flute", 60) > width("pilsner_flute", 190) * 1.8,
    "pilsner flares toward its mouth",
  );
  assert.ok(
    Math.abs(width("stange", 70) - width("stange", 200)) < 3,
    "stange stays straight sided",
  );
  assert.ok(width("shaker_pint", 60) > width("shaker_pint", 205) + 15, "shaker tapers to its base");
  assert.ok(
    width("wheat_glass", 75) > width("wheat_glass", 176) + 30,
    "wheat has a narrow lower waist",
  );
  assert.ok(
    width("stout_glass", 90) > width("stout_glass", 185) + 30,
    "stout has rounded upper shoulders",
  );
  assert.ok(
    width("tulip_glass", 120) > width("tulip_glass", 72) + 18,
    "tulip has a pinched neck and full lower bowl",
  );
  assert.ok(
    width("snifter", 115) > width("tulip_glass", 115) + 15,
    "snifter is broader than a tulip",
  );
  const stemHeight = (id: string) => {
    const stem = getVesselDescriptor(id).detailPaths.find(
      (item) => item.className === "glass-stem",
    )!;
    const bounds = tracePath(stem.d);
    return bounds.maxY - bounds.minY;
  };
  assert.ok(
    stemHeight("snifter") < stemHeight("tulip_glass") - 15,
    "snifter has a short stem that fits its original viewport",
  );
  assert.ok(width("teku", 117) > width("teku", 70) + 30, "teku has angular outward shoulders");
  assert.ok((body("teku").match(/ L /gu) ?? []).length >= 5, "teku preserves hard bowl angles");
  assert.ok(width("thistle", 55) > width("thistle", 80) + 10, "thistle has a flared lip");
  assert.ok(width("thistle", 115) > width("thistle", 80) + 10, "thistle has a bulb below its neck");
  for (const [ridge, recess] of [
    [158, 167],
    [176, 185],
    [194, 203],
  ]) {
    assert.ok(
      width("ipa_glass", ridge!) > width("ipa_glass", recess!) + 4,
      "IPA has three dimensional lower ribs",
    );
  }
  assert.ok(width("goblet", 80) > width("stemmed_lager", 80) + 20, "goblet remains a wide chalice");
  assert.ok(
    width("tasting_glass", 115) < width("snifter", 115) - 20,
    "tasting glass has a smaller bowl",
  );
});

void test("mug handle stays transparent and keg hardware frames a visible liquid gauge", () => {
  const mug = getVesselDescriptor("mug");
  const handle = mug.detailPaths.find((item) => item.fill === "handle");
  assert.ok(handle);
  const handleShape = tracePath(handle.d);
  assert.ok(handleShape.maxX > tracePath(mug.bodyPath).maxX + 15);
  assert.equal(
    contains(handleShape.subpaths[0]!, [127, 125]),
    false,
    "handle opening is transparent",
  );
  assert.equal(
    contains(handleShape.subpaths[0]!, [138, 125]),
    true,
    "outer handle retains solid glass",
  );
  const mugFacets = mug.frontPaths.filter((item) => item.fill === "facet");
  assert.equal(
    mugFacets.flatMap((item) => tracePath(item.d).subpaths).length,
    3,
    "approved mug has three rounded front facets",
  );
  const keg = getVesselDescriptor("corny_keg");
  assert.ok(keg.detailPaths.some((item) => item.fill === "metal"));
  assert.ok(keg.detailPaths.some((item) => item.fill === "#000000"));
  assert.ok(
    widthAt(keg.clipPath, 125) < widthAt(keg.bodyPath, 125) / 3,
    "liquid occupies the narrow sight gauge",
  );
  assert.ok(
    keg.frontPaths.some(
      (item) => item.stroke === "#F3FCFF" && tracePath(item.d).subpaths.length >= 6,
    ),
    "gauge has visible graduation marks",
  );
});

void test("style mapping is deterministic and explicit safe fill glass wins", () => {
  for (const [style, id] of [
    ["Witbier", "wheat_glass"],
    ["German Pilsner", "pilsner_flute"],
    ["Kölsch", "stange"],
    ["Belgian Saison", "goblet"],
    ["American Pale Ale", "ipa_glass"],
    ["Wild Ale", "teku"],
    ["Robust Porter", "stout_glass"],
    ["Wee Heavy", "thistle"],
    ["American Barleywine", "snifter"],
    ["English ESB", "nonic_pint"],
    ["American Amber Ale", "shaker_pint"],
    ["Doppelbock", "stemmed_lager"],
  ] as const)
    assert.equal(resolveVesselId({ style }), id, style);
  assert.equal(resolveVesselId({ style: "Wild Lambic" }), "teku");
  assert.equal(resolveVesselId({ style: "Sour Ale" }), "teku");
  assert.equal(resolveVesselId({ style: "West Coast IPA" }), "ipa_glass");
  assert.equal(resolveVesselId({ style: "Imperial Stout" }), "stout_glass");
  assert.equal(resolveVesselId({ style: "Hefeweizen" }), "wheat_glass");
  assert.equal(resolveVesselId({ style: "Tripel" }), "goblet");
  assert.equal(resolveVesselId({ style: "Unknown beverage" }), DEFAULT_VESSEL_ID);
  assert.equal(resolveVesselId({ fillGlass: "teku", style: "IPA" }), "teku");
  assert.deepEqual(
    resolveVessel({ fillGlass: "<svg onload=alert(1) />", style: "IPA" }).id,
    "ipa_glass",
  );
  assert.equal(resolveVesselId({ fillGlass: "<script>bad</script>" }), DEFAULT_VESSEL_ID);
  assert.equal(getVesselDescriptor("<svg onload=alert(1) />").id, DEFAULT_VESSEL_ID);
});

void test("display color validates explicit hex and uses finite SRM palette", () => {
  assert.equal(normalizeDisplayColor(" #aBc123 "), "#ABC123");
  assert.equal(normalizeDisplayColor("#abc"), null);
  assert.equal(normalizeDisplayColor("red"), null);
  assert.equal(resolveDisplayColor({ displayColor: "#aBc123", srm: 50 }), "#ABC123");
  assert.equal(
    resolveDisplayColor({ displayColor: "rgb(1,2,3)", srm: 30 }),
    displayColorForSrm(30),
  );
  assert.equal(resolveDisplayColor({ displayColor: "#bad", srm: Number.NaN }), SAFE_DISPLAY_COLOR);
  assert.equal(resolveDisplayColor({ displayColor: "url(javascript:bad)" }), SAFE_DISPLAY_COLOR);
  assert.equal(displayColorForSrm(3), "#ECE61A");
  assert.equal(displayColorForSrm(30), "#280200");
  assert.match(displayColorForSrm(0) ?? "", /^#[0-9A-F]{6}$/);
  assert.equal(resolveDisplayColor({ srm: "not-a-number" }), SAFE_DISPLAY_COLOR);
  assert.equal(displayColorForSrm(-1), null);
  assert.equal(displayColorForSrm(51), null);
});

void test("recipe projections cap, sanitize, and never expose source internals", () => {
  const ingredients = Array.from({ length: MAX_PUBLIC_RECIPE_INGREDIENTS + 3 }, (_, index) => ({
    id: `secret-${index}`,
    name: `${"n".repeat(160)}-${index}`,
    type: "fermentable-secret-type",
    amount: 1,
    unit: "kilograms-secret-unit",
  }));
  const steps = Array.from({ length: MAX_PUBLIC_RECIPE_STEPS + 2 }, () => ({
    id: "secret-step-id",
    text: "x".repeat(800),
  }));
  const custom = projectCustomRecipe(
    { id: "secret-recipe-id", ingredients, steps, notes: "private note" },
    { label: "My Recipe", state: "detached", version: 2, capturedAt: "2026-01-01T00:00:00.000Z" },
  );
  assert.equal(custom.status, "partial");
  assert.equal(custom.ingredients.length, MAX_PUBLIC_RECIPE_INGREDIENTS);
  assert.equal(custom.steps.length, MAX_PUBLIC_RECIPE_STEPS);
  assert.ok((custom.ingredients[0]?.name.length ?? 0) <= 120);
  assert.ok((custom.ingredients[0]?.type?.length ?? 0) <= 40);
  assert.ok((custom.ingredients[0]?.unit?.length ?? 0) <= 24);
  assert.equal(custom.ingredients[0]?.note, null);
  assert.ok((custom.steps[0]?.text.length ?? 0) <= 500);
  assert.equal(custom.steps[0]?.name, null);
  assert.equal(custom.steps[0]?.temperatureC, null);
  assert.equal(custom.steps[0]?.timeMinutes, null);
  assert.equal("id" in custom, false);
  assert.equal(JSON.stringify(custom).includes("secret-recipe-id"), false);
  assert.equal(JSON.stringify(custom).includes("secret-step-id"), false);
  assert.deepEqual(custom.provenance, {
    label: "My Recipe",
    state: "detached",
    version: 2,
    capturedAt: "2026-01-01T00:00:00.000Z",
  });

  const rich = projectCustomRecipe({
    ingredients: [{ name: "Lactose", amount: 10, unit: "g", note: "sweetener" }],
    steps: [{ name: "Mash", note: "Hold", temperatureC: 67, timeMinutes: 60 }],
  });
  assert.deepEqual(rich.ingredients[0], {
    name: "Lactose",
    type: null,
    amount: 10,
    unit: "g",
    percent: null,
    note: "sweetener",
  });
  assert.deepEqual(rich.steps[0], {
    text: "Hold",
    name: "Mash",
    temperatureC: 67,
    timeMinutes: 60,
    note: "Hold",
  });

  const groupedSource = projectSourceRecipe(
    JSON.stringify({
      ingredients: {
        fermentables: [{ name: "Pale Malt", type: "grain", note: "base" }],
        miscs: [{ name: "Lactose", amount: 10, unit: "g" }],
      },
      steps: [{ name: "Boil", text: "Boil wort", temperatureC: 100, timeMinutes: 60 }],
    }),
  );
  assert.equal(groupedSource.ingredients[0]?.note, "base");
  assert.deepEqual(groupedSource.steps[0], {
    text: "Boil wort",
    name: "Boil",
    temperatureC: 100,
    timeMinutes: 60,
    note: null,
  });
});

void test("malformed and oversized source JSON are safe unavailable projections", () => {
  const malformed = projectSourceRecipe("{not-json", {
    label: "Frozen",
    state: "detached",
    version: 1,
  });
  assert.equal(malformed.status, "unavailable");
  assert.deepEqual(malformed.ingredients, []);
  const oversized = projectSourceRecipe("x".repeat(MAX_SOURCE_JSON_BYTES + 1));
  assert.equal(oversized.status, "unavailable");
  assert.doesNotThrow(() => projectSourceRecipe({ ingredients: [{ name: "Pale Malt" }] }));
});
