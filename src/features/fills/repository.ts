import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { Fill, FillSettings } from "./types.ts";

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
