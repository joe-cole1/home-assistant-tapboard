import type { EventData, EventEnvelope, EventIdentifiers } from "../events/types.ts";

/** The only outcomes a delivery adapter may expose to the outbox worker. */
export type TransportOutcome = "success" | "retryable_failure" | "permanent_failure";

/**
 * A bounded, log-safe result.  Adapters deliberately do not return provider
 * error messages or response bodies: those values routinely contain secrets,
 * URLs, or unbounded remote content.
 */
export interface TransportAttemptResult {
  readonly outcome: TransportOutcome;
  readonly errorCode?: string;
  readonly status?: number;
}
export type DeliveryAttemptResult = TransportAttemptResult;
export type TransportResult = TransportAttemptResult;

export interface PublicEventContext {
  readonly tapNumber?: number;
  readonly title?: string;
}

/**
 * Formatter context is intentionally a function over public projections.  A
 * formatter must never receive TapService, AdminTapView, or persistence rows.
 */
export type PublicEventContextResolver = (
  identifiers: EventIdentifiers,
  data: EventData,
) => PublicEventContext | undefined;

export type EventContextResolver = PublicEventContextResolver;

export type EventEnvelopeInput = EventEnvelope | string;

export const MAX_TRANSPORT_ERROR_CODE_BYTES = 64;
export const MAX_TRANSPORT_ERROR_STATUS = 599;

const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Return a safe machine code without exposing an upstream error string. */
export function boundedErrorCode(value: unknown, fallback = "transport_failed"): string {
  if (typeof value === "string" && SAFE_ERROR_CODE.test(value)) return value;
  return SAFE_ERROR_CODE.test(fallback) ? fallback : "transport_failed";
}

/** Keep provider status useful while preventing arbitrary numeric output. */
export function boundedStatus(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 100 ||
    value > MAX_TRANSPORT_ERROR_STATUS
  ) {
    return undefined;
  }
  return value;
}

export function successResult(status?: number): TransportAttemptResult {
  const bounded = boundedStatus(status);
  return bounded === undefined ? { outcome: "success" } : { outcome: "success", status: bounded };
}

export function failureResult(
  outcome: "retryable_failure" | "permanent_failure",
  errorCode: unknown,
  status?: unknown,
): TransportAttemptResult {
  const bounded = boundedStatus(status);
  return bounded === undefined
    ? { outcome, errorCode: boundedErrorCode(errorCode) }
    : { outcome, errorCode: boundedErrorCode(errorCode), status: bounded };
}
