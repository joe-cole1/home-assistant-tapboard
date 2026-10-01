import { isApplicationError, type ApplicationErrorCategory } from "../../../shared/errors.ts";
import { BrewfatherError } from "./adapter.ts";

export interface BrewfatherFailure {
  readonly code: string;
  readonly category: ApplicationErrorCategory;
  readonly message: string;
  readonly providerStatus: number | null;
  readonly retryAfterMs: number | null;
}

const MESSAGES = {
  auth: "Brewfather rejected the User ID or API key. Check both credentials and save again.",
  forbidden:
    "Brewfather denied access. Enable Read Batches permission on the API key for synchronization.",
  not_found: "The requested batch was not found on Brewfather.",
  rate_limited: "Brewfather rate limited requests. Wait before trying the refresh again.",
  timeout: "Brewfather did not respond in time. Try the refresh again later.",
  network: "Tapboard could not reach Brewfather. Check network connectivity and try again.",
  response_too_large: "Brewfather returned a response larger than Tapboard can safely process.",
  invalid_response: "Brewfather returned an invalid response. Try again later.",
  transient: "Brewfather is temporarily unavailable. Try again later.",
  configuration: "The Brewfather connection configuration is invalid. Check the saved settings.",
  disposed: "Brewfather integration is shut down.",
} as const;

export function describeBrewfatherFailure(
  error: unknown,
  operation: "sync" | "complete" = "sync",
): BrewfatherFailure {
  if (error instanceof BrewfatherError) {
    const providerStatus =
      Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599
        ? error.status
        : null;
    const retryAfterMs =
      error.retryAfterMs !== null && Number.isFinite(error.retryAfterMs)
        ? Math.max(0, Math.min(3_600_000, error.retryAfterMs))
        : null;
    return {
      code: `brewfather.${error.category}`,
      category: "unavailable",
      message: `${error.category === "forbidden" && operation === "complete" ? "Brewfather denied access. Enable Read Batches and Edit Batches permissions on the API key to complete a batch." : MESSAGES[error.category]}${providerStatus === null ? "" : ` (HTTP ${providerStatus})`}`,
      providerStatus,
      retryAfterMs,
    };
  }
  if (isApplicationError(error) && error.code === "secrets.not_found")
    return {
      code: "brewfather.key_missing",
      category: "unavailable",
      message: "No Brewfather API key is stored. Enter an API key in Connection settings.",
      providerStatus: null,
      retryAfterMs: null,
    };
  if (isApplicationError(error) && error.code === "secrets.unavailable")
    return {
      code: "secrets.key_unusable",
      category: "unavailable",
      message:
        "Tapboard cannot decrypt the stored Brewfather API key. Restore the matching server secret key or rotate stored credentials using the operator tool.",
      providerStatus: null,
      retryAfterMs: null,
    };
  if (isApplicationError(error))
    return {
      code: error.code,
      category: error.category,
      message: error.clientMessage,
      providerStatus: null,
      retryAfterMs: null,
    };
  return {
    code: "brewfather.unexpected",
    category: "internal",
    message: "Brewfather refresh failed unexpectedly. Try again or check the container logs.",
    providerStatus: null,
    retryAfterMs: null,
  };
}
