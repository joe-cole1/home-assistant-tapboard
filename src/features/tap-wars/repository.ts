import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { EligibleParticipant, EligibilityReason, TapWar, TapWarCompetitor } from "./types.ts";

interface WarRow {
  readonly id: string;
  readonly status: "active" | "paused" | "completed";
  readonly result: "side1" | "side2" | "tie" | null;
  readonly startedAt: string;
  readonly pausedAt: string | null;
  readonly pausedReason: EligibilityReason | null;
  readonly completedAt: string | null;
  readonly publishedAt: string | null;
  readonly dismissedAt: string | null;
  readonly completionPublicTitleSide1: string | null;
  readonly completionPublicTitleSide2: string | null;
  readonly completionAdminTitleSide1: string | null;
  readonly completionAdminTitleSide2: string | null;
}
interface CompetitorRow {
  readonly side: 1 | 2;
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly beverageId: string;
  readonly tapNumber: number;
  readonly adminBeverageTitle: string;
  readonly voteCount: number;
  readonly finalVoteCount: number | null;
}
interface EligibilityRow {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly beverageId: string;
  readonly tapNumber: number;
  readonly adminBeverageTitle: string;
}

const titleSql =
  "COALESCE(CASE WHEN b.ownership_type = 'custom' THEN cp.name WHEN po.override_name_present = 1 THEN po.name ELSE sp.name END, 'Unknown Beverage')";
const eligibleSql = `SELECT a.id AS assignmentId, a.tap_id AS tapId, a.fill_id AS fillId, f.beverage_id AS beverageId, t.tap_number AS tapNumber, ${titleSql} AS adminBeverageTitle FROM tap_assignment_lifecycles a JOIN taps t ON t.id = a.tap_id JOIN fills f ON f.id = a.fill_id LEFT JOIN beverages b ON b.id = f.beverage_id LEFT JOIN custom_beverage_profiles cp ON cp.beverage_id = b.id LEFT JOIN brewfather_source_profiles sp ON sp.beverage_id = b.id LEFT JOIN brewfather_presentation_overrides po ON po.beverage_id = b.id WHERE a.ended_at IS NULL AND f.ended_at IS NULL AND t.enabled = 1 AND t.retired_at IS NULL`;
const warColumns =
  "id, status, result, started_at AS startedAt, paused_at AS pausedAt, paused_reason AS pausedReason, completed_at AS completedAt, published_at AS publishedAt, dismissed_at AS dismissedAt, completion_public_title_side1 AS completionPublicTitleSide1, completion_public_title_side2 AS completionPublicTitleSide2, completion_admin_title_side1 AS completionAdminTitleSide1, completion_admin_title_side2 AS completionAdminTitleSide2";
const competitorColumns =
  "side, assignment_id AS assignmentId, tap_id AS tapId, fill_id AS fillId, beverage_id AS beverageId, tap_number AS tapNumber, admin_beverage_title AS adminBeverageTitle, vote_count AS voteCount, final_vote_count AS finalVoteCount";

function getEligibility(
  database: DatabaseExecutor,
  competitor: CompetitorRow,
): { eligible: boolean; reason: EligibilityReason | null } {
  const row = database
    .prepare<
      [string, string],
      {
        readonly enabled: number;
        readonly retiredAt: string | null;
        readonly assignmentId: string | null;
        readonly fillId: string | null;
        readonly fillEndedAt: string | null;
      }
    >(
      "SELECT t.enabled, t.retired_at AS retiredAt, a.id AS assignmentId, a.fill_id AS fillId, f.ended_at AS fillEndedAt FROM taps t LEFT JOIN tap_assignment_lifecycles a ON a.id = ? LEFT JOIN fills f ON f.id = a.fill_id WHERE t.id = ?",
    )
    .get(competitor.assignmentId, competitor.tapId);
  if (!row) return { eligible: false, reason: "original_assignment_ended_or_replaced" };
  if (row.retiredAt !== null) return { eligible: false, reason: "retired" };
  if (row.enabled !== 1) return { eligible: false, reason: "disabled" };
  if (row.assignmentId !== competitor.assignmentId || row.fillId !== competitor.fillId)
    return { eligible: false, reason: "original_assignment_ended_or_replaced" };
  if (row.fillEndedAt !== null) return { eligible: false, reason: "fill_ended_or_missing" };
  const current = database
    .prepare<[string], { readonly id: string }>(
      "SELECT id FROM tap_assignment_lifecycles WHERE tap_id = ? AND ended_at IS NULL",
    )
    .get(competitor.tapId);
  return current?.id === competitor.assignmentId
    ? { eligible: true, reason: null }
    : { eligible: false, reason: "original_assignment_ended_or_replaced" };
}
function competitors(database: DatabaseExecutor, warId: string): CompetitorRow[] {
  return database
    .prepare<[string], CompetitorRow>(
      `SELECT ${competitorColumns} FROM tap_war_competitors WHERE war_id = ? ORDER BY side`,
    )
    .all(warId);
}
function map(database: DatabaseExecutor, war: WarRow): TapWar {
  const rows = competitors(database, war.id);
  if (rows.length !== 2 || rows[0]?.side !== 1 || rows[1]?.side !== 2)
    throw new Error("Tap War competitor invariant violated");
  return {
    ...war,
    competitors: rows.map((row) => ({ ...row, eligibility: getEligibility(database, row) })) as [
      TapWarCompetitor,
      TapWarCompetitor,
    ],
  };
}
export function listEligible(database: DatabaseExecutor): EligibleParticipant[] {
  return database.prepare<[], EligibilityRow>(`${eligibleSql} ORDER BY t.tap_number`).all();
}
export function eligibleByAssignment(
  database: DatabaseExecutor,
  assignmentId: string,
): EligibleParticipant | undefined {
  return database
    .prepare<[string], EligibilityRow>(`${eligibleSql} AND a.id = ?`)
    .get(assignmentId);
}
export function getWar(database: DatabaseExecutor, id: string): TapWar | undefined {
  const row = database
    .prepare<[string], WarRow>(`SELECT ${warColumns} FROM tap_wars WHERE id = ?`)
    .get(id);
  return row === undefined ? undefined : map(database, row);
}
export function currentWar(database: DatabaseExecutor): TapWar | undefined {
  const row = database
    .prepare<[], WarRow>(`SELECT ${warColumns} FROM tap_wars WHERE status IN ('active', 'paused')`)
    .get();
  return row === undefined ? undefined : map(database, row);
}
export function publishedWar(database: DatabaseExecutor): TapWar | undefined {
  const row = database
    .prepare<[], WarRow>(
      `SELECT ${warColumns} FROM tap_wars WHERE status = 'completed' AND published_at IS NOT NULL AND dismissed_at IS NULL`,
    )
    .get();
  return row === undefined ? undefined : map(database, row);
}
export function completedHistory(database: DatabaseExecutor): TapWar[] {
  return database
    .prepare<[], WarRow>(
      `SELECT ${warColumns} FROM tap_wars WHERE status = 'completed' ORDER BY completed_at DESC, id DESC`,
    )
    .all()
    .map((row) => map(database, row));
}

