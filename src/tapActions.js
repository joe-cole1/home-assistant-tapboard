import { HttpError } from './httpSecurity.js';
import { activeLifecycle, closeKegLifecycle } from './kegLifecycle.js';

const CLEAR_TAP_SQL = `
  UPDATE taps SET
    batch_id = NULL,
    on_tap_at = NULL,
    override_enabled = 0,
    override_name = NULL,
    override_style = NULL,
    override_abv = NULL,
    override_ibu = NULL,
    override_og = NULL,
    override_fg = NULL,
    override_srm = NULL,
    override_description = NULL
  WHERE tap_id = ?
`;

function currentTap(db, tapId) {
  return db
    .prepare(
      `SELECT tap_id, batch_id, override_enabled, override_name, override_style
       FROM taps WHERE tap_id = ?`
    )
    .get(tapId);
}

function displayMetadata(db, tap) {
  if (!tap) return {};
  if (tap.batch_id?.startsWith('custom:')) {
    const custom = db.prepare('SELECT name, style FROM custom_beverage WHERE id = ?').get(tap.batch_id);
    return {
      displayName: tap.override_name || custom?.name || null,
      displayStyle: tap.override_style || custom?.style || null
    };
  }
  const batch = tap.batch_id
    ? db.prepare('SELECT recipe_name, style FROM batches WHERE batch_id = ?').get(tap.batch_id)
    : null;
  return {
    displayName: tap.override_name || batch?.recipe_name || null,
    displayStyle: tap.override_style || batch?.style || null
  };
}

export class TapMutationCoordinator {
  constructor({ db, completeBatch, now = () => new Date() } = {}) {
    if (!db || typeof completeBatch !== 'function') throw new TypeError('Tap actions require dependencies');
    this.db = db;
    this.completeBatch = completeBatch;
    this.now = now;
    this.busy = new Set();
    this.clearTap = db.prepare(CLEAR_TAP_SQL);
  }

  async runExclusive(tapId, operation) {
    if (this.busy.has(tapId)) throw new HttpError(409, 'Another tap action is already in progress');
    this.busy.add(tapId);
    try {
      return await operation();
    } finally {
      this.busy.delete(tapId);
    }
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new HttpError(500, 'Tap action timestamp is invalid');
    return date.toISOString();
  }

  async endBatch(tapId) {
    return await this.runExclusive(tapId, async () => {
      const before = currentTap(this.db, tapId);
      const lifecycle = activeLifecycle(this.db, tapId);
      if (!before?.batch_id) throw new HttpError(409, 'Tap has no assigned Brewfather batch');
      if (before.batch_id.startsWith('custom:')) {
        throw new HttpError(400, 'Custom beverages cannot be completed in Brewfather');
      }
      if (!lifecycle || lifecycle.assignment_kind !== 'brewfather' || lifecycle.batch_id !== before.batch_id) {
        throw new HttpError(409, 'Tap assignment lifecycle is inconsistent');
      }
      const metadata = displayMetadata(this.db, before);

      // This is the only Brewfather mutation in Tapboard. Local state is not
      // touched unless the exact Completed PATCH succeeds.
      await this.completeBatch(before.batch_id);

      const closedAt = this.timestamp();
      const closed = closeKegLifecycle(this.db, {
        tapId,
        closedAt,
        closeReason: 'end_batch',
        updateTap: () => {
          const current = currentTap(this.db, tapId);
          if (current?.batch_id !== before.batch_id) {
            throw new HttpError(409, 'Tap assignment changed while completion was in progress');
          }
          this.clearTap.run(tapId);
          this.db
            .prepare(
              `UPDATE batches
               SET status = 'Completed', present = 1, last_seen_at = ?, last_success_at = ?, error_category = NULL
               WHERE batch_id = ?`
            )
            .run(closedAt, closedAt, before.batch_id);
        }
      });
      return {
        tapId,
        batchId: before.batch_id,
        lifecycle: closed,
        closeReason: 'end_batch',
        ...metadata
      };
    });
  }

  async endKeg(tapId) {
    return await this.runExclusive(tapId, async () => {
      const before = currentTap(this.db, tapId);
      const lifecycle = activeLifecycle(this.db, tapId);
      if (!lifecycle && !before?.batch_id && !before?.override_enabled) {
        throw new HttpError(409, 'Tap has no active keg');
      }
      const metadata = displayMetadata(this.db, before);
      const closed = closeKegLifecycle(this.db, {
        tapId,
        closedAt: this.timestamp(),
        closeReason: 'end_keg',
        updateTap: () => this.clearTap.run(tapId)
      });
      return {
        tapId,
        batchId: before?.batch_id ?? null,
        lifecycle: closed,
        closeReason: 'end_keg',
        ...metadata
      };
    });
  }
}
