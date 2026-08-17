import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export type FillState = "available" | "on_deck" | "on_tap" | "ended";

export interface Fill {
  readonly id: string;
  readonly beverageId: string;
  readonly kegId: string;
  readonly fillDate: string;
  readonly onDeckOrder: number | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FillSettings {
  readonly autoDeleteBeverageOnLastFill: boolean;
  readonly updatedAt: string;
}

export interface FillAssignmentLifecyclePort {
  hasActiveAssignment(fillId: string): boolean;
  /**
   * Close the active assignment, if any, and return its canonical identifiers.
   * The void branch keeps older TapService adapters source-compatible while
   * callers migrate to the richer transaction-local context.
   */
  closeForFillEnd(
    database: DatabaseExecutor,
    fillId: string,
    endedAt: string,
  ): FillAssignmentClosedContext | void;
}

export interface FillAssignmentClosedContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly endedAt: string;
}

export interface FillEndedContext {
  readonly fillId: string;
  readonly beverageId: string;
  readonly kegId: string;
  readonly assignmentId: string | null;
  readonly tapId: string | null;
  readonly occurredAt: string;
  readonly reason: "kicked" | "deleted";
}

export interface AdminFillView {
  readonly id: string;
  readonly beverageId: string;
  readonly beverageName: string;
  readonly beverageType: string;
  readonly beverageStyle: string | null;
  readonly beverageAbv: number | null;
  /** Safe admin-only presentation fields for the Keg Room card projection. */
  readonly fillGlass?: string | null;
  readonly displayColor?: string | null;
  readonly kegId: string;
  readonly kegNumber: number;
  readonly kegLabel: string | null;
  readonly tapId?: string | null;
  readonly tapNumber?: number | null;
  readonly fillDate: string;
  readonly state: FillState;
  readonly onDeckOrder: number | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicOnDeckItem {
  readonly fillId: string;
  readonly order: number;
  readonly name: string;
  readonly style: string | null;
}

export type BrewfatherCompletionOutcome =
  | "not_applicable"
  | "not_requested"
  | "confirmation_required"
  | "already_terminal"
  | "completed"
  | "failed";

export interface KickFillResult {
  readonly fill: AdminFillView;
  readonly brewfatherOutcome: BrewfatherCompletionOutcome;
  readonly brewfatherMessage?: string;
}

export interface FillDeletionImpact {
  readonly fillId: string;
  readonly fills: number;
  readonly isLastFillForBeverage: boolean;
  readonly beverageAutoDeleted: boolean;
  readonly beverageId: string;
  readonly kegId: string;
  readonly impacts: readonly { readonly code: string; readonly count: number }[];
}

export interface CreateFillInput {
  readonly id?: string;
  readonly beverageId: string;
  readonly kegId: string;
  readonly fillDate?: string;
}

export interface KickFillInput {
  readonly reason?: string | null;
}

export interface ReorderOnDeckInput {
  readonly fillIds: readonly string[];
}

export interface UpdateFillSettingsInput {
  readonly autoDeleteBeverageOnLastFill: boolean;
}

export interface DeleteFillInput {
  readonly reason?: string | null;
  /** Exact visible Filled Keg label, required by the canonical admin UI. */
  readonly confirmation?: string | null;
}

export type AdminFillPageState = "active" | "available" | "on_deck" | "on_tap" | "ended" | "all";
export type AdminFillPageSort = "state" | "name" | "fill_date" | "updated" | "keg";

export interface AdminFillPageQuery {
  readonly q?: unknown;
  readonly state?: unknown;
  readonly sort?: unknown;
  readonly page?: unknown;
}

export interface AdminFillPage {
  readonly items: readonly AdminFillView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly query: string;
  readonly state: AdminFillPageState;
  readonly sort: AdminFillPageSort;
}

export interface FillActorOptions {
  readonly actorType?: "admin" | "operator" | "system" | "machine";
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}
