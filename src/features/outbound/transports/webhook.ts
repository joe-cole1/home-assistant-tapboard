import { request as httpRequest, type RequestOptions as HttpRequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";

import { formatDiscordEvent, formatStandardEvent } from "./formatters.ts";
import {
  boundedErrorCode,
  failureResult,
  successResult,
  type EventEnvelopeInput,
  type PublicEventContextResolver,
  type TransportAttemptResult,
} from "../transport-types.ts";

const DEFAULT_OVERALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_URL_BYTES = 2_048;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 2_048;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type TimerHandle = ReturnType<typeof setTimeout> | number;
type Schedule = (handler: () => void, timeoutMs: number) => TimerHandle;
type Cancel = (handle: TimerHandle) => void;

export interface DnsLookupAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type DnsLookupAll = (
  hostname: string,
  options: { readonly all: true },
) => Promise<readonly DnsLookupAddress[]>;

export interface WebhookResponseLike {
  readonly statusCode?: number | undefined;
  on(event: string, listener: (...args: readonly unknown[]) => void): this;
  destroy?(): void;
}

export interface WebhookRequestLike {
  on(event: string, listener: (...args: readonly unknown[]) => void): this;
  end(data?: string): void;
  destroy?(error?: Error): void;
  abort?(): void;
}

export interface WebhookSocketLike {
  on(event: string, listener: (...args: readonly unknown[]) => void): this;
  once?(event: string, listener: (...args: readonly unknown[]) => void): this;
}

export type WebhookRequestFactory = (
  options: HttpRequestOptions,
  onResponse: (response: WebhookResponseLike) => void,
) => WebhookRequestLike;

type WebhookRequestOptions = HttpRequestOptions & {
  readonly autoSelectFamily: false;
  readonly servername?: string;
};

export interface WebhookDestination {
  readonly url?: string;
  readonly endpoint?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadFormat?: "standard" | "discord";
  readonly publicContextResolver?: PublicEventContextResolver;
  readonly resolver?: PublicEventContextResolver;
}

export interface WebhookTransportOptions {
  readonly request?: WebhookRequestFactory;
  readonly httpRequest?: WebhookRequestFactory;
  readonly httpsRequest?: WebhookRequestFactory;
  readonly dnsLookup?: DnsLookupAll;
  readonly schedule?: Schedule;
  readonly cancel?: Cancel;
  readonly overallTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly userAgent?: string;
  readonly publicContextResolver?: PublicEventContextResolver;
}

const DENIED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "content-encoding",
  "expect",
  "via",
]);

function isForwardedHeader(name: string): boolean {
  return name === "x-forwarded" || name.startsWith("x-forwarded-");
}

function boundedDuration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) {
    throw new TypeError("Webhook timeout is invalid");
  }
  return result;
}

function boundedResponseBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_RESPONSE_BYTES) {
    throw new TypeError("Webhook response limit is invalid");
  }
  return result;
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const result = parts.map((part) => {
    if (!/^\d{1,3}$/u.test(part)) return -1;
    const number = Number(part);
    return number >= 0 && number <= 255 ? number : -1;
  });
  return result.some((part) => part < 0) ? undefined : result;
}

