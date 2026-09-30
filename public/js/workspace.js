const revision = Number(document.body.dataset.workspaceRevision);

if (document.body.hasAttribute("data-workspace-revision") && Number.isSafeInteger(revision)) {
  let checking = false;
  let navigating = false;
  let refreshNeeded = false;

  const refresh = () => {
    if (
      refreshNeeded &&
      !navigating &&
      Number(document.body.dataset.workspacePendingActions || "0") === 0
    ) {
      navigating = true;
      window.location.reload();
    }
  };

  const check = async () => {
    if (checking || navigating || document.hidden) return;
    checking = true;
    try {
      const response = await fetch("/api/public/workspace", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return;
      const state = await response.json();
      if (Number.isSafeInteger(state.revision) && state.revision !== revision) {
        refreshNeeded = true;
        refresh();
      }
    } catch {
      // Keep the current display available; retry when connectivity returns.
    } finally {
      checking = false;
    }
  };

  document.addEventListener("submit", (event) => {
    // Enhanced forms prevent navigation; ordinary forms must finish their POST.
    void Promise.resolve().then(() => {
      if (!event.defaultPrevented) navigating = true;
    });
  });
  document.addEventListener("simulation:action-complete", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check();
  });
  window.addEventListener("pageshow", () => {
    navigating = false;
    void check();
  });
  window.setInterval(() => void check(), 3_000);
  void check();
}
