import { randomUUID } from "node:crypto";

import { isApplicationError, type ApplicationErrorCategory } from "./errors.ts";
import type { Logger } from "./logging.ts";

const STATUS_BY_CATEGORY: Readonly<Record<ApplicationErrorCategory, number>> = {
  validation: 400,
  too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export function errorStatus(category: ApplicationErrorCategory): number {
  return STATUS_BY_CATEGORY[category];
}

export interface FailureReport {
  readonly category: ApplicationErrorCategory;
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly expected: boolean;
  readonly reference?: string;
}

export function reportFailure(
  error: unknown,
  options: { readonly operation: string; readonly logger?: Logger },
): FailureReport {
  const expected = isApplicationError(error);
  const category = expected ? error.category : "internal";
  const code = expected ? error.code : "internal.unexpected";
  const status = errorStatus(category);
  const message = expected ? error.clientMessage : "An unexpected error occurred.";
  const operational = category === "unavailable" || category === "internal";
  const reference = operational ? randomUUID() : undefined;
  if (operational) {
    try {
      const context = {
        operation: options.operation,
        code,
        category,
        reference,
        httpStatus: status,
        ...(expected &&
        typeof error.details?.providerStatus === "number" &&
        Number.isInteger(error.details.providerStatus) &&
        error.details.providerStatus >= 100 &&
        error.details.providerStatus <= 599
          ? { providerStatus: error.details.providerStatus }
          : {}),
        ...(expected &&
        typeof error.details?.retryAfterMs === "number" &&
        Number.isFinite(error.details.retryAfterMs) &&
        error.details.retryAfterMs >= 0 &&
        error.details.retryAfterMs <= 3_600_000
          ? { retryAfterMs: error.details.retryAfterMs }
          : {}),
      };
      if (category === "unavailable") options.logger?.warn("Operation failed", context);
      else options.logger?.error("Operation failed", context);
    } catch {
      // Diagnostics must not alter the action or response when a custom logger fails.
    }
  }
  return {
    category,
    code,
    status,
    message,
    expected,
    ...(reference === undefined ? {} : { reference }),
  };
}

export function adminFailureMessage(report: FailureReport, fallback: string): string {
  const message = report.expected ? report.message : fallback;
  if (report.reference === undefined) return message;
  const suffix = ` Reference: ${report.reference}.`;
  // Form redirects cap messages at 240 characters; always retain the full reference.
  return `${message.slice(0, 240 - suffix.length)}${suffix}`;
}
