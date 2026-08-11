const DAY_MS = 86_400_000;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

function localDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
}

export function formatLifecycleLine(forecast, milestone) {
  if (milestone?.kickedAt) return `Kicked ${localDate(milestone.kickedAt) || ''}`.trim();
  const tappedAt = forecast?.lifecycle?.startedAt;
  if (!tappedAt) return '';
  const daysOn = Math.max(0, Math.floor((Date.now() - Date.parse(tappedAt)) / DAY_MS));
  const earliest = forecast?.depletion?.earliestDaysRemaining;
  const latest = forecast?.depletion?.latestDaysRemaining;
  const tapped = localDate(tappedAt);
  const range =
    Number.isFinite(earliest) && Number.isFinite(latest)
      ? `${forecast.isFallback ? 'broadly' : 'likely'} ${Math.max(0, Math.ceil(earliest))}–${Math.max(0, Math.ceil(latest))}d left`
      : forecast?.status === 'depleted'
        ? 'depleted'
        : 'forecast unavailable';
  return `Tapped ${tapped || 'unknown'} · ${daysOn}d on · ${range}`;
}

export function renderForecastDetails({ title, body, forecast, milestone }) {
  title.textContent = `Tap ${forecast?.lifecycle?.tapId ?? ''} forecast`.trim();
  body.replaceChildren();
  const summary = el('p', 'forecast-dialog-summary', formatLifecycleLine(forecast, milestone));
  const facts = el('dl', 'forecast-dialog-facts');
  const entries = [
    ['Confidence', forecast?.confidence?.level],
    [
      'Data span',
      Number.isFinite(forecast?.evidence?.observationDays) ? `${forecast.evidence.observationDays} days` : null
    ],
    ['Qualifying pours', forecast?.evidence?.qualifyingPours],
    ['Poured in span', Number.isFinite(forecast?.evidence?.totalOz) ? `${forecast.evidence.totalOz} oz` : null],
    ['Method', forecast?.evidence?.method?.replaceAll('_', ' ')],
    ['Measurement', forecast?.confidence?.status],
    ['Reason', forecast?.confidence?.reason?.replaceAll('_', ' ')]
  ];
  for (const [label, value] of entries) {
    if (value === null || value === undefined || value === '') continue;
    facts.append(el('dt', null, label), el('dd', null, value));
  }
  const note = el(
    'p',
    'forecast-dialog-note',
    forecast?.isFallback
      ? 'This is a broad fallback using 24 oz every four days until this lifecycle has enough evidence.'
      : 'The likely interval is a deterministic central 80% range from this lifecycle’s observed UTC usage days, including no-pour days.'
  );
  body.append(summary, facts, note);
}

function receiptText(receipt) {
  const remaining = receipt?.remaining?.remainingOz;
  const servings = receipt?.remaining?.servings;
  const parts = [`${Number(receipt?.volumePouredOz || 0).toFixed(1)} oz poured`];
  if (Number.isFinite(remaining))
    parts.push(`${remaining.toFixed(1)} oz left${receipt.provisional ? ' (settling)' : ''}`);
  if (Number.isFinite(servings)) parts.push(`${servings.toFixed(1)} servings`);
  return parts.join(' · ');
}

function toneSequence(preset) {
  if (preset === 'fanfare')
    return [
      [523, 0],
      [659, 0.12],
      [784, 0.24],
      [1047, 0.38]
    ];
  if (preset === 'last_call')
    return [
      [392, 0],
      [330, 0.2],
      [262, 0.4]
    ];
  return [
    [880, 0],
    [660, 0.18]
  ];
}

const settingEnabled = (value) => value === 1 || value === true;

export async function playCeremonySound(preset) {
  const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextImpl) return false;
  try {
    const context = new AudioContextImpl();
    await context.resume();
    for (const [frequency, offset] of toneSequence(preset)) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, context.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + 0.3);
    }
    setTimeout(() => context.close().catch(() => {}), 1_200);
    return true;
  } catch {
    return false;
  }
}

export function createCelebrationController({ layer, getSettings, soundEnabled }) {
  const seenReceipts = new Set();
  const active = new Map();
  const dismiss = (key) => {
    const entry = active.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    active.delete(key);
  };
  const show = (key, className, heading, detail, duration) => {
    dismiss(key);
    const node = el('section', className);
    node.setAttribute('role', 'status');
    const close = el('button', 'celebration-dismiss', 'Dismiss');
    close.type = 'button';
    close.addEventListener('click', () => dismiss(key));
    node.append(el('strong', 'celebration-heading', heading), el('p', null, detail), close);
    layer.appendChild(node);
    const timer = setTimeout(() => dismiss(key), duration);
    active.set(key, { node, timer });
  };
  return {
    receipt(receipt) {
      const key =
        receipt?.receiptId === null || receipt?.receiptId === undefined ? null : `receipt-${receipt.receiptId}`;
      if (!key || seenReceipts.has(key)) return;
      seenReceipts.add(key);
      show(
        key,
        'pour-receipt-card',
        `${receipt.beerName || `Tap ${receipt.tapId}`} · Tap ${receipt.tapId}`,
        receiptText(receipt),
        6_000
      );
    },
    receiptUpdated(receipt) {
      const key = `receipt-${receipt?.receiptId}`;
      const entry = active.get(key);
      if (entry) entry.node.querySelector('p').textContent = receiptText(receipt);
    },
    firstPour(receipt) {
      if (!settingEnabled(getSettings()?.first_pour_effects)) return;
      show(
        `first-${receipt.lifecycleId}`,
        'first-pour-banner',
        'Now on tap!',
        `${receipt.beerName} launches on Tap ${receipt.tapId}`,
        8_000
      );
    },
    kegKicked(event) {
      if (!settingEnabled(getSettings()?.kick_effects)) return;
      show(
        `kick-${event.lifecycleId}`,
        'keg-kick-ceremony',
        'Keg kicked!',
        `${event.beerName || `Tap ${event.tapId}`} · final pour ${event.receiptId ? `#${event.receiptId}` : 'recorded'}`,
        15_000
      );
      if (soundEnabled()) void playCeremonySound(getSettings()?.ceremony_sound || 'pub_bell');
    }
  };
}
