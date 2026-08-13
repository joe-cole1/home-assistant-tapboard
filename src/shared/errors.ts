export type ApplicationErrorCategory =
  "validation" | "not_found" | "conflict" | "unavailable" | "internal";

export type SafeDetailValue = string | number | boolean | null;
export type SafeErrorDetails = Readonly<Record<string, SafeDetailValue>>;

const OBVIOUS_SECRET_KEY =
  /(password|pin|secret|token|api[-_]?key|authorization|cookie|session|credential)/i;

export function isObviousSecretKey(key: string): boolean {
  return OBVIOUS_SECRET_KEY.test(key);
}

export function redactSafeErrorDetails(details: SafeErrorDetails): SafeErrorDetails {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      isObviousSecretKey(key) ? "[REDACTED]" : value,
    ]),
  );
}

export interface ApplicationErrorOptions {
  readonly category: ApplicationErrorCategory;
  readonly code: string;
  readonly clientMessage: string;
  readonly details?: SafeErrorDetails;
  readonly cause?: unknown;
}

export class ApplicationError extends Error {
  readonly category: ApplicationErrorCategory;
  readonly code: string;
  readonly clientMessage: string;
  readonly details?: SafeErrorDetails;

  constructor(options: ApplicationErrorOptions) {
    super(options.clientMessage, { cause: options.cause });
    this.name = "ApplicationError";
    this.category = options.category;
    this.code = options.code;
    this.clientMessage = options.clientMessage;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}
