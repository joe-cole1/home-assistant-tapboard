const BASE_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name)
  );
}

function requireColumns(db, table, required) {
  if (!tableExists(db, table)) return;
  const existing = columns(db, table);
  for (const column of required) {
    if (!existing.has(column)) throw new Error(`Incompatible ${table} table: missing ${column}`);
  }
}

function addColumnIfMissing(db, table, column, declaration) {
  if (!columns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function migrateBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), theme TEXT DEFAULT 'modern_dark',
      volume_format TEXT DEFAULT 'oz', title TEXT DEFAULT 'Hazardous Brews',
      font_title TEXT DEFAULT 'Outfit', font_body TEXT DEFAULT 'Inter',
      show_ondeck INTEGER DEFAULT 1, admin_pin_hash TEXT NOT NULL,
      admin_pin_initialized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS taps (
      tap_id INTEGER PRIMARY KEY CHECK (tap_id BETWEEN 1 AND 6), enabled INTEGER DEFAULT 1,
      batch_id TEXT, graphic TEXT DEFAULT 'corny_keg', override_enabled INTEGER DEFAULT 0,
      override_name TEXT, override_style TEXT, override_abv REAL, override_ibu INTEGER,
      override_og REAL, override_fg REAL, override_srm INTEGER, override_description TEXT,
      badge_low_keg REAL DEFAULT 20.0, badge_fresh INTEGER DEFAULT 1, on_tap_at TEXT,
      display_unit TEXT DEFAULT 'percent', custom_pour_size REAL DEFAULT 12.0
    );
    CREATE TABLE IF NOT EXISTS batches (
      batch_id TEXT PRIMARY KEY, recipe_name TEXT, style TEXT, brew_date TEXT, og REAL,
      fg REAL, abv REAL, ibu INTEGER, srm INTEGER, status TEXT, last_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS beverage_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, style TEXT, abv REAL,
      ibu INTEGER, srm_color INTEGER, description TEXT, on_deck INTEGER DEFAULT 0,
      target_tap_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL
    );
  `);
  requireColumns(db, 'settings', ['id', 'admin_pin_hash']);
  requireColumns(db, 'taps', ['tap_id']);
  requireColumns(db, 'batches', ['batch_id']);
  requireColumns(db, 'beverage_catalog', ['id', 'name']);
  requireColumns(db, 'admin_sessions', ['token', 'expires_at']);
  requireColumns(db, 'pour_logs', ['id', 'tap_id', 'volume_poured_oz', 'timestamp']);

  for (const [column, declaration] of Object.entries({
    theme: "TEXT DEFAULT 'modern_dark'",
    volume_format: "TEXT DEFAULT 'oz'",
    title: "TEXT DEFAULT 'Hazardous Brews'",
    font_title: "TEXT DEFAULT 'Outfit'",
    font_body: "TEXT DEFAULT 'Inter'",
    show_ondeck: 'INTEGER DEFAULT 1',
    admin_pin_initialized: 'INTEGER NOT NULL DEFAULT 0'
  }))
    addColumnIfMissing(db, 'settings', column, declaration);
  for (const [column, declaration] of Object.entries({
    enabled: 'INTEGER DEFAULT 1',
    batch_id: 'TEXT',
    graphic: "TEXT DEFAULT 'corny_keg'",
    override_enabled: 'INTEGER DEFAULT 0',
    override_name: 'TEXT',
    override_style: 'TEXT',
    override_abv: 'REAL',
    override_ibu: 'INTEGER',
    override_og: 'REAL',
    override_fg: 'REAL',
    override_srm: 'INTEGER',
    override_description: 'TEXT',
    badge_low_keg: 'REAL DEFAULT 20.0',
    badge_fresh: 'INTEGER DEFAULT 1',
    display_unit: "TEXT DEFAULT 'percent'",
    custom_pour_size: 'REAL DEFAULT 12.0',
    on_tap_at: 'TEXT'
  }))
    addColumnIfMissing(db, 'taps', column, declaration);
  for (const [column, declaration] of Object.entries({
    recipe_name: 'TEXT',
    style: 'TEXT',
    brew_date: 'TEXT',
    srm: 'INTEGER',
    og: 'REAL',
    fg: 'REAL',
    abv: 'REAL',
    ibu: 'INTEGER',
    status: 'TEXT',
    last_synced_at: 'TEXT'
  }))
    addColumnIfMissing(db, 'batches', column, declaration);
  for (const [column, declaration] of Object.entries({
    style: 'TEXT',
    abv: 'REAL',
    ibu: 'INTEGER',
    srm_color: 'INTEGER',
    description: 'TEXT',
    on_deck: 'INTEGER DEFAULT 0',
    target_tap_id: 'INTEGER'
  }))
    addColumnIfMissing(db, 'beverage_catalog', column, declaration);
  addColumnIfMissing(db, 'admin_sessions', 'created_at', 'TEXT DEFAULT CURRENT_TIMESTAMP');
  if (!tableExists(db, 'pour_logs')) {
    db.exec(`CREATE TABLE pour_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tap_id INTEGER NOT NULL, batch_id TEXT,
      volume_poured_oz REAL NOT NULL, timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(tap_id) REFERENCES taps(tap_id)
    )`);
  } else if (!columns(db, 'pour_logs').has('batch_id')) {
    addColumnIfMissing(db, 'pour_logs', 'batch_id', 'TEXT');
  }
  db.prepare(
    `UPDATE taps SET on_tap_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE on_tap_at IS NULL AND batch_id IS NOT NULL AND trim(batch_id) <> ''`
  ).run();
}

function migrateLifecycleSchema(db) {
  const orphan = db
    .prepare(
      `SELECT p.id FROM pour_logs p LEFT JOIN taps t ON t.tap_id = p.tap_id
    WHERE t.tap_id IS NULL LIMIT 1`
    )
    .get();
  if (orphan) throw new Error(`Cannot add foreign keys: pour_logs row ${orphan.id} references a missing tap`);
  const invalidTimestampCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM pour_logs
    WHERE timestamp IS NULL OR unixepoch(timestamp) IS NULL`
    )
    .get().count;
  if (invalidTimestampCount) throw new Error(`Cannot normalize ${invalidTimestampCount} pour timestamp(s)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS keg_lifecycles (
      lifecycle_id INTEGER PRIMARY KEY,
      tap_id INTEGER NOT NULL,
      batch_id TEXT,
      assignment_kind TEXT NOT NULL CHECK(assignment_kind IN ('brewfather', 'custom', 'override')),
      started_at TEXT NOT NULL,
      closed_at TEXT,
      close_reason TEXT,
      FOREIGN KEY(tap_id) REFERENCES taps(tap_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
      UNIQUE(lifecycle_id, tap_id),
      CHECK(closed_at IS NULL OR closed_at >= started_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS keg_lifecycles_one_open_tap
      ON keg_lifecycles(tap_id) WHERE closed_at IS NULL;
  `);

  const pourColumns = columns(db, 'pour_logs');
  if (!pourColumns.has('lifecycle_id') || !pourColumns.has('timestamp_epoch')) {
    db.exec(`
      CREATE TABLE pour_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tap_id INTEGER NOT NULL,
        batch_id TEXT,
        volume_poured_oz REAL NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lifecycle_id INTEGER,
        timestamp_epoch INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(tap_id) REFERENCES taps(tap_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
        FOREIGN KEY(lifecycle_id, tap_id) REFERENCES keg_lifecycles(lifecycle_id, tap_id)
          ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      INSERT INTO pour_logs_new (id, tap_id, batch_id, volume_poured_oz, timestamp, lifecycle_id, timestamp_epoch)
      SELECT id, tap_id, batch_id, volume_poured_oz, timestamp, NULL, CAST(unixepoch(timestamp) AS INTEGER)
      FROM pour_logs;
      DROP TABLE pour_logs;
      ALTER TABLE pour_logs_new RENAME TO pour_logs;
    `);
  } else {
    db.prepare(
      'UPDATE pour_logs SET timestamp_epoch = CAST(unixepoch(timestamp) AS INTEGER) WHERE timestamp_epoch IS NULL'
    ).run();
  }

  // Legacy pours deliberately remain unscoped.  Only the present tap assignment
  // gets an open lifecycle, so old usage can never leak into a new forecast.
  const insertLifecycle = db.prepare(`INSERT INTO keg_lifecycles (tap_id, batch_id, assignment_kind, started_at)
    VALUES (?, ?, ?, ?)`);
  for (const tap of db
    .prepare(
      `SELECT tap_id, batch_id, on_tap_at, override_enabled, override_name FROM taps
    WHERE (batch_id IS NOT NULL AND trim(batch_id) <> '')
       OR (override_enabled = 1 AND override_name IS NOT NULL AND trim(override_name) <> '')`
    )
    .all()) {
    const open = db
      .prepare('SELECT lifecycle_id FROM keg_lifecycles WHERE tap_id = ? AND closed_at IS NULL')
      .get(tap.tap_id);
    const batchId = tap.batch_id && tap.batch_id.trim() ? tap.batch_id : null;
    const kind = batchId ? (batchId.startsWith('custom:') ? 'custom' : 'brewfather') : 'override';
    if (!open) insertLifecycle.run(tap.tap_id, batchId, kind, tap.on_tap_at || new Date().toISOString());
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS pour_logs_lifecycle_epoch ON pour_logs(lifecycle_id, timestamp_epoch);
  `);
}

function validateLatestSchema(db) {
  for (const [table, required] of Object.entries({
    settings: ['id', 'admin_pin_hash', 'admin_pin_initialized'],
    taps: ['tap_id', 'batch_id', 'on_tap_at'],
    batches: ['batch_id'],
    pour_logs: ['id', 'tap_id', 'batch_id', 'volume_poured_oz', 'timestamp', 'lifecycle_id', 'timestamp_epoch'],
    keg_lifecycles: [
      'lifecycle_id',
      'tap_id',
      'batch_id',
      'assignment_kind',
      'started_at',
      'closed_at',
      'close_reason'
    ],
    schema_migrations: ['version', 'name', 'applied_at']
  })) {
    if (!tableExists(db, table)) throw new Error(`Incompatible schema version ${SCHEMA_VERSION}: missing ${table}`);
    requireColumns(db, table, required);
  }
  for (const index of ['keg_lifecycles_one_open_tap', 'pour_logs_lifecycle_epoch']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)) {
      throw new Error(`Incompatible schema version ${SCHEMA_VERSION}: missing ${index}`);
    }
  }
  const foreignKeys = db.prepare('PRAGMA foreign_key_list(pour_logs)').all();
  const lifecycleForeignKey = foreignKeys
    .filter((fk) => fk.table === 'keg_lifecycles')
    .reduce((groups, fk) => groups.set(fk.id, [...(groups.get(fk.id) || []), fk]), new Map());
  const hasCompositeLifecycleForeignKey = [...lifecycleForeignKey.values()].some((group) => {
    const ordered = group.sort((left, right) => left.seq - right.seq);
    return (
      ordered.length === 2 &&
      ordered[0].from === 'lifecycle_id' &&
      ordered[0].to === 'lifecycle_id' &&
      ordered[1].from === 'tap_id' &&
      ordered[1].to === 'tap_id' &&
      ordered.every((fk) => fk.on_update === 'RESTRICT' && fk.on_delete === 'RESTRICT')
    );
  });
  if (
    !hasCompositeLifecycleForeignKey ||
    !foreignKeys.some((fk) => fk.table === 'taps' && fk.from === 'tap_id' && fk.to === 'tap_id')
  ) {
    throw new Error(`Incompatible schema version ${SCHEMA_VERSION}: pour_logs foreign keys are missing`);
  }
  const violations = db.pragma('foreign_key_check');
  if (violations.length) throw new Error(`Database has ${violations.length} foreign-key violation(s)`);
}

export function migrateDatabase(db) {
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_keys', { simple: true }) !== 1)
    throw new Error('SQLite foreign-key enforcement could not be enabled');
  const version = Number(db.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported database schema version: ${version}`);
  }
  if (version !== SCHEMA_VERSION) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`);
      if (version < BASE_SCHEMA_VERSION) {
        migrateBaseSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          BASE_SCHEMA_VERSION,
          'canonical-base-schema'
        );
        db.pragma(`user_version = ${BASE_SCHEMA_VERSION}`);
      }
      if (version < SCHEMA_VERSION) {
        migrateLifecycleSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          SCHEMA_VERSION,
          'immutable-keg-lifecycles'
        );
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
    })();
  }
  validateLatestSchema(db);
}
