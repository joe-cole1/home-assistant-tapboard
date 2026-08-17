const EVENT_NAMES = [
  "tap.updated",
  "fill.updated",
  "telemetry.updated",
  "health.updated",
  "ondeck.updated",
  "integration_status.updated",
  "display.updated",
  "tap_wars.updated",
];

export function connect(path, onEvent, onReconnect) {
  let source;
  let reconnectTimer;
  let closed = false;
  let reconnecting = false;

  function open() {
    if (closed) return;
    const next = new EventSource(path);
    source = next;
    for (const name of EVENT_NAMES) next.addEventListener(name, (event) => onEvent(name, event));
    next.addEventListener("open", () => {
      if (next !== source || !reconnecting) return;
      reconnecting = false;
      void Promise.resolve(onReconnect()).catch(() => {
        /* The rendered page remains useful. */
      });
    });
    next.addEventListener("error", () => {
      if (next !== source) return;
      next.close();
      if (reconnectTimer !== undefined) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        reconnecting = true;
        open();
      }, 1500);
    });
  }

  open();
  return () => {
    closed = true;
    source?.close();
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  };
}
