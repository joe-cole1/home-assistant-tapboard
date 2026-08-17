import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { ActivityActorType } from "../activity/types.ts";
import type { FillAssignmentLifecyclePort } from "../fills/types.ts";

export interface Tap {
  readonly id: string;
  readonly tapNumber: number;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly firstUsedAt: string | null;
  readonly retiredAt: string | null;
  readonly gasType: string | null;
  readonly servingPressureKpa: number | null;
  readonly lineLengthMm: number | null;
  readonly lineDiameterMm: number | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TapAssignmentLifecycle {
  readonly id: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly assignedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly createdAt: string;
}

export interface ActiveAssignmentDetails {
  readonly id: string;
  readonly fillId: string;
  readonly beverageId: string;
  readonly beverageName: string;
  readonly beverageType: string;
  readonly beverageStyle: string | null;
  readonly beverageAbv: number | null;
  readonly kegId: string;
  readonly kegNumber: number;
  readonly kegLabel: string | null;
  readonly assignedAt: string;
}

export interface AdminTapView {
  readonly id: string;
  readonly tapNumber: number;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly isRetired: boolean;
  readonly isOccupied: boolean;
  readonly firstUsedAt: string | null;
  readonly retiredAt: string | null;
  readonly gasType: string | null;
  readonly servingPressureKpa: number | null;
  readonly lineLengthMm: number | null;
  readonly lineDiameterMm: number | null;
  readonly notes: string | null;
  readonly activeAssignment: ActiveAssignmentDetails | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicTapView {
  readonly tapNumber: number;
  readonly name: string | null;
  readonly activeFill: {
    readonly fillId: string | null;
    readonly beverageName: string | null;
    readonly beverageType: string | null;
    readonly beverageStyle: string | null;
    readonly beverageAbv: number | null;
  } | null;
}

export interface TapDeletionImpact {
  readonly tapId: string;
  readonly tapNumber: number;
  readonly canDelete: boolean;
  readonly reasonsCannotDelete: readonly string[];
  readonly firstUsedAt: string | null;
  readonly retiredAt: string | null;
  readonly activeAssignmentCount: number;
  readonly historicalAssignmentCount: number;
  readonly impacts: readonly { readonly code: string; readonly count: number }[];
}

export interface CreateTapInput {
  readonly id?: string;
  readonly tapNumber: number;
  readonly name?: string | null;
  readonly enabled?: boolean;
  readonly gasType?: string | null;
  readonly servingPressureKpa?: number | null;
  readonly lineLengthMm?: number | null;
  readonly lineDiameterMm?: number | null;
  readonly notes?: string | null;
}

export interface UpdateTapInput {
  readonly tapNumber?: number;
  readonly name?: string | null;
  readonly enabled?: boolean;
  readonly gasType?: string | null;
  readonly servingPressureKpa?: number | null;
  readonly lineLengthMm?: number | null;
  readonly lineDiameterMm?: number | null;
  readonly notes?: string | null;
  readonly acknowledgeTelemetryEndpointImpact?: boolean;
}

export interface AssignTapInput {
  readonly fillId: string;
}

export interface MoveTapInput {
  readonly targetTapId: string;
}

export interface RetireTapInput {
  readonly reason?: string | null;
}

export interface DeleteTapInput {
  readonly reason?: string | null;
  /** Exact visible label used by the authenticated Admin web confirmation. */
  readonly confirmation?: string | null;
}

export type AdminTapPageState = "all" | "assigned" | "unassigned" | "disabled" | "retired";

export interface AdminTapPageQuery {
  readonly q?: unknown;
  readonly state?: unknown;
  readonly page?: unknown;
}

/** Normalized query consumed by the bounded SQL Tap administration projection. */
export interface ValidatedAdminTapPageQuery {
  readonly q: string;
  readonly state: AdminTapPageState;
  readonly page: number;
}

/** Safe assignment summary used by the compact Admin Tap list. */
export interface AdminTapPageAssignment {
  readonly id: string;
  readonly fillId: string;
  readonly beverageId: string | null;
  readonly beverageName: string | null;
  readonly kegId: string | null;
  readonly kegNumber: number | null;
  readonly kegLabel: string | null;
  readonly assignedAt: string;
}

/** Bounded, non-privileged row returned by the Admin Tap list query. */
export interface AdminTapPageItem {
  readonly id: string;
  readonly tapNumber: number;
  readonly name: string | null;
  readonly enabled: boolean;
  readonly isRetired: boolean;
  readonly firstUsedAt: string | null;
  readonly retiredAt: string | null;
  readonly assignment: AdminTapPageAssignment | null;
  readonly updatedAt: string;
}

export interface AdminTapPage {
  readonly items: readonly AdminTapPageItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly query: string;
  readonly state: AdminTapPageState;
}

export interface AssignmentOpenedContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly occurredAt: string;
  readonly reason: "assigned" | "moved";
}

export interface AssignmentClosedContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly occurredAt: string;
  readonly reason: "unassigned" | "moved" | "fill_ended";
}

export interface AssignmentMysteryChangedContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly occurredAt: string;
}

/** Transaction-local notification emitted after a Tap row is inserted. */
export interface TapCreatedContext {
  readonly tapId: string;
  readonly occurredAt: string;
}

/** Transaction-local notification emitted after a Tap is persisted as retired. */
export interface TapRetiredContext {
  readonly tapId: string;
  readonly occurredAt: string;
}

export interface TapAssignmentExtensionPort {
  onAssignmentOpened(db: DatabaseExecutor, context: AssignmentOpenedContext): void;
  onAssignmentClosed(db: DatabaseExecutor, context: AssignmentClosedContext): void;
  /** Transaction-local notification after an assignment's Mystery settings change. */
  onAssignmentMysteryChanged?(db: DatabaseExecutor, context: AssignmentMysteryChangedContext): void;
  /** Optional for backwards-compatible extension ports that do not track Tap lifecycle. */
  onTapCreated?(
    db: DatabaseExecutor,
    tapId: TapCreatedContext["tapId"],
    occurredAt: TapCreatedContext["occurredAt"],
  ): void;
  /** Optional for backwards-compatible extension ports that do not track Tap lifecycle. */
  onTapRetired?(
    db: DatabaseExecutor,
    tapId: TapRetiredContext["tapId"],
    occurredAt: TapRetiredContext["occurredAt"],
  ): void;
  /** Transaction-local notification for an enabled Tap becoming unavailable. */
  onTapBecameUnavailable?(db: DatabaseExecutor, tapId: string, occurredAt: string): void;
}

export interface AssignmentOperationResult {
  readonly tap: AdminTapView;
  readonly assignment: TapAssignmentLifecycle;
  readonly requiresFreshBaseline: true;
}

export interface MoveOperationResult {
  readonly sourceTap: AdminTapView;
  readonly targetTap: AdminTapView;
  readonly closedAssignment: TapAssignmentLifecycle;
  readonly newAssignment: TapAssignmentLifecycle;
  readonly requiresFreshBaseline: true;
}

export interface UnassignOperationResult {
  readonly tap: AdminTapView;
  readonly closedAssignment: TapAssignmentLifecycle;
}

export interface TapActorOptions {
  readonly actorType?: ActivityActorType;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
}

export const MYSTERY_REVEAL_FIELDS = [
  "revealBeverageType",
  "revealStyle",
  "revealAbv",
  "revealIbu",
  "revealOg",
  "revealFg",
  "revealSrm",
  "revealDescription",
  "revealRecipe",
  "revealSensory",
  "revealHistory",
] as const;

export type MysteryRevealField = (typeof MYSTERY_REVEAL_FIELDS)[number];

export interface TapAssignmentMysteryConfig {
  readonly enabled: boolean;
  readonly revealBeverageType: boolean;
  readonly revealStyle: boolean;
  readonly revealAbv: boolean;
  readonly revealIbu: boolean;
  readonly revealOg: boolean;
  readonly revealFg: boolean;
  readonly revealSrm: boolean;
  readonly revealDescription: boolean;
  readonly revealRecipe: boolean;
  readonly revealSensory: boolean;
  readonly revealHistory: boolean;
}

export type UpdateTapAssignmentMysteryInput = TapAssignmentMysteryConfig;

export interface UpdateTapAssignmentMysteryResult {
  readonly config: TapAssignmentMysteryConfig;
  readonly changed: boolean;
}

export type { FillAssignmentLifecyclePort };
