const FILL_DURATION_MS = 8000;
const PREVIEW_DURATION_MS = 3000;
const states = new WeakMap();

function finiteNumber(value, fallback = 0) {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function clampPercentage(value) {
  return Math.max(0, Math.min(100, finiteNumber(value)));
}

function safeColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : "#D97706";
}

function geometryFor(graphic) {
  const topY = finiteNumber(graphic.topY);
  return { topY, bottomY: Math.max(topY, finiteNumber(graphic.bottomY, topY)) };
}

function renderedPercentage(svg, geometry) {
  if (
    finiteNumber(svg.dataset.fillTopY, geometry.topY) !== geometry.topY ||
    finiteNumber(svg.dataset.fillBottomY, geometry.bottomY) !== geometry.bottomY
  )
    return null;
  const value =
    svg.dataset.renderedFillPercent ?? svg.querySelector(".beer-liquid-rect")?.dataset.fillPercent;
  if (value === undefined || value.trim() === "") return null;
  const percentage = Number(value);
  return Number.isFinite(percentage) ? clampPercentage(percentage) : null;
}

function createState(svg, graphic, percentage, color) {
  const state = {
    geometry: geometryFor(graphic),
    liquid: svg.querySelector(".beer-liquid-rect"),
    shadow: svg.querySelector(".beer-liquid-shadow"),
    depth: svg.querySelector(".beer-liquid-depth"),
    bubbleBounds: svg.querySelector(".beer-bubble-clip-rect"),
    bubbles: svg.querySelector(".beer-bubbles"),
    foam: svg.querySelector(".beer-cloud-foam"),
    stream: svg.querySelector(".beer-pour-stream"),
    target: percentage,
    rendered: percentage,
    color: safeColor(color),
    animation: null,
  };
  states.set(svg, state);
  return state;
}

function paint(svg, state, percentage) {
  const rendered = clampPercentage(percentage);
  const { topY, bottomY } = state.geometry;
  const y = bottomY - ((bottomY - topY) * rendered) / 100;
  const height = bottomY - y;
  for (const element of [state.liquid, state.shadow, state.depth, state.bubbleBounds]) {
    if (!element) continue;
    element.setAttribute("y", String(y));
    element.setAttribute("height", String(height));
  }
  state.liquid?.setAttribute("fill", state.color);
  if (state.stream) {
    const streamY = topY - 32;
    state.stream.setAttribute("y", String(streamY));
    state.stream.setAttribute("height", String(Math.max(0, y - streamY)));
    state.stream.setAttribute("fill", state.color);
  }
  if (state.foam) {
    state.foam.setAttribute("transform", `translate(0 ${y})`);
    state.foam.setAttribute("data-base-y", String(y));
    state.foam.toggleAttribute("hidden", rendered === 0);
  }
  state.bubbles?.toggleAttribute("hidden", rendered === 0);
  state.rendered = rendered;
  svg.dataset.renderedFillPercent = String(rendered);
}

function clearAnimation(state) {
  const animation = state.animation;
  if (!animation) return;
  state.animation = null;
  if (animation.frame !== null) window.cancelAnimationFrame(animation.frame);
  animation.media?.removeEventListener?.("change", animation.onMotionChange);
}

function authoritativePercentage(state) {
  return clampPercentage(state.liquid?.dataset.fillPercent ?? state.target);
}

function restoreTarget(svg, state) {
  clearAnimation(state);
  state.target = authoritativePercentage(state);
  paint(svg, state, state.target);
}

function bezierCoordinate(t, first, second) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t;
}

// Match the reviewed CSS cubic-bezier(.25, .1, .25, 1), including its time axis.
function fillEase(progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 32; iteration++) {
    const t = (lower + upper) / 2;
    if (bezierCoordinate(t, 0.25, 0.25) < progress) lower = t;
    else upper = t;
  }
  return bezierCoordinate((lower + upper) / 2, 0.1, 1);
}

