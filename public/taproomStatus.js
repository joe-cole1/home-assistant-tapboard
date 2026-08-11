// This module intentionally renders only with DOM APIs: projection values can originate outside the UI.
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined && text !== null) value.textContent = String(text);
  return value;
};

const asList = (value) => (Array.isArray(value) ? value : []);
const words = (value) =>
  String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
function firstText(source, keys, fallback = null) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function factList(entries) {
  const list = node('dl', 'taproom-status-facts');
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    list.append(node('dt', null, label), node('dd', null, value));
  }
  return list;
}

function button(label, className, handler) {
  const control = node('button', className, label);
  control.type = 'button';
  control.addEventListener('click', handler);
  return control;
}

/** A short, public-facing status suitable for an existing header badge. */
export function taproomHeaderBadgeText(draftHealth) {
  if (!draftHealth || draftHealth.configured === false) return 'Taproom not configured';
  const attention = firstText(draftHealth, ['attentionCount', 'issuesCount', 'warningCount']);
  if (Number.isFinite(attention) && attention > 0)
    return `${attention} draft health alert${attention === 1 ? '' : 's'}`;
  return firstText(draftHealth, ['summary', 'statusText'], 'Draft health ready');
}

/** A deliberately compact indicator; it never exposes a backing entity identifier. */
export function tapCardPlanningIndicatorText(plan) {
  if (!plan || plan.configured === false) return 'Planning unavailable';
  if (plan.stale || plan.isStale) return 'Planning data stale';
  const confidence = firstText(plan, ['confidence', 'confidenceLevel']);
  return confidence ? `${words(confidence)} confidence` : 'Planning available';
}

function renderHealth(content, health, authenticated, callbacks) {
  content.replaceChildren();
  content.append(node('h2', 'taproom-status-heading', 'Draft Health'));
  if (!health || health.configured === false) {
    content.append(node('p', 'taproom-status-empty', 'Draft health is not configured yet.'));
    if (authenticated) content.append(adminControls(callbacks));
    return;
  }
  content.append(
    node('p', 'taproom-status-summary', firstText(health, ['summary', 'statusText'], 'Draft health is available.'))
  );
  const checks = asList(Array.isArray(health) ? health : health.checks || health.items || health.alerts);
  if (!checks.length)
    content.append(node('p', 'taproom-status-empty', 'No draft health checks are currently reported.'));
  else {
    const list = node('ul', 'taproom-health-checks');
    for (const check of checks) {
      const item = node('li', 'taproom-health-check');
      const checkName =
        firstText(check, ['label', 'title', 'name']) ?? (check?.id ? words(check.id) : 'Draft health check');
      const checkLabel = check?.tapId ? `Tap ${check.tapId} · ${checkName}` : checkName;
      item.append(node('strong', null, checkLabel));
      const detail =
        firstText(check, ['message', 'detail']) ??
        [check?.state, check?.severity].filter(Boolean).map(words).join(' · ');
      if (detail) item.append(node('span', 'taproom-health-detail', detail));
      if (authenticated && check?.acknowledgeable !== false && callbacks.acknowledge) {
        item.append(button('Acknowledge', 'taproom-acknowledge', () => callbacks.acknowledge(check)));
      }
      list.append(item);
    }
    content.append(list);
  }
  if (authenticated) content.append(adminControls(callbacks));
}

function renderPlanning(content, planning, authenticated, callbacks) {
  content.replaceChildren();
  content.append(node('h2', 'taproom-status-heading', 'Tap Planning'));
  if (!planning || planning.configured === false) {
    content.append(node('p', 'taproom-status-empty', 'Tap planning is not configured yet.'));
    if (authenticated) content.append(adminControls(callbacks));
    return;
  }
  if (planning.stale || planning.isStale)
    content.append(
      node('p', 'taproom-status-warning', 'Planning data may be stale; verify it before making a tap decision.')
    );
  const plans = asList(Array.isArray(planning) ? planning : planning.taps || planning.items || planning.plans);
  if (!plans.length)
    content.append(node('p', 'taproom-status-empty', 'No tap planning recommendations are available.'));
  for (const plan of plans) {
    const card = node('section', 'taproom-plan-card');
    card.append(node('h3', null, firstText(plan, ['tapName', 'name', 'label'], 'Tap recommendation')));
    const range =
      firstText(plan, ['rangeText', 'range', 'window']) ??
      (plan?.readiness?.earliest && plan?.readiness?.latest
        ? `${plan.readiness.earliest} to ${plan.readiness.latest}`
        : null);
    const candidate = firstText(plan, ['candidateName', 'candidate', 'recommendation', 'beerName', 'recipeName']);
    const confidence = firstText(plan, ['confidence', 'confidenceLevel']) ?? plan?.readiness?.confidence;
    card.append(
      factList([
        ['Planning range', range],
        ['Candidate', candidate],
        ['Confidence', confidence && words(confidence)],
        ['Compatibility', firstText(plan, ['compatibilityText', 'compatibility']) ?? plan?.compatibility?.status],
        ['Gap outlook', plan?.classification && words(plan.classification)],
        ['Forecast', plan.forecastAvailable === false ? 'No forecast available' : null]
      ])
    );
    for (const candidatePlan of asList(plan.candidates)) {
      const candidate = node('div', 'taproom-candidate');
      candidate.append(
        node('h4', null, firstText(candidatePlan, ['name', 'beerName', 'recipeName', 'title'], 'Potential candidate'))
      );
      const readiness = candidatePlan?.readiness;
      candidate.append(
        factList([
          [
            'Readiness range',
            readiness?.earliest && readiness?.latest ? `${readiness.earliest} to ${readiness.latest}` : null
          ],
          ['Confidence', readiness?.confidence && words(readiness.confidence)],
          ['Compatibility', candidatePlan?.compatibility?.status && words(candidatePlan.compatibility.status)],
          ['Gap outlook', candidatePlan?.gap?.classification && words(candidatePlan.gap.classification)],
          [
            'Likely gap',
            Number.isFinite(candidatePlan?.gap?.earliestGapDays) && Number.isFinite(candidatePlan?.gap?.latestGapDays)
              ? `${candidatePlan.gap.earliestGapDays}–${candidatePlan.gap.latestGapDays} days`
              : null
          ]
        ])
      );
      if (candidatePlan?.gap?.caveat) candidate.append(node('p', 'taproom-plan-warning', candidatePlan.gap.caveat));
      card.append(candidate);
    }
    const assumptions = asList(plan.assumptions);
    if (assumptions.length) {
      const section = node('div', 'taproom-assumptions');
      section.append(node('h4', null, 'Assumptions'));
      const list = node('ul');
      assumptions.forEach((assumption) => list.append(node('li', null, assumption)));
      section.append(list);
      card.append(section);
    }
    if (plan.noInventory || plan.inventoryAvailable === false)
      card.append(
        node(
          'p',
          'taproom-no-inventory',
          'No inventory match is currently known. This is a probabilistic planning result, not a confirmation that inventory is unavailable.'
        )
      );
    card.appendChild(node('p', 'taproom-plan-indicator', tapCardPlanningIndicatorText(plan)));
    content.append(card);
  }
  if (authenticated) content.append(adminControls(callbacks));
}

