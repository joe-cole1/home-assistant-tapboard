// DOM-only render helpers. Values passed here may originate outside the UI.
const element = (tagName, className, text) => {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};

function metric(label, value) {
  const item = element('div', 'metric-item');
  item.append(element('span', 'metric-label', label), element('span', 'metric-value', value));
  return item;
}

export function createToast(message) {
  return element('div', 'toast-message', message);
}

export function createSelectOption(value, label, selected = false) {
  const option = element('option', null, label);
  option.value = String(value ?? '');
  option.selected = selected;
  return option;
}

function servingGlassText(servingGlass) {
  return `Serve in: ${servingGlass.label}${servingGlass.source === 'auto' ? ' · Tapboard recommendation' : ' · Brewer selected'}`;
}

export function syncServingGlassReadout(card, servingGlass) {
  let readout = card.querySelector('.serving-glass-readout');
  if (!servingGlass?.id) {
    readout?.remove();
    return null;
  }
  if (!readout) {
    readout = element('div', 'serving-glass-readout');
    card.querySelector('.tap-card-content')?.appendChild(readout);
  }
  readout.textContent = servingGlassText(servingGlass);
  return readout;
}

export function buildTapCardContent({
  tapId,
  fillPercent,
  volumeStatus = 'unavailable',
  fresh,
  lowThreshold,
  beerName,
  style,
  description,
  abv,
  ibu,
  og,
  fg,
  volumeReadoutText,
  forecastText,
  servingGlass,
  kicked = false
}) {
  const fragment = document.createDocumentFragment();
  const header = element('div', 'tap-card-header');
  const actions = element('div', 'tap-card-actions');
  header.appendChild(element('div', 'tap-number-badge', tapId));
  const title = element('button', 'beer-title tap-story-btn', beerName);
  title.type = 'button';
  title.title = String(beerName || '');
  title.setAttribute('aria-label', `Open Brew Story for ${beerName}`);
  header.appendChild(title);
  const cog = element('button', 'btn-icon tap-cog-btn', '⚙️');
  cog.type = 'button';
  cog.title = `Tap ${tapId} Settings`;
  actions.appendChild(cog);
  header.appendChild(actions);
  fragment.appendChild(header);

  const details = element('div', 'tap-card-content');
  details.appendChild(element('div', 'beer-style', style));
  if (description) details.appendChild(element('p', 'beer-description', description));
  const metrics = element('div', 'metrics-row');
  metrics.append(metric('ABV', abv), metric('IBU', ibu), metric('OG', og), metric('FG', fg));
  details.appendChild(metrics);
  const graphicColumn = element('div', 'tap-card-graphic-column');
  const badges = element('div', 'tap-card-badges');
  if (lowThreshold !== null && lowThreshold !== undefined && fillPercent <= lowThreshold) {
    badges.appendChild(element('span', 'badge badge-low', 'LOW KEG!'));
  }
  if (fresh) badges.appendChild(element('span', 'badge badge-fresh', 'NEW'));
  if (kicked) badges.appendChild(element('span', 'badge badge-kicked', 'KICKED'));
  graphicColumn.appendChild(badges);
  const graphic = element('div', 'graphic-container');
  const graphicWrapper = element('div', 'tap-graphic-wrapper');
  graphicWrapper.id = `graphic-tap-${tapId}`;
  const volumeReadout = element('div', 'volume-readout', volumeReadoutText);
  const forecast = element('button', 'forecast-readout lifecycle-forecast-btn', forecastText);
  forecast.type = 'button';
  forecast.setAttribute('aria-haspopup', 'dialog');
  forecast.setAttribute(
    'aria-label',
    forecastText ? `${forecastText}. Open forecast details.` : 'Forecast unavailable'
  );
  forecast.hidden = !forecastText;
  graphic.append(graphicWrapper, element('div', 'floating-pour-badge', '🍺 NOW POURING'), volumeReadout, forecast);
  const statusText =
    volumeStatus === 'stale'
      ? 'Stale measurement'
      : volumeStatus === 'assumed_full'
        ? 'Assumed full — not measured'
        : volumeStatus === 'unavailable'
          ? 'Unavailable'
          : '';
  const status = element('div', `volume-status volume-status-${volumeStatus}`, statusText);
  status.hidden = !statusText;
  graphic.appendChild(status);
  graphicColumn.appendChild(graphic);
  if (servingGlass?.id) {
    details.appendChild(element('div', 'serving-glass-readout', servingGlassText(servingGlass)));
  }
  fragment.append(graphicColumn, details);
  return fragment;
}

export function buildRecipeModalContent({ style, abv, ibu, srm, og, fg, brewDate, description }) {
  const fragment = document.createDocumentFragment();
  const grid = element('div', 'recipe-metrics-grid');
  [
    ['Style:', style],
    ['ABV:', abv],
    ['IBU:', ibu],
    ['SRM Color:', srm],
    ['Original Gravity:', og],
    ['Final Gravity:', fg]
  ].forEach(([label, value]) => {
    const row = element('div');
    row.append(element('strong', null, label), document.createTextNode(` ${value}`));
    grid.appendChild(row);
  });
  fragment.appendChild(grid);
  if (brewDate) {
    const date = element('div', 'recipe-brew-date');
    date.append(element('strong', null, 'Brew Date:'), document.createTextNode(` ${brewDate}`));
    fragment.appendChild(date);
  }
  const notes = element('div', 'recipe-notes');
  notes.appendChild(element('strong', null, 'Tasting Notes & Profile:'));
  notes.appendChild(element('p', 'recipe-description', description || 'Crafted with premium ingredients.'));
  fragment.appendChild(notes);
  return fragment;
}

export function buildOnDeckItems(onDeckBrews) {
  const fragment = document.createDocumentFragment();
  if (onDeckBrews.length === 0) {
    fragment.appendChild(element('span', 'ondeck-item', 'All fermenters available'));
    return fragment;
  }
  onDeckBrews.forEach((brew) => {
    const batchId = brew.batch_id || brew.id || brew.batchId;
    const item = batchId ? element('button', 'ondeck-item ondeck-story-button') : element('span', 'ondeck-item');
    if (batchId) {
      item.type = 'button';
      item.dataset.batchId = String(batchId);
      item.setAttribute('aria-label', 'Open Brew Story');
    }
    const name = brew.name || brew.recipe_name || 'Untitled batch';
    const style = brew.style || 'Craft';
    const abv = brew.abv ?? '--';
    item.append(
      document.createTextNode('🍺 '),
      element('strong', null, name),
      document.createTextNode(` (${style}) - ${abv}% ABV`)
    );
    fragment.appendChild(item);
  });
  return fragment;
}
