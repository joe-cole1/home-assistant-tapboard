/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Eta } from "eta";
import { getVesselDescriptor, VESSEL_IDS } from "../../src/features/story/vessels.ts";
import type { VesselGeometryDescriptor, VesselId } from "../../src/features/story/types.ts";

interface SampleTap {
  readonly id: string;
  readonly tapNumber: number;
  readonly title: string;
  readonly graphicId: VesselId;
  readonly graphic: VesselGeometryDescriptor;
  readonly fillPercent: number;
  readonly displayColor: string;
}

interface VesselHarness {
  readonly taps: readonly SampleTap[];
  readonly graphics: readonly SVGSVGElement[];
  readonly renderer: {
    createGraphic(tap: SampleTap): SVGSVGElement;
    applyGraphic(svg: SVGSVGElement, tap: SampleTap): void;
  };
  readonly fill: {
    previewVesselPour(this: void, svg: SVGSVGElement): void;
    stopVesselPour(this: void, svg: SVGSVGElement): void;
  };
}

declare global {
  interface Window {
    vesselHarness: VesselHarness;
  }
}

const originalViewBoxes: Record<VesselId, string> = {
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
};

async function openArtwork(page: Page, fillPercent = 57): Promise<void> {
  const taps = VESSEL_IDS.map((id, index) => ({
    id: `artwork-${id}`,
    tapNumber: index + 1,
    title: id,
    graphicId: id,
    graphic: getVesselDescriptor(id),
    fillPercent,
    displayColor: "#C77C18",
  }));
  const eta = new Eta();
  const template = readFileSync(
    new URL("../../views/partials/fill-graphic.eta", import.meta.url),
    "utf8",
  );
  // Repeated copies of one tap must still own their gradient and clipping IDs.
  const serverMarkup = [...taps, taps[0]!]
    .map(
      (tap) => `<article class="sample tap-card">${eta.renderString(template, { tap })}</article>`,
    )
    .join("");
  await page.route("**/__vessel-artwork", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html data-theme="dark"><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/assets/css/tokens.css">
        <link rel="stylesheet" href="/assets/css/dashboard.css">
        <style>
          body { margin: 12px; }
          #server, #live { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
          .sample { display: block; min-width: 0; padding: 8px; }
          .sample .tap-graphic { width: 100%; height: 230px; max-height: none; }
        </style>
      </head><body><section id="server">${serverMarkup}</section><section id="live"></section></body></html>`,
    });
  });
  await page.goto("/__vessel-artwork");
  await page.evaluate(async (samples) => {
    const rendererPath = "/assets/js/vessel-renderer.js";
    const fillPath = "/assets/js/vessel-fill.js";
    const renderer = (await import(rendererPath)) as VesselHarness["renderer"];
    const fill = (await import(fillPath)) as VesselHarness["fill"];
    const graphics = [...samples, samples[0]!].map((tap) => {
      const card = document.createElement("article");
      card.className = "sample tap-card";
      const graphic = renderer.createGraphic(tap);
      card.append(graphic);
      document.querySelector("#live")!.append(card);
      return graphic;
    });
    window.vesselHarness = {
      taps: samples,
      graphics: graphics.slice(0, samples.length),
      renderer,
      fill,
    };
  }, taps);
}

async function surfaces(page: Page) {
  return page.evaluate(() =>
    window.vesselHarness.graphics.map((svg) => {
      const rect = (selector: string) => {
        const element = svg.querySelector<SVGRectElement>(selector);
        if (!element) throw new Error(`Missing ${selector}.`);
        // getBBox observes CSS geometry too, so a stray CSS transition cannot
        // hide a mismatch between the painted surface and its SVG attributes.
        const height = element.height.baseVal.value;
        const bounds = element.getBBox();
        return height > 0
          ? { y: bounds.y, height: bounds.height }
          : { y: element.y.baseVal.value, height };
      };
      const liquid = rect(".beer-liquid-rect");
      const stream = rect(".beer-pour-stream");
      const foam = svg.querySelector<SVGGElement>(".beer-cloud-foam")!;
      return {
        id: svg.dataset.graphicId,
        target: Number(svg.querySelector<SVGRectElement>(".beer-liquid-rect")!.dataset.fillPercent),
        top: Number(svg.dataset.fillTopY),
        bottom: Number(svg.dataset.fillBottomY),
        liquid,
        companions: [
          rect(".beer-liquid-shadow"),
          rect(".beer-liquid-depth"),
          rect(".beer-bubble-clip-rect"),
        ],
        streamEnd: stream.y + stream.height,
        foamY: foam.hasAttribute("hidden")
          ? foam.transform.baseVal.consolidate()!.matrix.f
          : svg.getScreenCTM()!.inverse().multiply(foam.getScreenCTM()!).f,
        foamHidden: foam.hasAttribute("hidden"),
        bubblesHidden: svg.querySelector(".beer-bubbles")!.hasAttribute("hidden"),
      };
    }),
  );
}

function expectSynchronized(frames: Awaited<ReturnType<typeof surfaces>>, target: number): void {
  expect(frames).toHaveLength(17);
  for (const frame of frames) {
    expect(frame.target, frame.id).toBe(target);
    expect(frame.streamEnd, frame.id).toBeCloseTo(frame.liquid.y, 4);
    expect(frame.foamY, frame.id).toBeCloseTo(frame.liquid.y, 4);
    expect(frame.liquid.y + frame.liquid.height, frame.id).toBeCloseTo(frame.bottom, 4);
    for (const companion of frame.companions) {
      expect(companion.y, frame.id).toBeCloseTo(frame.liquid.y, 4);
      expect(companion.height, frame.id).toBeCloseTo(frame.liquid.height, 4);
    }
  }
}

test("all 17 server and live vessels share artwork, local paint, and bowl-only clipping", async ({
  page,
}) => {
  await openArtwork(page);
  const artwork = await page.evaluate(() => {
    const canonical = (svg: SVGSVGElement) => {
      const ids = new Map(
        [...svg.querySelectorAll("[id]")].map((node, index) => [node.id, `local-${index}`]),
      );
      const numeric = new Set([
        "x",
        "y",
        "width",
        "height",
        "cx",
        "cy",
        "r",
        "opacity",
        "offset",
        "stroke-width",
        "stroke-opacity",
        "fill-opacity",
        "stop-opacity",
        "data-fill-percent",
      ]);
      return [svg, ...svg.querySelectorAll("*")].map((node) => ({
        tag: node.tagName,
        attributes: [...node.attributes]
          .filter(
            (attribute) =>
              !attribute.name.startsWith("data-") ||
              ["data-glass-contour", "data-field", "data-fill-percent"].includes(attribute.name),
          )
          .map((attribute) => [
            attribute.name,
            attribute.name === "id"
              ? ids.get(attribute.value)
              : numeric.has(attribute.name)
                ? String(Number(attribute.value))
                : attribute.value.replace(
                    /url\(#([\w-]+)\)/gu,
                    (_match: string, id: string) => `url(#${ids.get(id)})`,
                  ),
          ])
          .sort(([left], [right]) => left!.localeCompare(right!)),
        text: node.tagName === "title" ? node.textContent : null,
      }));
    };
    const all = [...document.querySelectorAll<SVGSVGElement>(".tap-graphic")];
    const server = [...document.querySelectorAll<SVGSVGElement>("#server .tap-graphic")];
    const ids = all.flatMap((svg) => [...svg.querySelectorAll("[id]")].map((node) => node.id));
    return {
      uniqueIds: new Set(ids).size === ids.length,
      localReferences: all.every((svg) =>
        [...svg.querySelectorAll("*")].every((node) =>
          [...node.attributes].every((attribute) => {
            if (!attribute.value.includes("url(")) return true;
            const id = attribute.value.match(/^url\(#([\w-]+)\)$/u)?.[1];
            return (
              id !== undefined &&
              svg.querySelector<SVGElement>(`#${CSS.escape(id)}`)?.ownerSVGElement === svg
            );
          }),
        ),
      ),
      pairs: window.vesselHarness.graphics.map((svg, index) => ({
        id: svg.dataset.graphicId,
        server: canonical(server[index]!),
        live: canonical(svg),
      })),
      geometry: server.slice(0, 17).map((svg) => {
        const clip = svg.querySelector<SVGPathElement>("clipPath.beer-liquid-clip path")!;
        const bowl = clip.getBBox();
        const view = svg.viewBox.baseVal;
        const bottom = Number(svg.dataset.fillBottomY);
        const center = bowl.x + bowl.width / 2;
        const bubbles = svg.querySelector(".beer-bubbles")!;
        return {
          id: svg.dataset.graphicId as VesselId,
          version: svg.dataset.artworkVersion,
          viewBox: svg.getAttribute("viewBox"),
          bowlBottom: bowl.y + bowl.height,
          bottom,
          bottomInsideBowl: clip.isPointInFill(new DOMPoint(center, bottom - 2)),
          belowBowlIsDry: !clip.isPointInFill(new DOMPoint(center, bottom + 3)),
          stemRemainsBelowBowl:
            !svg.querySelector(".glass-stem") || bottom < view.y + view.height - 12,
          bubbleCount: bubbles.querySelectorAll(".beer-bubble").length,
          bubblesInsideBowlClip:
            bubbles.parentElement?.getAttribute("clip-path") === `url(#${clip.parentElement!.id})`,
          bubblesHaveSurfaceClip:
            bubbles.getAttribute("clip-path") ===
            `url(#${svg.querySelector("clipPath.beer-bubble-clip")!.id})`,
          pathsInsideViewBox: [
            ...svg.querySelectorAll<SVGGraphicsElement>(
              ".glass, .glass-detail, .glass-stem, .glass-base, .glass-highlight, .rim",
            ),
          ].every((path) => {
            const bounds = path.getBBox();
            return (
              bounds.x >= view.x - 0.01 &&
              bounds.y >= view.y - 0.01 &&
              bounds.x + bounds.width <= view.x + view.width + 0.01 &&
              bounds.y + bounds.height <= view.y + view.height + 0.01
            );
          }),
        };
      }),
    };
  });
  expect(artwork.uniqueIds).toBe(true);
  expect(artwork.localReferences).toBe(true);
  expect(artwork.pairs).toHaveLength(17);
  for (const pair of artwork.pairs) expect(pair.live, pair.id).toEqual(pair.server);
  for (const geometry of artwork.geometry) {
    expect(geometry.version, geometry.id).toBe("astra-1");
    expect(geometry.viewBox, geometry.id).toBe(originalViewBoxes[geometry.id]);
    expect(geometry.bowlBottom, geometry.id).toBeLessThanOrEqual(geometry.bottom + 0.01);
    expect(geometry.bottomInsideBowl, geometry.id).toBe(true);
    expect(geometry.belowBowlIsDry, geometry.id).toBe(true);
    expect(geometry.stemRemainsBelowBowl, geometry.id).toBe(true);
    expect(geometry.pathsInsideViewBox, geometry.id).toBe(true);
    expect(geometry.bubbleCount, geometry.id).toBe(24);
    expect(geometry.bubblesInsideBowlClip, geometry.id).toBe(true);
    expect(geometry.bubblesHaveSurfaceClip, geometry.id).toBe(true);
  }
  for (const width of [390, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test("moving liquid, foam, clipping, and stream stay synchronized through fill and preview updates", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-08-15T12:00:00Z") });
  await openArtwork(page, 0);
  await page.clock.pauseAt(new Date("2026-08-15T12:00:10Z"));
  const empty = await surfaces(page);
  expectSynchronized(empty, 0);
  expect(
    empty.every((frame) => frame.liquid.height === 0 && frame.foamHidden && frame.bubblesHidden),
  ).toBe(true);
  await page.evaluate(() => {
    const { graphics, renderer, taps } = window.vesselHarness;
    graphics.forEach((svg, index) =>
      renderer.applyGraphic(svg, { ...taps[index]!, fillPercent: 80 }),
    );
  });
  let previous = empty;
  for (const elapsed of [1_000, 2_000, 2_000]) {
    await page.clock.fastForward(elapsed);
    const current = await surfaces(page);
    expectSynchronized(current, 80);
    current.forEach((frame, index) => {
      expect(frame.liquid.y, frame.id).toBeLessThan(previous[index]!.liquid.y);
      expect(frame.liquid.y, frame.id).toBeGreaterThan(
        frame.bottom - (frame.bottom - frame.top) * 0.8,
      );
    });
    previous = current;
  }
  await page.clock.fastForward(3_024);
  const filled = await surfaces(page);
  expectSynchronized(filled, 80);
  for (const frame of filled)
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.8,
      4,
    );
  await page.evaluate(() =>
    window.vesselHarness.graphics.forEach(window.vesselHarness.fill.previewVesselPour),
  );
  const previewStart = await surfaces(page);
  expectSynchronized(previewStart, 80);
  expect(
    previewStart.every((frame) => frame.liquid.height === 0 && frame.streamEnd === frame.bottom),
  ).toBe(true);
  await page.clock.fastForward(1_000);
  const previewMiddle = await surfaces(page);
  expectSynchronized(previewMiddle, 80);
  expect(
    previewMiddle.every(
      (frame) => frame.liquid.height > 0 && !frame.foamHidden && !frame.bubblesHidden,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const { graphics, renderer, taps } = window.vesselHarness;
    graphics.forEach((svg, index) =>
      renderer.applyGraphic(svg, { ...taps[index]!, fillPercent: 35 }),
    );
  });
  const retargeted = await surfaces(page);
  expectSynchronized(retargeted, 35);
  retargeted.forEach((frame, index) =>
    expect(frame.liquid.y, frame.id).toBeCloseTo(previewMiddle[index]!.liquid.y, 4),
  );
  await page.clock.fastForward(2_500);
  const beforeTimeout = await surfaces(page);
  await page.evaluate(() =>
    window.vesselHarness.graphics.forEach(window.vesselHarness.fill.stopVesselPour),
  );
  const afterTimeout = await surfaces(page);
  afterTimeout.forEach((frame, index) =>
    expect(frame.liquid.y, frame.id).toBeCloseTo(beforeTimeout[index]!.liquid.y, 4),
  );
  await page.clock.fastForward(5_524);
  for (const frame of await surfaces(page))
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.35,
      4,
    );
  await page.evaluate(() =>
    window.vesselHarness.graphics.forEach(window.vesselHarness.fill.previewVesselPour),
  );
  await page.clock.fastForward(3_024);
  const restored = await surfaces(page);
  expectSynchronized(restored, 35);
  for (const frame of restored)
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.35,
      4,
    );
  expect(
    await page.evaluate(() =>
      window.vesselHarness.graphics.every(
        (svg) =>
          svg.isConnected &&
          svg === document.querySelector(`#live [data-graphic-id="${svg.dataset.graphicId}"]`),
      ),
    ),
  ).toBe(true);
});

