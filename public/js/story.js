import { connect } from "/assets/js/sse.js";
import "/assets/js/display-preferences.js";

const root = document.querySelector("[data-story]");
const tapId = root?.dataset.tapId;

if (root && tapId) {
  const reload = () => window.location.reload();
  connect(
    root.dataset.ssePath || "/api/public/events",
    (name, event) => {
      if (name === "display.updated") {
        reload();
        return;
      }
      if (name === "fill.updated" && !root.dataset.ssePath?.includes("/api/admin/")) return;
      if (name !== "tap.updated" && name !== "fill.updated") return;
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === "object" && data.tapId === tapId) reload();
      } catch {
        // Ephemeral malformed frames are ignored; the next reconnect is authoritative.
      }
    },
    reload,
  );
}
