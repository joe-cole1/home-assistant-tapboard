import { connect } from "/assets/js/sse.js";

const root = document.querySelector("[data-admin-tap-wars]");

if (root) {
  const status = root.querySelector("[data-tap-wars-live-status]");
  const startForm = root.querySelector("[data-tap-wars-start]");

  if (startForm instanceof HTMLFormElement) {
    const selectors = [...startForm.querySelectorAll("[data-tap-wars-selector]")];
    const preview = startForm.querySelector("[data-tap-wars-preview]");
    const submit = startForm.querySelector("[data-tap-wars-start-submit]");

    const selectedOption = (select) => select.selectedOptions.item(0);
    const setPreview = () => {
      const [first, second] = selectors;
      const firstOption = first && selectedOption(first);
      const secondOption = second && selectedOption(second);
      const duplicate = Boolean(first?.value && first.value === second?.value);
      for (const select of selectors) {
        select.setCustomValidity(duplicate ? "Choose two different Tap assignments." : "");
      }
      if (submit && "disabled" in submit)
        submit.disabled = duplicate || !first?.value || !second?.value;
      if (!(preview instanceof HTMLElement)) return;
      if (!first?.value || !second?.value) {
        preview.textContent =
          "Select two Tap assignments to preview the exact public-safe matchup.";
        return;
      }
      if (duplicate) {
        preview.textContent = "Choose two different Tap assignments.";
        return;
      }
      const description = [firstOption, secondOption]
        .map((option, index) => {
          const tapNumber = option?.dataset.tapNumber ?? "?";
          const title = option?.dataset.title ?? "Mystery Tap";
          return `Side ${index + 1}: Tap ${tapNumber} · ${title}`;
        })
        .join(" versus ");
      preview.textContent = description;
    };

    selectors.forEach((select) => select.addEventListener("change", setPreview));
    setPreview();
  }

  const currentSignature = () =>
    `${root.dataset.currentId ?? ""}:${root.dataset.currentStatus ?? ""}:${root.dataset.publishedId ?? ""}`;
  const text = (selector, value) => {
    const node = root.querySelector(selector);
    if (node && value !== undefined) node.textContent = String(value);
  };
  const displayPercentage = (value) => (typeof value === "number" ? `${value}%` : "—");
  const patchCurrent = (current, publicVisible) => {
    const competitors = Array.isArray(current?.competitors) ? current.competitors : [];
    if (competitors.length !== 2) return false;
    const total = Number.isFinite(current.totalVotes)
      ? current.totalVotes
      : competitors.reduce((sum, side) => sum + (Number(side.voteCount) || 0), 0);
    for (const side of competitors) {
      const sideNumber = Number(side.side);
      text(`[data-war-count="${sideNumber}"]`, side.voteCount);
      text(`[data-war-percentage="${sideNumber}"]`, displayPercentage(side.percentage));
      const meter = root.querySelector(`[data-war-meter="${sideNumber}"]`);
      if (meter instanceof HTMLElement)
        meter.style.width = `${Math.max(0, Math.min(100, Number(side.percentage) || 0))}%`;
      const publicSide =
        publicVisible?.id === current.id ? publicVisible[`side${sideNumber}`] : null;
      if (typeof publicSide?.title === "string")
        text(`[data-war-public-title="${sideNumber}"]`, publicSide.title);
    }
    text("[data-war-total]", total);
    text(
      "[data-war-leader]",
      current.isTie
        ? "Tied"
        : current.leaderSide
          ? `Side ${current.leaderSide} leads`
          : "No leader yet",
    );
    return true;
  };
  const refresh = async (announced = false) => {
    try {
      const response = await fetch("/api/admin/tap-wars", {
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!response.ok) {
        window.location.reload();
        return;
      }
      const next = await response.json();
      const nextSignature = `${next.current?.id ?? ""}:${next.current?.status ?? ""}:${next.published?.id ?? ""}`;
      if (nextSignature !== currentSignature() || !patchCurrent(next.current, next.publicVisible)) {
        window.location.reload();
        return;
      }
      if (announced && status instanceof HTMLElement)
        status.textContent = "Tap War vote totals updated.";
    } catch {
      // A reconnect or later dirty event will safely retry; the rendered page remains useful.
    }
  };

  connect(
    "/api/admin/events",
    (name) => {
      if (name === "tap_wars.updated") void refresh(true);
    },
    () => refresh(false),
  );
}
