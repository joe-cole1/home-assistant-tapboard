// Brew Story is deliberately DOM-only: Brewfather text is never interpolated as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const AXIS_ORDER = ['malt', 'hops', 'bitterness', 'sweetness', 'roast', 'tartness', 'body', 'perceived_strength'];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

const present = (item) => item !== null && item !== undefined && item !== '';
const display = (item, fallback = '—') => (present(item) ? String(item) : fallback);
const finitePresent = (item) => present(item) && Number.isFinite(Number(item));

function formatDate(item) {
  if (!present(item)) return null;
  const date = new Date(item);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : String(item);
}

function section(title, sourceLabel) {
  const node = el('section', 'brew-story-section');
  const heading = el('div', 'brew-story-section-heading');
  heading.appendChild(el('h3', null, title));
  if (sourceLabel) heading.appendChild(el('span', 'brew-story-source-label', sourceLabel));
  node.appendChild(heading);
  return node;
}

function appendFacts(parent, facts) {
  const grid = el('dl', 'brew-story-facts');
  for (const [label, item] of facts) {
    if (!present(item)) continue;
    grid.append(el('dt', null, label), el('dd', null, item));
  }
  if (grid.childElementCount) parent.appendChild(grid);
}

function appendParagraph(parent, label, text, sourceLabel) {
  if (!present(text)) return;
  const block = el('div', 'brew-story-text-block');
  const heading = el('strong', null, label);
  if (sourceLabel) heading.appendChild(el('span', 'brew-story-inline-source', ` · ${sourceLabel}`));
  block.append(heading, el('p', null, text));
  parent.appendChild(block);
}