function ipv4Number(parts: readonly number[]): number {
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function ipv4FromNumber(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function ipv4InRange(value: number, base: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(value: string): boolean {
  const parts = parseIpv4(value);
  if (parts === undefined) return false;
  const number = ipv4Number(parts);
  const blocked: readonly [string, number, number][] = [
    ["0.0.0.0", 0, 8],
    ["10.0.0.0", 10 << 24, 8],
    ["100.64.0.0", (100 << 24) | (64 << 16), 10],
    ["127.0.0.0", 127 << 24, 8],
    ["169.254.0.0", (169 << 24) | (254 << 16), 16],
    ["172.16.0.0", (172 << 24) | (16 << 16), 12],
    ["192.0.0.0", (192 << 24) | (0 << 16), 24],
    ["192.0.2.0", (192 << 24) | (0 << 16) | (2 << 8), 24],
    ["192.88.99.0", (192 << 24) | (88 << 16) | (99 << 8), 24],
    ["192.168.0.0", (192 << 24) | (168 << 16), 16],
    ["198.18.0.0", (198 << 24) | (18 << 16), 15],
    ["198.51.100.0", (198 << 24) | (51 << 16) | (100 << 8), 24],
    ["203.0.113.0", (203 << 24) | (0 << 16) | (113 << 8), 24],
    ["224.0.0.0", 224 << 24, 4],
    ["240.0.0.0", 240 << 24, 4],
  ];
  return !blocked.some(([, base, bits]) => ipv4InRange(number, base >>> 0, bits));
}

function parseIpv6(value: string): bigint[] | undefined {
  if (value.includes("%")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (part: string): number[] | undefined => {
    if (part.length === 0) return [];
    const pieces = part.split(":");
    const numbers: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return undefined;
        const ipv4 = parseIpv4(piece);
        if (ipv4 === undefined) return undefined;
        numbers.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else if (/^[0-9a-f]{1,4}$/iu.test(piece)) {
        numbers.push(Number.parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return numbers;
  };

  const left = parsePart(halves[0] ?? "");
  const right = parsePart(halves.length === 2 ? (halves[1] ?? "") : "");
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const values =
    halves.length === 2
      ? [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right]
      : left;
  return values.map((part) => BigInt(part));
}

function ipv6Number(parts: readonly bigint[]): bigint {
  return parts.reduce((value, part) => (value << 16n) | part, 0n);
}

function ipv6InRange(value: bigint, base: bigint, prefixBits: number): boolean {
  const shift = 128 - prefixBits;
  return value >> BigInt(shift) === base >> BigInt(shift);
}

function isPublicIpv6(value: string): boolean {
  const parts = parseIpv6(value);
  if (parts === undefined) return false;
  const number = ipv6Number(parts);
  const mapped = ipv6InRange(number, 0xffffn << 32n, 96);
  if (mapped) {
    const lower = Number((number & 0xffffffffn).toString());
    return isPublicIpv4(ipv4FromNumber(lower).join("."));
  }
  // Public webhook targets are limited to the currently allocated global
  // unicast block. Other syntactically valid IPv6 space is reserved or local.
  if (!ipv6InRange(number, 0x2000n << 112n, 3)) return false;
  const blocked: readonly [bigint, number][] = [
    [0n, 128], // unspecified
    [1n, 128], // loopback
    [0n, 96], // deprecated IPv4-compatible space
    [0xfc00n << 112n, 7], // unique local
    [0xfe80n << 112n, 10], // link local
    [0xfec0n << 112n, 10], // deprecated site-local
    [0xffn << 120n, 8], // multicast
    [0x100n << 112n, 64], // discard-only
    [0x20010db8n << 96n, 32], // documentation
    [0x20010000n << 96n, 32], // Teredo
    [0x200100020000n << 80n, 48], // benchmarking
    [0x20010010n << 96n, 28], // ORCHID
    [0x20010020n << 96n, 28], // ORCHIDv2
    [0x20020000n << 96n, 16], // 6to4 (conservative reserved handling)
    [0x3ffen << 112n, 16], // 6bone
  ];
  return !blocked.some(([base, prefix]) => ipv6InRange(number, base, prefix));
}

/** True only for addresses that are safe candidates for public webhook dials. */
export function isPublicNetworkAddress(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return isPublicIpv4(normalized);
  return isPublicIpv6(normalized);
}

export const isPublicAddress = isPublicNetworkAddress;

function networkFamily(value: string): 4 | 6 | undefined {
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (parseIpv4(normalized) !== undefined) return 4;
  return parseIpv6(normalized) === undefined ? undefined : 6;
}

function isSafeDnsAddress(value: unknown): value is DnsLookupAddress {
  if (typeof value !== "object" || value === null) return false;
  const address = (value as { readonly address?: unknown }).address;
  const family = (value as { readonly family?: unknown }).family;
  return (
    typeof address === "string" &&
    (family === 4 || family === 6) &&
    networkFamily(address) === family &&
    isPublicNetworkAddress(address)
  );
}

function normalizeUrl(input: string): URL {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    Buffer.byteLength(input, "utf8") > MAX_URL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw new TypeError("Webhook URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Webhook URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Webhook URL must use http or https");
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(input)?.[1];
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.host.includes("@") ||
    authority?.includes("@") === true
  ) {
    throw new TypeError("Webhook URL must not contain userinfo");
  }
  if (url.hash.length > 0 || url.hostname.length === 0) {
    throw new TypeError("Webhook URL is invalid");
  }
  return url;
}

export function normalizeWebhookUrl(input: string): string {
  return normalizeUrl(input).toString();
}

export const normalizeWebhookEndpoint = normalizeWebhookUrl;

function validateHeaders(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (input === undefined) return {};
  const entries = Object.entries(input);
  if (entries.length > MAX_HEADER_COUNT) throw new TypeError("Webhook headers are too numerous");
  const result: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      Buffer.byteLength(name, "utf8") > MAX_HEADER_NAME_BYTES ||
      lower === "content-type" ||
      DENIED_HEADERS.has(lower) ||
      isForwardedHeader(lower)
    ) {
      throw new TypeError("Webhook header is not allowed");
    }
    if (names.has(lower)) throw new TypeError("Webhook header is repeated");
    names.add(lower);
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError("Webhook header value is invalid");
    }
    result[lower] = value;
  }
  return result;
}

function endpoint(destination: WebhookDestination): string {
  const value = destination.url ?? destination.endpoint;
  if (typeof value !== "string") throw new TypeError("Webhook URL is invalid");
  return value;
}

function networkHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function defaultLookup(
  hostname: string,
  options: { readonly all: true },
): Promise<readonly DnsLookupAddress[]> {
  return dnsLookup(hostname, options) as Promise<readonly DnsLookupAddress[]>;
}

function defaultHttpFactory(
  options: HttpRequestOptions,
  onResponse: (response: WebhookResponseLike) => void,
): WebhookRequestLike {
  return httpRequest(options, (response) => onResponse(response));
}

function defaultHttpsFactory(
  options: HttpRequestOptions,
  onResponse: (response: WebhookResponseLike) => void,
): WebhookRequestLike {
  return httpsRequest(options, (response) => onResponse(response));
}

interface ActiveRequest {
  readonly controller: AbortController;
  request: WebhookRequestLike | undefined;
  settled: boolean;
  resolve: (result: TransportAttemptResult) => void;
  overallTimer: TimerHandle | undefined;
  connectTimer: TimerHandle | undefined;
  responseTimer: TimerHandle | undefined;
}

function statusResult(status: number): TransportAttemptResult {
  if (status >= 200 && status < 300) return successResult(status);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return failureResult("retryable_failure", `webhook_http_${status}`, status);
  }
  if (status >= 300 && status < 400) {
    return failureResult("permanent_failure", "webhook_redirect", status);
  }
  if (status >= 400 && status < 500) {
    return failureResult("permanent_failure", `webhook_http_${status}`, status);
  }
  return failureResult("retryable_failure", "webhook_invalid_status", status);
}

export class WebhookTransport {
  readonly #httpRequest: WebhookRequestFactory;
  readonly #httpsRequest: WebhookRequestFactory;
  readonly #dnsLookup: DnsLookupAll;
  readonly #schedule: Schedule;
  readonly #cancel: Cancel;
  readonly #overallTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #responseTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #userAgent: string;
  readonly #publicContextResolver: PublicEventContextResolver | undefined;
  readonly #active = new Set<ActiveRequest>();
  #stopped = false;

  constructor(options: WebhookTransportOptions = {}) {
    this.#httpRequest = options.httpRequest ?? options.request ?? defaultHttpFactory;
    this.#httpsRequest = options.httpsRequest ?? options.request ?? defaultHttpsFactory;
    this.#dnsLookup = options.dnsLookup ?? defaultLookup;
    this.#schedule = options.schedule ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.#overallTimeoutMs = boundedDuration(options.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS);
    this.#connectTimeoutMs = boundedDuration(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.#responseTimeoutMs = boundedDuration(
      options.responseTimeoutMs,
      DEFAULT_RESPONSE_TIMEOUT_MS,
    );
    this.#maxResponseBytes = boundedResponseBytes(options.maxResponseBytes);
    const userAgent = options.userAgent ?? "Tapboard/2";
    if (
      typeof userAgent !== "string" ||
      userAgent.length === 0 ||
      Buffer.byteLength(userAgent, "utf8") > 128 ||
      /[\u0000-\u001f\u007f]/u.test(userAgent)
    ) {
      throw new TypeError("Webhook user agent is invalid");
    }
    this.#userAgent = userAgent;
    this.#publicContextResolver = options.publicContextResolver;
  }

  async sendEvent(
    destination: WebhookDestination,
    envelope: EventEnvelopeInput,
  ): Promise<TransportAttemptResult> {
    if (this.#stopped) return failureResult("permanent_failure", "webhook_stopped");

    let url: URL;
    let body: string;
    let headers: Record<string, string>;
    try {
      url = normalizeUrl(endpoint(destination));
      const payloadFormat = destination.payloadFormat ?? "standard";
      if (payloadFormat !== "standard" && payloadFormat !== "discord") {
        throw new TypeError("Webhook payload format is invalid");
      }
      const resolver =
        destination.publicContextResolver ?? destination.resolver ?? this.#publicContextResolver;
      body =
        payloadFormat === "discord"
          ? formatDiscordEvent(envelope, resolver)
          : formatStandardEvent(envelope);
      headers = validateHeaders(destination.headers);
    } catch {
      return failureResult("permanent_failure", "webhook_invalid_configuration");
    }

    const controller = new AbortController();
    let addresses: readonly DnsLookupAddress[];
    try {
      addresses = await this.#lookupWithTimeout(networkHostname(url), controller);
    } catch (error) {
      if (this.#stopped) return failureResult("permanent_failure", "webhook_stopped");
      return error instanceof WebhookTimeout
        ? failureResult("retryable_failure", error.code)
        : failureResult("retryable_failure", "webhook_dns_failed");
    }
    if (
      this.#stopped ||
      addresses.length === 0 ||
      addresses.some((item) => !isSafeDnsAddress(item))
    ) {
      if (this.#stopped) return failureResult("permanent_failure", "webhook_stopped");
      return failureResult("permanent_failure", "webhook_dns_unsafe");
    }
    const approved = addresses[0]!;

    const requestOptions: WebhookRequestOptions = {
      protocol: url.protocol,
      hostname: networkHostname(url),
      ...(url.port.length === 0 ? {} : { port: Number(url.port) }),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      family: approved.family,
      // Node 24 enables network-family autoselection by default.  The lookup
      // closure below is deliberately pinned to one already-approved address;
      // do not let net.connect reinterpret it as a multi-address lookup.
      autoSelectFamily: false,
      // Do not reuse a socket that was opened for a prior DNS answer.  Each
      // attempt must dial through the freshly validated lookup closure.
      agent: false,
      headers: {
        ...headers,
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
        "user-agent": this.#userAgent,
      },
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: approved.address, family: approved.family }]);
          return;
        }
        callback(null, approved.address, approved.family);
      },
      signal: controller.signal,
      ...(url.protocol === "https:" ? { servername: networkHostname(url) } : {}),
    };

    return this.#requestBody(url, requestOptions, body, controller);
  }

  deliver = this.sendEvent.bind(this);
  send = this.sendEvent.bind(this);

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const active of this.#active) {
      this.#settle(active, failureResult("retryable_failure", "webhook_stopped"));
    }
  }

  close(): void {
    this.stop();
  }

  async #lookupWithTimeout(
    hostname: string,
    controller: AbortController,
  ): Promise<readonly DnsLookupAddress[]> {
    return new Promise<readonly DnsLookupAddress[]>((resolve, reject) => {
      const timer = this.#schedule(() => {
        controller.abort();
        reject(new WebhookTimeout("webhook_connect_timeout"));
      }, this.#connectTimeoutMs);
      void this.#dnsLookup(hostname, { all: true }).then(
        (addresses) => {
          this.#cancel(timer);
          if (!Array.isArray(addresses)) {
            reject(new Error("DNS lookup returned invalid addresses"));
            return;
          }
          resolve(addresses);
        },
        () => {
          this.#cancel(timer);
          reject(new Error("DNS lookup failed"));
        },
      );
    });
  }

  #requestBody(
    url: URL,
    requestOptions: HttpRequestOptions,
    body: string,
    controller: AbortController,
  ): Promise<TransportAttemptResult> {
    return new Promise<TransportAttemptResult>((resolve) => {
      const active: ActiveRequest = {
        controller,
        request: undefined,
        settled: false,
        resolve,
        overallTimer: undefined,
        connectTimer: undefined,
        responseTimer: undefined,
      };
      this.#active.add(active);
      active.overallTimer = this.#schedule(() => {
        this.#settle(active, failureResult("retryable_failure", "webhook_timeout"));
      }, this.#overallTimeoutMs);
      active.connectTimer = this.#schedule(() => {
        this.#settle(active, failureResult("retryable_failure", "webhook_connect_timeout"));
      }, this.#connectTimeoutMs);
      active.responseTimer = this.#schedule(() => {
        this.#settle(active, failureResult("retryable_failure", "webhook_response_timeout"));
      }, this.#responseTimeoutMs);

      const onResponse = (response: WebhookResponseLike): void => {
        if (active.settled) return;
        this.#clearTimer(active, "responseTimer");
        active.responseTimer = this.#schedule(() => {
          this.#settle(active, failureResult("retryable_failure", "webhook_response_timeout"));
        }, this.#responseTimeoutMs);
        let bytes = 0;
        let ended = false;
        response.on("data", (chunk: unknown) => {
          if (active.settled || ended) return;
          const size =
            typeof chunk === "string"
              ? Buffer.byteLength(chunk, "utf8")
              : chunk instanceof Uint8Array
                ? chunk.byteLength
                : 0;
          bytes += size;
          if (bytes > this.#maxResponseBytes) {
            this.#settle(active, failureResult("permanent_failure", "webhook_response_too_large"));
            response.destroy?.();
          }
        });
        response.on("error", () => {
          if (!active.settled) {
            this.#settle(active, failureResult("retryable_failure", "webhook_response_error"));
          }
        });
        response.on("aborted", () => {
          if (!active.settled) {
            this.#settle(active, failureResult("retryable_failure", "webhook_response_aborted"));
          }
        });
        response.on("close", () => {
          if (!ended && !active.settled) {
            this.#settle(active, failureResult("retryable_failure", "webhook_response_closed"));
          }
        });
        response.on("end", () => {
          ended = true;
          if (active.settled) return;
          const status = response.statusCode;
          if (typeof status !== "number" || !Number.isSafeInteger(status)) {
            this.#settle(active, failureResult("retryable_failure", "webhook_invalid_status"));
            return;
          }
          this.#settle(active, statusResult(status));
        });
      };

      try {
        const requestFactory = url.protocol === "https:" ? this.#httpsRequest : this.#httpRequest;
        active.request = requestFactory(requestOptions, onResponse);
        // `socket` only means a socket object was assigned.  DNS/TCP/TLS can
        // still be stalled at that point; clear the connect bound only after
        // the actual TCP or TLS connect event on that socket.
        active.request.on("socket", (value: unknown) => {
          if (typeof value !== "object" || value === null) return;
          const socket = value as WebhookSocketLike;
          const connected = (): void => this.#clearTimer(active, "connectTimer");
          if (socket.once !== undefined) {
            socket.once("connect", connected);
            socket.once("secureConnect", connected);
          } else {
            socket.on("connect", connected);
            socket.on("secureConnect", connected);
          }
        });
        active.request.on("error", () => {
          if (!active.settled) {
            this.#settle(active, failureResult("retryable_failure", "webhook_request_error"));
          }
        });
        active.request.end(body);
      } catch {
        this.#settle(active, failureResult("retryable_failure", "webhook_request_error"));
      }
    });
  }

  #clearTimer(active: ActiveRequest, key: "overallTimer" | "connectTimer" | "responseTimer"): void {
    const timer = active[key];
    if (timer !== undefined) this.#cancel(timer);
    active[key] = undefined;
  }

  #settle(active: ActiveRequest, result: TransportAttemptResult): void {
    if (active.settled) return;
    active.settled = true;
    this.#clearTimer(active, "overallTimer");
    this.#clearTimer(active, "connectTimer");
    this.#clearTimer(active, "responseTimer");
    this.#active.delete(active);
    if (result.outcome !== "success") {
      active.controller.abort();
      try {
        active.request?.destroy?.();
        active.request?.abort?.();
      } catch {
        // Request teardown is best effort and never changes the safe result.
      }
    }
    active.resolve(result);
  }
}

class WebhookTimeout extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Webhook timeout");
    this.name = "WebhookTimeout";
    this.code = boundedErrorCode(code, "webhook_timeout");
  }
}

export function createWebhookTransport(options: WebhookTransportOptions = {}): WebhookTransport {
  return new WebhookTransport(options);
}
