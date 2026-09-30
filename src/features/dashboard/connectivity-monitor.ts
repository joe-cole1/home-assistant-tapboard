import type { PublicHeaderView } from "./types.ts";

/** Publish clock-driven changes, including outage escalation without new events. */
export function startConnectivityMonitor(options: {
  readonly readState: () => PublicHeaderView["connectivity"];
  readonly onChange: () => void;
  readonly onError: () => void;
}): () => void {
  let previous = options.readState();
  const timer = setInterval(() => {
    try {
      const current = options.readState();
      if (current !== previous) {
        options.onChange();
        previous = current;
      }
    } catch {
      options.onError();
    }
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
