import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { EventEnvelope, EventType } from "../events/types.ts";
import type { TransportAttemptResult } from "./transport-types.ts";

/** The two provider-neutral outbound transports supported by v2. */
export type OutboundTransport = "home_assistant" | "webhook";

export const OUTBOUND_TRANSPORTS = ["home_assistant", "webhook"] as const;

export type OutboundFailureClass = "authentication" | "connectivity" | "unknown";
export type OutboundDestinationState =
  "healthy" | "degraded" | "disabled" | "unknown" | "failing" | "needs_attention";
export type OutboundIntegrationState = "healthy" | "degraded" | "disabled";

export interface OutboundHeader {
  readonly name: string;
  readonly value: string;
}

export interface OutboundSecretHeader {
  readonly name: string;
  /** Stable logical slot. The slot, not the secret value, is persisted in config. */
  readonly slot: string;
  readonly configured: boolean;
  readonly available?: boolean;
}

export interface OutboundUrlSummary {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number | null;
}

export interface HomeAssistantConfig {
  readonly transport: "home_assistant";
  readonly baseUrl: string;
  readonly urlSummary: OutboundUrlSummary;
  readonly authConfigured: boolean;
  readonly authAvailable: boolean;
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly OutboundSecretHeader[];
}

export interface WebhookConfig {
  readonly transport: "webhook";
  readonly payloadFormat: "standard" | "discord";
  readonly urlSummary: OutboundUrlSummary;
  readonly endpointConfigured: boolean;
  readonly endpointAvailable: boolean;
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly OutboundSecretHeader[];
}

export type OutboundConfig = HomeAssistantConfig | WebhookConfig;

export interface OutboundDestination {
  readonly id: string;
  readonly label: string;
  readonly transport: OutboundTransport;
  readonly enabled: boolean;
  readonly required: boolean;
  readonly retiredAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentVersion: OutboundDestinationVersion | null;
  readonly state: OutboundDestinationState;
  readonly failure: OutboundFailureSummary | null;
  readonly lastSuccessAt: string | null;
  readonly subscriptions: readonly EventType[];
}

export interface OutboundDestinationVersion {
  readonly id: string;
  readonly destinationId: string;
  readonly versionNumber: number;
  readonly createdAt: string;
  readonly config: OutboundConfig;
}

export interface OutboundFailureSummary {
  readonly code: string;
  readonly failureClass: OutboundFailureClass;
  readonly occurredAt: string;
  readonly ageMs: number;
}

export interface OutboundDestinationListItem extends OutboundDestination {
  readonly pendingCount: number;
  readonly retryCount: number;
  readonly terminalCount: number;
}

