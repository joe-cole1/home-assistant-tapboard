import { createHash } from "node:crypto";

import { EVENT_TYPES, type EventType } from "../events/types.ts";
import type {
  CreateOutboundDestinationInput,
  EditOutboundDestinationInput,
  OutboundHeader,
  OutboundTransport,
  OutboundUrlSummary,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SLOT = /^[a-z][a-z0-9_-]{0,31}$/u;
const DANGEROUS_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

export const DEFAULT_OUTBOUND_SUBSCRIPTIONS: readonly EventType[] = EVENT_TYPES;
export const MAX_OUTBOUND_DESTINATIONS = 32;
export const MAX_STATIC_HEADERS = 8;
export const MAX_SECRET_HEADERS = 8;
export const MAX_CONFIGURED_HEADERS = 8;
export const MAX_HEADER_NAME_BYTES = 64;
export const MAX_HEADER_VALUE_BYTES = 1_024;
export const MAX_HEADER_TOTAL_BYTES = 4_096;
export const HA_TOKEN_SLOT = "token_current";
export const WEBHOOK_ENDPOINT_SLOT = "endpoint";

export function validateHomeAssistantToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 16_384 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("token", "must be non-empty bounded text");
  }
  return value;
}

export function validateHeaderSecretValue(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("header secret", "must not contain control characters");
  }
  return bounded(value, "header secret", MAX_HEADER_VALUE_BYTES);
}

export function configuredHeaderBytes(
  headers: readonly { readonly name: string; readonly value: string }[],
): number {
  return headers.reduce(
    (total, header) =>
      total + Buffer.byteLength(header.name, "utf8") + Buffer.byteLength(header.value, "utf8"),
    0,
  );
}

export interface NormalizedSecretHeader {
  readonly name: string;
  readonly slot: string;
}

export interface NormalizedDestinationConfig {
  readonly transport: OutboundTransport;
  readonly transportKind: "ha" | "webhook";
  readonly baseUrl?: string;
  readonly endpointSummary: OutboundUrlSummary;
  readonly endpointSlot?: string;
  readonly authSlot?: string;
  readonly payloadFormat: "standard" | "discord";
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly NormalizedSecretHeader[];
  /** Safe JSON only; never include endpoint, token, or header secret values. */
  readonly configJson: string;
  readonly safeSummary: string;
}

function fail(field: string, reason: string): never {
  throw new TypeError(`Invalid outbound ${field}: ${reason}`);
}

export function validateOutboundId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) fail(field, "must be a UUID");
  return value.trim().toLowerCase();
}

export const validateDestinationId = validateOutboundId;

function bounded(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") fail(field, "must be text");
  const normalized = value.trim();
  if (normalized.length === 0) fail(field, "must not be empty");
  if (/\p{Cc}/u.test(normalized) || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    fail(field, `must be printable text of at most ${maxBytes} bytes`);
  }
  return normalized;
}

export function validateDestinationLabel(value: unknown): string {
  return bounded(value, "label", 120);
}

export function validateOutboundTransport(value: unknown): OutboundTransport {
  if (value === "ha" || value === "home_assistant") return "home_assistant";
  if (value === "webhook") return "webhook";
  fail("transport", "must be home_assistant or webhook");
}

export function validateSubscriptions(value: unknown): readonly EventType[] {
  if (value === undefined) return DEFAULT_OUTBOUND_SUBSCRIPTIONS;
  if (!Array.isArray(value) || value.length > EVENT_TYPES.length) {
    fail("subscriptions", "must contain at most 6 event types");
  }
  const normalized = value.map((item, index) => {
    if (typeof item !== "string" || !(EVENT_TYPES as readonly string[]).includes(item)) {
      fail(`subscriptions[${index}]`, "is not a registered event type");
    }
    return item as EventType;
  });
  if (new Set(normalized).size !== normalized.length)
    fail("subscriptions", "must not repeat events");
  return normalized;
}

function headerName(value: unknown, field: string): string {
  const result = bounded(value, field, MAX_HEADER_NAME_BYTES);
  const normalized = result.toLowerCase();
  if (!HEADER_NAME.test(result)) fail(field, "must be an RFC token header name");
  if (
    DANGEROUS_HEADERS.has(normalized) ||
    normalized === "x-forwarded" ||
    normalized.startsWith("x-forwarded-")
  ) {
    fail(field, "is reserved by the transport");
  }
  return result;
}