test("the first live update smoothly hydrates every server-rendered vessel", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-15T12:00:00Z") });
  await openArtwork(page, 80);
  await page.clock.pauseAt(new Date("2026-08-15T12:00:10Z"));
  await page.evaluate(() => {
    const { renderer, taps } = window.vesselHarness;
    const graphics = [...document.querySelectorAll<SVGSVGElement>("#server .tap-graphic")].slice(
      0,
      17,
    );
    window.vesselHarness = { ...window.vesselHarness, graphics };
    graphics.forEach((svg, index) =>
      renderer.applyGraphic(svg, { ...taps[index]!, fillPercent: 20 }),
    );
  });
  const start = await surfaces(page);
  expectSynchronized(start, 20);
  for (const frame of start)
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.8,
      4,
    );
  await page.clock.fastForward(4_000);
  const middle = await surfaces(page);
  expectSynchronized(middle, 20);
  for (const [index, frame] of middle.entries()) {
    expect(frame.liquid.y, frame.id).toBeGreaterThan(start[index]!.liquid.y);
    expect(frame.liquid.y, frame.id).toBeLessThan(frame.bottom - (frame.bottom - frame.top) * 0.2);
  }
  await page.clock.fastForward(4_024);
  for (const frame of await surfaces(page))
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.2,
      4,
    );
});