export interface OutboundDeliveryHistoryItem {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: EventType;
  readonly destinationId: string;
  readonly destinationVersionId: string;
  readonly state: "pending" | "leased" | "retry" | "terminal" | "succeeded" | "dismissed";
  readonly attemptCount: number;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string;
  readonly revision: number;
  readonly lastErrorCode: string | null;
  readonly envelopeBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

export interface CreateOutboundDestinationInput {
  readonly id?: string;
  readonly label: string;
  readonly transport: OutboundTransport;
  readonly required?: boolean;
  readonly enabled?: boolean;
  readonly subscriptions?: readonly EventType[];
  readonly baseUrl?: string;
  readonly webhookUrl?: string;
  readonly payloadFormat?: "standard" | "discord";
  readonly staticHeaders?: readonly OutboundHeader[];
  readonly secretHeaders?: readonly { readonly name: string; readonly slot?: string }[];
  readonly secret?: string;
}

export interface EditOutboundDestinationInput {
  readonly label?: string;
  readonly transport?: OutboundTransport;
  readonly required?: boolean;
  readonly subscriptions?: readonly EventType[];
  readonly baseUrl?: string;
  readonly webhookUrl?: string;
  readonly payloadFormat?: "standard" | "discord";
  readonly staticHeaders?: readonly OutboundHeader[];
  readonly secretHeaders?: readonly { readonly name: string; readonly slot?: string }[];
}

export interface OutboundHeaderSecretReplacement {
  readonly name: string;
  readonly value: string;
}

/** One complete Admin create submission, including write-only secret values. */
export interface CreateConfiguredOutboundDestinationInput extends CreateOutboundDestinationInput {
  readonly headerSecrets?: readonly OutboundHeaderSecretReplacement[];
}

/** One complete Admin edit submission, including final enabled state and write-only secrets. */
export interface UpdateConfiguredOutboundDestinationInput extends EditOutboundDestinationInput {
  readonly enabled: boolean;
  readonly token?: string;
  readonly headerSecrets?: readonly OutboundHeaderSecretReplacement[];
}

export interface OutboundDestinationPatch {
  readonly label?: string;
  readonly required?: boolean;
  readonly enabled?: boolean;
  readonly transport?: OutboundTransport;
  readonly subscriptions?: readonly EventType[];
  readonly baseUrl?: string;
  readonly webhookUrl?: string;
  readonly payloadFormat?: "standard" | "discord";
  readonly staticHeaders?: readonly OutboundHeader[];
  readonly secretHeaders?: readonly { readonly name: string; readonly slot?: string }[];
}

export interface OutboundStatusProjection {
  readonly state: OutboundDestinationState;
  readonly required: boolean;
  readonly enabled: boolean;
  readonly destinationIds: readonly string[];
  readonly degradedRequiredDestinationIds: readonly string[];
}

export interface OutboundAdmissionPort {
  admit(
    database: DatabaseExecutor,
    event: EventEnvelope | OutboundEventInput,
  ): OutboundAdmissionResult;
  assignmentOpened(
    database: DatabaseExecutor,
    context: AssignmentOpenedEventContext,
  ): OutboundAdmissionResult;
  assignmentClosed(
    database: DatabaseExecutor,
    context: AssignmentClosedEventContext,
    mappedReason?: "kicked" | "manual" | "deleted" | "other",
  ): OutboundAdmissionResult;
  pourCompleted(
    database: DatabaseExecutor,
    pour: CompletedPourEventContext,
  ): OutboundAdmissionResult;
  healthTransitioned(
    database: DatabaseExecutor,
    context: HealthTransitionEventContext,
  ): OutboundAdmissionResult;
  integrationStatusChanged(
    database: DatabaseExecutor,
    context: IntegrationStatusEventContext,
  ): OutboundAdmissionResult;
}

export interface OutboundEventInput {
  readonly event: EventEnvelope;
}

export interface AssignmentOpenedEventContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly occurredAt: string;
  readonly reason: "assigned" | "moved";
}

export interface AssignmentClosedEventContext {
  readonly assignmentId: string;
  readonly tapId: string;
  readonly fillId: string;
  readonly occurredAt: string;
  readonly reason: "unassigned" | "moved" | "fill_ended";
}

export interface CompletedPourEventContext {
  readonly id?: string;
  readonly effectKey?: string;
  readonly fillId: string;
  readonly tapId: string;
  readonly assignmentId?: string | null;
  readonly epochId?: string | null;
  readonly canonicalVolumeMl: number;
  readonly completedAt: string;
}

export interface HealthEvaluationLike {
  readonly state: string;
  readonly severity: string;
  readonly evidence?: unknown;
  readonly reason?: string;
}

export interface HealthTransitionEventContext {
  readonly tapId: string;
  readonly checkId:
    | "low_keg"
    | "scale_availability"
    | "suspected_leak"
    | "serving_temperature"
    | "line_cleaning_due";
  readonly previousState?: string | null;
  readonly previousSeverity?: string | null;
  readonly current: HealthEvaluationLike;
  readonly occurredAt: string;
}

