export const EVENT_TYPES = [
  "fill.assigned",
  "fill.ended",
  "pour.completed",
  "keg.low",
  "health.transitioned",
  "integration.status_changed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventIdentifiers {
  readonly tap_id?: string | null;
  readonly fill_id?: string | null;
  readonly keg_id?: string | null;
  readonly beverage_id?: string | null;
}

export interface FillAssignedData {
  readonly assignment_id: string;
}

export interface FillEndedData {
  readonly reason: "kicked" | "manual" | "deleted" | "other";
}

export interface PourCompletedData {
  readonly volume_ml: number;
}

export interface KegLowData {
  readonly remaining_percent: number;
  readonly threshold_percent: number;
}

export interface HealthTransitionedData {
  readonly check_id:
    | "low_keg"
    | "scale_availability"
    | "suspected_leak"
    | "serving_temperature"
    | "line_cleaning_due";
  readonly state: "healthy" | "degraded" | "active";
  readonly severity: "none" | "info" | "warning" | "critical";
}

export interface IntegrationStatusChangedData {
  readonly integration_type: string;
  readonly state: "healthy" | "degraded" | "disabled";
  readonly reason_code: string | null;
}

export type EventData =
  | FillAssignedData
  | FillEndedData
  | PourCompletedData
  | KegLowData
  | HealthTransitionedData
  | IntegrationStatusChangedData;

export interface EventEnvelope {
  readonly schema_version: 1;
  readonly event_id: string;
  readonly event_type: EventType;
  readonly occurred_at: string;
  readonly identifiers: EventIdentifiers;
  readonly data: EventData;
}

export interface EventEnvelopeInput {
  readonly eventType?: string;
  readonly event_type?: string;
  readonly identifiers?: EventIdentifiers;
  readonly data: unknown;
  readonly eventId?: string;
  readonly event_id?: string;
  readonly occurredAt?: Date | string;
  readonly occurred_at?: Date | string;
  readonly coalescingKey?: string;
  readonly coalescing_key?: string;
}

export interface EventEnvelopeBuildOptions {
  readonly eventId?: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface EventDefinition {
  readonly eventType: EventType;
  readonly supersedable: boolean;
  readonly requiresCoalescingKey: boolean;
  readonly coalescingKeyMaxBytes: number;
  readonly requiresIdentifier: boolean;
}

export const EVENT_REGISTRY: Readonly<Record<EventType, EventDefinition>> = {
  "fill.assigned": {
    eventType: "fill.assigned",
    supersedable: false,
    requiresCoalescingKey: false,
    coalescingKeyMaxBytes: 0,
    requiresIdentifier: true,
  },
  "fill.ended": {
    eventType: "fill.ended",
    supersedable: false,
    requiresCoalescingKey: false,
    coalescingKeyMaxBytes: 0,
    requiresIdentifier: true,
  },
  "pour.completed": {
    eventType: "pour.completed",
    supersedable: false,
    requiresCoalescingKey: false,
    coalescingKeyMaxBytes: 0,
    requiresIdentifier: true,
  },
  "keg.low": {
    eventType: "keg.low",
    supersedable: false,
    requiresCoalescingKey: false,
    coalescingKeyMaxBytes: 0,
    requiresIdentifier: true,
  },
  "health.transitioned": {
    eventType: "health.transitioned",
    supersedable: false,
    requiresCoalescingKey: false,
    coalescingKeyMaxBytes: 0,
    requiresIdentifier: true,
  },
  "integration.status_changed": {
    eventType: "integration.status_changed",
    supersedable: true,
    requiresCoalescingKey: true,
    coalescingKeyMaxBytes: 128,
    requiresIdentifier: false,
  },
};

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function getEventDefinition(value: string): EventDefinition | undefined {
  return isEventType(value) ? EVENT_REGISTRY[value] : undefined;
}

export const lookupEventDefinition = getEventDefinition;
