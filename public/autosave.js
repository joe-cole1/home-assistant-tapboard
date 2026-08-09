/**
 * Small, DOM-free write coordinator for settings screens.  Each key keeps only
 * its newest pending value while writes themselves are serialized, preventing
 * a slow earlier response from overtaking a newer edit.
 */
export function createAutosaveController({ onStatus = () => {} } = {}) {
  const pending = new Map();
  let active = false;
  let idleResolvers = [];

  function notify(key, state, error = null) {
    onStatus(key, { state, error });
  }

  async function drain() {
    if (active) return;
    active = true;
    while (pending.size) {
      const [key, job] = pending.entries().next().value;
      pending.delete(key);
      notify(key, 'saving');
      try {
        await job.save();
        notify(key, 'saved');
      } catch (error) {
        notify(key, 'error', error);
      }
    }
    active = false;
    idleResolvers.forEach((resolve) => resolve());
    idleResolvers = [];
  }

  return {
    save(key, save) {
      pending.set(key, { save });
      notify(key, 'queued');
      void drain();
    },
    async flush() {
      await drain();
      if (!active && pending.size === 0) return;
      await new Promise((resolve) => idleResolvers.push(resolve));
    },
    isDirty(key) {
      return pending.has(key);
    }
  };
}
