import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { getVesselDescriptor, VESSEL_IDS } from "../src/features/story/vessels.ts";

interface Geometry {
  topY: number;
  bottomY: number;
  fillX: number;
  fillWidth: number;
  viewBox: string;
}

class SvgElement {
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  toggleAttribute(name: string, enabled: boolean): void {
    if (enabled) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }
}

const boundedSelectors = [
  ".beer-liquid-rect",
  ".beer-liquid-shadow",
  ".beer-liquid-depth",
  ".beer-bubble-clip-rect",
];

class VesselSvg extends SvgElement {
  isConnected = true;
  readonly parts = new Map(
    [...boundedSelectors, ".beer-cloud-foam", ".beer-bubbles", ".beer-pour-stream"].map(
      (selector) => [selector, new SvgElement()],
    ),
  );

  querySelector(selector: string): SvgElement | null {
    return this.parts.get(selector) ?? null;
  }

  part(selector: string): SvgElement {
    const part = this.querySelector(selector);
    assert.ok(part, `${selector} exists`);
    return part;
  }
}

const { updateVesselFill, previewVesselPour, stopVesselPour, cancelVesselAnimation } =
  (await import(new URL("../public/js/vessel-fill.js", import.meta.url).href)) as {
    updateVesselFill: (
      svg: VesselSvg,
      graphic: Geometry,
      percentage: unknown,
      color: string,
      animate?: boolean,
    ) => void;
    previewVesselPour: (svg: VesselSvg) => void;
    stopVesselPour: (svg: VesselSvg) => void;
    cancelVesselAnimation: (svg: VesselSvg) => void;
  };

function installClock(context: TestContext, reduced = false) {
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, (timestamp: number) => void>();
  const listeners = new Set<() => void>();
  const media = {
    matches: reduced,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      performance: { now: () => now },
      matchMedia: () => media,
      requestAnimationFrame(callback: (timestamp: number) => void) {
        frames.set(++nextId, callback);
        return nextId;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    },
  });
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return {
    frames,
    listeners,
    step(timestamp: number) {
      assert.ok(timestamp >= now, "animation clock moves forward");
      now = timestamp;
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(timestamp);
      }
    },
    reduceMotion(matches: boolean) {
      media.matches = matches;
      for (const listener of [...listeners]) listener();
    },
  };
}

function numberAttribute(svg: VesselSvg, selector: string, attribute: string): number {
  const value = svg.part(selector).getAttribute(attribute);
  assert.notEqual(value, null);
  const number = Number(value);
  assert.ok(Number.isFinite(number), `${selector} ${attribute} is finite`);
  return number;
}