test("reduced motion keeps static bubbles visible and settles the authoritative fill", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openArtwork(page, 70);
  const bubbles = page.locator("#live .beer-bubbles");
  await expect(bubbles.first()).not.toHaveCSS("display", "none");
  expect(
    await page
      .locator("#live .beer-bubble")
      .evaluateAll((nodes) =>
        nodes.every(
          (node) =>
            getComputedStyle(node).animationName === "none" &&
            Number(getComputedStyle(node).opacity) > 0,
        ),
      ),
  ).toBe(true);
  await page.evaluate(() => {
    const { graphics, renderer, taps, fill } = window.vesselHarness;
    graphics.forEach((svg, index) => {
      renderer.applyGraphic(svg, { ...taps[index]!, fillPercent: 25 });
      fill.previewVesselPour(svg);
    });
  });
  const reduced = await surfaces(page);
  expectSynchronized(reduced, 25);
  for (const frame of reduced) {
    expect(frame.liquid.y, frame.id).toBeCloseTo(
      frame.bottom - (frame.bottom - frame.top) * 0.25,
      4,
    );
    expect(frame.bubblesHidden, frame.id).toBe(false);
  }
  await page.evaluate(() => {
    const { graphics, renderer, taps } = window.vesselHarness;
    graphics.forEach((svg, index) =>
      renderer.applyGraphic(svg, { ...taps[index]!, fillPercent: 0 }),
    );
  });
  const empty = await surfaces(page);
  expectSynchronized(empty, 0);
  expect(
    empty.every((frame) => frame.liquid.height === 0 && frame.foamHidden && frame.bubblesHidden),
  ).toBe(true);
});