export function validateStaticHeaders(value: unknown): readonly OutboundHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STATIC_HEADERS) {
    fail("staticHeaders", "must contain at most 8 headers");
  }
  let total = 0;
  const names = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`staticHeaders[${index}]`, "must be an object");
    }
    const item = raw as Record<string, unknown>;
    const name = headerName(item.name, `staticHeaders[${index}].name`);
    if (typeof item.value !== "string" || /[\u0000-\u001f\u007f]/u.test(item.value)) {
      fail(`staticHeaders[${index}].value`, "must not contain control characters");
    }
    const text = bounded(item.value, `staticHeaders[${index}].value`, MAX_HEADER_VALUE_BYTES);
    const key = name.toLowerCase();
    if (key === "authorization") {
      fail(`staticHeaders[${index}].name`, "must use a secret header value");
    }
    if (names.has(key)) fail("staticHeaders", "must not repeat header names");
    names.add(key);
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(text, "utf8");
    if (total > MAX_HEADER_TOTAL_BYTES) fail("staticHeaders", "exceed 4096 total bytes");
    return { name, value: text };
  });
}

export function validateSecretHeaders(
  value: unknown,
  staticHeaders: readonly OutboundHeader[] = [],
): readonly NormalizedSecretHeader[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SECRET_HEADERS) {
    fail("secretHeaders", "must contain at most 8 headers");
  }
  const names = new Set(staticHeaders.map((item) => item.name.toLowerCase()));
  const slots = new Set<string>();
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`secretHeaders[${index}]`, "must be an object");
    }
    const item = raw as Record<string, unknown>;
    const name = headerName(item.name, `secretHeaders[${index}].name`);
    const key = name.toLowerCase();
    if (names.has(key)) fail("secretHeaders", "must not repeat static header names");
    names.add(key);
    const slot =
      item.slot === undefined || item.slot === null
        ? stableHeaderSlot(name)
        : bounded(item.slot, `secretHeaders[${index}].slot`, 32);
    if (!SLOT.test(slot)) fail(`secretHeaders[${index}].slot`, "is not a stable logical slot");
    if (slot === HA_TOKEN_SLOT || slot === WEBHOOK_ENDPOINT_SLOT) {
      fail(`secretHeaders[${index}].slot`, "is reserved by the transport");
    }
    if (slots.has(slot)) fail("secretHeaders", "must not repeat secret slots");
    slots.add(slot);
    return { name, slot };
  });
}

function stableHeaderSlot(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const digest = createHash("sha256").update(name.toLowerCase(), "utf8").digest("hex").slice(0, 8);
  const prefix = normalized.slice(0, 20) || "header";
  return `${prefix}_${digest}`.slice(0, 32);
}

export function validatePayloadFormat(value: unknown): "standard" | "discord" {
  if (value === undefined) return "standard";
  if (value === "standard" || value === "discord") return value;
  fail("payloadFormat", "must be standard or discord");
}

