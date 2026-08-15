function nowIso(value) {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Lifecycle timestamp is invalid');
  return date.toISOString();
}

export function activeLifecycle(db, tapId) {
  return (
    db
      .prepare(
        `SELECT lifecycle_id, tap_id, batch_id, assignment_kind, started_at FROM keg_lifecycles
    WHERE tap_id = ? AND closed_at IS NULL`
      )
      .get(tapId) || null
  );
}

export function captureActiveLifecycle(db, tapId) {
  const lifecycle = activeLifecycle(db, tapId);
  return lifecycle ? Object.freeze({ ...lifecycle }) : null;
}

export function assignKegLifecycle(
  db,
  {
    tapId,
    batchId = null,
    assignmentKind = batchId?.startsWith('custom:') ? 'custom' : 'brewfather',
    startedAt,
    closeReason = 'reassigned',
    updateTap,
    onLifecycleClosed
  }
) {
  const run = db.transaction(() => {
    const current = activeLifecycle(db, tapId);
    if (current) {
      db.prepare('UPDATE keg_lifecycles SET closed_at = ?, close_reason = ? WHERE lifecycle_id = ?').run(
        nowIso(startedAt),
        closeReason,
        current.lifecycle_id
      );
      if (onLifecycleClosed) onLifecycleClosed(current, closeReason);
    }
    if (updateTap) updateTap();
    const result = db
      .prepare(
        `INSERT INTO keg_lifecycles
      (tap_id, batch_id, assignment_kind, started_at) VALUES (?, ?, ?, ?)`
      )
      .run(tapId, batchId, assignmentKind, nowIso(startedAt));
    return db
      .prepare(
        `SELECT lifecycle_id, tap_id, batch_id, assignment_kind, started_at
      FROM keg_lifecycles WHERE lifecycle_id = ?`
      )
      .get(result.lastInsertRowid);
  });
  return run();
}

export function closeKegLifecycle(db, { tapId, closedAt, closeReason = 'ended', updateTap, onLifecycleClosed }) {
  return db.transaction(() => {
    const current = activeLifecycle(db, tapId);
    if (current) {
      db.prepare('UPDATE keg_lifecycles SET closed_at = ?, close_reason = ? WHERE lifecycle_id = ?').run(
        nowIso(closedAt),
        closeReason,
        current.lifecycle_id
      );
      if (onLifecycleClosed) onLifecycleClosed(current, closeReason);
    }
    if (updateTap) updateTap();
    return current;
  })();
}

// The caller captures lifecycleId synchronously at pour start. The immutable
// row remains valid after reassignment, so completion cannot move the pour to
// a newly assigned keg. Unassigned pours deliberately retain a NULL identity.
export function recordPour(db, { tapId, lifecycleId = null, volumePouredOz, timestamp }) {
  return db.transaction(() => {
    const recordedAt = nowIso(timestamp);
    const epoch = Math.floor(Date.parse(recordedAt) / 1000);
    if (!Number.isFinite(epoch)) throw new Error('Pour timestamp is invalid');
    let lifecycle = null;
    if (lifecycleId !== null) {
      lifecycle = db
        .prepare(
          `SELECT lifecycle_id, batch_id FROM keg_lifecycles
        WHERE lifecycle_id = ? AND tap_id = ?`
        )
        .get(lifecycleId, tapId);
      if (!lifecycle) throw new Error('Captured keg lifecycle does not belong to this tap');
    }
    return db
      .prepare(
        `INSERT INTO pour_logs
      (tap_id, batch_id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch)
      VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tapId, lifecycle?.batch_id ?? null, volumePouredOz, recordedAt, lifecycle?.lifecycle_id ?? null, epoch);
  })();
}
