import { createHash } from "node:crypto";

import { canonicalizeJson } from "../../../shared/canonical-json.ts";
import { formatStandardEvent } from "./formatters.ts";
import {
  failureResult,
  successResult,
  type EventEnvelopeInput,
  type TransportAttemptResult,
} from "../transport-types.ts";

const WEBSOCKET_OPEN = 1;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_MAX_PENDING_REQUESTS = 64;
const MAX_DESTINATION_ID_BYTES = 256;
const MAX_DESTINATION_VERSION_ID_BYTES = 256;
const MAX_BINDING_GENERATION_BYTES = 256;
const MAX_TOKEN_BYTES = 16_384;
const MAX_FRAME_BYTES = 32_768;

export type TimerHandle = ReturnType<typeof setTimeout> | number;
type Schedule = (handler: () => void, timeoutMs: number) => TimerHandle;
type Cancel = (handle: TimerHandle) => void;

export interface WebSocketEventLike {
  readonly data?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
}

export interface WebSocketLike {
  readonly readyState?: number;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
  removeEventListener?(type: string, listener: (event: WebSocketEventLike) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Adapter for Node 24's native EventTarget-style WebSocket. */
export const nativeWebSocketFactory: WebSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return socket;
};

export interface HomeAssistantDestination {
  readonly destinationId?: string;
  readonly id?: string;
  /** Immutable delivery-bound version metadata for connection-state evidence. */
  readonly destinationVersionId?: string;
  readonly baseUrl?: string;
  readonly url?: string;
  readonly token: string;
  /** Explicit logical binding generation supplied by the caller. */
  readonly bindingGeneration?: string | number | null;
  /** Changes when a secret is replaced, even when the URL is unchanged. */
  readonly tokenGeneration?: string | number | null;
  /** Alias accepted by callers that version credentials explicitly. */
  readonly tokenVersion?: string | number | null;
  /** Optional endpoint/config generation; URL changes are always detected. */
  readonly endpointVersion?: string | number | null;
}

export interface HomeAssistantTransportOptions {
  readonly webSocketFactory?: WebSocketFactory;
  readonly createWebSocket?: WebSocketFactory;
  readonly authTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly maxPendingRequests?: number;
  readonly schedule?: Schedule;
  readonly cancel?: Cancel;
  readonly onConnectionStateChanged?: HomeAssistantConnectionStateListener;
}

/** Sanitized evidence emitted by the HA connection manager. */
export interface HomeAssistantConnectionStateEvent {
  readonly destinationId: string;
  readonly destinationVersionId?: string;
  readonly bindingGeneration?: string;
  readonly result: TransportAttemptResult;
}

export type HomeAssistantConnectionStateListener = (
  event: HomeAssistantConnectionStateEvent,
) => void;

interface BoundDestination {
  readonly destinationId: string;
  readonly destinationVersionId?: string;
  readonly baseUrl: string;
  readonly wsUrl: string;
  readonly token: string;
  readonly bindingGeneration?: string;
  readonly bindingKey: string;
}

interface PendingRequest {
  readonly timer: TimerHandle;
  readonly resolve: (result: TransportAttemptResult) => void;
}

interface Connection {
  destination: BoundDestination;
  socket: WebSocketLike | undefined;
  phase: "idle" | "connecting" | "authenticating" | "ready" | "closed";
  authRequired: boolean;
  authSent: boolean;
  invalidAuth: boolean;
  nextRequestId: number;
  pending: Map<number, PendingRequest>;
  connectPromise: Promise<void> | undefined;
  connectResolve: (() => void) | undefined;
  connectReject: ((error: ConnectionFailure) => void) | undefined;
  authTimer: TimerHandle | undefined;
  reconnectTimer: TimerHandle | undefined;
  reconnectAttempts: number;
  reconnectExponent: number;
  closed: boolean;
  onOpen: (event: WebSocketEventLike) => void;
  onMessage: (event: WebSocketEventLike) => void;
  onError: (event: WebSocketEventLike) => void;
  onClose: (event: WebSocketEventLike) => void;
}

class ConnectionFailure extends Error {
  readonly result: TransportAttemptResult;

