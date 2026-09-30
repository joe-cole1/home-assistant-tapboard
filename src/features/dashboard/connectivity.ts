import type { OutboundDestination } from "../outbound/types.ts";
import type { PublicHeaderView } from "./types.ts";

type Connectivity = PublicHeaderView["connectivity"];

export function requiredDestinationConnectivity(
  destination: OutboundDestination,
): Connectivity | undefined {
  if (!destination.required || destination.retiredAt !== null) return undefined;
  const missingSecret =
    destination.disabledReason === "token_missing" ||
    destination.disabledReason === "secret_missing";
  // Deliberately disabled integrations are excluded; an automatic credential
  // failure must not remove a required integration from the health summary.
  if (!destination.enabled) return missingSecret ? "disconnected" : undefined;

  const config = destination.currentVersion?.config;
  if (
    config === undefined ||
    config.secretHeaders.some((header) => !header.configured || header.available === false) ||
    (config.transport === "home_assistant"
      ? !config.authConfigured || !config.authAvailable
      : !config.endpointConfigured || !config.endpointAvailable)
  ) {
    return "disconnected";
  }
  if (destination.state === "needs_attention" || destination.state === "degraded")
    return "disconnected";
  if (destination.state === "healthy" && destination.lastSuccessAt !== null) return "healthy";
  return "degraded";
}

export function aggregateConnectivity(checks: readonly Connectivity[]): Connectivity {
  if (checks.length === 0 || checks.includes("disconnected")) return "disconnected";
  return checks.includes("degraded") ? "degraded" : "healthy";
}

export const CONNECTIVITY_LABELS: Readonly<Record<Connectivity, string>> = {
  healthy: "Connected",
  degraded: "Partial",
  disconnected: "Disconnected",
};
