const shell = document.querySelector(".admin-shell");

if (shell) {
  const menuToggle = shell.querySelector("[data-admin-menu-toggle]");
  const sidebar = shell.querySelector("[data-admin-sidebar]");
  const sidebarToggle = shell.querySelector("[data-admin-sidebar-toggle]");
  const sidebarClose = shell.querySelector("[data-admin-sidebar-close]");
  const drawerBackdrop = shell.querySelector("[data-admin-drawer-backdrop]");
  const jumpInput = shell.querySelector("[data-admin-jump-input]");
  const storageKey = "tapboard.v2.admin-sidebar.v1";
  const mobileNavigation = window.matchMedia("(max-width: 58rem)");
  const backgroundNodes = [...shell.children].filter(
    (node) => node !== sidebar && node !== drawerBackdrop,
  );

  shell.classList.add("admin-shell--js");
  shell.dataset.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "true"
    : "false";

  const setCollapsed = (collapsed) => {
    shell.dataset.sidebarCollapsed = collapsed ? "true" : "false";
    if (sidebarToggle) {
      sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      sidebarToggle.textContent = collapsed ? "Expand" : "Collapse";
      sidebarToggle.setAttribute(
        "aria-label",
        collapsed ? "Expand Admin navigation" : "Collapse Admin navigation",
      );
    }
    try {
      window.localStorage.setItem(storageKey, collapsed ? "collapsed" : "expanded");
    } catch {
      // A blocked or unavailable localStorage must not affect navigation.
    }
  };

  const synchronizeDrawerAccessibility = () => {
    const isMobile = mobileNavigation.matches;
    const isOpen = shell.dataset.drawerOpen === "true";
    if (sidebar) {
      sidebar.inert = isMobile && !isOpen;
      if (isMobile && !isOpen) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
    }
    for (const node of backgroundNodes) {
      node.inert = isMobile && isOpen;
      if (isMobile && isOpen) node.setAttribute("aria-hidden", "true");
      else node.removeAttribute("aria-hidden");
    }
  };

  const setDrawerOpen = (open, restoreFocus = true) => {
    shell.dataset.drawerOpen = open ? "true" : "false";
    if (menuToggle) menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (drawerBackdrop) drawerBackdrop.hidden = !open;
    synchronizeDrawerAccessibility();
    if (open) {
      sidebarClose?.focus();
    } else if (restoreFocus) {
      menuToggle?.focus();
    }
  };

  if (menuToggle) menuToggle.hidden = false;
  if (sidebarToggle) sidebarToggle.hidden = false;
  if (sidebarClose) sidebarClose.hidden = false;

  let savedPreference = "expanded";
  try {
    savedPreference = window.localStorage.getItem(storageKey) ?? "expanded";
  } catch {
    // Use the expanded desktop default.
  }
  setCollapsed(savedPreference === "collapsed");
  setDrawerOpen(false, false);

  mobileNavigation.addEventListener("change", () => setDrawerOpen(false, false));

  menuToggle?.addEventListener("click", () => {
    setDrawerOpen(shell.dataset.drawerOpen !== "true");
  });
  sidebarClose?.addEventListener("click", () => setDrawerOpen(false));
  drawerBackdrop?.addEventListener("click", () => setDrawerOpen(false));
  sidebarToggle?.addEventListener("click", () => {
    setCollapsed(shell.dataset.sidebarCollapsed !== "true");
  });
  sidebar?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      if (mobileNavigation.matches) setDrawerOpen(false);
    });
  });

  shell.querySelectorAll("[data-row-href]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.target.closest("a,button,input,select,textarea,summary,label")
      ) {
        return;
      }
      const href = row.dataset.rowHref;
      if (href) window.location.assign(href);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && shell.dataset.drawerOpen === "true" && mobileNavigation.matches) {
      const focusable = [
        ...(sidebar?.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => !element.hidden && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last) {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (event.key === "Escape" && shell.dataset.drawerOpen === "true") {
      event.preventDefault();
      setDrawerOpen(false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      jumpInput?.focus();
      jumpInput?.select();
    }
  });

  const pinForm = document.querySelector("[data-pin-form]");
  const pinInput = pinForm?.querySelector("[data-pin-input]");
  const indicatorSurface = pinForm?.querySelector("[data-pin-indicators]");
  const indicators = [...(pinForm?.querySelectorAll("[data-pin-indicator]") ?? [])];
  const pinLive = pinForm?.querySelector("[data-pin-live]");
  const keypad = pinForm?.querySelector("[data-pin-keypad]");
  if (pinForm && pinInput && keypad) {
    const updateIndicators = () => {
      const length = pinInput.value.replace(/\D/gu, "").length;
      indicators.forEach((indicator, index) => {
        indicator.dataset.filled = index < length ? "true" : "false";
      });
      if (pinLive) pinLive.textContent = `${length} of 4 digits entered`;
      indicatorSurface?.setAttribute(
        "aria-label",
        `Admin PIN entry, ${length} of 4 digits entered`,
      );
    };
    const setPin = (value) => {
      pinInput.value = value.replace(/\D/gu, "").slice(0, 4);
      pinInput.dispatchEvent(new Event("input", { bubbles: true }));
      pinInput.focus();
    };
    indicatorSurface?.addEventListener("click", () => pinInput.focus());
    indicatorSurface?.addEventListener("focus", () => pinInput.focus());
    indicatorSurface?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        pinInput.focus();
      }
    });
    pinInput.addEventListener("focus", () => {
      indicatorSurface?.setAttribute("data-input-focused", "true");
    });
    pinInput.addEventListener("blur", () => {
      indicatorSurface?.removeAttribute("data-input-focused");
    });
    pinInput.addEventListener("input", () => {
      const sanitized = pinInput.value.replace(/\D/gu, "").slice(0, 4);
      if (sanitized !== pinInput.value) pinInput.value = sanitized;
      updateIndicators();
    });
    keypad.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const digit = button.dataset.pinKey;
      if (digit !== undefined) {
        setPin(pinInput.value + digit);
      } else if (button.dataset.pinAction === "clear") {
        setPin("");
      } else if (button.dataset.pinAction === "backspace") {
        setPin(pinInput.value.slice(0, -1));
      }
    });
    updateIndicators();
  }

  // Confirmation values are intentionally displayed read-only. Copying one
  // must never populate the separate typed confirmation field.
  const copyText = async (value) => {
    if (!value) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // Fall through to the selection-based compatibility path.
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let copied;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  };

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.dataset.copyTarget;
      const target = targetId ? document.getElementById(targetId) : null;
      const value =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.value
          : (target?.textContent?.trim() ?? "");
      const copied = await copyText(value);
      const status = button.closest("[data-copy-group]")?.querySelector("[data-copy-status]");
      if (status) status.textContent = copied ? "Copied." : "Select and copy the value manually.";
      if (copied)
        window.setTimeout(() => {
          if (status) status.textContent = "";
        }, 2200);
    });
  });

  // HTML drag enhancement for the On Deck queue. The server remains the
  // source of truth and the visible Move up/down forms remain available.
  document.querySelectorAll("[data-admin-reorder]").forEach((queue) => {
    const list = queue.querySelector("[data-reorder-list]");
    if (!(list instanceof HTMLElement)) return;
    const form = queue.querySelector("[data-reorder-form]");
    const input = form?.querySelector("[name=fillIds]");
    const status = queue.querySelector("[data-reorder-status]");
    let dragging = null;
    const items = () => [...list.querySelectorAll("[data-reorder-item]")];
    const updateOrder = () => {
      if (input)
        input.value = items()
          .map((node) => node.dataset.fillId)
          .filter(Boolean)
          .join(",");
    };
    items().forEach((item) => {
      const handle = item.querySelector("[data-reorder-handle]");
      if (!(handle instanceof HTMLElement) || !(item instanceof HTMLElement)) return;
      handle.draggable = true;
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const sibling =
          event.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
        if (!(sibling instanceof HTMLElement) || !sibling.matches("[data-reorder-item]")) return;
        if (event.key === "ArrowUp") list.insertBefore(item, sibling);
        else list.insertBefore(sibling, item);
        updateOrder();
        if (status) status.textContent = "Order changed. Saving…";
        form?.requestSubmit();
        handle.focus();
      });
      handle.addEventListener("dragstart", (event) => {
        dragging = item;
        item.classList.add("is-dragging");
        event.dataTransfer?.setData("text/plain", item.dataset.fillId || "");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      handle.addEventListener("dragend", () => {
        item.classList.remove("is-dragging");
        dragging = null;
      });
      item.addEventListener("dragover", (event) => {
        if (!dragging || dragging === item) return;
        event.preventDefault();
        const rect = item.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        list.insertBefore(dragging, after ? item.nextSibling : item);
      });
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!input || !form) return;
        updateOrder();
        if (status) status.textContent = "Order changed. Saving…";
        form.requestSubmit();
      });
    });
  });
}
