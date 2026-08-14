import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type {
  ActorType,
  KegDeletionImpact,
  KegMaintenanceRecord,
  KegTareHistoryRecord,
  PhysicalKeg,
} from "./types.ts";

interface KegRow {
  readonly id: string;
  readonly keg_number: number;
  readonly label: string | null;
  readonly capacity_ml: number;
  readonly current_tare_g: number;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TareHistoryRow {
  readonly id: string;
  readonly keg_id: string;
  readonly previous_tare_g: number | null;
  readonly new_tare_g: number;
  readonly recorded_at: string;
  readonly reason: string | null;
  readonly actor_type: string;
  readonly actor_id: string | null;
}

interface MaintenanceRow {
  readonly id: string;
  readonly keg_id: string;
  readonly maintenance_type: string;
  readonly notes: string | null;
  readonly recorded_at: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
}

interface CountRow {
  readonly count: number;
}

function mapKegRow(row: KegRow): PhysicalKeg {
  return {
    id: row.id,
    kegNumber: row.keg_number,
    label: row.label,
    capacityMl: row.capacity_ml,
    currentTareG: row.current_tare_g,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTareHistoryRow(row: TareHistoryRow): KegTareHistoryRecord {
  return {
    id: row.id,
    kegId: row.keg_id,
    previousTareG: row.previous_tare_g,
    newTareG: row.new_tare_g,
    recordedAt: row.recorded_at,
    reason: row.reason,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
  };
}

function mapMaintenanceRow(row: MaintenanceRow): KegMaintenanceRecord {
  return {
    id: row.id,
    kegId: row.keg_id,
    maintenanceType: row.maintenance_type,
    notes: row.notes,
    recordedAt: row.recorded_at,
    actorType: row.actor_type as ActorType,
    actorId: row.actor_id,
  };
}

export function insertKeg(database: DatabaseExecutor, keg: PhysicalKeg): void {
  database
    .prepare<[string, number, string | null, number, number, number, string, string]>(
      `INSERT INTO kegs (id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      keg.id,
      keg.kegNumber,
      keg.label,
      keg.capacityMl,
      keg.currentTareG,
      keg.isActive ? 1 : 0,
      keg.createdAt,
      keg.updatedAt,
    );
}

export function updateKeg(database: DatabaseExecutor, keg: PhysicalKeg): boolean {
  const result = database
    .prepare<[number, string | null, number, number, number, string, string]>(
      `UPDATE kegs
       SET keg_number = ?,
           label = ?,
           capacity_ml = ?,
           current_tare_g = ?,
           is_active = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      keg.kegNumber,
      keg.label,
      keg.capacityMl,
      keg.currentTareG,
      keg.isActive ? 1 : 0,
      keg.updatedAt,
      keg.id,
    );

  return result.changes > 0;
}

export function findKegById(database: DatabaseExecutor, id: string): PhysicalKeg | undefined {
  const row = database
    .prepare<[string], KegRow>(
      `SELECT id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at
       FROM kegs
       WHERE id = ?`,
    )
    .get(id);

  return row === undefined ? undefined : mapKegRow(row);
}

export function findKegByNumber(
  database: DatabaseExecutor,
  kegNumber: number,
): PhysicalKeg | undefined {
  const row = database
    .prepare<[number], KegRow>(
      `SELECT id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at
       FROM kegs
       WHERE keg_number = ?`,
    )
    .get(kegNumber);

  return row === undefined ? undefined : mapKegRow(row);
}

export interface ListKegsOptions {
  readonly isActive?: boolean;
}

export function listKegs(database: DatabaseExecutor, options: ListKegsOptions = {}): PhysicalKeg[] {
  if (options.isActive !== undefined) {
    const rows = database
      .prepare<[number], KegRow>(
        `SELECT id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at
         FROM kegs
         WHERE is_active = ?
         ORDER BY keg_number ASC`,
      )
      .all(options.isActive ? 1 : 0);
    return rows.map(mapKegRow);
  }

  const rows = database
    .prepare<[], KegRow>(
      `SELECT id, keg_number, label, capacity_ml, current_tare_g, is_active, created_at, updated_at
       FROM kegs
       ORDER BY keg_number ASC`,
    )
    .all();

  return rows.map(mapKegRow);
}

export function deleteKegById(database: DatabaseExecutor, id: string): boolean {
  const result = database.prepare<[string]>(`DELETE FROM kegs WHERE id = ?`).run(id);

  return result.changes > 0;
}

export function insertTareHistory(database: DatabaseExecutor, record: KegTareHistoryRecord): void {
  database
    .prepare<[string, string, number | null, number, string, string | null, string, string | null]>(
      `INSERT INTO keg_tare_history (id, keg_id, previous_tare_g, new_tare_g, recorded_at, reason, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.kegId,
      record.previousTareG,
      record.newTareG,
      record.recordedAt,
      record.reason,
      record.actorType,
      record.actorId,
    );
}

export function listTareHistoryByKegId(
  database: DatabaseExecutor,
  kegId: string,
): KegTareHistoryRecord[] {
  const rows = database
    .prepare<[string], TareHistoryRow>(
      `SELECT id, keg_id, previous_tare_g, new_tare_g, recorded_at, reason, actor_type, actor_id
       FROM keg_tare_history
       WHERE keg_id = ?
       ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(kegId);

  return rows.map(mapTareHistoryRow);
}

export function countTareHistoryByKegId(database: DatabaseExecutor, kegId: string): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM keg_tare_history
       WHERE keg_id = ?`,
    )
    .get(kegId);

  return row?.count ?? 0;
}

export function insertMaintenanceRecord(
  database: DatabaseExecutor,
  record: KegMaintenanceRecord,
): void {
  database
    .prepare<[string, string, string, string | null, string, string, string | null]>(
      `INSERT INTO keg_maintenance_records (id, keg_id, maintenance_type, notes, recorded_at, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.kegId,
      record.maintenanceType,
      record.notes,
      record.recordedAt,
      record.actorType,
      record.actorId,
    );
}

export function listMaintenanceRecordsByKegId(
  database: DatabaseExecutor,
  kegId: string,
): KegMaintenanceRecord[] {
  const rows = database
    .prepare<[string], MaintenanceRow>(
      `SELECT id, keg_id, maintenance_type, notes, recorded_at, actor_type, actor_id
       FROM keg_maintenance_records
       WHERE keg_id = ?
       ORDER BY recorded_at DESC, rowid DESC`,
    )
    .all(kegId);

  return rows.map(mapMaintenanceRow);
}

export function countMaintenanceRecordsByKegId(database: DatabaseExecutor, kegId: string): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM keg_maintenance_records
       WHERE keg_id = ?`,
    )
    .get(kegId);

  return row?.count ?? 0;
}

export function countFillsByKegId(database: DatabaseExecutor, kegId: string): number {
  try {
    const row = database
      .prepare<[string], CountRow>(
        `SELECT COUNT(*) AS count
         FROM fills
         WHERE keg_id = ?`,
      )
      .get(kegId);

    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export function getKegDeletionImpact(
  database: DatabaseExecutor,
  id: string,
): KegDeletionImpact | undefined {
  const keg = findKegById(database, id);
  if (keg === undefined) {
    return undefined;
  }

  const tareCount = countTareHistoryByKegId(database, id);
  const maintenanceCount = countMaintenanceRecordsByKegId(database, id);
  const fillCount = countFillsByKegId(database, id);

  const impacts: { readonly code: string; readonly count: number }[] = [
    { code: "kegs", count: 1 },
    { code: "keg_tare_history", count: tareCount },
    { code: "keg_maintenance_records", count: maintenanceCount },
  ];
  if (fillCount > 0) {
    impacts.push({ code: "fills", count: fillCount });
  }

  return {
    kegId: keg.id,
    kegNumber: keg.kegNumber,
    kegs: 1,
    tareHistoryRecords: tareCount,
    maintenanceRecords: maintenanceCount,
    fills: fillCount,
    impacts,
  };
}
