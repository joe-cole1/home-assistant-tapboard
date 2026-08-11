// Lifecycle milestones are intentionally kept independent of HTTP and Home
// Assistant. Callers capture a lifecycle at pour start and hand this module a
// better-sqlite3 connection when the pour completes.

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  return value;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function isoTimestamp(value, name = 'timestamp') {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date.toISOString();
}

function lifecycleForTap(db, lifecycleId, tapId) {
  return db
    .prepare('SELECT lifecycle_id, tap_id, batch_id FROM keg_lifecycles WHERE lifecycle_id = ? AND tap_id = ?')
    .get(lifecycleId, tapId);
}

/**
 * Record a completed pour and claim its lifecycle's first-pour milestone in
 * one SQLite transaction. A captured lifecycle is valid even after that tap
 * has since been reassigned, but never for another tap.
 */
export function recordQualifyingPourWithMilestones(db, { tapId, lifecycleId = null, volumePouredOz, timestamp }) {
  positiveInteger(tapId, 'tapId');
  positiveNumber(volumePouredOz, 'volumePouredOz');
  if (lifecycleId !== null) positiveInteger(lifecycleId, 'lifecycleId');

  return db.transaction(() => {
    const recordedAt = isoTimestamp(timestamp, 'Pour timestamp');
    const lifecycle = lifecycleId === null ? null : lifecycleForTap(db, lifecycleId, tapId);
    if (lifecycleId !== null && !lifecycle) throw new Error('Captured keg lifecycle does not belong to this tap');

    const result = db
      .prepare(
        `INSERT INTO pour_logs
          (tap_id, batch_id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        tapId,
        lifecycle?.batch_id ?? null,
        volumePouredOz,
        recordedAt,
        lifecycle?.lifecycle_id ?? null,
        Math.floor(Date.parse(recordedAt) / 1000)
      );
    const pourId = Number(result.lastInsertRowid);
    let firstPourClaimed = false;
    if (lifecycle) {
      db.prepare('INSERT OR IGNORE INTO lifecycle_milestones (lifecycle_id) VALUES (?)').run(lifecycle.lifecycle_id);
      firstPourClaimed =
        db
          .prepare(
            `UPDATE lifecycle_milestones
             SET first_pour_id = ?, first_pour_at = ?
             WHERE lifecycle_id = ? AND first_pour_id IS NULL`
          )
          .run(pourId, recordedAt, lifecycle.lifecycle_id).changes === 1;
    }
    return { pourId, lifecycleId: lifecycle?.lifecycle_id ?? null, firstPourClaimed };
  })();
}

/** Claim a manual or automatic kick exactly once, optionally closing the keg. */
export function claimKickMilestone(
  db,
  {
    tapId,
    lifecycleId,
    trigger,
    pourId = null,
    thresholdOz = null,
    timestamp,
    closeLifecycle = false,
    closeReason = 'kicked',
    clearTap
  }
) {
  positiveInteger(tapId, 'tapId');
  positiveInteger(lifecycleId, 'lifecycleId');
  if (trigger !== 'manual' && trigger !== 'automatic') throw new Error('kick trigger must be manual or automatic');
  if (pourId !== null) positiveInteger(pourId, 'pourId');
  if (thresholdOz !== null) nonNegativeNumber(thresholdOz, 'thresholdOz');
  if (typeof clearTap !== 'undefined' && typeof clearTap !== 'function') throw new Error('clearTap must be a function');

  return db.transaction(() => {
    const kickedAt = isoTimestamp(timestamp, 'Kick timestamp');
    const lifecycle = lifecycleForTap(db, lifecycleId, tapId);
    if (!lifecycle) throw new Error('Lifecycle does not belong to this tap');
    db.prepare('INSERT OR IGNORE INTO lifecycle_milestones (lifecycle_id) VALUES (?)').run(lifecycleId);
    const claimed =
      db
        .prepare(
          `UPDATE lifecycle_milestones
           SET kicked_at = ?, kick_trigger = ?, kick_pour_id = ?, kick_threshold_oz = ?
           WHERE lifecycle_id = ? AND kicked_at IS NULL`
        )
        .run(kickedAt, trigger, pourId, thresholdOz, lifecycleId).changes === 1;

    if (closeLifecycle) {
      db.prepare(
        `UPDATE keg_lifecycles SET closed_at = ?, close_reason = ?
         WHERE lifecycle_id = ? AND tap_id = ? AND closed_at IS NULL`
      ).run(kickedAt, closeReason, lifecycleId, tapId);
    }
    if (clearTap) clearTap(tapId);
    const milestone = db.prepare('SELECT * FROM lifecycle_milestones WHERE lifecycle_id = ?').get(lifecycleId);
    return { claimed, idempotent: !claimed, lifecycleId, milestone };
  })();
}

function finiteNonNegativeOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function servingSizeFor(displayUnit, customServingSizeOz) {
  if (displayUnit === 'pours_custom') return finiteNonNegativeOrNull(customServingSizeOz) || null;
  if (displayUnit === 'pours_12') return 12;
  if (displayUnit === 'pints') return 16;
  return null;
}

/**
 * A receipt never reports more beer than either the post-pour estimate or a
 * current scale reading. `final` is null until a usable measurement exists.
 */
export function calculateConservativeReceipt({
  startVolumeOz,
  volumePouredOz,
  currentMeasuredOz = null,
  capacityOz = null,
  displayUnit = 'oz',
  customServingSizeOz = null
}) {
  const start = finiteNonNegativeOrNull(startVolumeOz);
  const poured = finiteNonNegativeOrNull(volumePouredOz);
  const capacity = finiteNonNegativeOrNull(capacityOz);
  const upperBound = capacity ?? Number.POSITIVE_INFINITY;
  const provisionalRemainingOz =
    start === null || poured === null ? null : Math.min(Math.max(start - poured, 0), upperBound);
  const measured = finiteNonNegativeOrNull(currentMeasuredOz);
  const finalRemainingOz =
    measured === null ? null : Math.min(measured, upperBound, provisionalRemainingOz ?? upperBound);
  const servingSizeOz = servingSizeFor(displayUnit, customServingSizeOz);
  const servings = (remaining) => (remaining === null || servingSizeOz === null ? null : remaining / servingSizeOz);
  return {
    displayUnit,
    servingSizeOz,
    provisional: { remainingOz: provisionalRemainingOz, servings: servings(provisionalRemainingOz) },
    final: { remainingOz: finalRemainingOz, servings: servings(finalRemainingOz) }
  };
}

export const buildConservativeReceipt = calculateConservativeReceipt;
