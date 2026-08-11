export const TICKER_INTERACTION_PAUSE_MS = 5_000;

export function createTickerAutoScroller({
  element,
  speedPxPerSecond = 36,
  reducedMotionSpeedPxPerSecond = 12,
  pauseMs = TICKER_INTERACTION_PAUSE_MS,
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame,
  now = () => globalThis.performance.now(),
  motionQuery = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'),
  reducedMotion = () => motionQuery?.matches === true,
  visibilityTarget = globalThis.document,
  isHidden = () => visibilityTarget?.hidden === true
}) {
  let frameId = null;
  let lastFrameAt = null;
  let pausedUntil = 0;
  let direction = 1;
  let destroyed = false;

  const maxScroll = () => Math.max(0, element.scrollWidth - element.clientWidth);

  const schedule = () => {
    if (!destroyed && frameId === null) frameId = requestFrame(tick);
  };

  const tick = (timestamp) => {
    frameId = null;
    if (destroyed) return;
    const frameAt = Number.isFinite(timestamp) ? timestamp : now();
    const elapsed = lastFrameAt === null ? 0 : Math.min(64, Math.max(0, frameAt - lastFrameAt));
    lastFrameAt = frameAt;
    const limit = maxScroll();

    if (isHidden() || limit <= 0) {
      lastFrameAt = null;
      return;
    }

    if (frameAt >= pausedUntil && elapsed > 0) {
      const activeSpeed = reducedMotion()
        ? Math.min(speedPxPerSecond, reducedMotionSpeedPxPerSecond)
        : speedPxPerSecond;
      let next = element.scrollLeft + direction * activeSpeed * (elapsed / 1_000);
      if (next >= limit) {
        next = limit;
        direction = -1;
      } else if (next <= 0) {
        next = 0;
        direction = 1;
      }
      element.scrollLeft = next;
    }
    schedule();
  };

  const pauseForInteraction = () => {
    pausedUntil = Math.max(pausedUntil, now() + pauseMs);
    lastFrameAt = null;
  };

  const resumeWhenActionable = () => {
    lastFrameAt = null;
    if (!isHidden() && maxScroll() > 0) schedule();
  };

  const interactionEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown', 'focusin'];
  interactionEvents.forEach((eventName) => element.addEventListener(eventName, pauseForInteraction, { passive: true }));
  visibilityTarget?.addEventListener?.('visibilitychange', resumeWhenActionable);
  motionQuery?.addEventListener?.('change', resumeWhenActionable);

  schedule();

  return {
    pause: pauseForInteraction,
    refresh({ reset = true } = {}) {
      if (reset) {
        element.scrollLeft = 0;
        direction = 1;
      } else if (element.scrollLeft >= maxScroll()) {
        direction = -1;
      }
      lastFrameAt = null;
      schedule();
    },
    destroy() {
      destroyed = true;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      interactionEvents.forEach((eventName) => element.removeEventListener(eventName, pauseForInteraction));
      visibilityTarget?.removeEventListener?.('visibilitychange', resumeWhenActionable);
      motionQuery?.removeEventListener?.('change', resumeWhenActionable);
    }
  };
}