export function pauseActiveWar(
  database: DatabaseExecutor,
  warId: string,
  at: string,
  reason: EligibilityReason,
): boolean {
  return (
    database
      .prepare<[string, EligibilityReason, string, string]>(
        "UPDATE tap_wars SET status = 'paused', paused_at = ?, paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(at, reason, at, warId).changes === 1
  );
}

export function resumePausedWar(database: DatabaseExecutor, warId: string, at: string): boolean {
  return (
    database
      .prepare<[string, string]>(
        "UPDATE tap_wars SET status = 'active', paused_at = NULL, paused_reason = NULL, updated_at = ? WHERE id = ? AND status = 'paused'",
      )
      .run(at, warId).changes === 1
  );
}

export function dismissPublishedWars(database: DatabaseExecutor, at: string): number {
  return database
    .prepare<[string, string]>(
      "UPDATE tap_wars SET dismissed_at = ?, updated_at = ? WHERE status = 'completed' AND published_at IS NOT NULL AND dismissed_at IS NULL",
    )
    .run(at, at).changes;
}

export function dismissPublishedWar(
  database: DatabaseExecutor,
  warId: string,
  at: string,
): boolean {
  return (
    database
      .prepare<[string, string, string]>(
        "UPDATE tap_wars SET dismissed_at = ?, updated_at = ? WHERE id = ? AND dismissed_at IS NULL",
      )
      .run(at, at, warId).changes === 1
  );
}

export function insertStartedWar(
  database: DatabaseExecutor,
  input: {
    readonly id: string;
    readonly at: string;
    readonly first: EligibleParticipant;
    readonly second: EligibleParticipant;
  },
): void {
  database
    .prepare<[string, string, string, string]>(
      "INSERT INTO tap_wars (id, status, started_at, created_at, updated_at) VALUES (?, 'active', ?, ?, ?)",
    )
    .run(input.id, input.at, input.at, input.at);
  const insert = database.prepare<[string, number, string, string, string, string, number, string]>(
    "INSERT INTO tap_war_competitors (war_id, side, assignment_id, tap_id, fill_id, beverage_id, tap_number, admin_beverage_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [side, competitor] of [
    [1, input.first],
    [2, input.second],
  ] as const) {
    insert.run(
      input.id,
      side,
      competitor.assignmentId,
      competitor.tapId,
      competitor.fillId,
      competitor.beverageId,
      competitor.tapNumber,
      competitor.adminBeverageTitle,
    );
  }
}

export function incrementWarVote(database: DatabaseExecutor, warId: string, side: 1 | 2): boolean {
  return (
    database
      .prepare<[string, number]>(
        "UPDATE tap_war_competitors SET vote_count = vote_count + 1 WHERE war_id = ? AND side = ?",
      )
      .run(warId, side).changes === 1
  );
}

export function freezeWarVoteCount(
  database: DatabaseExecutor,
  warId: string,
  side: 1 | 2,
  count: number,
): boolean {
  return (
    database
      .prepare<[number, string, number]>(
        "UPDATE tap_war_competitors SET final_vote_count = ? WHERE war_id = ? AND side = ?",
      )
      .run(count, warId, side).changes === 1
  );
}

export function completeWar(
  database: DatabaseExecutor,
  input: {
    readonly warId: string;
    readonly at: string;
    readonly result: "side1" | "side2" | "tie";
    readonly publicTitleSide1: string;
    readonly publicTitleSide2: string;
    readonly adminTitleSide1: string;
    readonly adminTitleSide2: string;
  },
): boolean {
  return (
    database
      .prepare<[string, string, string, string, string, string, string, string, string]>(
        "UPDATE tap_wars SET status = 'completed', paused_at = NULL, paused_reason = NULL, result = ?, completed_at = ?, published_at = ?, completion_public_title_side1 = ?, completion_public_title_side2 = ?, completion_admin_title_side1 = ?, completion_admin_title_side2 = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.result,
        input.at,
        input.at,
        input.publicTitleSide1,
        input.publicTitleSide2,
        input.adminTitleSide1,
        input.adminTitleSide2,
        input.at,
        input.warId,
      ).changes === 1
  );
}
