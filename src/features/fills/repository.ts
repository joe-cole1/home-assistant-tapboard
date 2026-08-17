import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { AdminFillPageSort, AdminFillPageState, Fill, FillSettings } from "./types.ts";

interface FillRow {
  readonly id: string;
  readonly beverage_id: string;
  readonly keg_id: string;
  readonly fill_date: string;
  readonly on_deck_order: number | null;
  readonly ended_at: string | null;
  readonly end_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface FillSettingsRow {
  readonly id: number;
  readonly auto_delete_beverage_on_last_fill: number;
  readonly updated_at: string;
}

interface CountRow {
  readonly count: number;
}

interface MaxOrderRow {
  readonly max_order: number | null;
}

export interface AdminFillProjectionRow {
  readonly id: string;
  readonly beverage_id: string;
  readonly beverage_name: string | null;
  readonly beverage_type: string | null;
  readonly beverage_style: string | null;
  readonly beverage_abv: number | null;
  readonly fill_glass: string | null;
  readonly display_color: string | null;
  readonly keg_id: string;
  readonly keg_number: number;
  readonly keg_label: string | null;
  readonly fill_date: string;
  readonly on_deck_order: number | null;
  readonly ended_at: string | null;
  readonly end_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly tap_id: string | null;
  readonly tap_number: number | null;
  readonly state: string;
}

export interface AdminFillPageRepositoryQuery {
  readonly q: string;
  readonly state: AdminFillPageState;
  readonly sort: AdminFillPageSort;
  readonly page: number;
}

const ADMIN_FILL_PROJECTION_CTE = `
  WITH beverage_projection AS (
    SELECT
      b.id AS beverage_id,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.name
        WHEN po.override_name_present = 1 AND po.name IS NOT NULL THEN po.name
        ELSE sp.name
      END AS beverage_name,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.beverage_type
        WHEN po.override_beverage_type_present = 1 AND po.beverage_type IS NOT NULL THEN po.beverage_type
        ELSE sp.beverage_type
      END AS beverage_type,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.style
        WHEN po.override_style_present = 1 THEN po.style
        ELSE sp.style
      END AS beverage_style,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.abv
        WHEN po.override_abv_present = 1 THEN po.abv
        ELSE sp.abv
      END AS beverage_abv,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.fill_glass
        WHEN po.override_fill_glass_present = 1 THEN po.fill_glass
        ELSE NULL
      END AS fill_glass,
      CASE
        WHEN b.ownership_type = 'custom' THEN cp.display_color
        WHEN po.override_display_color_present = 1 THEN po.display_color
        ELSE sp.display_color
      END AS display_color
    FROM beverages b
    LEFT JOIN custom_beverage_profiles cp ON cp.beverage_id = b.id
    LEFT JOIN brewfather_source_profiles sp ON sp.beverage_id = b.id
    LEFT JOIN brewfather_presentation_overrides po ON po.beverage_id = b.id
  ),
  active_assignments AS (
    SELECT a.fill_id, a.tap_id, t.tap_number
    FROM tap_assignment_lifecycles a
    INNER JOIN taps t ON t.id = a.tap_id
    WHERE a.ended_at IS NULL
  ),
  fill_projection AS (
    SELECT
      f.id,
      f.beverage_id,
      bp.beverage_name,
      bp.beverage_type,
      bp.beverage_style,
      bp.beverage_abv,
      bp.fill_glass,
      bp.display_color,
      f.keg_id,
      k.keg_number,
      k.label AS keg_label,
      f.fill_date,
      f.on_deck_order,
      f.ended_at,
      f.end_reason,
      f.created_at,
      f.updated_at,
      aa.tap_id,
      aa.tap_number,
      CASE
        WHEN f.ended_at IS NOT NULL THEN 'ended'
        WHEN aa.fill_id IS NOT NULL THEN 'on_tap'
        WHEN f.on_deck_order IS NOT NULL THEN 'on_deck'
        ELSE 'available'
      END AS state
    FROM fills f
    INNER JOIN kegs k ON k.id = f.keg_id
    LEFT JOIN beverage_projection bp ON bp.beverage_id = f.beverage_id
    LEFT JOIN active_assignments aa ON aa.fill_id = f.id
  )`;

function adminFillPageWhere(query: AdminFillPageRepositoryQuery): {
  readonly sql: string;
  readonly params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.state === "active") clauses.push("state <> 'ended'");
  else if (query.state !== "all") {
    clauses.push("state = ?");
    params.push(query.state);
  }
  if (query.q.length > 0) {
    const escaped = query.q.replace(/[\\%_]/gu, (value) => `\\${value}`);
    const pattern = `%${escaped}%`;
    clauses.push(`(
      LOWER(COALESCE(beverage_name, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(beverage_style, '')) LIKE LOWER(?) ESCAPE '\\'
      OR LOWER(COALESCE(keg_label, '')) LIKE LOWER(?) ESCAPE '\\'
      OR CAST(keg_number AS TEXT) LIKE ? ESCAPE '\\'
      OR CAST(COALESCE(tap_number, '') AS TEXT) LIKE ? ESCAPE '\\'
      OR LOWER(state) LIKE LOWER(?) ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function adminFillPageOrder(sort: AdminFillPageSort): string {
  switch (sort) {
    case "name":
      return "LOWER(COALESCE(beverage_name, '')) ASC, id ASC";
    case "fill_date":
      return "fill_date DESC, id ASC";
    case "updated":
      return "updated_at DESC, id ASC";
    case "keg":
      return "keg_number ASC, id ASC";
    case "state":
    default:
      return "CASE state WHEN 'on_tap' THEN 1 WHEN 'on_deck' THEN 2 WHEN 'available' THEN 3 ELSE 4 END ASC, on_deck_order ASC, LOWER(COALESCE(beverage_name, '')) ASC, id ASC";
  }
}

function mapFillRow(row: FillRow): Fill {
  return {
    id: row.id,
    beverageId: row.beverage_id,
    kegId: row.keg_id,
    fillDate: row.fill_date,
    onDeckOrder: row.on_deck_order,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertFill(database: DatabaseExecutor, fill: Fill): void {
  database
    .prepare<
      [string, string, string, string, number | null, string | null, string | null, string, string]
    >(
      `INSERT INTO fills (id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fill.id,
      fill.beverageId,
      fill.kegId,
      fill.fillDate,
      fill.onDeckOrder,
      fill.endedAt,
      fill.endReason,
      fill.createdAt,
      fill.updatedAt,
    );
}

export function updateFill(database: DatabaseExecutor, fill: Fill): boolean {
  const result = database
    .prepare<[string, string, string, number | null, string | null, string | null, string, string]>(
      `UPDATE fills
       SET beverage_id = ?,
           keg_id = ?,
           fill_date = ?,
           on_deck_order = ?,
           ended_at = ?,
           end_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      fill.beverageId,
      fill.kegId,
      fill.fillDate,
      fill.onDeckOrder,
      fill.endedAt,
      fill.endReason,
      fill.updatedAt,
      fill.id,
    );

  return result.changes > 0;
}

export function findFillById(database: DatabaseExecutor, id: string): Fill | undefined {
  const row = database
    .prepare<[string], FillRow>(
      `SELECT id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at
       FROM fills
       WHERE id = ?`,
    )
    .get(id);

  return row === undefined ? undefined : mapFillRow(row);
}

export function findActiveFillByKegId(database: DatabaseExecutor, kegId: string): Fill | undefined {
  const row = database
    .prepare<[string], FillRow>(
      `SELECT id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at
       FROM fills
       WHERE keg_id = ? AND ended_at IS NULL`,
    )
    .get(kegId);

  return row === undefined ? undefined : mapFillRow(row);
}

export interface ListFillsFilter {
  readonly beverageId?: string;
  readonly kegId?: string;
}

export function listFills(database: DatabaseExecutor, filter: ListFillsFilter = {}): Fill[] {
  let sql = `SELECT id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at FROM fills`;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.beverageId !== undefined) {
    conditions.push("beverage_id = ?");
    params.push(filter.beverageId);
  }

  if (filter.kegId !== undefined) {
    conditions.push("keg_id = ?");
    params.push(filter.kegId);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(" AND ");
  }

  sql += ` ORDER BY created_at DESC, rowid DESC`;

  const rows = database.prepare<unknown[], FillRow>(sql).all(...params);
  return rows.map(mapFillRow);
}

/** Count a bounded, SQL-filtered admin Keg Room projection. */
export function countAdminFillPage(
  database: DatabaseExecutor,
  query: AdminFillPageRepositoryQuery,
): number {
  const where = adminFillPageWhere(query);
  const row = database
    .prepare<unknown[], CountRow>(
      `${ADMIN_FILL_PROJECTION_CTE}
       SELECT COUNT(*) AS count
       FROM fill_projection
       ${where.sql}`,
    )
    .get(...where.params);
  return row?.count ?? 0;
}

/** Return one deterministic 25-row Keg Room page directly from SQLite. */
export function listAdminFillPage(
  database: DatabaseExecutor,
  query: AdminFillPageRepositoryQuery,
): AdminFillProjectionRow[] {
  const where = adminFillPageWhere(query);
  const offset = (query.page - 1) * 25;
  const rows = database
    .prepare<unknown[], AdminFillProjectionRow>(
      `${ADMIN_FILL_PROJECTION_CTE}
       SELECT id, beverage_id, beverage_name, beverage_type, beverage_style, beverage_abv,
              fill_glass, display_color, keg_id, keg_number, keg_label, fill_date,
              on_deck_order, ended_at, end_reason, created_at, updated_at,
              tap_id, tap_number, state
       FROM fill_projection
       ${where.sql}
       ORDER BY ${adminFillPageOrder(query.sort)}
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, 25, offset);
  return rows;
}

export function deleteFillById(database: DatabaseExecutor, id: string): boolean {
  const result = database.prepare<[string]>(`DELETE FROM fills WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function countFillsByKegId(database: DatabaseExecutor, kegId: string): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM fills
       WHERE keg_id = ?`,
    )
    .get(kegId);

  return row?.count ?? 0;
}

export function countFillsByBeverageId(database: DatabaseExecutor, beverageId: string): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM fills
       WHERE beverage_id = ?`,
    )
    .get(beverageId);

  return row?.count ?? 0;
}

export function countActiveFillsByBeverageId(
  database: DatabaseExecutor,
  beverageId: string,
): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM fills
       WHERE beverage_id = ? AND ended_at IS NULL`,
    )
    .get(beverageId);

