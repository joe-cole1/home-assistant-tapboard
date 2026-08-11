const BASE_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 8;

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
  if (tableExists(db, 'pour_logs')) requireColumns(db, 'pour_logs', ['id', 'tap_id', 'volume_poured_oz', 'timestamp']);

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

function migrateTapboardContentSchema(db) {
  addColumnIfMissing(db, 'settings', 'layout_mode', "TEXT NOT NULL DEFAULT 'cozy'");
  addColumnIfMissing(db, 'settings', 'ondeck_new_batch_default', 'INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    CREATE TABLE IF NOT EXISTS brewfather_ondeck_preferences (
      batch_id TEXT PRIMARY KEY,
      visible INTEGER NOT NULL CHECK(visible IN (0, 1)),
      first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS custom_beverage (
      id TEXT PRIMARY KEY CHECK(id = 'custom:topo_chico'),
      name TEXT NOT NULL,
      style TEXT NOT NULL DEFAULT '',
      abv REAL NOT NULL DEFAULT 0,
      ibu INTEGER NOT NULL DEFAULT 0,
      og REAL,
      fg REAL,
      srm INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  db.prepare(
    "UPDATE settings SET layout_mode = 'cozy' WHERE layout_mode NOT IN ('cozy', 'compact') OR layout_mode IS NULL"
  ).run();
  db.prepare('UPDATE settings SET ondeck_new_batch_default = 1 WHERE ondeck_new_batch_default IS NULL').run();
  db.prepare(
    `INSERT OR IGNORE INTO custom_beverage (id, name, style, abv, ibu, og, fg, srm, description)
     VALUES ('custom:topo_chico', 'Topo Chico', 'Sparkling Water', 0, 0, 1, 1, 0, 'Sparkling mineral water')`
  ).run();
}

function migrateThemeAccentSchema(db) {
  // NULL means "use the selected preset's default", rather than a special
  // sentinel colour that would leak into public snapshots.
  addColumnIfMissing(db, 'settings', 'primary_color', 'TEXT');
  addColumnIfMissing(db, 'settings', 'secondary_color', 'TEXT');
}

function migrateBrewfatherCacheSchema(db) {
  for (const [column, declaration] of Object.entries({
    batch_name: 'TEXT',
    batch_number: 'TEXT',
    brewer: 'TEXT',
    recipe_id: 'TEXT',
    style_id: 'TEXT',
    description: 'TEXT',
    start_date: 'TEXT',
    fermentation_start_date: 'TEXT',
    conditioning_date: 'TEXT',
    packaging_date: 'TEXT',
    completed_date: 'TEXT',
    image_url: 'TEXT',
    estimated_og: 'REAL',
    estimated_fg: 'REAL',
    measured_og: 'REAL',
    measured_fg: 'REAL',
    estimated_abv: 'REAL',
    measured_abv: 'REAL',
    estimated_ibu: 'REAL',
    estimated_srm: 'REAL',
    carbonation: 'REAL',
    carbonation_temp_c: 'REAL',
    present: 'INTEGER NOT NULL DEFAULT 1 CHECK(present IN (0, 1))',
    summary_fingerprint: 'TEXT',
    source_updated_at: 'TEXT',
    content_version: 'INTEGER NOT NULL DEFAULT 1',
    first_seen_at: 'TEXT',
    last_seen_at: 'TEXT',
    last_attempt_at: 'TEXT',
    last_success_at: 'TEXT',
    error_category: 'TEXT',
    detail_fingerprint: 'TEXT',
    detail_fetched_at: 'TEXT'
  })) {
    addColumnIfMissing(db, 'batches', column, declaration);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS brewfather_batch_details (
      batch_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL CHECK(length(payload_json) <= 262144),
      fingerprint TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      FOREIGN KEY(batch_id) REFERENCES batches(batch_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS brewfather_batch_readings (
      batch_id TEXT NOT NULL,
      reading_key TEXT NOT NULL,
      remote_id TEXT,
      recorded_at TEXT,
      recorded_at_ms INTEGER,
      reading_type TEXT,
      device_id TEXT,
      sg REAL,
      temp_c REAL,
      pressure REAL,
      battery REAL,
      rssi REAL,
      payload_json TEXT NOT NULL CHECK(length(payload_json) <= 16384),
      PRIMARY KEY(batch_id, reading_key),
      FOREIGN KEY(batch_id) REFERENCES batches(batch_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS brewfather_sync_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      last_attempt_at TEXT,
      last_success_at TEXT,
      status TEXT NOT NULL DEFAULT 'never'
        CHECK(status IN ('never', 'running', 'ok', 'partial', 'stale_cache', 'failed', 'not_configured')),
      error_category TEXT,
      retry_at TEXT,
      freshness_at TEXT,
      last_cycle_requests INTEGER NOT NULL DEFAULT 0,
      last_cycle_batches INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT OR IGNORE INTO brewfather_sync_state (id) VALUES (1);
    CREATE INDEX IF NOT EXISTS batches_brewfather_present_status_date
      ON batches(present, status, brew_date DESC, batch_id);
    CREATE INDEX IF NOT EXISTS batches_brewfather_last_seen
      ON batches(last_seen_at DESC, batch_id);
    CREATE INDEX IF NOT EXISTS brewfather_batch_readings_batch_time
      ON brewfather_batch_readings(batch_id, recorded_at_ms DESC, reading_key);
  `);
}

function migrateBrewStorySchema(db) {
  addColumnIfMissing(db, 'brewfather_batch_readings', 'ph', 'REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS brewfather_history_sync_state (
      batch_id TEXT PRIMARY KEY,
      last_attempt_at TEXT,
      last_success_at TEXT,
      error_category TEXT,
      reading_count INTEGER NOT NULL DEFAULT 0 CHECK(reading_count >= 0),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY(batch_id) REFERENCES batches(batch_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS brewfather_sensory_overrides (
      batch_id TEXT PRIMARY KEY,
      hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
      description_override TEXT CHECK(description_override IS NULL OR length(description_override) <= 2000),
      malt REAL CHECK(malt IS NULL OR (malt >= 0 AND malt <= 5 AND malt * 2 = CAST(malt * 2 AS INTEGER))),
      hops REAL CHECK(hops IS NULL OR (hops >= 0 AND hops <= 5 AND hops * 2 = CAST(hops * 2 AS INTEGER))),
      bitterness REAL CHECK(bitterness IS NULL OR (bitterness >= 0 AND bitterness <= 5 AND bitterness * 2 = CAST(bitterness * 2 AS INTEGER))),
      sweetness REAL CHECK(sweetness IS NULL OR (sweetness >= 0 AND sweetness <= 5 AND sweetness * 2 = CAST(sweetness * 2 AS INTEGER))),
      roast REAL CHECK(roast IS NULL OR (roast >= 0 AND roast <= 5 AND roast * 2 = CAST(roast * 2 AS INTEGER))),
      tartness REAL CHECK(tartness IS NULL OR (tartness >= 0 AND tartness <= 5 AND tartness * 2 = CAST(tartness * 2 AS INTEGER))),
      body REAL CHECK(body IS NULL OR (body >= 0 AND body <= 5 AND body * 2 = CAST(body * 2 AS INTEGER))),
      perceived_strength REAL CHECK(perceived_strength IS NULL OR (perceived_strength >= 0 AND perceived_strength <= 5 AND perceived_strength * 2 = CAST(perceived_strength * 2 AS INTEGER))),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY(batch_id) REFERENCES batches(batch_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS brewfather_history_sync_due
      ON brewfather_history_sync_state(last_success_at, batch_id);
  `);
}

function migrateServingGlassSchema(db) {
  addColumnIfMissing(db, 'taps', 'serving_glass', "TEXT NOT NULL DEFAULT 'auto'");
}

function migrateLifecycleExperienceSchema(db) {
  addColumnIfMissing(
    db,
    'taps',
    'kick_threshold_oz',
    'REAL CHECK(kick_threshold_oz IS NULL OR (kick_threshold_oz >= 0 AND kick_threshold_oz <= 128))'
  );
  addColumnIfMissing(
    db,
    'settings',
    'first_pour_effects',
    'INTEGER NOT NULL DEFAULT 1 CHECK(first_pour_effects IN (0, 1))'
  );
  addColumnIfMissing(db, 'settings', 'kick_effects', 'INTEGER NOT NULL DEFAULT 1 CHECK(kick_effects IN (0, 1))');
  addColumnIfMissing(
    db,
    'settings',
    'ceremony_sound',
    "TEXT NOT NULL DEFAULT 'pub_bell' CHECK(ceremony_sound IN ('pub_bell', 'fanfare', 'last_call'))"
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_milestones (
      lifecycle_id INTEGER PRIMARY KEY,
      first_pour_id INTEGER UNIQUE,
      first_pour_at TEXT,
      kicked_at TEXT,
      kick_trigger TEXT CHECK(kick_trigger IS NULL OR kick_trigger IN ('manual', 'automatic')),
      kick_pour_id INTEGER,
      kick_threshold_oz REAL CHECK(kick_threshold_oz IS NULL OR (kick_threshold_oz >= 0 AND kick_threshold_oz <= 128)),
      FOREIGN KEY(lifecycle_id) REFERENCES keg_lifecycles(lifecycle_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      FOREIGN KEY(first_pour_id) REFERENCES pour_logs(id) ON DELETE SET NULL ON UPDATE RESTRICT,
      FOREIGN KEY(kick_pour_id) REFERENCES pour_logs(id) ON DELETE SET NULL ON UPDATE RESTRICT,
      CHECK(first_pour_id IS NULL OR first_pour_at IS NOT NULL),
      CHECK((kicked_at IS NULL AND kick_trigger IS NULL) OR (kicked_at IS NOT NULL AND kick_trigger IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS lifecycle_milestones_kicked_at
      ON lifecycle_milestones(kicked_at, lifecycle_id);
  `);
}

function validateLatestSchema(db) {
  for (const [table, required] of Object.entries({
    settings: ['id', 'admin_pin_hash', 'admin_pin_initialized'],
    taps: ['tap_id', 'batch_id', 'on_tap_at', 'serving_glass', 'kick_threshold_oz'],
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
    brewfather_ondeck_preferences: ['batch_id', 'visible', 'first_seen_at', 'updated_at'],
    custom_beverage: ['id', 'name', 'style', 'abv', 'ibu', 'og', 'fg', 'srm', 'description'],
    brewfather_batch_details: ['batch_id', 'payload_json', 'fingerprint', 'fetched_at'],
    brewfather_batch_readings: ['batch_id', 'reading_key', 'recorded_at_ms', 'payload_json'],
    brewfather_history_sync_state: [
      'batch_id',
      'last_attempt_at',
      'last_success_at',
      'error_category',
      'reading_count'
    ],
    brewfather_sensory_overrides: [
      'batch_id',
      'hidden',
      'description_override',
      'malt',
      'hops',
      'bitterness',
      'sweetness',
      'roast',
      'tartness',
      'body',
      'perceived_strength'
    ],
    brewfather_sync_state: ['id', 'status', 'error_category', 'last_cycle_requests', 'last_cycle_batches'],
    lifecycle_milestones: [
      'lifecycle_id',
      'first_pour_id',
      'first_pour_at',
      'kicked_at',
      'kick_trigger',
      'kick_pour_id',
      'kick_threshold_oz'
    ],
    schema_migrations: ['version', 'name', 'applied_at']
  })) {
    if (!tableExists(db, table)) throw new Error(`Incompatible schema version ${SCHEMA_VERSION}: missing ${table}`);
    requireColumns(db, table, required);
  }
  requireColumns(db, 'settings', [
    'layout_mode',
    'ondeck_new_batch_default',
    'primary_color',
    'secondary_color',
    'first_pour_effects',
    'kick_effects',
    'ceremony_sound'
  ]);
  requireColumns(db, 'batches', [
    'batch_name',
    'batch_number',
    'recipe_id',
    'description',
    'present',
    'summary_fingerprint',
    'last_attempt_at',
    'last_success_at',
    'error_category',
    'detail_fingerprint'
  ]);
  requireColumns(db, 'brewfather_batch_readings', ['ph']);
  for (const index of [
    'keg_lifecycles_one_open_tap',
    'pour_logs_lifecycle_epoch',
    'batches_brewfather_present_status_date',
    'batches_brewfather_last_seen',
    'brewfather_batch_readings_batch_time',
    'brewfather_history_sync_due',
    'lifecycle_milestones_kicked_at'
  ]) {
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
      if (version < 2) {
        migrateLifecycleSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          2,
          'immutable-keg-lifecycles'
        );
        db.pragma('user_version = 2');
      }
      if (version < 3) {
        migrateTapboardContentSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          3,
          'brewfather-ondeck-and-custom-beverage'
        );
        db.pragma('user_version = 3');
      }
      if (version < 4) {
        migrateThemeAccentSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          4,
          'theme-accent-overrides'
        );
        db.pragma('user_version = 4');
      }
      if (version < 5) {
        migrateBrewfatherCacheSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(5, 'brewfather-cache');
        db.pragma('user_version = 5');
      }
      if (version < 6) {
        migrateBrewStorySchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(6, 'brew-story');
        db.pragma('user_version = 6');
      }
      if (version < 7) {
        migrateServingGlassSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          7,
          'serving-glass-recommendations'
        );
        db.pragma('user_version = 7');
      }
      if (version < 8) {
        migrateLifecycleExperienceSchema(db);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)').run(
          8,
          'lifecycle-experiences'
        );
        db.pragma('user_version = 8');
      }
      // Validation is part of the migration transaction. A malformed legacy
      // table or missing constraint must roll back schema changes, ledger rows,
      // and user_version together.
      validateLatestSchema(db);
    })();
  } else validateLatestSchema(db);
}