function humanize(key) {
  return String(key)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceLayerLabel(value) {
  return (
    {
      manual: 'Tapboard override',
      tasting: 'Brewer tasting',
      recipe_prediction: 'Prediction',
      style_baseline: 'Style baseline'
    }[value] || humanize(value || 'unknown')
  );
}

function telemetryChart(points) {
  if (!Array.isArray(points) || !points.length)
    return el('p', 'brew-story-empty', 'No telemetry readings in this window.');
  const series = [
    ['sg', 'Gravity', '#f5b642'],
    ['temp_c', 'Temperature °C', '#ef5350'],
    ['pressure', 'Pressure', '#42a5f5'],
    ['ph', 'pH', '#ab47bc']
  ]
    .map(([field, label, color]) => ({
      field,
      label,
      color,
      points: points
        .map((point, index) => ({
          value: finitePresent(point[field]) ? Number(point[field]) : Number.NaN,
          time: Number(point.recorded_at_ms) || Date.parse(point.recorded_at) || index
        }))
        .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.time))
    }))
    .filter((item) => item.points.length);
  if (!series.length) return el('p', 'brew-story-empty', 'Telemetry values are unavailable.');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'brew-story-chart');
  svg.setAttribute('viewBox', '0 0 480 220');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Telemetry trend: ${series.map((item) => item.label).join(', ')}`);
  const allTimes = series.flatMap((item) => item.points.map((point) => point.time));
  const start = Math.min(...allTimes);
  const end = Math.max(...allTimes);
  const timeRange = end - start || 1;
  series.forEach((item) => {
    const minimum = Math.min(...item.points.map((point) => point.value));
    const maximum = Math.max(...item.points.map((point) => point.value));
    const valueRange = maximum - minimum || 1;
    const polyline = document.createElementNS(SVG_NS, 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', item.color);
    polyline.setAttribute('stroke-width', '2');
    polyline.setAttribute(
      'points',
      item.points
        .map(
          (point) =>
            `${24 + ((point.time - start) / timeRange) * 432},${190 - ((point.value - minimum) / valueRange) * 160}`
        )
        .join(' ')
    );
    svg.appendChild(polyline);
  });
  const wrapper = el('div', 'brew-story-chart-wrap');
  const legend = el('div', 'brew-story-chart-legend');
  series.forEach((item) => {
    const entry = el('span', null, item.label);
    entry.style.setProperty('--series-color', item.color);
    legend.appendChild(entry);
  });
  wrapper.append(svg, legend);
  return wrapper;
}

function sensoryRadar(axes) {
  const records = AXIS_ORDER.map((name) => ({ name, ...(axes?.[name] || {}) }));
  const known = records.filter((axis) => finitePresent(axis.value));
  if (known.length < 3) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'brew-story-radar');
  svg.setAttribute('viewBox', '0 0 280 280');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Resolved sensory profile');
  const center = 140;
  const radius = 92;
  const knownPoints = [];
  records.forEach((axis, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / records.length;
    const spoke = document.createElementNS(SVG_NS, 'line');
    spoke.setAttribute('x1', String(center));
    spoke.setAttribute('y1', String(center));
    spoke.setAttribute('x2', String(center + Math.cos(angle) * radius));
    spoke.setAttribute('y2', String(center + Math.sin(angle) * radius));
    spoke.setAttribute(
      'class',
      finitePresent(axis.value) ? 'brew-story-radar-spoke' : 'brew-story-radar-spoke is-unknown'
    );
    svg.appendChild(spoke);
    if (finitePresent(axis.value)) {
      const score = Math.max(0, Math.min(5, Number(axis.value)));
      const point = {
        x: center + Math.cos(angle) * radius * (score / 5),
        y: center + Math.sin(angle) * radius * (score / 5)
      };
      knownPoints.push(point);
      const marker = document.createElementNS(SVG_NS, 'circle');
      marker.setAttribute('cx', String(point.x));
      marker.setAttribute('cy', String(point.y));
      marker.setAttribute('r', '3');
      marker.setAttribute('class', 'brew-story-radar-marker');
      svg.appendChild(marker);
    }
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(center + Math.cos(angle) * 122));
    label.setAttribute('y', String(center + Math.sin(angle) * 122));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = humanize(axis.name);
    svg.appendChild(label);
  });
  const polygon = document.createElementNS(SVG_NS, 'polygon');
  polygon.setAttribute('class', 'brew-story-radar-shape');
  polygon.setAttribute('points', knownPoints.map((point) => `${point.x},${point.y}`).join(' '));
  svg.prepend(polygon);
  return svg;
}

function identitySection(story, fallback) {
  const batch = story?.batch || {};
  const detailBatch = story?.sections?.batch || {};
  const node = section('Identity', 'Brewfather cache');
  const image = batch.image_url;
  if (typeof image === 'string' && image.startsWith('/api/batches/')) {
    const img = el('img', 'brew-story-image');
    img.src = image;
    img.alt = `${batch.recipe_name || batch.batch_name || 'Beer'} artwork`;
    img.loading = 'lazy';
    node.appendChild(img);
  }
  appendFacts(node, [
    ['Batch', batch.batch_name],
    ['Batch number', batch.batch_number],
    ['Recipe', batch.recipe_name],
    ['Brewer', batch.brewer],
    ['Style', batch.style || fallback.style],
    ['Status', batch.status],
    ['Brew date', formatDate(batch.brew_date)],
    ['Fermentation started', formatDate(batch.fermentation_start_date)],
    ['Packaged', formatDate(batch.packaging_date)],
    ['Completed', formatDate(batch.completed_date)]
  ]);
  if (Array.isArray(detailBatch.tags) && detailBatch.tags.length) {
    node.appendChild(el('p', 'brew-story-tags', detailBatch.tags.join(' · ')));
  }
  appendParagraph(node, 'Description', batch.description || fallback.description, 'Brewfather');
  return node;
}

function styleSection(recipe) {
  const style = recipe?.style;
  if (!style || typeof style !== 'object') return null;
  const node = section('Style intent', 'Style baseline');
  appendFacts(node, [
    ['Style', style.name],
    ['Category', style.category],
    ['Guideline', [style.category_number, style.style_letter].filter(Boolean).join('')]
  ]);
  for (const [label, key] of [
    ['Overall impression', 'overall_impression'],
    ['Aroma', 'aroma'],
    ['Appearance', 'appearance'],
    ['Flavor', 'flavor'],
    ['Mouthfeel', 'mouthfeel'],
    ['Characteristic ingredients', 'characteristic_ingredients'],
    ['Examples', 'examples']
  ]) {
    appendParagraph(node, label, style[key], 'Style baseline');
  }
  return node;
}

function recipeSection(recipe) {
  if (!recipe || typeof recipe !== 'object') return null;
  const node = section('Recipe', 'Brewfather recipe');
  appendParagraph(node, 'Recipe notes', recipe.notes || recipe.description, 'Brewer');
  for (const [group, items] of Object.entries(recipe.ingredients || {})) {
    if (!Array.isArray(items) || !items.length) continue;
    const list = el('ul', 'brew-story-ingredients');
    items.forEach((item) => {
      const amount = [item.amount, item.unit].filter(present).join(' ');
      const percentage = present(item.percentage) ? `${item.percentage}%` : '';
      const timing = [item.use, present(item.time) ? `${item.time} min` : ''].filter(Boolean).join(', ');
      list.appendChild(
        el('li', null, [item.name || 'Unnamed', amount, percentage, timing].filter(Boolean).join(' · '))
      );
    });
    const heading = el('strong', null, humanize(group));
    node.append(heading, list);
  }
  const profiles = recipe.profiles || {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile) continue;
    appendParagraph(
      node,
      `${humanize(name)} profile`,
      [profile.name, profile.description].filter(Boolean).join(' — '),
      'Target'
    );
  }
  return node.childElementCount > 1 ? node : null;
}

function measurementsSection(detailBatch, fallback) {
  const values = detailBatch?.measurements || {};
  const node = section('Planned vs actual', 'Target · Measured');
  const pairs = [
    ['OG', 'target_og', 'measured_og'],
    ['FG', 'target_fg', 'measured_fg'],
    ['ABV', 'target_abv', 'measured_abv'],
    ['Attenuation', 'target_attenuation', 'measured_attenuation'],
    ['IBU', 'target_ibu', 'measured_ibu'],
    ['Color (SRM)', 'target_color_srm', 'measured_color_srm'],
    ['Batch volume (L)', 'target_batch_volume_l', 'measured_batch_volume_l'],
    ['Efficiency', 'target_efficiency', 'measured_efficiency']
  ];
  pairs.forEach(([label, target, measured]) => {
    if (!present(values[target]) && !present(values[measured])) return;
    appendFacts(node, [
      [`${label} · Target`, values[target]],
      [`${label} · Measured`, values[measured]]
    ]);
  });
  if (node.childElementCount === 1) {
    appendFacts(node, [
      ['ABV · Measured', fallback.abv],
      ['IBU · Target', fallback.ibu],
      ['OG · Target', fallback.og],
      ['FG · Target', fallback.fg]
    ]);
  }
  return node.childElementCount > 1 ? node : null;
}

function timelineSection(events) {
  if (!Array.isArray(events) || !events.length) return null;
  const node = section('Brew timeline', 'Brewfather');
  const list = el('ol', 'brew-story-timeline');
  events.forEach((event) =>
    list.appendChild(
      el('li', null, [formatDate(event.occurred_at), event.name, event.description].filter(Boolean).join(' · '))
    )
  );
  node.appendChild(list);
  return node;
}

function telemetrySection(story) {
  const telemetry = story?.telemetry || {};
  const node = section('On Deck telemetry', 'Read-only Brewfather telemetry');
  const latest = telemetry.latest || {};
  appendFacts(node, [
    ['Recorded', formatDate(latest.recorded_at)],
    ['Gravity', latest.sg],
    ['Temperature', present(latest.temp_c) ? `${latest.temp_c} °C` : null],
    ['Pressure', latest.pressure],
    ['pH', latest.ph],
    ['Battery', latest.battery],
    ['RSSI', latest.rssi]
  ]);
  node.appendChild(telemetryChart(telemetry.history?.points));
  const freshness = story?.freshness;
  if (freshness) {
    node.appendChild(
      el(
        'p',
        `brew-story-freshness${freshness.stale ? ' is-stale' : ''}`,
        freshness.stale
          ? `Stale — latest reading ${formatDate(freshness.latest_reading_at) || 'unknown'}; threshold ${freshness.stale_after_hours} hours.`
          : `Current as of ${formatDate(freshness.latest_reading_at) || formatDate(freshness.detail_fetched_at) || 'unknown'}.`
      )
    );
  }
  return node;
}

function tastingSection(logs) {
  if (!Array.isArray(logs) || !logs.length) return null;
  const node = section('Finished experience', 'Brewer tasting');
  logs.forEach((log) => {
    appendFacts(node, [
      ['Recorded', formatDate(log.recorded_at)],
      ['Rating', log.score]
    ]);
    for (const key of ['aroma', 'appearance', 'flavor', 'mouthfeel', 'overall']) {
      appendParagraph(node, humanize(key), log[key], 'Brewer tasting');
    }
  });
  return node;
}

function forecastDetails(forecast) {
  if (!forecast || typeof forecast !== 'object') return null;
  const depletion = forecast.depletion || {};
  const confidence = forecast.confidence || {};
  const range = forecast.range || {};
  const days = depletion.medianDaysRemaining ?? forecast.estimatedDaysRemaining;
  const earliest = depletion.earliestDaysRemaining;
  const latest = depletion.latestDaysRemaining;
  if (!present(days) && !present(earliest) && !present(latest)) return null;
  const details = el('div', 'brew-story-forecast');
  details.appendChild(el('strong', null, 'Kick forecast'));
  const rangeText =
    present(earliest) && present(latest) ? `${earliest}–${latest} days remaining` : `${days} days remaining`;
  details.appendChild(el('p', 'brew-story-forecast-range', rangeText));
  appendFacts(details, [
    ['Confidence', confidence.level],
    [
      'Kick window',
      present(depletion.earliestDate) && present(depletion.latestDate)
        ? `${formatDate(depletion.earliestDate)} to ${formatDate(depletion.latestDate)}`
        : null
    ],
    ['Observed', present(range.startDate) && present(range.endDate) ? `${range.startDate} to ${range.endDate}` : null],
    ['Basis', forecast.explanation || humanize(forecast.reason || forecast.evidence?.method || '')]
  ]);
  return details;
}

function milestoneList(entry) {
  const milestones = [
    ['First pour', entry.first_pour_at],
    ['Kicked', entry.kicked_at || entry.kick_date]
  ].filter(([, value]) => present(value));
  if (!milestones.length) return null;
  const list = el('ul', 'brew-story-milestones');
  milestones.forEach(([name, at]) => list.appendChild(el('li', null, `${name} · ${formatDate(at)}`)));
  return list;
}

function lifecycleSection(lifecycles) {
  if (!Array.isArray(lifecycles) || !lifecycles.length) return null;
  const node = section('Tapboard chapter', 'Tapboard lifecycle');
  lifecycles.forEach((entry, index) => {
    const chapter = el('article', 'brew-story-lifecycle');
    chapter.appendChild(
      el(
        'h4',
        null,
        `${entry.active ? 'Current keg' : 'Keg'} ${lifecycles.length > 1 ? lifecycles.length - index : ''}`.trim()
      )
    );
    appendFacts(chapter, [
      ['Tap', entry.tap_id],
      ['Tapped', formatDate(entry.tapped_at)],
      ['Closed', formatDate(entry.closed_at)],
      ['Kick date', formatDate(entry.kick_date)],
      ['Pours', entry.pours?.count],
      ['Poured', present(entry.pours?.total_oz) ? `${entry.pours.total_oz} oz` : null],
      ['Remaining', present(entry.remaining?.volume_oz) ? `${entry.remaining.volume_oz} oz` : null]
    ]);
    const milestones = milestoneList(entry);
    if (milestones) chapter.appendChild(milestones);
    const forecast = forecastDetails(entry.forecast);
    if (forecast) chapter.appendChild(forecast);
    node.appendChild(chapter);
  });
  return node;
}

function sensorySection(sensory) {
  if (!sensory || sensory.hidden) return null;
  const node = section('Flavor guidance', `Deterministic ${sensory.rules_version || ''}`.trim());
  if (sensory.description) appendParagraph(node, 'Plain-English profile', sensory.description, 'Prediction');
  const graphic = sensoryRadar(sensory.axes);
  if (graphic) node.appendChild(graphic);
  else
    node.appendChild(
      el('p', 'brew-story-empty', 'A radar needs at least three evidenced axes. Unknown axes are not filled.')
    );
  const evidence = el('dl', 'brew-story-sensory-evidence');
  AXIS_ORDER.forEach((name) => {
    const axis = sensory.axes?.[name];
    if (!axis || !present(axis.value)) return;
    evidence.append(
      el('dt', null, `${humanize(name)} · ${axis.value}/5`),
      el(
        'dd',
        null,
        `${sourceLayerLabel(axis.source_layer)} · ${axis.confidence || 'unknown confidence'} · ${display(axis.evidence)}`
      )
    );
  });
  if (evidence.childElementCount) node.appendChild(evidence);
  return node;
}

function sensoryShadowSection(sensory) {
  const shadow = sensory?.shadow;
  if (!shadow || shadow.rules_version !== 'sensory-v2' || typeof shadow !== 'object') return null;
  const candidate = shadow.candidate || {};
  const comparison = shadow.comparison || {};
  const axes = AXIS_ORDER.filter((name) => Object.hasOwn(comparison, name));
  if (!axes.length) return null;

  const node = section('Sensory v2 comparison', 'Authenticated shadow');
  node.classList.add('brew-story-admin', 'brew-story-sensory-shadow');
  if (finitePresent(candidate.known_axis_count)) {
    node.appendChild(
      el('p', 'brew-story-shadow-summary', `V2 candidate · ${candidate.known_axis_count} evidenced axes`)
    );
  }
  if (present(candidate.prose)) appendParagraph(node, 'V2 candidate profile', candidate.prose, 'Prediction');

  const wrap = el('div', 'brew-story-shadow-table-wrap');
  const table = el('table', 'brew-story-shadow-table');
  const caption = el('caption', null, 'Sensory v1 and v2 axis comparison');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['Axis', 'V1', 'V2', 'Delta', 'Coverage', 'V2 evidence'].forEach((label) =>
    headerRow.appendChild(el('th', null, label))
  );
  head.appendChild(headerRow);
  const body = document.createElement('tbody');
  axes.forEach((name) => {
    const values = comparison[name] || {};
    const delta = finitePresent(values.delta)
      ? `${Number(values.delta) > 0 ? '+' : ''}${Number(values.delta).toFixed(1)}`
      : 'Unavailable';
    const row = document.createElement('tr');
    [
      humanize(name),
      finitePresent(values.v1) ? Number(values.v1).toFixed(1) : 'Unavailable',
      finitePresent(values.v2) ? Number(values.v2).toFixed(1) : 'Unavailable',
      delta,
      display(values.coverage),
      display(candidate.axes?.[name]?.evidence)
    ].forEach((value) => row.appendChild(el('td', null, value)));
    body.appendChild(row);
  });
  table.append(caption, head, body);
  wrap.appendChild(table);
  node.appendChild(wrap);
  return node;
}

function sensoryEditor(story, onSave, onError) {
  const override = story?.sensory?.override;
  if (!override || typeof onSave !== 'function') return null;
  const node = section('Admin sensory override', 'Authenticated');
  node.classList.add('brew-story-admin');
  const form = el('form', 'brew-story-override-form');

  const hiddenLabel = el('label', 'brew-story-checkbox');
  const hidden = el('input');
  hidden.type = 'checkbox';
  hidden.checked = override.hidden === true;
  hiddenLabel.append(hidden, document.createTextNode(' Hide sensory guidance from public viewers'));
  form.appendChild(hiddenLabel);

  const descriptionLabel = el('label', 'brew-story-field');
  descriptionLabel.appendChild(el('span', null, 'Plain-English description'));
  const description = el('textarea');
  description.rows = 4;
  description.maxLength = 2000;
  description.placeholder = 'Leave blank to use deterministic guidance';
  description.value = override.description_override || '';
  descriptionLabel.appendChild(description);
  form.appendChild(descriptionLabel);

  const axes = el('div', 'brew-story-axis-controls');
  AXIS_ORDER.forEach((name) => {
    const label = el('label', 'brew-story-field');
    label.appendChild(el('span', null, humanize(name)));
    const select = el('select');
    select.dataset.axis = name;
    const value = override.axis_overrides?.[name];
    const selectedValue = Number.isFinite(Number(value)) && value !== null ? String(value) : '';
    const automatic = el('option', null, 'Automatic');
    automatic.value = '';
    automatic.selected = selectedValue === '';
    select.appendChild(automatic);
    for (let score = 0; score <= 5; score += 0.5) {
      const option = el('option', null, `${score}/5`);
      option.value = String(score);
      option.selected = option.value === selectedValue;
      select.appendChild(option);
    }
    label.appendChild(select);
    axes.appendChild(label);
  });
  form.appendChild(axes);

  const actions = el('div', 'brew-story-override-actions');
  const save = el('button', 'btn-primary', 'Save sensory guidance');
  save.type = 'submit';
  actions.appendChild(save);
  form.appendChild(actions);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    const axisOverrides = {};
    axes.querySelectorAll('select[data-axis]').forEach((select) => {
      axisOverrides[select.dataset.axis] = select.value === '' ? null : Number(select.value);
    });
    try {
      await onSave({
        hidden: hidden.checked,
        description_override: description.value.trim() || null,
        axis_overrides: axisOverrides
      });
    } catch (error) {
      onError?.(error);
    } finally {
      save.disabled = false;
    }
  });
  node.appendChild(form);
  return node;
}

export function buildBrewStoryContent(story, fallback = {}) {
  const fragment = document.createDocumentFragment();
  const detail = story?.sections || {};
  for (const node of [
    lifecycleSection(story?.tapboard?.lifecycles),
    sensorySection(story?.sensory),
    identitySection(story, fallback),
    styleSection(detail.recipe),
    recipeSection(detail.recipe),
    measurementsSection(detail.batch, fallback),
    timelineSection(detail.batch?.events),
    telemetrySection(story),
    tastingSection(detail.batch?.taste_logs)
  ]) {
    if (node) fragment.appendChild(node);
  }
  return fragment;
}

export function createBrewStoryController({ dialog, title, body, status, fetchStory, saveSensory, canEdit }) {
  let controller;
  let requestId = 0;
  let current;
  let activeWindow = '7d';
  const setStatus = (text, stale = false) => {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('is-stale', stale);
  };
  async function load(windowName = '7d') {
    if (!current?.batchId) return;
    activeWindow = windowName;
    controller?.abort();
    controller = new AbortController();
    const id = ++requestId;
    setStatus('Loading Brewfather story…');
    body.replaceChildren(el('p', 'brew-story-loading', 'Loading…'));
    try {
      const response = await fetchStory(current.batchId, windowName, controller.signal, current.tapId);
      if (id !== requestId) return;
      if (!response.ok) throw new Error('Brew Story is unavailable.');
      const story = await response.json();
      if (id !== requestId) return;
      title.textContent = story?.batch?.recipe_name || story?.batch?.batch_name || current.title || 'Brew Story';
      const content = buildBrewStoryContent(story, current.fallback);
      body.replaceChildren(content);
      if (canEdit?.()) {
        const shadow = sensoryShadowSection(story?.sensory);
        if (shadow) body.appendChild(shadow);
      }
      if (canEdit?.() && typeof saveSensory === 'function') {
        const editor = sensoryEditor(
          story,
          async (payload) => {
            setStatus('Saving sensory guidance…');
            const response = await saveSensory(current.batchId, payload);
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || 'Unable to save sensory guidance.');
            await load(activeWindow);
            setStatus(
              story?.freshness?.stale
                ? 'Sensory guidance saved. Cached Brewfather data may be stale.'
                : 'Sensory guidance saved.',
              Boolean(story?.freshness?.stale)
            );
          },
          (error) => setStatus(error.message || 'Unable to save sensory guidance.', true)
        );
        if (editor) body.appendChild(editor);
      }
      setStatus(
        story?.freshness?.stale ? 'Showing stale cached Brewfather data.' : '',
        Boolean(story?.freshness?.stale)
      );
    } catch (error) {
      if (error.name === 'AbortError' || id !== requestId) return;
      body.replaceChildren(buildBrewStoryContent(null, current.fallback));
      const retry = el('button', 'btn-primary', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => load(windowName));
      body.appendChild(retry);
      setStatus(error.message || 'Unable to load Brew Story.', true);
    }
  }
  dialog.addEventListener('cancel', () => controller?.abort());
  return {
    open(context) {
      current = context;
      title.textContent = context.title || 'Brew Story';
      dialog
        .querySelectorAll('[data-story-window]')
        .forEach((item) => item.setAttribute('aria-pressed', String(item.dataset.storyWindow === '7d')));
      if (!dialog.open) dialog.showModal();
      if (context.batchId) load('7d');
      else {
        body.replaceChildren(buildBrewStoryContent(null, context.fallback));
        setStatus('Local tap detail — no Brewfather batch is assigned.', true);
      }
    },
    close() {
      controller?.abort();
      if (dialog.open) dialog.close();
    },
    load
  };
}
