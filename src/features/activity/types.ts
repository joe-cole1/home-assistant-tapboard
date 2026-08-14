export const ACTIVITY_CATEGORIES = [
  "security",
  "admin",
  "domain",
  "integration",
  "outbox",
  "system",
] as const;

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_ACTIONS = {
  security: [
    "auth_login_succeeded",
    "auth_login_failed",
    "auth_throttled",
    "credential_changed",
    "session_revoked",
    "sessions_revoked",
  ],
  admin: ["configuration_changed"],
  domain: ["entity_changed", "transition", "deletion"],
  integration: [
    "secret_configured",
    "secret_removed",
    "secret_rotation_completed",
    "api_key_created",
    "api_key_revoked",
    "api_key_rotated",
    "status_degraded",
    "status_recovered",
  ],
  outbox: ["capacity_degraded", "capacity_recovered", "delivery_terminal"],
  system: ["operator_pin_reset"],
} as const satisfies Readonly<Record<ActivityCategory, readonly string[]>>;

type ActionValues = (typeof ACTIVITY_ACTIONS)[ActivityCategory][number];
export type ActivityAction = ActionValues;

export type ActivityActorType = "admin" | "operator" | "system" | "machine";

export type ActivityScalar = string | number | boolean | null;
export type ActivityDetails = Readonly<Record<string, ActivityScalar>>;

export interface ActivityInput {
  readonly category: string;
  readonly action: string;
  readonly actorType: string;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly details?: ActivityDetails;
  readonly id?: string;
  readonly occurredAt?: Date | string;
}

export interface ActivityRecord {
  readonly id: string;
  readonly category: ActivityCategory;
  readonly action: ActivityAction;
  readonly actorType: ActivityActorType;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly details?: ActivityDetails;
  readonly occurredAt: string;
}

export interface ActivityListOptions {
  readonly limit?: number;
  readonly category?: ActivityCategory;
  readonly action?: ActivityAction;
  readonly before?: Date | string;
  readonly after?: Date | string;
}

export interface ActivityRetention {
  readonly retentionDays: number;
  readonly updatedAt: string;
}

export interface ActivityClockOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface DeletionImpact {
  readonly code: string;
  readonly count: number;
}

export interface DeletionAuditInput {
  readonly entityType: string;
  readonly entityId: string;
  readonly actorType: string;
  readonly actorId?: string;
  readonly reason?: string;
  readonly impacts: readonly DeletionImpact[];
  readonly id?: string;
  readonly deletedAt?: Date | string;
}

export interface DeletionAuditRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly entityType: string;
  readonly entityId: string;
  readonly actorType: ActivityActorType;
  readonly actorId?: string;
  readonly reason?: string;
  readonly impacts: readonly DeletionImpact[];
  readonly deletedAt: string;
}

export const ACTIVITY_REGISTRY: Readonly<Record<ActivityCategory, readonly ActivityAction[]>> =
  ACTIVITY_ACTIONS;

export function isActivityCategory(value: string): value is ActivityCategory {
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(value);
}

export function isActivityAction(value: string): value is ActivityAction {
  return Object.values(ACTIVITY_ACTIONS).some((actions) =>
    (actions as readonly string[]).includes(value),
  );
}

export function isValidActivityPair(category: string, action: string): action is ActivityAction {
  if (!isActivityCategory(category)) return false;
  return (ACTIVITY_ACTIONS[category] as readonly string[]).includes(action);
}

export const isActivityCategoryActionPair = isValidActivityPair;