export interface IntegrationStatusEventContext {
  readonly destinationId?: string | null;
  readonly integrationType: string;
  readonly previousState?: OutboundIntegrationState | null;
  readonly state: OutboundIntegrationState;
  readonly reasonCode?: string | null;
  readonly occurredAt: string;
  readonly coalescingKey?: string;
}

export type OutboundAdmissionResult =
  | { readonly status: "no_targets" }
  | {
      readonly status: "queued";
      readonly eventId: string;
      readonly pruned: number;
      readonly coalesced: boolean;
    }
  | {
      readonly status: "not_queued_capacity";
      readonly pruned: number;
      readonly coalesced: boolean;
    };

export interface OutboundSecretStore {
  listDescriptors?(): readonly {
    readonly integrationType: string;
    readonly recordId: string;
    readonly fieldName: string;
    readonly configured: boolean;
    readonly available: boolean;
  }[];
  list?(): readonly {
    readonly integrationType: string;
    readonly recordId: string;
    readonly fieldName: string;
    readonly configured: boolean;
    readonly available: boolean;
  }[];
  upsert(
    integrationType: string,
    recordId: string,
    fieldName: string,
    plaintext: string,
    options?: { readonly now?: () => Date },
  ): unknown;
  remove(
    integrationType: string,
    recordId: string,
    fieldName: string,
    options?: { readonly now?: () => Date },
  ): boolean;
  revealPrivileged(integrationType: string, recordId: string, fieldName: string): string;
}

export interface OutboundLifecycleCallbacks {
  readonly onDisabled?: (destinationId: string) => void;
  readonly onEnabled?: (destinationId: string) => void;
  /** Close/re-authenticate a destination after a credential replacement. */
  readonly onCredentialsChanged?: (destinationId: string) => void;
  readonly onRetired?: (destinationId: string) => void;
}

export interface OutboundServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly secrets?: OutboundSecretStore;
  readonly lifecycle?: OutboundLifecycleCallbacks;
}

export interface OutboundTransportSendInput {
  readonly destination: OutboundDestination;
  readonly version: OutboundDestinationVersion;
  readonly envelope: EventEnvelope;
  readonly secretHeaders: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly endpoint?: string;
  readonly payloadFormat?: "standard" | "discord";
}

export interface OutboundTransportOutcome {
  readonly outcome: "success" | "retry" | "failure";
  readonly errorCode?: string;
  readonly failureClass?: OutboundFailureClass;
}

export interface OutboundTransportRouter {
  send(
    input: OutboundTransportSendInput,
  ):
    | TransportAttemptResult
    | OutboundTransportOutcome
    | PromiseLike<TransportAttemptResult | OutboundTransportOutcome>;
  /** Optional HA-only startup/re-enable authentication probe. Never used for webhooks. */
  ensureHealthy?(
    input: Omit<OutboundTransportSendInput, "envelope">,
  ):
    | TransportAttemptResult
    | OutboundTransportOutcome
    | PromiseLike<TransportAttemptResult | OutboundTransportOutcome>;
  connect?(
    input: Omit<OutboundTransportSendInput, "envelope">,
  ):
    | TransportAttemptResult
    | OutboundTransportOutcome
    | PromiseLike<TransportAttemptResult | OutboundTransportOutcome>;
  closeDestination?(destinationId: string): void;
  stop?(): void;
}

export interface OutboundWorkerClock {
  now(): Date;
  setInterval?(callback: () => void, delayMs: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface OutboundWorkerOptions {
  readonly database: DatabaseExecutor;
  readonly transports: OutboundTransportRouter;
  readonly secrets?: OutboundSecretStore;
  readonly owner?: string;
  readonly leaseTtlMs?: number;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: OutboundWorkerClock;
  readonly onError?: (error: unknown) => void;
  /** Called inside the short SQLite status transaction; it must not perform network I/O. */
  readonly onStatusChanged?: (
    database: DatabaseExecutor,
    context: IntegrationStatusEventContext,
  ) => void;
}