  return row?.count ?? 0;
}

export function getFillSettings(database: DatabaseExecutor): FillSettings {
  const row = database
    .prepare<[], FillSettingsRow>(
      `SELECT id, auto_delete_beverage_on_last_fill, updated_at
       FROM fill_settings
       WHERE id = 1`,
    )
    .get();

  if (row === undefined) {
    return {
      autoDeleteBeverageOnLastFill: false,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    autoDeleteBeverageOnLastFill: row.auto_delete_beverage_on_last_fill === 1,
    updatedAt: row.updated_at,
  };
}

export function updateFillSettings(
  database: DatabaseExecutor,
  autoDelete: boolean,
  updatedAt: string,
): void {
  database
    .prepare<[number, string]>(
      `UPDATE fill_settings
       SET auto_delete_beverage_on_last_fill = ?,
           updated_at = ?
       WHERE id = 1`,
    )
    .run(autoDelete ? 1 : 0, updatedAt);
}

export function listOnDeckFills(database: DatabaseExecutor): Fill[] {
  const rows = database
    .prepare<[], FillRow>(
      `SELECT id, beverage_id, keg_id, fill_date, on_deck_order, ended_at, end_reason, created_at, updated_at
       FROM fills
       WHERE ended_at IS NULL AND on_deck_order IS NOT NULL
       ORDER BY on_deck_order ASC, created_at ASC`,
    )
    .all();

  return rows.map(mapFillRow);
}

export function getMaxOnDeckOrder(database: DatabaseExecutor): number {
  const row = database
    .prepare<[], MaxOrderRow>(
      `SELECT MAX(on_deck_order) AS max_order
       FROM fills
       WHERE ended_at IS NULL AND on_deck_order IS NOT NULL`,
    )
    .get();

  return row?.max_order ?? 0;
}

export function updateOnDeckOrder(
  database: DatabaseExecutor,
  fillId: string,
  order: number | null,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[number | null, string, string]>(
      `UPDATE fills
       SET on_deck_order = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(order, updatedAt, fillId);

  return result.changes > 0;
}

export function endFill(
  database: DatabaseExecutor,
  fillId: string,
  endedAt: string,
  endReason: string | null,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[string, string | null, string, string]>(
      `UPDATE fills
       SET ended_at = ?,
           end_reason = ?,
           on_deck_order = NULL,
           updated_at = ?
       WHERE id = ? AND ended_at IS NULL`,
    )
    .run(endedAt, endReason, updatedAt, fillId);

  return result.changes > 0;
}

export function reorderOnDeck(
  database: DatabaseExecutor,
  fillIds: readonly string[],
  updatedAt: string,
): void {
  const updateStmt = database.prepare<[number, string, string]>(
    `UPDATE fills
     SET on_deck_order = ?,
         updated_at = ?
     WHERE id = ? AND ended_at IS NULL`,
  );

  for (let i = 0; i < fillIds.length; i += 1) {
    const fillId = fillIds[i];
    if (fillId !== undefined) {
      updateStmt.run(i + 1, updatedAt, fillId);
    }
  }
}
