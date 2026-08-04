const TAP_IDS = Object.freeze([1, 2, 3, 4, 5, 6]);

export const tapEntityIds = (tapId) =>
  Object.freeze({
    volume: `sensor.tap_${tapId}_fl_oz`,
    capacity: `input_number.tap_${tapId}_keg_capacity_oz`,
    batch: `sensor.tap_${tapId}_batch_info`,
    batchSelection: `select.tap_${tapId}_batch_select`
  });

const EMPTY_MEASUREMENT = Object.freeze({
  volumeOz: null,
  capacityOz: null,
  fillPercent: null,
  pintsRemaining: null,
  volumeStatus: 'unavailable'
});

const EMPTY_TAP_STATE = Object.freeze({
  ...EMPTY_MEASUREMENT,
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

function validCapacity(entity) {
  const capacity = numberOrNull(usableState(entity)?.state);
  return capacity !== null && capacity > 0 ? capacity : null;
}

function measurementTuple(volume, capacity, volumeStatus) {
  const effectiveOz = Math.min(Math.max(volume, 0), capacity);
  return {
    volumeOz: effectiveOz,
    capacityOz: capacity,
    fillPercent: Math.round((effectiveOz / capacity) * 1000) / 10,
    pintsRemaining: effectiveOz / 16,
    volumeStatus
  };
}

/**
 * Derive the only public volume tuple Tapboard exposes. `lastValidMeasurements`
 * is intentionally process-local: stale readings are a continuity aid, never a
 * persisted replacement for a scale measurement.
 */
export function projectMeasurement(
  statesMap,
  tapId,
  { isAssigned = () => false, lastValidMeasurements = new Map() } = {}
) {
  const ids = tapEntityIds(tapId);
  const volumeEntity = statesMap.get(ids.volume);
  const capacityEntity = statesMap.get(ids.capacity);
  const hasVolumeEntity = statesMap.has(ids.volume);
  const capacity = validCapacity(capacityEntity);

  // A keg without an active assignment has no meaningful remaining-volume
  // reading, even if an old scale entity is still reporting a value.
  if (capacity === null) return { ...EMPTY_MEASUREMENT };
  if (!isAssigned(tapId)) return { ...EMPTY_MEASUREMENT, capacityOz: capacity };

  const volume = numberOrNull(usableState(volumeEntity)?.state);
  if (volume !== null) {
    lastValidMeasurements.set(tapId, { volumeOz: volume, capacityOz: capacity });
    return measurementTuple(volume, capacity, 'measured');
  }

  // Sensorless taps are explicitly full only when the standard source does not
  // exist at all. An existing unavailable source is distinguishable and may be
  // stale, but must never become an invented full keg.
  if (!hasVolumeEntity) return measurementTuple(capacity, capacity, 'assumed_full');

  const last = lastValidMeasurements.get(tapId);
  if (last) return measurementTuple(last.volumeOz, capacity, 'stale');
  return { ...EMPTY_MEASUREMENT };
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
  const attributes = entity?.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
  return {
    value: source && typeof source.state === 'string' ? source.state : '',
    options: Array.isArray(attributes.options) ? attributes.options.filter((option) => typeof option === 'string') : []
  };
}

export function projectTapState(statesMap, tapId, options) {
  const ids = tapEntityIds(tapId);
  return {
    ...projectMeasurement(statesMap, tapId, options),
    batch: projectBatch(statesMap.get(ids.batch)),
    batchSelection: projectBatchSelection(statesMap.get(ids.batchSelection))
  };
}

export function createTapStatesProjection(statesMap, options) {
  return Object.fromEntries(TAP_IDS.map((tapId) => [String(tapId), projectTapState(statesMap, tapId, options)]));
}

/**
 * For a measurement source change, emit every member of the tuple together so
 * browser clients cannot momentarily mix an old percentage with new ounces.
 */
export function projectTapStateChange(entityId, entity, { statesMap, ...options } = {}) {
  for (const tapId of TAP_IDS) {
    const ids = tapEntityIds(tapId);
    if (entityId === ids.volume || entityId === ids.capacity) {
      const sourceStates = statesMap || new Map([[entityId, entity]]);
      return { tapId, changes: projectMeasurement(sourceStates, tapId, options) };
    }
    if (entityId === ids.batch) return { tapId, changes: { batch: projectBatch(entity) } };
    if (entityId === ids.batchSelection) return { tapId, changes: { batchSelection: projectBatchSelection(entity) } };
  }
  return null;
}

export function isTapStateChange(previous, next) {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

export { EMPTY_TAP_STATE, TAP_IDS };