function close(actual: number, expected: number, tolerance = 1e-7): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is close to ${expected}`);
}

function assertFrame(svg: VesselSvg, graphic: Geometry, percentage?: number): void {
  const y = numberAttribute(svg, ".beer-liquid-rect", "y");
  const height = numberAttribute(svg, ".beer-liquid-rect", "height");
  assert.ok(y >= graphic.topY && y <= graphic.bottomY, "surface remains inside the bowl");
  assert.equal(height, graphic.bottomY - y, "no liquid extends beneath the bowl floor");
  for (const selector of boundedSelectors) {
    assert.equal(numberAttribute(svg, selector, "y"), y, `${selector} tracks the surface`);
    assert.equal(numberAttribute(svg, selector, "height"), height, `${selector} stays in bowl`);
  }
  const streamY = numberAttribute(svg, ".beer-pour-stream", "y");
  const streamHeight = numberAttribute(svg, ".beer-pour-stream", "height");
  assert.equal(streamY, graphic.topY - 32);
  assert.equal(streamHeight, y - streamY, "stream reaches the current surface exactly");
  close(streamY + streamHeight, y);
  assert.equal(svg.part(".beer-cloud-foam").getAttribute("transform"), `translate(0 ${y})`);
  assert.equal(numberAttribute(svg, ".beer-cloud-foam", "data-base-y"), y);
  const rendered = Number(svg.dataset.renderedFillPercent);
  assert.equal(svg.part(".beer-cloud-foam").attributes.has("hidden"), rendered === 0);
  assert.equal(svg.part(".beer-bubbles").attributes.has("hidden"), rendered === 0);
  if (percentage !== undefined) {
    close(rendered, percentage);
    close(y, graphic.bottomY - ((graphic.bottomY - graphic.topY) * percentage) / 100);
  }
}

void test("every vessel empties without residue and keeps all liquid layers above its floor", (context) => {
  const clock = installClock(context);
  for (const id of VESSEL_IDS) {
    const graphic = getVesselDescriptor(id);
    const svg = new VesselSvg();
    const liquid = svg.part(".beer-liquid-rect");
    for (const percentage of [0, 0.0001, 1, 50, 100, 0]) {
      updateVesselFill(svg, graphic, percentage, "#C57216", false);
      assertFrame(svg, graphic, percentage);
      assert.equal(liquid.dataset.fillPercent, String(percentage));
      assert.equal(svg.part(".beer-liquid-rect"), liquid, "liquid identity is preserved");
      assert.equal(svg.part(".beer-pour-stream").getAttribute("fill"), "#C57216");
    }
    assert.equal(numberAttribute(svg, ".beer-liquid-rect", "height"), 0);
    assert.equal(numberAttribute(svg, ".beer-liquid-rect", "y"), graphic.bottomY);
  }
  for (const id of ["goblet", "tulip_glass", "teku", "stemmed_lager", "snifter"] as const) {
    const graphic = getVesselDescriptor(id);
    const [, viewY = 0, , viewHeight = 0] = graphic.viewBox.split(" ").map(Number);
    assert.ok(
      graphic.bottomY < viewY + viewHeight,
      `${id} liquid floor excludes its stem and base`,
    );
  }
  assert.equal(clock.frames.size, 0);
});

void test("first paint and nonfinite or out-of-range values settle safely without animation", (context) => {
  const clock = installClock(context);
  const svg = new VesselSvg();
  const graphic = getVesselDescriptor("goblet");
  updateVesselFill(svg, graphic, 60, "#9C5500");
  assertFrame(svg, graphic, 60);
  assert.equal(clock.frames.size, 0);
  for (const [input, expected] of [
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
    ["invalid", 0],
    [Symbol("invalid"), 0],
    [-30, 0],
    [140, 100],
    ["35", 35],
  ] as const) {
    updateVesselFill(svg, graphic, input, "url(unsafe)", false);
    assertFrame(svg, graphic, expected);
    assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, String(expected));
    assert.equal(svg.part(".beer-liquid-rect").getAttribute("fill"), "#D97706");
    assert.equal(svg.part(".beer-pour-stream").getAttribute("fill"), "#D97706");
  }
  assert.equal(clock.frames.size, 0);
});

void test("the first live update animates from the server-rendered fill", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("tulip_glass");
  const svg = new VesselSvg();
  svg.dataset.fillTopY = String(graphic.topY);
  svg.dataset.fillBottomY = String(graphic.bottomY);
  svg.part(".beer-liquid-rect").dataset.fillPercent = "80";
  updateVesselFill(svg, graphic, 20, "#D97706");
  assertFrame(svg, graphic, 80);
  assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, "20");
  clock.step(4000);
  assertFrame(svg, graphic, 80 - 60 * 0.80240338758);
  clock.step(8000);
  assertFrame(svg, graphic, 20);
  assert.equal(clock.frames.size, 0);
});

void test("live fill uses the reviewed eight-second easing with synchronized geometry on every frame", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("teku");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 0, "#D97706");
  updateVesselFill(svg, graphic, 100, "#A64010");
  assertFrame(svg, graphic, 0);
  let previous = 0;
  for (const timestamp of [0, 16, 100, 500, 2000, 4000, 6000, 7999, 8000]) {
    clock.step(timestamp);
    assertFrame(svg, graphic);
    const rendered = Number(svg.dataset.renderedFillPercent);
    assert.ok(rendered >= previous && rendered <= 100);
    previous = rendered;
    assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, "100");
    if (timestamp === 4000) close(rendered, 80.240338758, 0.00001);
    if (timestamp < 8000) assert.ok(rendered < 100);
  }
  assertFrame(svg, graphic, 100);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  updateVesselFill(svg, graphic, 0, "#A64010");
  clock.step(12000);
  assertFrame(svg, graphic);
  assert.ok(Number(svg.dataset.renderedFillPercent) > 0);
  assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, "0");
  clock.step(16000);
  assertFrame(svg, graphic, 0);
  assert.equal(numberAttribute(svg, ".beer-liquid-depth", "height"), 0);
  assert.equal(clock.frames.size, 0);
});

void test("repeated live updates start at the visible level and stale callbacks cannot overwrite them", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("tulip_glass");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 0, "#D97706");
  updateVesselFill(svg, graphic, 90, "#D97706");
  clock.step(2000);
  const visible = Number(svg.dataset.renderedFillPercent);
  const staleFrame = [...clock.frames.values()][0];
  assert.ok(staleFrame);
  updateVesselFill(svg, graphic, 20, "#120100");
  assertFrame(svg, graphic, visible);
  assert.equal(clock.frames.size, 1);
  assert.equal(clock.listeners.size, 1);
  assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, "20");
  staleFrame(8000);
  assertFrame(svg, graphic, visible);
  assert.equal(clock.frames.size, 1);
  clock.step(6000);
  assertFrame(svg, graphic, visible + (20 - visible) * 0.80240338758);
  updateVesselFill(svg, graphic, 20, "#370200");
  assert.equal(svg.part(".beer-pour-stream").getAttribute("fill"), "#370200");
  clock.step(10000);
  assertFrame(svg, graphic, 20);
  assert.equal(clock.frames.size, 0, "an unchanged target does not restart the eight-second clock");
  assert.equal(clock.listeners.size, 0);
});

void test("preview bootstraps server-rendered geometry and fills from the empty bowl in three seconds", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("snifter");
  const svg = new VesselSvg();
  svg.dataset.fillTopY = String(graphic.topY);
  svg.dataset.fillBottomY = String(graphic.bottomY);
  svg.setAttribute("viewBox", graphic.viewBox);
  const liquid = svg.part(".beer-liquid-rect");
  liquid.setAttribute("x", String(graphic.fillX));
  liquid.setAttribute("width", String(graphic.fillWidth));
  liquid.setAttribute("fill", "#AA7700");
  liquid.dataset.fillPercent = "65.0";
  previewVesselPour(svg);
  assertFrame(svg, graphic, 0);
  const emptyStreamHeight = numberAttribute(svg, ".beer-pour-stream", "height");
  let previousStreamHeight = emptyStreamHeight;
  for (const timestamp of [16, 500, 1500, 2999, 3000]) {
    clock.step(timestamp);
    assertFrame(svg, graphic);
    const streamHeight = numberAttribute(svg, ".beer-pour-stream", "height");
    assert.ok(streamHeight < previousStreamHeight, "stream shortens as the surface rises");
    previousStreamHeight = streamHeight;
    assert.equal(liquid.dataset.fillPercent, "65.0", "preview never writes the authoritative data");
  }
  assertFrame(svg, graphic, 65);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  assert.equal(svg.part(".beer-pour-stream").getAttribute("fill"), "#AA7700");
});

void test("stopping a preview restores the latest authority and live updates supersede a preview", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("goblet");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 70, "#D97706");
  previewVesselPour(svg);
  clock.step(1000);
  svg.part(".beer-liquid-rect").dataset.fillPercent = "45";
  stopVesselPour(svg);
  assertFrame(svg, graphic, 45);
  assert.equal(clock.frames.size, 0);
  previewVesselPour(svg);
  clock.step(1500);
  const visible = Number(svg.dataset.renderedFillPercent);
  const stalePreview = [...clock.frames.values()][0];
  assert.ok(stalePreview);
  updateVesselFill(svg, graphic, 80, "#250100");
  assertFrame(svg, graphic, visible);
  assert.equal(svg.part(".beer-liquid-rect").dataset.fillPercent, "80");
  stalePreview(4000);
  assertFrame(svg, graphic, visible);
  clock.step(9500);
  assertFrame(svg, graphic, 80);
  assert.equal(clock.frames.size, 0);
  previewVesselPour(svg);
  clock.step(10000);
  updateVesselFill(svg, graphic, 80, "#250100", false);
  assertFrame(svg, graphic, 80);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
});

void test("a late preview timeout leaves a superseding live animation running", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("tulip_glass");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 80, "#D97706");
  previewVesselPour(svg);
  clock.step(1000);
  const start = Number(svg.dataset.renderedFillPercent);
  updateVesselFill(svg, graphic, 20, "#D97706");
  clock.step(3500);
  const beforeTimeout = Number(svg.dataset.renderedFillPercent);
  assert.ok(beforeTimeout < start && beforeTimeout > 20);
  stopVesselPour(svg);
  assertFrame(svg, graphic, beforeTimeout);
  assert.equal(clock.frames.size, 1);
  clock.step(9000);
  assertFrame(svg, graphic, 20);
  assert.equal(clock.frames.size, 0);
});

void test("reduced motion renders targets immediately and changes cancel active motion", (context) => {
  const clock = installClock(context, true);
  const graphic = getVesselDescriptor("stemmed_lager");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 10, "#D97706");
  updateVesselFill(svg, graphic, 75, "#D97706");
  assertFrame(svg, graphic, 75);
  previewVesselPour(svg);
  assertFrame(svg, graphic, 75);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  clock.reduceMotion(false);
  previewVesselPour(svg);
  clock.step(500);
  assert.ok(Number(svg.dataset.renderedFillPercent) < 75);
  clock.reduceMotion(true);
  assertFrame(svg, graphic, 75);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  clock.reduceMotion(false);
  assert.equal(clock.frames.size, 0, "turning motion back on does not revive old work");
  updateVesselFill(svg, graphic, 30, "#D97706");
  clock.step(1000);
  clock.reduceMotion(true);
  assertFrame(svg, graphic, 30);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
});

void test("disconnected SVGs and structure cancellation release pending frames and motion listeners", (context) => {
  const clock = installClock(context);
  const graphic = getVesselDescriptor("teku");
  const svg = new VesselSvg();
  updateVesselFill(svg, graphic, 0, "#D97706");
  updateVesselFill(svg, graphic, 100, "#D97706");
  svg.isConnected = false;
  clock.step(16);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  updateVesselFill(svg, graphic, 40, "#D97706");
  assertFrame(svg, graphic, 40);
  assert.equal(clock.frames.size, 0);
  svg.isConnected = true;
  updateVesselFill(svg, graphic, 80, "#D97706");
  const staleFrame = [...clock.frames.values()][0];
  assert.ok(staleFrame);
  cancelVesselAnimation(svg);
  assert.equal(clock.frames.size, 0);
  assert.equal(clock.listeners.size, 0);
  const replacementGraphic = getVesselDescriptor("pint_glass");
  updateVesselFill(svg, replacementGraphic, 55, "#D97706");
  assertFrame(svg, replacementGraphic, 55);
  staleFrame(9000);
  assertFrame(svg, replacementGraphic, 55);
  assert.equal(clock.frames.size, 0, "first paint after a rebuild is immediate");
});
