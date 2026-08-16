export function createDirtyQueue(run, maximumConcurrency = 4) {
  const queued = new Set();
  const running = new Set();
  const rerun = new Set();

  function pump() {
    while (running.size < maximumConcurrency && queued.size > 0) {
      const target = queued.values().next().value;
      queued.delete(target);
      running.add(target);
      void Promise.resolve(run(target)).finally(() => {
        running.delete(target);
        if (rerun.delete(target)) queued.add(target);
        pump();
      });
    }
  }

  return (target) => {
    if (running.has(target)) rerun.add(target);
    else queued.add(target);
    pump();
  };
}
