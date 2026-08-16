const EVENT_NAMES = [
  "tap.updated",
  "fill.updated",
  "telemetry.updated",
  "health.updated",
  "ondeck.updated",
  "integration_status.updated",
  "display.updated",
];

export function connect(path, onEvent, onReconnect) {
  let source;
  let reconnectTimer;
  let closed = false;

  function open() {
    if (closed) return;
    source = new EventSource(path);
    for (const name of EVENT_NAMES) source.addEventListener(name, (event) => onEvent(name, event));
    source.addEventListener("error", () => {
      source?.close();
      if (reconnectTimer !== undefined) return;
      reconnectTimer = window.setTimeout(async () => {
        reconnectTimer = undefined;
        try {
          await onReconnect();
        } catch {
          /* The rendered page remains useful. */
        }
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
