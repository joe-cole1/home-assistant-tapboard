import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export type ActorType = "admin" | "operator" | "system" | "machine";

export interface PhysicalKeg {
  readonly id: string;
  readonly kegNumber: number;
  readonly label: string | null;
  readonly capacityMl: number;
  readonly currentTareG: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface KegTareHistoryRecord {
  readonly id: string;
  readonly kegId: string;
  readonly previousTareG: number | null;
  readonly newTareG: number;
  readonly recordedAt: string;
  readonly reason: string | null;
  readonly actorType: ActorType;
  readonly actorId: string | null;
}

export interface KegMaintenanceRecord {
  readonly id: string;
  readonly kegId: string;
  readonly maintenanceType: string;
  readonly notes: string | null;
  readonly recordedAt: string;
  readonly actorType: ActorType;
  readonly actorId: string | null;
}

export interface KegDeletionImpact {
  readonly kegId: string;
  readonly kegNumber: number;
  readonly kegs: number;
  readonly tareHistoryRecords: number;
  readonly maintenanceRecords: number;
  readonly impacts: readonly [
    { readonly code: "kegs"; readonly count: number },
    { readonly code: "keg_tare_history"; readonly count: number },
    { readonly code: "keg_maintenance_records"; readonly count: number },
  ];
}

export interface CreateKegInput {
  readonly id?: string;
  readonly kegNumber: number;
  readonly label?: string | null;
  readonly capacityMl: number;
  readonly currentTareG?: number;
  readonly tareWeightG?: number;
  readonly isActive?: boolean;
}

export interface UpdateKegInput {
  readonly kegNumber?: number;
  readonly label?: string | null;
  readonly capacityMl?: number;
  readonly currentTareG?: number;
  readonly tareWeightG?: number;
  readonly isActive?: boolean;
  readonly reason?: string | null;
}

export interface RecordMaintenanceInput {
  readonly maintenanceType: string;
  readonly notes?: string | null;
  readonly recordedAt?: string;
}

export interface DeleteKegInput {
  readonly reason?: string | null;
}

export interface KegActorOptions {
  readonly actorType?: ActorType;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface KegCorrectionEvent {
  readonly kegId: string;
  readonly previousCapacityMl: number;
  readonly newCapacityMl: number;
  readonly previousTareG: number;
  readonly newTareG: number;
}

export type KegCorrectionHook = (database: DatabaseExecutor, event: KegCorrectionEvent) => void;

export interface AdminKegSummaryView {
  readonly id: string;
  readonly kegNumber: number;
  readonly label: string | null;
  readonly capacityMl: number;
  readonly currentTareG: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminTareHistoryView {
  readonly id: string;
  readonly previousTareG: number | null;
  readonly newTareG: number;
  readonly recordedAt: string;
  readonly reason: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
}

export interface AdminMaintenanceView {
  readonly id: string;
  readonly maintenanceType: string;
  readonly notes: string | null;
  readonly recordedAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
}

export interface AdminKegDetailView extends AdminKegSummaryView {
  readonly tareHistory: readonly AdminTareHistoryView[];
  readonly maintenanceHistory: readonly AdminMaintenanceView[];
}

export interface AdminDeletionImpactView {
  readonly kegId: string;
  readonly kegNumber: number;
  readonly impacts: readonly { readonly code: string; readonly count: number }[];
}
