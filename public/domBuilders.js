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
  forecastText
}) {
  const fragment = document.createDocumentFragment();
  const header = element('div', 'tap-card-header');
  const actions = element('div', 'tap-card-actions');
  header.appendChild(element('div', 'tap-number-badge', tapId));
  const title = element('h2', 'beer-title', beerName);
  title.title = String(beerName || '');
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
  const forecast = element('div', 'forecast-readout', forecastText);
  forecast.hidden = !forecastText;
  details.appendChild(forecast);

  const graphicColumn = element('div', 'tap-card-graphic-column');
  const badges = element('div', 'tap-card-badges');
  if (lowThreshold !== null && lowThreshold !== undefined && fillPercent <= lowThreshold) {
    badges.appendChild(element('span', 'badge badge-low', 'LOW KEG!'));
  }
  if (fresh) badges.appendChild(element('span', 'badge badge-fresh', 'NEW'));
  graphicColumn.appendChild(badges);
  const graphic = element('div', 'graphic-container');
  const graphicWrapper = element('div', 'tap-graphic-wrapper');
  graphicWrapper.id = `graphic-tap-${tapId}`;
  graphic.append(
    graphicWrapper,
    element('div', 'floating-pour-badge', '🍺 NOW POURING'),
    element('div', 'volume-readout', volumeReadoutText)
  );
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
    const item = element('span', 'ondeck-item');
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
