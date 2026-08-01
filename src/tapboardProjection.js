const TAP_IDS = Object.freeze([1, 2, 3, 4, 5, 6]);

export const tapEntityIds = tapId => Object.freeze({
  fill: `sensor.tap_${tapId}_fill`,
  volume: `sensor.tap_${tapId}_fl_oz`,
  pints: `sensor.tap_${tapId}_pints_remaining`,
  batch: `sensor.tap_${tapId}_batch_info`,
  batchSelection: `select.tap_${tapId}_batch_select`
});

const EMPTY_TAP_STATE = Object.freeze({
  fillPercent: null,
  volumeOz: null,
  pintsRemaining: null,
  batch: null,
  batchSelection: Object.freeze({ value: '', options: Object.freeze([]) })
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usableState(entity) {
  return entity && entity.state !== 'unknown' && entity.state !== 'unavailable' ? entity : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function attribute(attributes, ...names) {
  for (const name of names) {
    if (Object.hasOwn(attributes, name) && attributes[name] !== undefined && attributes[name] !== null) {
      return attributes[name];
    }
  }
  return null;
}

export function projectBatch(entity) {
  const source = usableState(entity);
  if (!source) return null;
  const attributes = source.attributes && typeof source.attributes === 'object' ? source.attributes : {};
  return {
    batchId: stringOrNull(attribute(attributes, 'batch_id', 'id')),
    recipeName: stringOrNull(attribute(attributes, 'recipe_name', 'name')),
    style: stringOrNull(attribute(attributes, 'style')),
    brewDate: stringOrNull(attribute(attributes, 'brew_date')),
    og: numberOrNull(attribute(attributes, 'og')),
    fg: numberOrNull(attribute(attributes, 'fg')),
    abv: numberOrNull(attribute(attributes, 'abv')),
    ibu: numberOrNull(attribute(attributes, 'ibu')),
    srm: numberOrNull(attribute(attributes, 'srm', 'color')),
    description: stringOrNull(attribute(attributes, 'tasting_notes', 'notes')),
    status: stringOrNull(attribute(attributes, 'status'))
  };
}

export function projectBatchSelection(entity) {
  const source = usableState(entity);
  const attributes = source?.attributes && typeof source.attributes === 'object' ? source.attributes : {};
  return {
    value: source && typeof source.state === 'string' ? source.state : '',
    options: Array.isArray(attributes.options) ? attributes.options.filter(option => typeof option === 'string') : []
  };
}

export function projectTapState(statesMap, tapId) {
  const ids = tapEntityIds(tapId);
  return {
    fillPercent: numberOrNull(usableState(statesMap.get(ids.fill))?.state),
    volumeOz: numberOrNull(usableState(statesMap.get(ids.volume))?.state),
    pintsRemaining: numberOrNull(usableState(statesMap.get(ids.pints))?.state),
    batch: projectBatch(statesMap.get(ids.batch)),
    batchSelection: projectBatchSelection(statesMap.get(ids.batchSelection))
  };
}

export function createTapStatesProjection(statesMap) {
  return Object.fromEntries(TAP_IDS.map(tapId => [String(tapId), projectTapState(statesMap, tapId)]));
}

export function projectTapStateChange(entityId, entity) {
  for (const tapId of TAP_IDS) {
    const ids = tapEntityIds(tapId);
    if (entityId === ids.fill) return { tapId, changes: { fillPercent: numberOrNull(usableState(entity)?.state) } };
    if (entityId === ids.volume) return { tapId, changes: { volumeOz: numberOrNull(usableState(entity)?.state) } };
    if (entityId === ids.pints) return { tapId, changes: { pintsRemaining: numberOrNull(usableState(entity)?.state) } };
    if (entityId === ids.batch) return { tapId, changes: { batch: projectBatch(entity) } };
    if (entityId === ids.batchSelection) return { tapId, changes: { batchSelection: projectBatchSelection(entity) } };
  }
  return null;
}

export function isTapStateChange(previous, next) {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export { EMPTY_TAP_STATE, TAP_IDS };