function animateTo(svg, state, from, duration, preview) {
  clearAnimation(state);
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (media?.matches || svg.isConnected === false || from === state.target) {
    paint(svg, state, state.target);
    return;
  }
  const animation = {
    frame: null,
    startedAt: window.performance.now(),
    target: state.target,
    preview,
    media,
    onMotionChange: () => {
      if (state.animation === animation && media.matches) restoreTarget(svg, state);
    },
  };
  state.animation = animation;
  media?.addEventListener?.("change", animation.onMotionChange);
  paint(svg, state, from);
  const frame = (timestamp) => {
    if (state.animation !== animation) return;
    animation.frame = null;
    if (svg.isConnected === false) {
      clearAnimation(state);
      return;
    }
    if (media?.matches) {
      restoreTarget(svg, state);
      return;
    }
    const elapsed = Math.max(0, finiteNumber(timestamp, animation.startedAt) - animation.startedAt);
    const progress = Math.min(1, elapsed / duration);
    paint(
      svg,
      state,
      progress === 1 ? animation.target : from + (animation.target - from) * fillEase(progress),
    );
    if (progress === 1) clearAnimation(state);
    else animation.frame = window.requestAnimationFrame(frame);
  };
  animation.frame = window.requestAnimationFrame(frame);
}

export function updateVesselFill(svg, graphic, percentage, color, animate = true) {
  const target = clampPercentage(percentage);
  const geometry = geometryFor(graphic);
  let state = states.get(svg);
  // Preserve the visible server-rendered level on the first live update.
  const initialPercentage = !state && animate ? renderedPercentage(svg, geometry) : null;
  const firstPaint = !state && initialPercentage === null;
  const geometryChanged =
    state && (state.geometry.topY !== geometry.topY || state.geometry.bottomY !== geometry.bottomY);
  if (geometryChanged) clearAnimation(state);
  if (!state || geometryChanged)
    state = createState(
      svg,
      graphic,
      geometryChanged ? target : (initialPercentage ?? target),
      color,
    );
  const previousTarget = state.target;
  state.target = target;
  state.color = safeColor(color);
  if (state.liquid) {
    // This is the live target. Animation and preview frames never overwrite it.
    state.liquid.dataset.fillPercent = String(target);
    state.liquid.dataset.field = "fill-graphic";
    state.liquid.setAttribute("fill", state.color);
  }
  state.stream?.setAttribute("fill", state.color);
  svg.dataset.fillTopY = String(geometry.topY);
  svg.dataset.fillBottomY = String(geometry.bottomY);
  if (firstPaint || geometryChanged || !animate) {
    clearAnimation(state);
    paint(svg, state, target);
  } else if (
    state.animation?.preview ||
    previousTarget !== target ||
    (!state.animation && state.rendered !== target)
  ) {
    animateTo(svg, state, state.rendered, FILL_DURATION_MS, false);
  }
}

export function previewVesselPour(svg) {
  let state = states.get(svg);
  if (!state) {
    const liquid = svg.querySelector(".beer-liquid-rect");
    if (!liquid) return;
    // Server-rendered cards can be previewed before the first live refresh.
    state = createState(
      svg,
      { topY: svg.dataset.fillTopY, bottomY: svg.dataset.fillBottomY },
      clampPercentage(liquid.dataset.fillPercent),
      liquid.getAttribute("fill"),
    );
  }
  state.target = authoritativePercentage(state);
  animateTo(svg, state, 0, PREVIEW_DURATION_MS, true);
}

export function stopVesselPour(svg) {
  const state = states.get(svg);
  // A late preview timeout must not interrupt a newer live update.
  if (state && (!state.animation || state.animation.preview)) restoreTarget(svg, state);
}

export function cancelVesselAnimation(svg) {
  const state = states.get(svg);
  if (state) clearAnimation(state);
  states.delete(svg);
}
