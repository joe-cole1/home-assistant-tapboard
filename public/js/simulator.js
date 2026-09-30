const page = document.querySelector("[data-simulator]");

if (page?.dataset.simulationEnabled === "true") {
  const feedback = page.querySelector("[data-simulation-feedback]");
  const connection = page.querySelector("[data-simulation-connection]");
  const cards = new Map(
    [...page.querySelectorAll("[data-simulation-sensor]")].map((card) => [
      card.dataset.simulationSensor,
      card,
    ]),
  );
  let polling = false;
  let authorizationFailed = false;
  let lastState;
  let actionVersion = 0;
  let pendingActions = 0;
  const statusLabels = {
    stopped: "Stopped",
    offline: "Paused",
    unassigned: "No fill",
    unavailable: "Retired",
    settling: "Settling",
    ready: "Ready",
    pouring: "Pouring",
    empty: "Empty",
    error: "Needs attention",
  };

  const report = (message, error = false) => {
    if (!feedback) return;
    feedback.hidden = false;
    feedback.textContent = message;
    feedback.className = error ? "simulator-feedback error" : "simulator-feedback notice";
    feedback.setAttribute("role", error ? "alert" : "status");
  };

  const applyState = (state) => {
    if (!Array.isArray(state.sensors)) return;
    if (state.revision !== Number(document.body.dataset.workspaceRevision)) return;
    lastState = state;
    for (const sensor of state.sensors) {
      const card = cards.get(sensor.tapId);
      if (!card) continue;
      card.dataset.sensorOnline = String(sensor.online);
      card.dataset.sensorPouring = String(sensor.pouring);
      card.dataset.sensorState = sensor.status;
      const text = (selector, value) => {
        const target = card.querySelector(selector);
        if (target) target.textContent = value;
      };
      text("[data-sensor-label]", sensor.label);
      text("[data-sensor-volume]", `${(sensor.remainingMl / 1000).toFixed(2)} L`);
      text("[data-sensor-temperature]", `${sensor.temperatureC.toFixed(1)} °C`);
      text("[data-sensor-status-label]", statusLabels[sensor.status] || "Unavailable");
      const error = card.querySelector("[data-sensor-error]");
      if (error) {
        error.textContent = sensor.error || "";
        error.hidden = !sensor.error;
      }
      if (card.dataset.submitting === "true") continue;
      const blocked = authorizationFailed || state.changing || !state.enabled;
      card.querySelectorAll("[data-pour-button]").forEach((button) => {
        button.disabled =
          blocked ||
          sensor.status !== "ready" ||
          !sensor.online ||
          sensor.pouring ||
          sensor.remainingMl < 29.5735295625;
      });
      const online = card.querySelector('[data-online-form] [name="online"]');
      if (online) online.value = String(!sensor.online);
      const noise = card.querySelector('[data-noise-form] [name="enabled"]');
      if (noise) noise.value = String(!sensor.noiseEnabled);
      const onlineButton = card.querySelector("[data-online-button]");
      if (onlineButton) {
        onlineButton.textContent = sensor.online ? "Pause sensor" : "Bring online";
        onlineButton.disabled = blocked;
      }
      const noiseButton = card.querySelector("[data-noise-button]");
      if (noiseButton) {
        noiseButton.textContent = sensor.noiseEnabled ? "Noise on" : "Noise off";
        noiseButton.setAttribute("aria-checked", String(sensor.noiseEnabled));
        noiseButton.disabled = blocked;
      }
    }
    page.querySelectorAll("[data-workspace-action] button").forEach((button) => {
      button.disabled = state.changing || authorizationFailed;
    });
  };

  const poll = async () => {
    if (polling || document.hidden || authorizationFailed || pendingActions > 0) return;
    const version = actionVersion;
    polling = true;
    try {
      const response = await fetch("/api/admin/simulation", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const state = await response.json();
      if (version !== actionVersion) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          authorizationFailed = true;
          report(state.error?.message || "Sign in again to continue using the Simulator.", true);
          if (lastState) applyState(lastState);
        } else if (connection) {
          connection.textContent = "Readings temporarily unavailable. Retrying…";
        }
        return;
      }
      applyState(state);
      if (connection) {
        connection.textContent = state.changing ? "Switching workspace…" : "Live sensor readings";
      }
    } catch {
      if (connection) connection.textContent = "Readings disconnected. Retrying…";
    } finally {
      polling = false;
    }
  };

  page.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-simulation-action")) return;
    const card = form.closest("[data-simulation-sensor]");
    if (!card) return;
    event.preventDefault();
    if (card.dataset.submitting === "true" || authorizationFailed) return;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === "string") body.append(name, value);
    }
    if (event.submitter?.name) body.set(event.submitter.name, event.submitter.value);
    const buttons = [...card.querySelectorAll("button")];
    const previousDisabled = buttons.map((button) => button.disabled);
    card.dataset.submitting = "true";
    card.setAttribute("aria-busy", "true");
    buttons.forEach((button) => (button.disabled = true));
    actionVersion += 1;
    pendingActions += 1;
    document.body.dataset.workspacePendingActions = String(pendingActions);
    let resultState;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) authorizationFailed = true;
        report(result.message || "The change could not be completed. Reload and try again.", true);
      } else {
        resultState = result.state;
        report(result.message || "Saved.");
      }
    } catch {
      // Never retry a pour automatically: the first request may have succeeded.
      report("The result could not be confirmed. Check the sensor before trying again.", true);
    } finally {
      card.dataset.submitting = "false";
      card.removeAttribute("aria-busy");
      buttons.forEach((button, index) => {
        button.disabled = authorizationFailed || previousDisabled[index];
      });
      pendingActions -= 1;
      document.body.dataset.workspacePendingActions = String(pendingActions);
      if (resultState) applyState(resultState);
      else if (authorizationFailed && lastState) applyState(lastState);
      document.dispatchEvent(new Event("simulation:action-complete"));
      void poll();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
  window.setInterval(() => void poll(), 1_000);
  void poll();
}