export function parseOutboundUrl(
  value: unknown,
  field: string,
): {
  readonly url: string;
  readonly summary: OutboundUrlSummary;
} {
  const text = bounded(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(field, "must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(field, "must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") fail(field, "must not contain credentials");
  if (parsed.hash !== "") fail(field, "must not contain a fragment");
  const url = parsed.toString();
  return {
    url,
    summary: {
      scheme: parsed.protocol.slice(0, -1) as "http" | "https",
      host: parsed.hostname.toLowerCase(),
      port: parsed.port === "" ? null : Number(parsed.port),
    },
  };
}

function safeConfigJson(config: {
  readonly transport: "ha" | "webhook";
  readonly baseUrl?: string;
  readonly summary: OutboundUrlSummary;
  readonly endpointSlot?: string;
  readonly authSlot?: string;
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly NormalizedSecretHeader[];
  readonly payloadFormat?: "standard" | "discord";
}): string {
  const safe: Record<string, unknown> = {
    transport: config.transport,
    urlSummary: config.summary,
    staticHeaders: config.staticHeaders,
    secretHeaders: config.secretHeaders,
  };
  if (config.baseUrl !== undefined) safe.baseUrl = config.baseUrl;
  if (config.endpointSlot !== undefined) safe.endpointSlot = config.endpointSlot;
  if (config.authSlot !== undefined) safe.authSlot = config.authSlot;
  if (config.payloadFormat !== undefined) safe.payloadFormat = config.payloadFormat;
  return JSON.stringify(safe);
}

export function normalizeDestinationConfig(
  input:
    | Pick<
        CreateOutboundDestinationInput,
        "transport" | "baseUrl" | "webhookUrl" | "staticHeaders" | "secretHeaders" | "payloadFormat"
      >
    | Pick<
        EditOutboundDestinationInput,
        "transport" | "baseUrl" | "webhookUrl" | "staticHeaders" | "secretHeaders" | "payloadFormat"
      >,
  fallback?: {
    readonly transport: OutboundTransport;
    readonly baseUrl?: string;
    readonly webhookUrl?: string;
    readonly staticHeaders?: readonly OutboundHeader[];
    readonly secretHeaders?: readonly { readonly name: string; readonly slot?: string }[];
    readonly payloadFormat?: "standard" | "discord";
  },
): NormalizedDestinationConfig {
  const transport = validateOutboundTransport(input.transport ?? fallback?.transport);
  const baseUrl = input.baseUrl ?? fallback?.baseUrl;
  const webhookUrl = input.webhookUrl ?? fallback?.webhookUrl;
  const staticHeaders = validateStaticHeaders(input.staticHeaders ?? fallback?.staticHeaders);
  const secretHeaders = validateSecretHeaders(
    input.secretHeaders ?? fallback?.secretHeaders,
    staticHeaders,
  );
  if (staticHeaders.length + secretHeaders.length > MAX_CONFIGURED_HEADERS) {
    fail("headers", "must contain at most 8 total static and secret headers");
  }
  const payloadFormat = validatePayloadFormat(input.payloadFormat ?? fallback?.payloadFormat);

  if (transport === "home_assistant") {
    const parsed = parseOutboundUrl(baseUrl, "baseUrl");
    const parsedBase = new URL(parsed.url);
    if (parsedBase.search !== "") fail("baseUrl", "must not contain a query");
    parsedBase.pathname = parsedBase.pathname.replace(/\/+$/u, "");
    const normalizedBaseUrl = parsedBase.toString().replace(/\/$/u, "");
    const configJson = safeConfigJson({
      transport: "ha",
      baseUrl: normalizedBaseUrl,
      summary: parsed.summary,
      authSlot: HA_TOKEN_SLOT,
      staticHeaders,
      secretHeaders,
      payloadFormat,
    });
    return {
      transport,
      transportKind: "ha",
      baseUrl: normalizedBaseUrl,
      endpointSummary: parsed.summary,
      authSlot: HA_TOKEN_SLOT,
      payloadFormat,
      staticHeaders,
      secretHeaders,
      configJson,
      safeSummary: JSON.stringify(parsed.summary),
    };
  }

  const parsed = parseOutboundUrl(webhookUrl, "webhookUrl");
  const configJson = safeConfigJson({
    transport: "webhook",
    summary: parsed.summary,
    endpointSlot: WEBHOOK_ENDPOINT_SLOT,
    staticHeaders,
    secretHeaders,
    payloadFormat,
  });
  return {
    transport,
    transportKind: "webhook",
    endpointSummary: parsed.summary,
    endpointSlot: WEBHOOK_ENDPOINT_SLOT,
    staticHeaders,
    secretHeaders,
    payloadFormat,
    configJson,
    safeSummary: JSON.stringify(parsed.summary),
  };
}

export function normalizeCreateInput(input: CreateOutboundDestinationInput): {
  readonly label: string;
  readonly transport: OutboundTransport;
  readonly required: boolean;
  readonly enabled: boolean;
  readonly subscriptions: readonly EventType[];
  readonly config: NormalizedDestinationConfig;
  readonly secret?: string;
} {
  const label = validateDestinationLabel(input.label);
  const transport = validateOutboundTransport(input.transport);
  if (input.required !== undefined && typeof input.required !== "boolean")
    fail("required", "must be boolean");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    fail("enabled", "must be boolean");
  const config = normalizeDestinationConfig(input);
  if (transport === "webhook" && input.secret !== undefined) {
    fail("secret", "is not accepted for webhook endpoints");
  }
  const secret =
    transport === "webhook"
      ? parseOutboundUrl(input.webhookUrl, "webhookUrl").url
      : input.secret === undefined
        ? undefined
        : validateHomeAssistantToken(input.secret);
  return {
    label,
    transport,
    required: input.required ?? false,
    enabled: input.enabled ?? true,
    subscriptions: validateSubscriptions(input.subscriptions),
    config,
    ...(secret === undefined ? {} : { secret }),
  };
}
