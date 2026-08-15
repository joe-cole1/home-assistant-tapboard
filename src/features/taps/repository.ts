import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { resolveEffectivePresentationFromDb } from "../beverages/presentation.ts";
import type {
  ActiveAssignmentDetails,
  AdminTapView,
  PublicTapView,
  Tap,
  TapAssignmentLifecycle,
} from "./types.ts";

interface TapRow {
  readonly id: string;
  readonly tap_number: number;
  readonly name: string | null;
  readonly enabled: number;
  readonly first_used_at: string | null;
  readonly retired_at: string | null;
  readonly gas_type: string | null;
  readonly serving_pressure_kpa: number | null;
  readonly line_length_mm: number | null;
  readonly line_diameter_mm: number | null;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LifecycleRow {
  readonly id: string;
  readonly tap_id: string;
  readonly fill_id: string;
  readonly assigned_at: string;
  readonly ended_at: string | null;
  readonly end_reason: string | null;
  readonly created_at: string;
}

interface AdminTapJoinedRow extends TapRow {
  readonly assignment_id: string | null;
  readonly assignment_fill_id: string | null;
  readonly assignment_assigned_at: string | null;
  readonly beverage_id: string | null;
  readonly keg_id: string | null;
  readonly keg_number: number | null;
  readonly keg_label: string | null;
}

interface PublicTapJoinedRow {
  readonly tap_number: number;
  readonly name: string | null;
  readonly fill_id: string | null;
  readonly beverage_id: string | null;
}

interface CountRow {
  readonly count: number;
}

function mapTapRow(row: TapRow): Tap {
  return {
    id: row.id,
    tapNumber: row.tap_number,
    name: row.name,
    enabled: row.enabled === 1,
    firstUsedAt: row.first_used_at,
    retiredAt: row.retired_at,
    gasType: row.gas_type,
    servingPressureKpa: row.serving_pressure_kpa,
    lineLengthMm: row.line_length_mm,
    lineDiameterMm: row.line_diameter_mm,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLifecycleRow(row: LifecycleRow): TapAssignmentLifecycle {
  return {
    id: row.id,
    tapId: row.tap_id,
    fillId: row.fill_id,
    assignedAt: row.assigned_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    createdAt: row.created_at,
  };
}

function mapAdminTapJoinedRow(database: DatabaseExecutor, row: AdminTapJoinedRow): AdminTapView {
  const isRetired = row.retired_at !== null;
  const isOccupied = row.assignment_id !== null;

  let activeAssignment: ActiveAssignmentDetails | null = null;
  if (
    row.assignment_id !== null &&
    row.assignment_fill_id !== null &&
    row.assignment_assigned_at !== null &&
    row.beverage_id !== null &&
    row.keg_id !== null &&
    row.keg_number !== null
  ) {
    const pres = resolveEffectivePresentationFromDb(database, row.beverage_id);
    if (pres !== undefined) {
      activeAssignment = {
        id: row.assignment_id,
        fillId: row.assignment_fill_id,
        beverageId: row.beverage_id,
        beverageName: pres.name,
        beverageType: pres.beverageType,
        beverageStyle: pres.style,
        beverageAbv: pres.abv,
        kegId: row.keg_id,
        kegNumber: row.keg_number,
        kegLabel: row.keg_label,
        assignedAt: row.assignment_assigned_at,
      };
    }
  }

  return {
    id: row.id,
    tapNumber: row.tap_number,
    name: row.name,
    enabled: row.enabled === 1,
    isRetired,
    isOccupied,
    firstUsedAt: row.first_used_at,
    retiredAt: row.retired_at,
    gasType: row.gas_type,
    servingPressureKpa: row.serving_pressure_kpa,
    lineLengthMm: row.line_length_mm,
    lineDiameterMm: row.line_diameter_mm,
    notes: row.notes,
    activeAssignment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTap(database: DatabaseExecutor, tap: Tap): void {
  database
    .prepare<
      [
        string,
        number,
        string | null,
        number,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO taps (
        id,
        tap_number,
        name,
        enabled,
        first_used_at,
        retired_at,
        gas_type,
        serving_pressure_kpa,
        line_length_mm,
        line_diameter_mm,
        notes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tap.id,
      tap.tapNumber,
      tap.name,
      tap.enabled ? 1 : 0,
      tap.firstUsedAt,
      tap.retiredAt,
      tap.gasType,
      tap.servingPressureKpa,
      tap.lineLengthMm,
      tap.lineDiameterMm,
      tap.notes,
      tap.createdAt,
      tap.updatedAt,
    );
}

export function updateTap(database: DatabaseExecutor, tap: Tap): boolean {
  const result = database
    .prepare<
      [
        number,
        string | null,
        number,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        string,
        string,
      ]
    >(
      `UPDATE taps
       SET tap_number = ?,
           name = ?,
           enabled = ?,
           first_used_at = ?,
           retired_at = ?,
           gas_type = ?,
           serving_pressure_kpa = ?,
           line_length_mm = ?,
           line_diameter_mm = ?,
           notes = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      tap.tapNumber,
      tap.name,
      tap.enabled ? 1 : 0,
      tap.firstUsedAt,
      tap.retiredAt,
      tap.gasType,
      tap.servingPressureKpa,
      tap.lineLengthMm,
      tap.lineDiameterMm,
      tap.notes,
      tap.updatedAt,
      tap.id,
    );

  return result.changes > 0;
}

export function findTapById(database: DatabaseExecutor, id: string): Tap | undefined {
  const row = database
    .prepare<[string], TapRow>(
      `SELECT
        id,
        tap_number,
        name,
        enabled,
        first_used_at,
        retired_at,
        gas_type,
        serving_pressure_kpa,
        line_length_mm,
        line_diameter_mm,
        notes,
        created_at,
        updated_at
       FROM taps
       WHERE id = ?`,
    )
    .get(id);

  return row === undefined ? undefined : mapTapRow(row);
}

export function findTapByNumber(database: DatabaseExecutor, tapNumber: number): Tap | undefined {
  const row = database
    .prepare<[number], TapRow>(
      `SELECT
        id,
        tap_number,
        name,
        enabled,
        first_used_at,
        retired_at,
        gas_type,
        serving_pressure_kpa,
        line_length_mm,
        line_diameter_mm,
        notes,
        created_at,
        updated_at
       FROM taps
       WHERE tap_number = ?`,
    )
    .get(tapNumber);

  return row === undefined ? undefined : mapTapRow(row);
}

export function listTaps(database: DatabaseExecutor): Tap[] {
  const rows = database
    .prepare<[], TapRow>(
      `SELECT
        id,
        tap_number,
        name,
        enabled,
        first_used_at,
        retired_at,
        gas_type,
        serving_pressure_kpa,
        line_length_mm,
        line_diameter_mm,
        notes,
        created_at,
        updated_at
       FROM taps
       ORDER BY tap_number ASC`,
    )
    .all();

  return rows.map(mapTapRow);
}

export function deleteTapById(database: DatabaseExecutor, id: string): boolean {
  const result = database.prepare<[string]>(`DELETE FROM taps WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function registerTapFirstUse(
  database: DatabaseExecutor,
  tapId: string,
  occurredAt: string,
): void {
  database
    .prepare<[string, string, string]>(
      `UPDATE taps
       SET first_used_at = ?,
           updated_at = ?
       WHERE id = ? AND first_used_at IS NULL`,
    )
    .run(occurredAt, occurredAt, tapId);
}

export function insertAssignmentLifecycle(
  database: DatabaseExecutor,
  lifecycle: TapAssignmentLifecycle,
): void {
  database
    .prepare<[string, string, string, string, string | null, string | null, string]>(
      `INSERT INTO tap_assignment_lifecycles (
        id,
        tap_id,
        fill_id,
        assigned_at,
        ended_at,
        end_reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lifecycle.id,
      lifecycle.tapId,
      lifecycle.fillId,
      lifecycle.assignedAt,
      lifecycle.endedAt,
      lifecycle.endReason,
      lifecycle.createdAt,
    );
}

export function closeAssignmentLifecycle(
  database: DatabaseExecutor,
  assignmentId: string,
  endedAt: string,
  endReason: string,
): boolean {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE tap_assignment_lifecycles
       SET ended_at = ?,
           end_reason = ?
       WHERE id = ? AND ended_at IS NULL`,
    )
    .run(endedAt, endReason, assignmentId);

  return result.changes > 0;
}

export function closeActiveAssignmentByFillId(
  database: DatabaseExecutor,
  fillId: string,
  endedAt: string,
  endReason: string,
): boolean {
  const result = database
    .prepare<[string, string, string]>(
      `UPDATE tap_assignment_lifecycles
       SET ended_at = ?,
           end_reason = ?
       WHERE fill_id = ? AND ended_at IS NULL`,
    )
    .run(endedAt, endReason, fillId);

  return result.changes > 0;
}

export function findActiveAssignmentByTapId(
  database: DatabaseExecutor,
  tapId: string,
): TapAssignmentLifecycle | undefined {
  const row = database
    .prepare<[string], LifecycleRow>(
      `SELECT id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at
       FROM tap_assignment_lifecycles
       WHERE tap_id = ? AND ended_at IS NULL`,
    )
    .get(tapId);

  return row === undefined ? undefined : mapLifecycleRow(row);
}

export function listActiveAssignments(database: DatabaseExecutor): TapAssignmentLifecycle[] {
  return database
    .prepare<[], LifecycleRow>(
      `SELECT id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at
       FROM tap_assignment_lifecycles
       WHERE ended_at IS NULL
       ORDER BY assigned_at, id`,
    )
    .all()
    .map(mapLifecycleRow);
}

export function findActiveAssignmentByFillId(
  database: DatabaseExecutor,
  fillId: string,
): TapAssignmentLifecycle | undefined {
  const row = database
    .prepare<[string], LifecycleRow>(
      `SELECT id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at
       FROM tap_assignment_lifecycles
       WHERE fill_id = ? AND ended_at IS NULL`,
    )
    .get(fillId);

  return row === undefined ? undefined : mapLifecycleRow(row);
}

/** The original tap assignment for a Fill, retained across later moves. */
export function findFirstAssignmentByFillId(
  database: DatabaseExecutor,
  fillId: string,
): TapAssignmentLifecycle | undefined {
  const row = database
    .prepare<[string], LifecycleRow>(
      `SELECT id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at
       FROM tap_assignment_lifecycles
       WHERE fill_id = ?
       ORDER BY assigned_at ASC, id ASC
       LIMIT 1`,
    )
    .get(fillId);

  return row === undefined ? undefined : mapLifecycleRow(row);
}

export function findAssignmentLifecycleById(
  database: DatabaseExecutor,
  id: string,
): TapAssignmentLifecycle | undefined {
  const row = database
    .prepare<[string], LifecycleRow>(
      `SELECT id, tap_id, fill_id, assigned_at, ended_at, end_reason, created_at
       FROM tap_assignment_lifecycles
       WHERE id = ?`,
    )
    .get(id);

  return row === undefined ? undefined : mapLifecycleRow(row);
}

export function countActiveAssignmentsByTapId(database: DatabaseExecutor, tapId: string): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM tap_assignment_lifecycles
       WHERE tap_id = ? AND ended_at IS NULL`,
    )
    .get(tapId);

  return row?.count ?? 0;
}

export function countHistoricalAssignmentsByTapId(
  database: DatabaseExecutor,
  tapId: string,
): number {
  const row = database
    .prepare<[string], CountRow>(
      `SELECT COUNT(*) AS count
       FROM tap_assignment_lifecycles
       WHERE tap_id = ? AND ended_at IS NOT NULL`,
    )
    .get(tapId);

  return row?.count ?? 0;
}

const ADMIN_TAP_SELECT = `
  SELECT
    t.id,
    t.tap_number,
    t.name,
    t.enabled,
    t.first_used_at,
    t.retired_at,
    t.gas_type,
    t.serving_pressure_kpa,
    t.line_length_mm,
    t.line_diameter_mm,
    t.notes,
    t.created_at,
    t.updated_at,
    a.id AS assignment_id,
    a.fill_id AS assignment_fill_id,
    a.assigned_at AS assignment_assigned_at,
    f.beverage_id,
    k.id AS keg_id,
    k.keg_number AS keg_number,
    k.label AS keg_label
  FROM taps t
  LEFT JOIN tap_assignment_lifecycles a ON a.tap_id = t.id AND a.ended_at IS NULL
  LEFT JOIN fills f ON f.id = a.fill_id
  LEFT JOIN kegs k ON k.id = f.keg_id
`;

export function findAdminTapViewById(
  database: DatabaseExecutor,
  tapId: string,
): AdminTapView | undefined {
  const row = database
    .prepare<[string], AdminTapJoinedRow>(`${ADMIN_TAP_SELECT} WHERE t.id = ?`)
    .get(tapId);

  return row === undefined ? undefined : mapAdminTapJoinedRow(database, row);
}

export function listAdminTapViews(database: DatabaseExecutor): AdminTapView[] {
  const rows = database
    .prepare<[], AdminTapJoinedRow>(`${ADMIN_TAP_SELECT} ORDER BY t.tap_number ASC`)
    .all();

  return rows.map((row) => mapAdminTapJoinedRow(database, row));
}

export function listPublicTapViews(database: DatabaseExecutor): PublicTapView[] {
  const rows = database
    .prepare<[], PublicTapJoinedRow>(
      `SELECT
        t.tap_number,
        t.name,
        a.fill_id,
        f.beverage_id
       FROM taps t
       LEFT JOIN tap_assignment_lifecycles a ON a.tap_id = t.id AND a.ended_at IS NULL
       LEFT JOIN fills f ON f.id = a.fill_id
       WHERE t.enabled = 1 AND t.retired_at IS NULL
       ORDER BY t.tap_number ASC`,
    )
    .all();

  return rows.map((row) => {
    let activeFill: PublicTapView["activeFill"] = null;
    if (row.fill_id !== null && row.beverage_id !== null) {
      const pres = resolveEffectivePresentationFromDb(database, row.beverage_id);
      if (pres !== undefined) {
        activeFill = {
          fillId: row.fill_id,
          beverageName: pres.name,
          beverageType: pres.beverageType,
          beverageStyle: pres.style,
          beverageAbv: pres.abv,
        };
      }
    }
    return {
      tapNumber: row.tap_number,
      name: row.name,
      activeFill,
    };
  });
}
