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
    readonly fillId: string;
    readonly beverageName: string;
    readonly beverageType: string;
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
}

export type { FillAssignmentLifecyclePort };
