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
  forecastText,
  kicked = false,
  isMystery = false,
  inBattle = false,
  battleContestantSide = null
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

  const forecastLines = (forecastText || '').split('\n').filter(Boolean);
  let tappedDateText = '';
  let daysLeftText = '';
  if (forecastLines.length >= 2) {
    tappedDateText = forecastLines[0];
    daysLeftText = forecastLines[1];
  } else if (forecastLines.length === 1) {
    const line = forecastLines[0];
    if (line.includes('left') || line.includes('remaining') || line.includes('Depleted') || line.includes('days')) {
      daysLeftText = line;
    } else {
      tappedDateText = line;
    }
  }

  const details = element('div', 'tap-card-content');
  const styleName = element('div', 'beer-style', style);
  styleName.title = String(style || '');
  details.appendChild(styleName);

  const badges = element('div', 'tap-card-badges');
  if (isMystery) badges.appendChild(element('span', 'badge badge-mystery', '❓ Mystery Tap'));
  if (lowThreshold !== null && lowThreshold !== undefined && fillPercent <= lowThreshold) {
    badges.appendChild(element('span', 'badge badge-low', 'Low'));
  }
  if (fresh) badges.appendChild(element('span', 'badge badge-fresh', 'New'));
  if (kicked) badges.appendChild(element('span', 'badge badge-kicked', 'KICKED'));
  if (volumeStatus === 'assumed_full') {
    const sensorBadge = element('span', 'badge badge-sensor-problem', '!');
    sensorBadge.setAttribute('role', 'img');
    sensorBadge.setAttribute('aria-label', 'Sensor problem');
    badges.appendChild(sensorBadge);
  }
  details.appendChild(badges);

  const tappedDateEl = element('div', 'tapped-date-line text-muted', tappedDateText);
  tappedDateEl.hidden = !tappedDateText;
  details.appendChild(tappedDateEl);

  const metrics = element('div', 'metrics-row');
  metrics.append(metric('ABV', abv), metric('IBU', ibu), metric('OG', og), metric('FG', fg));
  details.appendChild(metrics);

  if (description) details.appendChild(element('p', 'beer-description', description));

  if (inBattle && battleContestantSide) {
    const voteBtnContainer = element('div', 'tap-vote-container');
    const voteBtn = element('button', 'btn btn-vote tap-vote-btn', 'Vote for this tap');
    voteBtn.type = 'button';
    voteBtn.dataset.tapId = String(tapId);
    voteBtn.dataset.contestantSide = String(battleContestantSide);
    voteBtn.setAttribute('aria-label', `Vote for Tap ${tapId}`);
    voteBtnContainer.appendChild(voteBtn);
    details.appendChild(voteBtnContainer);
  }

  const graphicColumn = element('div', 'tap-card-graphic-column');
  const graphic = element('div', 'graphic-container');
  const graphicWrapper = element('div', 'tap-graphic-wrapper');
  graphicWrapper.id = `graphic-tap-${tapId}`;
  const volumeReadout = element('div', 'volume-readout', volumeReadoutText);

  const daysLeftEl = element('div', 'days-left-line text-muted', daysLeftText);
  daysLeftEl.hidden = !daysLeftText;

  graphic.append(graphicWrapper, element('div', 'floating-pour-badge', '🍺 NOW POURING'), volumeReadout, daysLeftEl);
  const statusText =
    volumeStatus === 'stale' ? 'Stale measurement' : volumeStatus === 'unavailable' ? 'Unavailable' : '';
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
