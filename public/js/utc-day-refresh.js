const DAY_MS = 86_400_000;

// A badge can age out even when no telemetry or domain changes arrive.
export function watchUtcDayChanges(
  refresh,
  { now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {},
) {
  let lastDay = Math.floor(now() / DAY_MS);
  let timer;

  function check() {
    clearTimer(timer);
    const timestamp = now();
    const day = Math.floor(timestamp / DAY_MS);
    if (day !== lastDay) {
      lastDay = day;
      refresh();
    }
    timer = setTimer(check, DAY_MS - (timestamp % DAY_MS));
  }

  check();
  return { check, stop: () => clearTimer(timer) };
}