function adminControls(callbacks) {
  const section = node('section', 'taproom-admin-controls');
  section.append(node('h3', null, 'Taproom administration'));
  const controls = [
    ['Save draft health configuration', 'saveConfig'],
    ['Record maintenance', 'recordMaintenance'],
    ['Save readiness', 'saveReadiness'],
    ['Save policy', 'savePolicy'],
    ['Save tap capabilities', 'saveTapCapabilities']
  ];
  for (const [label, key] of controls)
    if (callbacks[key]) section.append(button(label, 'taproom-admin-action', () => callbacks[key]()));
  return section;
}

/**
 * Render a self-contained full-screen dialog. `dialog` may be a native dialog or any host element.
 * Projection records are displayed only through their human-facing fields; entity IDs and maintenance notes are ignored.
 */
export function renderTaproomStatus({
  dialog,
  draftHealth,
  tapPlanning,
  authenticated = false,
  callbacks = {},
  onClose
} = {}) {
  if (!dialog) throw new TypeError('A dialog host is required');
  dialog.replaceChildren();
  dialog.classList.add('taproom-status-dialog');
  dialog.setAttribute('aria-modal', 'true');
  const headingId = 'taproom-status-title';
  dialog.setAttribute('aria-labelledby', headingId);
  const header = node('header', 'taproom-status-header');
  const title = node('h1', null, 'Taproom Status');
  title.id = headingId;
  header.append(title);
  const dismiss = () => {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    onClose?.();
  };
  const close = button('Close', 'taproom-status-close', dismiss);
  close.setAttribute('aria-label', 'Close Taproom Status');
  header.append(close);
  const tabs = node('div', 'taproom-status-tabs');
  tabs.setAttribute('role', 'tablist');
  const panel = node('section', 'taproom-status-panel');
  panel.id = 'taproom-status-panel';
  panel.setAttribute('role', 'tabpanel');
  const status = node('p', 'taproom-status-live');
  status.setAttribute('aria-live', 'polite');
  const select = (tab) => {
    healthTab.setAttribute('aria-selected', String(tab === 'health'));
    planningTab.setAttribute('aria-selected', String(tab === 'planning'));
    healthTab.tabIndex = tab === 'health' ? 0 : -1;
    planningTab.tabIndex = tab === 'planning' ? 0 : -1;
    status.textContent = tab === 'health' ? 'Draft Health tab selected.' : 'Tap Planning tab selected.';
    panel.setAttribute('aria-labelledby', tab === 'health' ? healthTab.id : planningTab.id);
    if (tab === 'health') renderHealth(panel, draftHealth, authenticated, callbacks);
    else renderPlanning(panel, tapPlanning, authenticated, callbacks);
  };
  const healthTab = button('Draft Health', 'taproom-status-tab', () => select('health'));
  const planningTab = button('Tap Planning', 'taproom-status-tab', () => select('planning'));
  const tabControls = [
    [healthTab, 'health'],
    [planningTab, 'planning']
  ];
  for (const [control, name] of tabControls) {
    control.setAttribute('role', 'tab');
    control.id = `taproom-status-${name}-tab`;
    control.setAttribute('aria-controls', panel.id);
    control.addEventListener('keydown', (event) => {
      const currentIndex = tabControls.findIndex(([candidate]) => candidate === control);
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabControls.length;
      else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabControls.length) % tabControls.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabControls.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      const [nextControl, nextName] = tabControls[nextIndex];
      select(nextName);
      nextControl.focus();
    });
  }
  tabs.append(healthTab, planningTab);
  dialog.append(header, tabs, status, panel);
  select('health');
  return { selectTab: select, close: dismiss, dialog };
}

export function createTaproomStatusController(options = {}) {
  let state = { ...options };
  let current = null;
  return {
    render(next = {}) {
      state = { ...state, ...next };
      current = renderTaproomStatus(state);
      return current;
    },
    open(next = {}) {
      const result = this.render(next);
      if (typeof state.dialog?.showModal === 'function' && !state.dialog.open) state.dialog.showModal();
      return result;
    },
    close() {
      if (current) return current.close();
      if (typeof state.dialog?.close === 'function' && state.dialog.open) state.dialog.close();
      return state.onClose?.();
    }
  };
}
