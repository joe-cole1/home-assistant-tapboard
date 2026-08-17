const AUTOSAVE_FORMS = 'form[data-autosave="blur"]';
const UNDO_WINDOW_MS = 8_000;
const resourceStates = new Map();

function fieldNames(form) {
  return (form.dataset.autosaveFields ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

function controlsFor(form, name) {
  return [...form.elements].filter((element) => element.name === name);
}

function snapshot(form) {
  const values = {};
  for (const field of fieldNames(form)) {
    const controls = controlsFor(form, field);
    if (controls.length === 0) continue;
    const radios = controls.filter((control) => control.type === "radio");
    if (radios.length > 0) {
      values[field] = radios.find((control) => control.checked)?.value ?? "";
      continue;
    }
    const control = controls[0];
    values[field] =
      control.type === "checkbox"
        ? control.checked
          ? control.value || "true"
          : "false"
        : control.value;
  }
  const revisionName = form.dataset.autosaveRevision || "updatedAt";
  const revision = controlsFor(form, revisionName)[0];
  if (revision && "value" in revision) values[revisionName] = revision.value;
  return values;
}

function logicalSnapshot(form, values = snapshot(form)) {
  const result = { ...values };
  delete result[form.dataset.autosaveRevision || "updatedAt"];
  return result;
}

function logicalKey(form, values) {
  return JSON.stringify(logicalSnapshot(form, values));
}

function statusElement(form) {
  return form.querySelector("[data-autosave-status]");
}

function setStatus(form, message, state = "") {
  const output = statusElement(form);
  if (!output) return;
  output.textContent = message;
  output.dataset.autosaveState = state;
}

function csrfToken(form) {
  const field = controlsFor(form, "_csrf")[0];
  return field && "value" in field ? field.value : "";
}

function revisionField(form) {
  return form.dataset.autosaveRevision || "updatedAt";
}

function readRevision(form) {
  const field = controlsFor(form, revisionField(form))[0];
  return field && "value" in field ? field.value : "";
}

function setRevision(form, revision) {
  if (typeof revision !== "string" && typeof revision !== "number") return;
  const field = controlsFor(form, revisionField(form))[0];
  if (field && "value" in field) field.value = String(revision);
}

function registerResourceState(form, state) {
  const key = form.dataset.autosaveResource || form.action;
  state.resourceKey = key;
  const states = resourceStates.get(key) ?? new Set();
  states.add(state);
  resourceStates.set(key, states);
}

function syncResourceRevision(state, revision) {
  if (typeof revision !== "string" && typeof revision !== "number") return;
  const states = resourceStates.get(state.resourceKey) ?? new Set([state]);
  for (const sibling of states) setRevision(sibling.form, revision);
}

function clearFieldError(form, fieldName) {
  for (const control of controlsFor(form, fieldName)) {
    control.removeAttribute("aria-invalid");
    const original = control.getAttribute("data-autosave-original-describedby");
    if (original === null) control.removeAttribute("aria-describedby");
    else control.setAttribute("aria-describedby", original);
    control.removeAttribute("data-autosave-original-describedby");
  }
  for (const error of form.querySelectorAll(`[data-autosave-field-error="${fieldName}"]`))
    error.remove();
}

function applyFieldErrors(form, fields) {
  for (const error of form.querySelectorAll("[data-autosave-field-error]")) error.remove();
  for (const field of fieldNames(form)) clearFieldError(form, field);
  if (!fields || typeof fields !== "object") return;
  for (const [field, message] of Object.entries(fields)) {
    if (field === "_form") continue;
    const controls = controlsFor(form, field);
    if (controls.length === 0) continue;
    const id = `${form.id || "autosave"}-${field}-error`;
    const error = document.createElement("span");
    error.id = id;
    error.dataset.autosaveFieldError = field;
    error.className = "autosave-field-error";
    error.setAttribute("role", "alert");
    error.textContent = String(message);
    controls[controls.length - 1].insertAdjacentElement("afterend", error);
    for (const control of controls) {
      const original = control.getAttribute("aria-describedby");
      if (original !== null) control.setAttribute("data-autosave-original-describedby", original);
      control.setAttribute("aria-describedby", id);
      control.setAttribute("aria-invalid", "true");
    }
  }
}

function applyControlValue(controls, value) {
  const radios = controls.filter((control) => control.type === "radio");
  if (radios.length > 0) {
    const target = value === null || value === undefined ? "" : String(value);
    for (const control of radios) control.checked = String(control.value) === target;
    return;
  }
  for (const control of controls) {
    if (control.type === "checkbox") {
      control.checked = value === true || value === "true" || value === control.value;
    } else if ("value" in control) {
      control.value = value === null || value === undefined ? "" : String(value);
    }
  }
}

function applyResource(form, resource, onlyIfSentValues = undefined) {
  if (!resource || typeof resource !== "object") return;
  for (const field of fieldNames(form)) {
    if (!Object.prototype.hasOwnProperty.call(resource, field)) continue;
    const controls = controlsFor(form, field);
    if (controls.length === 0) continue;
    if (onlyIfSentValues && Object.prototype.hasOwnProperty.call(onlyIfSentValues, field)) {
      const current = snapshot(form)[field];
      if (current !== onlyIfSentValues[field]) continue;
    }
    const value = resource[field];
    applyControlValue(controls, value);
  }
}

function ensureUndoButton(form, state) {
  if (state.undoButton) return state.undoButton;
  const output = statusElement(form);
  if (!output) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "autosave-undo secondary";
  button.hidden = true;
  button.textContent = "Undo";
  button.addEventListener("click", () => {
    if (!state.undoValues) return;
    const values = state.undoValues;
    state.undoValues = null;
    button.hidden = true;
    for (const [field, value] of Object.entries(values)) {
      applyControlValue(controlsFor(form, field), value);
    }
    queue(form, state);
  });
  output.insertAdjacentElement("afterend", button);
  state.undoButton = button;
  return button;
}

function invalidateUndo(state) {
  state.undoValues = null;
  if (state.undoTimer) window.clearTimeout(state.undoTimer);
  state.undoTimer = null;
  if (state.undoButton) state.undoButton.hidden = true;
}

function armUndo(form, state, previousValues) {
  const previousFields = logicalSnapshot(form, previousValues);
  const currentFields = logicalSnapshot(form);
  if (JSON.stringify(previousFields) === JSON.stringify(currentFields)) return;
  invalidateUndo(state);
  state.undoValues = previousFields;
  const button = ensureUndoButton(form, state);
  if (!button) return;
  button.hidden = false;
  state.undoTimer = window.setTimeout(() => invalidateUndo(state), UNDO_WINDOW_MS);
}

async function send(form, values) {
  const revisionName = revisionField(form);
  const payload = { ...values };
  if (revisionName === "updatedAt") payload.updatedAt = values[revisionName] ?? "";
  if (revisionName === "expectedRevision") payload.expectedRevision = values[revisionName] ?? "";
  const response = await fetch(form.action, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(form),
      "X-Tapboard-Enhancement": "autosave",
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.message || "The change could not be saved.");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function queue(form, state) {
  const values = snapshot(form);
  const key = logicalKey(form, values);
  if (key === state.lastSentFieldsKey || key === state.pendingFieldsKey) return;
  invalidateUndo(state);
  state.pending = values;
  state.pendingFieldsKey = key;
  void drain(form, state);
}

async function drain(form, state) {
  if (state.running || state.pending === null) return;
  state.running = true;
  const values = { ...state.pending };
  const revisionName = revisionField(form);
  // Read the newest parent revision immediately before each queued request.
  values[revisionName] = readRevision(form);
  state.pending = null;
  state.pendingFieldsKey = "";
  const previous = state.lastAuthoritative ?? values;
  setStatus(form, "Saving…", "saving");
  try {
    const body = await send(form, values);
    // Preserve a newer in-flight edit while still applying normalization for
    // fields that remained at the submitted value.
    applyResource(form, body?.resource, values);
    syncResourceRevision(state, body?.revision);
    state.lastSentFieldsKey = logicalKey(form, values);
    state.lastAuthoritative = snapshot(form);
    applyFieldErrors(form, null);
    setStatus(form, "Saved", "saved");
    if (state.pending === null) armUndo(form, state, previous);
  } catch (error) {
    invalidateUndo(state);
    if (error.status === 422) {
      applyFieldErrors(form, error.body?.fields);
      setStatus(form, error.message || "Check the highlighted value", "error");
    } else if (error.status === 409) {
      setStatus(form, "Conflict — reload to review the current value", "conflict");
    } else setStatus(form, error.message || "Could not save", "error");
  } finally {
    state.running = false;
    if (state.pending !== null) void drain(form, state);
  }
}

function initialize(form) {
  if (form.dataset.autosaveInitialized === "true") return;
  form.dataset.autosaveInitialized = "true";
  const initialValues = snapshot(form);
  const state = {
    form,
    resourceKey: "",
    running: false,
    pending: null,
    pendingFieldsKey: "",
    lastSentFieldsKey: logicalKey(form, initialValues),
    lastAuthoritative: initialValues,
    undoValues: null,
    undoTimer: null,
    undoButton: null,
  };
  registerResourceState(form, state);
  const commit = (event) => {
    if (event.target && event.target.name && fieldNames(form).includes(event.target.name)) {
      clearFieldError(form, event.target.name);
      queue(form, state);
    }
  };
  form.addEventListener("change", commit);
  form.addEventListener("input", (event) => {
    if (event.target?.name) clearFieldError(form, event.target.name);
  });
  form.addEventListener("blur", commit, true);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    queue(form, state);
  });
}

if (typeof document !== "undefined") {
  for (const form of document.querySelectorAll(AUTOSAVE_FORMS)) initialize(form);
}

export { applyResource, logicalKey, snapshot };
