// Browser-side state patching for the Batch 2 SSE schema.
// Keeping this DOM-free makes coalescing behavior deterministic to test.
export function createLiveUpdateController({ getState, setState, onDirty, requestFrame }) {
  let dirtyTapIds = new Set();
  let framePending = false;

  function flush() {
    framePending = false;
    const tapIds = dirtyTapIds;
    dirtyTapIds = new Set();
    onDirty(tapIds);
  }

  function schedule(tapIds) {
    tapIds.forEach((tapId) => dirtyTapIds.add(String(tapId)));
    if (!framePending) {
      framePending = true;
      requestFrame(flush);
    }
  }

  return {
    replaceSnapshot(snapshot) {
      setState({ ...snapshot, tapStates: snapshot.tapStates || {} });
    },

    applyStateChanged({ taps = [] }) {
      const state = getState();
      const tapStates = { ...(state.tapStates || {}) };
      const changedTapIds = [];

      taps.forEach(({ tapId, changes }) => {
        if (!tapId || !changes || typeof changes !== 'object') return;
        const id = String(tapId);
        tapStates[id] = { ...(tapStates[id] || {}), ...changes };
        changedTapIds.push(id);
      });

      if (changedTapIds.length) {
        setState({ ...state, tapStates });
        schedule(changedTapIds);
      }
    },

    flushNow: flush
  };
}

export function updateGraphicFill(card, fillPercent) {
  if (card.classList.contains('is-pouring')) return;
  const svgEl = card.querySelector('.tap-graphic-svg');
  if (!svgEl) return;

  const bottomY = parseFloat(svgEl.getAttribute('data-bottom-y')) || 220;
  const topRimY = parseFloat(svgEl.getAttribute('data-top-rim-y')) || 55;
  const fullHeight = bottomY - topRimY;
  const targetY = bottomY - (fillPercent / 100) * fullHeight;
  const targetHeight = bottomY - targetY;
  card.querySelectorAll('.beer-liquid-rect, .beer-liquid-shadow').forEach((rect) => {
    rect.setAttribute('y', targetY);
    rect.setAttribute('height', targetHeight);
  });
  const foamGroup = card.querySelector('.beer-cloud-foam');
  if (foamGroup) {
    const baseY = parseFloat(foamGroup.getAttribute('data-base-y')) || bottomY;
    foamGroup.style.transform = `translateY(${targetY - baseY}px)`;
  }
}
