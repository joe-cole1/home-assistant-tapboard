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
  if (fillPercent <= lowThreshold) actions.appendChild(element('span', 'badge badge-low', 'LOW KEG!'));
  if (fresh) actions.appendChild(element('span', 'badge badge-fresh', 'NEW'));
  const cog = element('button', 'btn-icon tap-cog-btn', '⚙️');
  cog.type = 'button';
  cog.title = `Tap ${tapId} Settings`;
  actions.appendChild(cog);
  header.appendChild(actions);
  fragment.appendChild(header);

  fragment.append(element('h2', 'beer-title', beerName), element('div', 'beer-style', style));
  if (description) fragment.appendChild(element('p', 'beer-description', description));

  const metrics = element('div', 'metrics-row');
  metrics.append(metric('ABV', abv), metric('IBU', ibu), metric('OG', og), metric('FG', fg));
  fragment.appendChild(metrics);

  const graphic = element('div', 'graphic-container');
  const graphicWrapper = element('div', 'tap-graphic-wrapper');
  graphicWrapper.id = `graphic-tap-${tapId}`;
  graphic.append(
    graphicWrapper,
    element('div', 'floating-pour-badge', '🍺 NOW POURING'),
    element('div', 'volume-readout', volumeReadoutText)
  );
  fragment.appendChild(graphic);
  const forecast = element('div', 'forecast-readout', forecastText);
  forecast.hidden = !forecastText;
  fragment.appendChild(forecast);
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
    item.append(
      document.createTextNode('🍺 '),
      element('strong', null, brew.name),
      document.createTextNode(` (${brew.style || 'Craft'}) - ${brew.abv}% ABV`)
    );
    fragment.appendChild(item);
  });
  return fragment;
}
