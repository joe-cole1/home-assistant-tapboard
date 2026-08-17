import { canonicalizeJson } from "../../../shared/canonical-json.ts";
import { serializeEventEnvelope } from "../../events/envelope.ts";
import type {
  EventData,
  EventEnvelope,
  EventIdentifiers,
  EventType,
  FillEndedData,
  HealthTransitionedData,
  IntegrationStatusChangedData,
  KegLowData,
  PourCompletedData,
} from "../../events/types.ts";
import type {
  EventEnvelopeInput,
  PublicEventContext,
  PublicEventContextResolver,
} from "../transport-types.ts";

const MAX_DISCORD_CONTENT_BYTES = 1_000;
const MAX_PUBLIC_TITLE_BYTES = 160;
const MAX_PUBLIC_TAP_NUMBER = 1_000_000;

function parseEnvelope(input: EventEnvelopeInput): EventEnvelope {
  if (typeof input !== "string") return input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new TypeError("Invalid event envelope JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Invalid event envelope JSON");
  }
  return parsed as EventEnvelope;
}

/**
 * Return the standard envelope as canonical JSON, without adding provider
 * fields or display metadata.  A canonical input string is returned byte for
 * byte; object inputs are serialized through the authoritative envelope
 * validator.
 */
export function formatStandardEvent(input: EventEnvelopeInput): string {
  if (typeof input === "string") {
    const canonical = serializeEventEnvelope(parseEnvelope(input));
    return canonical === input ? input : canonical;
  }
  return serializeEventEnvelope(input);
}

export const formatStandardEnvelope = formatStandardEvent;
export const formatTapboardEvent = formatStandardEvent;

function boundedText(
  value: unknown,
  maximumBytes: number,
  preserveNewlines = false,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const controls = preserveNewlines
    ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/gu
    : /[\u0000-\u001f\u007f]/gu;
  const normalized = value.replace(controls, " ").trim();
  if (normalized.length === 0) return undefined;
  if (Buffer.byteLength(normalized, "utf8") <= maximumBytes) return normalized;

  let result = "";
  for (const character of normalized) {
    if (Buffer.byteLength(`${result}${character}…`, "utf8") > maximumBytes) break;
    result += character;
  }
  return `${result}…`;
}

function safeContext(
  identifiers: EventIdentifiers,
  data: EventData,
  resolver: PublicEventContextResolver | undefined,
): PublicEventContext {
  if (resolver === undefined) return {};
  try {
    const resolved = resolver(identifiers, data);
    if (resolved === undefined || typeof resolved !== "object" || resolved === null) return {};

    const tapNumber =
      typeof resolved.tapNumber === "number" &&
      Number.isSafeInteger(resolved.tapNumber) &&
      resolved.tapNumber > 0 &&
      resolved.tapNumber <= MAX_PUBLIC_TAP_NUMBER
        ? resolved.tapNumber
        : undefined;
    const title = boundedText(resolved.title, MAX_PUBLIC_TITLE_BYTES);
    return {
      ...(tapNumber === undefined ? {} : { tapNumber }),
      ...(title === undefined ? {} : { title }),
    };
  } catch {
    return {};
  }
}

function contextLabel(context: PublicEventContext): string {
  if (context.tapNumber !== undefined && context.title !== undefined) {
    return `${context.title} · Tap ${context.tapNumber}`;
  }
  if (context.tapNumber !== undefined) return `Tap ${context.tapNumber}`;
  if (context.title !== undefined) return context.title;
  return "Tapboard";
}

function finiteNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function reason(data: EventData): string {
  return (data as FillEndedData).reason;
}

function discordTitle(eventType: EventType): string {
  switch (eventType) {
    case "fill.assigned":
      return "Fill assigned";
    case "fill.ended":
      return "Fill ended";
    case "pour.completed":
      return "Pour completed";
    case "keg.low":
      return "Keg low";
    case "health.transitioned":
      return "Health transitioned";
    case "integration.status_changed":
      return "Integration status changed";
  }
}

function discordDetails(eventType: EventType, data: EventData): string {
  switch (eventType) {
    case "fill.assigned":
      return "A fill was assigned.";
    case "fill.ended":
      return `Reason: ${boundedText(reason(data), 32) ?? "other"}`;
    case "pour.completed":
      return `${finiteNumber((data as PourCompletedData).volume_ml)} mL poured`;
    case "keg.low": {
      const low = data as KegLowData;
      return `${finiteNumber(low.remaining_percent)}% remaining · threshold ${finiteNumber(
        low.threshold_percent,
      )}%`;
    }
    case "health.transitioned": {
      const health = data as HealthTransitionedData;
      const check = boundedText(health.check_id, 48) ?? "health";
      const state = boundedText(health.state, 24) ?? "unknown";
      const severity = boundedText(health.severity, 24) ?? "none";
      return `${check} · ${state} · ${severity}`;
    }
    case "integration.status_changed": {
      const integration = data as IntegrationStatusChangedData;
      const name = boundedText(integration.integration_type, 48) ?? "integration";
      const state = boundedText(integration.state, 24) ?? "unknown";
      const code = boundedText(integration.reason_code, 48);
      return code === undefined ? `${name} · ${state}` : `${name} · ${state} · ${code}`;
    }
  }
}

/**
 * Build a deterministic, intentionally small Discord webhook body.  Only the
 * six registered event shapes are rendered; arbitrary envelope data is never
 * dumped or interpreted as a template.
 */
export function formatDiscordEvent(
  input: EventEnvelopeInput,
  resolver?: PublicEventContextResolver,
): string {
  const envelope = parseEnvelope(input);
  // Validate the complete envelope before looking at event fields.  This also
  // keeps the formatter's accepted contract aligned with the standard adapter.
  serializeEventEnvelope(envelope);
  const context = safeContext(envelope.identifiers, envelope.data, resolver);
  const title = discordTitle(envelope.event_type);
  const contextLine = contextLabel(context);
  const details = discordDetails(envelope.event_type, envelope.data);
  const content =
    boundedText(`${title}: ${details}`, MAX_DISCORD_CONTENT_BYTES) ?? "Tapboard event";
  const description =
    boundedText(`${contextLine}\n${details}`, MAX_DISCORD_CONTENT_BYTES, true) ?? contextLine;
  return canonicalizeJson(
    {
      allowed_mentions: { parse: [] },
      content,
      embeds: [{ description, title }],
    },
    { maxBytes: 4_096, maxDepth: 4, maxKeys: 4, maxArrayItems: 4 },
  );
}

export const formatDiscordPayload = formatDiscordEvent;