  constructor(result: TransportAttemptResult) {
    super("Home Assistant connection failed");
    this.name = "ConnectionFailure";
    this.result = result;
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 3_600_000) {
    throw new TypeError("Home Assistant timeout is invalid");
  }
  return result;
}

function boundedCount(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new TypeError("Home Assistant transport limit is invalid");
  }
  return result;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Home Assistant destination ID is invalid");
  }
  if (
    Buffer.byteLength(value, "utf8") > MAX_DESTINATION_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Home Assistant destination ID is invalid");
  }
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Home Assistant token is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Home Assistant token is invalid");
  }
  return value;
}

function optionalMetadata(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Home Assistant ${field} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Home Assistant ${field} is invalid`);
  }
  return value;
}

function bindingGeneration(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Home Assistant binding generation is invalid");
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("Home Assistant binding generation is invalid");
  }
  return optionalMetadata(String(value), "binding generation", MAX_BINDING_GENERATION_BYTES);
}

function urlInput(destination: HomeAssistantDestination): string {
  const value = destination.baseUrl ?? destination.url;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Home Assistant base URL is invalid");
  }
  return value;
}

function containsUserInfo(input: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(input)?.[1];
  return authority?.includes("@") === true;
}

/** Normalize an HA HTTP(S) base URL while preserving an optional path prefix. */
export function normalizeHomeAssistantBaseUrl(input: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("?") ||
    input.includes("#")
  ) {
    throw new TypeError("Home Assistant URL must not contain a query or fragment");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError("Home Assistant URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Home Assistant URL must use http or https");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.host.includes("@") ||
    containsUserInfo(input)
  ) {
    throw new TypeError("Home Assistant URL must not contain userinfo");
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

export function deriveHomeAssistantWebSocketUrl(input: string): string {
  const base = new URL(normalizeHomeAssistantBaseUrl(input));
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const prefix = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${prefix}/api/websocket`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function eventData(event: WebSocketEventLike): unknown {
  const value = event.data;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return undefined;
}

function objectMessage(event: WebSocketEventLike): Record<string, unknown> | undefined {
  const raw = eventData(event);
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function failure(errorCode: string, status?: number): ConnectionFailure {
  return new ConnectionFailure(failureResult("retryable_failure", errorCode, status));
}

function permanent(errorCode: string): ConnectionFailure {
  return new ConnectionFailure(failureResult("permanent_failure", errorCode));
}

function resultFromError(error: unknown): TransportAttemptResult {
  return error instanceof ConnectionFailure
    ? error.result
    : failureResult("retryable_failure", "ha_connection_failed");
}

function sanitizeResult(result: TransportAttemptResult): TransportAttemptResult {
  return result.outcome === "success"
    ? successResult(result.status)
    : failureResult(result.outcome, result.errorCode, result.status);
}

function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function resolveDestination(input: HomeAssistantDestination): BoundDestination {
  const destinationId = identity(input.destinationId ?? input.id);
  const destinationVersionId = optionalMetadata(
    input.destinationVersionId,
    "destination version ID",
    MAX_DESTINATION_VERSION_ID_BYTES,
  );
  const baseUrl = normalizeHomeAssistantBaseUrl(urlInput(input));
  const wsUrl = deriveHomeAssistantWebSocketUrl(baseUrl);
  const secret = token(input.token);
  const generation = bindingGeneration(
    input.bindingGeneration ?? input.tokenGeneration ?? input.tokenVersion,
  );
  const normalizedGeneration = generation ?? "";
  return {
    destinationId,
    ...(destinationVersionId === undefined ? {} : { destinationVersionId }),
    baseUrl,
    wsUrl,
    token: secret,
    ...(generation === undefined ? {} : { bindingGeneration: generation }),
    // Historical destination versions intentionally do not create separate
    // sockets.  Only an actual endpoint or credential binding change does.
    // Keep the token out of the in-memory binding identifier; the token is
    // retained only on the bound destination because authentication requires it.
    bindingKey: `${wsUrl}\u0000${normalizedGeneration}\u0000${credentialFingerprint(secret)}`,
  };
}

export class HomeAssistantConnectionManager {
  readonly #webSocketFactory: WebSocketFactory;
  readonly #authTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #maxPendingRequests: number;
  readonly #schedule: Schedule;
  readonly #cancel: Cancel;
  readonly #onConnectionStateChanged: HomeAssistantConnectionStateListener | undefined;
  readonly #connections = new Map<string, Connection>();
  #stopped = false;

  constructor(options: HomeAssistantTransportOptions = {}) {
    this.#webSocketFactory =
      options.webSocketFactory ?? options.createWebSocket ?? nativeWebSocketFactory;
    this.#authTimeoutMs = boundedDuration(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS);
    this.#requestTimeoutMs = boundedDuration(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#reconnectDelayMs = boundedDuration(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this.#maxReconnectDelayMs = boundedDuration(
      options.maxReconnectDelayMs,
      DEFAULT_MAX_RECONNECT_DELAY_MS,
    );
    this.#maxPendingRequests = boundedCount(
      options.maxPendingRequests,
      DEFAULT_MAX_PENDING_REQUESTS,
      256,
    );
    this.#schedule = options.schedule ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle));
    this.#onConnectionStateChanged = options.onConnectionStateChanged;
  }

  async sendEvent(
    destinationInput: HomeAssistantDestination,
    envelope: EventEnvelopeInput,
  ): Promise<TransportAttemptResult> {
    if (this.#stopped) return failureResult("permanent_failure", "ha_stopped");

    let destination: BoundDestination;
    let eventJson: string;
    try {
      destination = resolveDestination(destinationInput);
      eventJson = formatStandardEvent(envelope);
    } catch {
      return failureResult("permanent_failure", "ha_invalid_configuration");
    }

    const connection = this.#connectionFor(destination);

    try {
      await this.#ensureReady(connection);
    } catch (error) {
      return resultFromError(error);
    }
    return this.#fireEvent(connection, eventJson);
  }

  /**
   * Establish/authenticate the bound logical destination without firing an
   * event.  This is useful as startup/re-enable recovery evidence and shares
   * the exact same one-connection cache as sendEvent().
   */
  async ensureAuthenticated(
    destinationInput: HomeAssistantDestination,
  ): Promise<TransportAttemptResult> {
    if (this.#stopped) return failureResult("permanent_failure", "ha_stopped");
    let destination: BoundDestination;
    try {
      destination = resolveDestination(destinationInput);
    } catch {
      return failureResult("permanent_failure", "ha_invalid_configuration");
    }
    const connection = this.#connectionFor(destination);
    try {
      await this.#ensureReady(connection);
      return successResult();
    } catch (error) {
      return resultFromError(error);
    }
  }

  deliver = this.sendEvent.bind(this);
  fireEvent = this.sendEvent.bind(this);
  send = this.sendEvent.bind(this);
  authenticate = this.ensureAuthenticated.bind(this);
  ensureHealthy = this.ensureAuthenticated.bind(this);

  closeDestination(destinationId: string): void {
    let id: string;
    try {
      id = identity(destinationId);
    } catch {
      return;
    }
    const connection = this.#connections.get(id);
    if (connection === undefined) return;
    this.#connections.delete(id);
    this.#closeConnection(connection, "ha_destination_closed");
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const [id, connection] of this.#connections) {
      this.#connections.delete(id);
      this.#closeConnection(connection, "ha_stopped");
    }
  }

  close(): void {
    this.stop();
  }

  #createConnection(destination: BoundDestination): Connection {
    const connection = {} as Connection;
    connection.destination = destination;
    connection.socket = undefined;
    connection.phase = "idle";
    connection.authRequired = false;
    connection.authSent = false;
    connection.invalidAuth = false;
    connection.nextRequestId = 1;
    connection.pending = new Map();
    connection.connectPromise = undefined;
    connection.connectResolve = undefined;
    connection.connectReject = undefined;
    connection.authTimer = undefined;
    connection.reconnectTimer = undefined;
    connection.reconnectAttempts = 0;
    connection.reconnectExponent = 0;
    connection.closed = false;
    connection.onOpen = (event) => this.#onOpen(connection, event);
    connection.onMessage = (event) => this.#onMessage(connection, event);
    connection.onError = () => this.#onSocketFailure(connection, "ha_socket_error");
    connection.onClose = () => this.#onSocketFailure(connection, "ha_socket_closed");
    return connection;
  }

  #connectionFor(destination: BoundDestination): Connection {
    let connection = this.#connections.get(destination.destinationId);
    if (connection === undefined || connection.destination.bindingKey !== destination.bindingKey) {
      if (connection !== undefined) this.#closeConnection(connection, "ha_destination_changed");
      connection = this.#createConnection(destination);
      this.#connections.set(destination.destinationId, connection);
    } else {
      // Version metadata may advance without changing endpoint or credentials.
      // Keep the physical socket while ensuring later health evidence is bound
      // to the current immutable destination version.
      connection.destination = destination;
    }
    return connection;
  }

  #ensureReady(connection: Connection): Promise<void> {
    this.#clearReconnectTimer(connection);
    if (connection.phase === "ready" && connection.socket !== undefined) return Promise.resolve();
    if (connection.invalidAuth) return Promise.reject(permanent("ha_auth_invalid"));
    if (connection.connectPromise !== undefined) return connection.connectPromise;

    connection.phase = "connecting";
    let resolveConnect!: () => void;
    let rejectConnect!: (error: ConnectionFailure) => void;
    const connectPromise = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    connection.connectPromise = connectPromise;
    connection.connectResolve = resolveConnect;
    connection.connectReject = rejectConnect;

    let socket: WebSocketLike;
    try {
      socket = this.#webSocketFactory(connection.destination.wsUrl);
      connection.socket = socket;
      this.#listen(connection, socket);
      if (socket.readyState === WEBSOCKET_OPEN) this.#onOpen(connection, {});
    } catch {
      this.#onSocketFailure(connection, "ha_connect_failed");
    }
    return connectPromise;
  }

  #listen(connection: Connection, socket: WebSocketLike): void {
    socket.addEventListener("open", connection.onOpen);
    socket.addEventListener("message", connection.onMessage);
    socket.addEventListener("error", connection.onError);
    socket.addEventListener("close", connection.onClose);
  }

  #unlisten(connection: Connection, socket: WebSocketLike): void {
    socket.removeEventListener?.("open", connection.onOpen);
    socket.removeEventListener?.("message", connection.onMessage);
    socket.removeEventListener?.("error", connection.onError);
    socket.removeEventListener?.("close", connection.onClose);
  }

  #onOpen(connection: Connection, _event: WebSocketEventLike): void {
    if (connection.closed || connection.socket === undefined) return;
    connection.phase = "authenticating";
    connection.authRequired = false;
    connection.authSent = false;
    this.#armAuthTimer(connection);
  }

  #onMessage(connection: Connection, event: WebSocketEventLike): void {
    if (connection.closed) return;
    const message = objectMessage(event);
    if (message === undefined || typeof message.type !== "string") return;

    if (message.type === "auth_required") {
      if (connection.phase !== "authenticating" || connection.authSent) return;
      connection.authRequired = true;
      connection.authSent = true;
      try {
        connection.socket?.send(
          JSON.stringify({ type: "auth", access_token: connection.destination.token }),
        );
      } catch {
        this.#onSocketFailure(connection, "ha_auth_send_failed");
      }
      return;
    }

    if (message.type === "auth_ok") {
      if (connection.phase !== "authenticating" || !connection.authRequired || !connection.authSent)
        return;
      this.#clearAuthTimer(connection);
      connection.phase = "ready";
      connection.reconnectAttempts = 0;
      connection.reconnectExponent = 0;
      this.#clearReconnectTimer(connection);
      this.#finishConnectSuccess(connection);
      this.#emitState(connection, successResult());
      return;
    }

    if (message.type === "auth_invalid") {
      connection.invalidAuth = true;
      connection.phase = "closed";
      this.#clearAuthTimer(connection);
      this.#finishConnectFailure(connection, permanent("ha_auth_invalid"));
      this.#rejectPending(connection, failureResult("permanent_failure", "ha_auth_invalid"));
      this.#emitState(connection, failureResult("permanent_failure", "ha_auth_invalid"));
      this.#closeSocket(connection);
      return;
    }

    if (message.type !== "result" || !isInteger(message.id)) return;
    const pending = connection.pending.get(message.id);
    if (pending === undefined) return;
    connection.pending.delete(message.id);
    this.#cancel(pending.timer);
    const success = message.success === true;
    pending.resolve(
      success ? successResult() : failureResult("permanent_failure", "ha_result_failed"),
    );
  }

  #onSocketFailure(connection: Connection, errorCode: string): void {
    if (connection.closed || connection.invalidAuth) return;
    if (
      connection.socket === undefined &&
      connection.phase === "idle" &&
      connection.connectPromise === undefined
    ) {
      return;
    }
    const hadSocket = connection.socket !== undefined;
    this.#clearAuthTimer(connection);
    connection.phase = "idle";
    this.#finishConnectFailure(connection, failure(errorCode));
    this.#rejectPending(connection, failureResult("retryable_failure", errorCode));
    this.#emitState(connection, failureResult("retryable_failure", errorCode));
    if (hadSocket) this.#closeSocket(connection);
    this.#scheduleReconnect(connection);
  }

  #emitState(connection: Connection, result: TransportAttemptResult): void {
    if (
      this.#stopped ||
      connection.closed ||
      this.#connections.get(connection.destination.destinationId) !== connection
    ) {
      return;
    }
    const destination = connection.destination;
    const event: HomeAssistantConnectionStateEvent = {
      destinationId: destination.destinationId,
      ...(destination.destinationVersionId === undefined
        ? {}
        : { destinationVersionId: destination.destinationVersionId }),
      ...(destination.bindingGeneration === undefined
        ? {}
        : { bindingGeneration: destination.bindingGeneration }),
      result: sanitizeResult(result),
    };
    try {
      this.#onConnectionStateChanged?.(event);
    } catch {
      // Connection evidence must not change transport control flow.
    }
  }

  #finishConnectSuccess(connection: Connection): void {
    const resolve = connection.connectResolve;
    connection.connectResolve = undefined;
    connection.connectReject = undefined;
    connection.connectPromise = undefined;
    resolve?.();
  }

  #finishConnectFailure(connection: Connection, error: ConnectionFailure): void {
    const reject = connection.connectReject;
    connection.connectResolve = undefined;
    connection.connectReject = undefined;
    connection.connectPromise = undefined;
    reject?.(error);
  }

  #armAuthTimer(connection: Connection): void {
    this.#clearAuthTimer(connection);
    connection.authTimer = this.#schedule(() => {
      if (connection.phase !== "ready" && !connection.closed) {
        this.#onSocketFailure(connection, "ha_auth_timeout");
      }
    }, this.#authTimeoutMs);
  }

  #clearAuthTimer(connection: Connection): void {
    if (connection.authTimer !== undefined) this.#cancel(connection.authTimer);
    connection.authTimer = undefined;
  }

  #clearReconnectTimer(connection: Connection): void {
    if (connection.reconnectTimer !== undefined) this.#cancel(connection.reconnectTimer);
    connection.reconnectTimer = undefined;
  }

  #allocateRequestId(connection: Connection): number | undefined {
    for (let attempt = 0; attempt < 2_147_483_647; attempt += 1) {
      const candidate = connection.nextRequestId;
      connection.nextRequestId = candidate >= 2_147_483_647 ? 1 : candidate + 1;
      if (!connection.pending.has(candidate)) return candidate;
    }
    return undefined;
  }

  #fireEvent(connection: Connection, eventJson: string): Promise<TransportAttemptResult> {
    const socket = connection.socket;
    if (connection.phase !== "ready" || socket === undefined) {
      return Promise.resolve(failureResult("retryable_failure", "ha_not_ready"));
    }
    if (connection.pending.size >= this.#maxPendingRequests) {
      return Promise.resolve(failureResult("retryable_failure", "ha_pending_limit"));
    }

    const id = this.#allocateRequestId(connection);
    if (id === undefined) {
      return Promise.resolve(failureResult("retryable_failure", "ha_id_exhausted"));
    }

    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(eventJson) as unknown;
    } catch {
      return Promise.resolve(failureResult("permanent_failure", "ha_invalid_event"));
    }
    let frame: string;
    try {
      frame = canonicalizeJson(
        { event_data: parsedEvent, event_type: "tapboard_event", id, type: "fire_event" },
        { maxBytes: MAX_FRAME_BYTES },
      );
    } catch {
      return Promise.resolve(failureResult("permanent_failure", "ha_invalid_event"));
    }

    return new Promise<TransportAttemptResult>((resolve) => {
      const timer = this.#schedule(() => {
        const pending = connection.pending.get(id);
        if (pending === undefined) return;
        connection.pending.delete(id);
        pending.resolve(failureResult("retryable_failure", "ha_request_timeout"));
        this.#onSocketFailure(connection, "ha_request_timeout");
      }, this.#requestTimeoutMs);
      connection.pending.set(id, { timer, resolve });
      try {
        socket.send(frame);
      } catch {
        const pending = connection.pending.get(id);
        if (pending !== undefined) {
          connection.pending.delete(id);
          this.#cancel(pending.timer);
          pending.resolve(failureResult("retryable_failure", "ha_send_failed"));
        }
        this.#onSocketFailure(connection, "ha_send_failed");
      }
    });
  }

  #rejectPending(connection: Connection, result: TransportAttemptResult): void {
    for (const [id, pending] of connection.pending) {
      connection.pending.delete(id);
      this.#cancel(pending.timer);
      pending.resolve(result);
    }
  }

  #scheduleReconnect(connection: Connection): void {
    if (
      this.#stopped ||
      connection.closed ||
      connection.invalidAuth ||
      this.#connections.get(connection.destination.destinationId) !== connection ||
      connection.reconnectTimer !== undefined ||
      connection.phase === "ready"
    ) {
      return;
    }
    connection.reconnectAttempts += 1;
    connection.reconnectExponent = Math.min(connection.reconnectExponent + 1, 31);
    const delay = Math.min(
      this.#reconnectDelayMs * 2 ** Math.max(0, connection.reconnectExponent - 1),
      this.#maxReconnectDelayMs,
    );
    const destinationId = connection.destination.destinationId;
    connection.reconnectTimer = this.#schedule(() => {
      connection.reconnectTimer = undefined;
      if (
        connection.closed ||
        connection.invalidAuth ||
        this.#stopped ||
        this.#connections.get(destinationId) !== connection
      )
        return;
      void this.#ensureReady(connection).catch(() => this.#scheduleReconnect(connection));
    }, delay);
  }

  #closeSocket(connection: Connection): void {
    const socket = connection.socket;
    connection.socket = undefined;
    if (socket === undefined) return;
    this.#unlisten(connection, socket);
    try {
      socket.close(1000, "Tapboard shutdown");
    } catch {
      // The adapter is already closing; no provider error is safe to expose.
    }
  }

  #closeConnection(connection: Connection, errorCode: string): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.phase = "closed";
    this.#clearAuthTimer(connection);
    this.#clearReconnectTimer(connection);
    this.#finishConnectFailure(connection, failure(errorCode));
    this.#rejectPending(connection, failureResult("retryable_failure", errorCode));
    this.#closeSocket(connection);
  }
}

export function createHomeAssistantConnectionManager(
  options: HomeAssistantTransportOptions = {},
): HomeAssistantConnectionManager {
  return new HomeAssistantConnectionManager(options);
}
