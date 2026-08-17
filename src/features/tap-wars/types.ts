import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export type TapWarStatus = "active" | "paused" | "completed";
export type TapWarResult = "side1" | "side2" | "tie";
export type EligibilityReason =
  "disabled" | "retired" | "original_assignment_ended_or_replaced" | "fill_ended_or_missing";
export interface TapWarEligibility {
  readonly eligible: boolean;
  readonly reason: EligibilityReason | null;
}
export interface TapWarCompetitor {
  readonly side: 1 | 2;
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly beverageId: string;
  readonly tapNumber: number;
  readonly adminBeverageTitle: string;
  /** Last known safe public title for the original assignment. */
  readonly publicTitleFallback: string;
  readonly voteCount: number;
  readonly finalVoteCount: number | null;
  readonly eligibility: TapWarEligibility;
}
export interface TapWar {
  readonly id: string;
  readonly status: TapWarStatus;
  readonly result: TapWarResult | null;
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
  readonly competitors: readonly [TapWarCompetitor, TapWarCompetitor];
}
export interface EligibleParticipant {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly beverageId: string;
  readonly tapNumber: number;
  readonly adminBeverageTitle: string;
}
export interface TapWarActorOptions {
  readonly actorType?: "admin" | "operator" | "system" | "machine";
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}
export interface TapWarLifecyclePort {
  pauseForAssignmentClose(database: DatabaseExecutor, assignmentId: string, at: string): void;
  pauseForTapUnavailable(database: DatabaseExecutor, tapId: string, at: string): void;
}
/**
 * Application-composed authority for the current original assignment's safe
 * public title. It may resolve a disabled Tap when the exact original
 * assignment is still active; it returns null when that assignment is
 * unavailable, replaced, retired, or otherwise not servable.
 */
export type PublicTitleResolver = (tapId: string, assignmentId: string) => string | null;
export interface TapWarPercentages {
  readonly side1: number;
  readonly side2: number;
}

/** Purpose-built, identity-safe public projection. */
export interface PublicTapWarSideView {
  readonly side: 1 | 2;
  readonly tapId: string;
  readonly tapNumber: number;
  readonly title: string;
  /** Safe card-association flag; never exposes the underlying assignment ID. */
  readonly isCardParticipant: boolean;
  readonly voteCount: number;
  readonly percentage: number | null;
  readonly meterLabel: string;
}

export interface PublicTapWarView {
  readonly id: string;
  readonly status: TapWarStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly side1: PublicTapWarSideView;
  readonly side2: PublicTapWarSideView;
  readonly totalVotes: number;
  readonly result: TapWarResult | null;
  readonly winnerSide: 1 | 2 | null;
  readonly leaderSide: 1 | 2 | null;
  readonly isTie: boolean;
  readonly canVote: boolean;
  readonly votePath: string;
  readonly statusLabel: string;
}

/** Safe selector-preview data for the authenticated Tap Wars page. */
export interface PublicTapWarEligiblePreview {
  readonly tapId: string;
  readonly tapNumber: number;
  readonly title: string;
}
