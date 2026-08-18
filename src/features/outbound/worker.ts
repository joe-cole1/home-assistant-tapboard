import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { EventEnvelope } from "../events/types.ts";
import {
  applyDeliveryResult,
  claimDue,
  listDestinations,
  markTokenMissing,
  readClaimConfiguration,
  readDestinationProfile,
  recordFailure,
  recordSuccess,
  releaseClaim,
  setEnabledState,
  type DeliveryClaim,
  type OutboundSecretDescriptorLike,
} from "./repository.ts";
import type {
  OutboundDestination,
  OutboundDestinationVersion,
  OutboundFailureClass,
  OutboundIntegrationState,
  OutboundSecretStore,
  OutboundTransportOutcome,
  OutboundTransportRouter,
  OutboundTransportSendInput,
  OutboundWorkerClock,
  OutboundWorkerOptions,
} from "./types.ts";
import { HA_TOKEN_SLOT, WEBHOOK_ENDPOINT_SLOT } from "./outbound-validation.ts";
import { boundedErrorCode, type TransportAttemptResult } from "./transport-types.ts";
import type { HomeAssistantConnectionStateEvent } from "./transports/home-assistant.ts";

const DEFAULT_OWNER = "outbound-worker";
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function now(clock: OutboundWorkerClock | undefined): Date {
  const value = clock?.now() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid outbound worker clock");
  return new Date(value.getTime());
}

function descriptors(
  secrets: OutboundSecretStore | undefined,
): readonly OutboundSecretDescriptorLike[] {
  const rows = secrets?.listDescriptors?.() ?? secrets?.list?.() ?? [];
  return rows.map((row) => ({
    integrationType: row.integrationType,
    recordId: row.recordId,
    fieldName: row.fieldName,
    configured: row.configured,
    available: row.available,
  }));
}

function normalizeResult(value: TransportAttemptResult | OutboundTransportOutcome): {
  readonly outcome: "success" | "retry" | "failure" | "permanent";
  readonly code: string;
  readonly failureClass: OutboundFailureClass;
} {
  if (value.outcome === "success") return { outcome: "success", code: "", failureClass: "unknown" };
  if (value.outcome === "retryable_failure" || value.outcome === "retry") {
    return {
      outcome: "retry",
      code: boundedErrorCode(value.errorCode),
      failureClass: "connectivity",
    };
  }
  const code = boundedErrorCode(value.errorCode, "delivery_failed");
  const status = "status" in value ? value.status : undefined;
  const authentication =
    code.includes("auth") ||
    code.includes("token") ||
    code.includes("unauthorized") ||
    code.includes("forbidden") ||
    status === 401 ||
    status === 403;
  return {
    outcome: value.outcome === "permanent_failure" ? "permanent" : "failure",
    code,
    // A permanent delivery outcome (for example an ordinary webhook 4xx) is
    // still meaningful transport evidence. It must remain visible and start
    // the Required-destination degradation clock even though this individual
    // delivery will not be retried.
    failureClass: authentication ? "authentication" : "connectivity",
  };
}

function promiseLike<T>(value: T | PromiseLike<T>): Promise<T> {
  return Promise.resolve(value);
}

export class OutboundWorker {
  readonly #database: DatabaseExecutor;
  readonly #transports: OutboundTransportRouter;
  readonly #secrets: OutboundSecretStore | undefined;
  readonly #owner: string;
  readonly #leaseTtlMs: number;
  readonly #concurrency: number;
  readonly #pollIntervalMs: number;
  readonly #clock: OutboundWorkerClock | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onStatusChanged: OutboundWorkerOptions["onStatusChanged"];
  readonly #inFlightDestinations = new Set<string>();
  #running = false;
  #stopRequested = false;
  #polling = false;
  #timer: unknown = undefined;

  constructor(options: OutboundWorkerOptions) {
    this.#database = options.database;
    this.#transports = options.transports;
    this.#secrets = options.secrets;
    this.#owner = options.owner ?? DEFAULT_OWNER;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#clock = options.clock;
    this.#onError = options.onError;
    this.#onStatusChanged = options.onStatusChanged;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs < 1_000)
      throw new TypeError("Invalid outbound lease TTL");
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 32)
      throw new TypeError("Invalid outbound concurrency");
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1)
      throw new TypeError("Invalid outbound poll interval");
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#stopRequested = false;
    this.#running = true;
    this.#timer = this.#setInterval(() => {
      void this.pollOnce().catch((error: unknown) => this.#onError?.(error));
    }, this.#pollIntervalMs);
    void this.#probeEnabledHomeAssistant().catch((error: unknown) => this.#onError?.(error));
    void this.pollOnce().catch((error: unknown) => this.#onError?.(error));
  }

  stop(): void {
    if (!this.#running) return;
    this.#stopRequested = true;
    this.#running = false;
    if (this.#timer !== undefined) this.#clearInterval(this.#timer);
    this.#timer = undefined;
    this.#transports.stop?.();
  }

  async pollOnce(): Promise<number> {
    if (this.#polling) return 0;
    this.#polling = true;
    try {
      const current = now(this.#clock);
      const availableCapacity = this.#concurrency - this.#inFlightDestinations.size;
      if (availableCapacity < 1) return 0;
      const claims = claimDue(
        this.#database,
        this.#owner,
        current.toISOString(),
        this.#leaseTtlMs,
        availableCapacity,
      );
      const tasks: Promise<void>[] = [];
      for (const claim of claims) {
        if (this.#inFlightDestinations.has(claim.destinationId)) {
          releaseClaim(this.#database, claim, current.toISOString());
          continue;
        }
        this.#inFlightDestinations.add(claim.destinationId);
        tasks.push(
          this.#processClaim(claim).finally(() =>
            this.#inFlightDestinations.delete(claim.destinationId),
          ),
        );
      }
      await Promise.all(tasks);
      return tasks.length;
    } finally {
      this.#polling = false;
    }
  }

  /** Lifecycle callback used by the application when a destination is enabled. */
  onDestinationEnabled(destinationId: string): void {
    void this.#probeHomeAssistant(destinationId).catch((error: unknown) => this.#onError?.(error));
  }

  /** Rebind HA after token replacement; webhooks are intentionally not probed. */
  onDestinationCredentialsChanged(destinationId: string): void {
    this.#transports.closeDestination?.(destinationId);
    this.onDestinationEnabled(destinationId);
  }

  /** Lifecycle callback used by the application when disabled or retired. */
  onDestinationDisabled(destinationId: string): void {
    this.#transports.closeDestination?.(destinationId);
  }

  closeDestination(destinationId: string): void {
    this.onDestinationDisabled(destinationId);
  }

  /** Durable evidence from the current persistent HA connection binding. */
  onHomeAssistantConnectionState(event: HomeAssistantConnectionStateEvent): void {
    this.#database.withTransaction(() => {
      const timestamp = now(this.#clock).toISOString();
      const destination = listDestinations(this.#database, {
        secrets: descriptors(this.#secrets),
        now: new Date(timestamp),
      }).find((item) => item.id === event.destinationId);
      if (
        destination === undefined ||
        !destination.enabled ||
        destination.retiredAt !== null ||
        destination.transport !== "home_assistant" ||
        destination.currentVersion === null ||
        destination.currentVersion.id !== event.destinationVersionId
      ) {
        return;
      }
      const profileRevision = readDestinationProfile(
        this.#database,
        event.destinationId,
      )?.profile_revision;
      if (profileRevision === undefined) return;
      const normalized = normalizeResult(event.result);
      this.#recordTransportStatus(event.destinationId, normalized, timestamp, profileRevision);
    });
  }

  async #processClaim(claim: DeliveryClaim): Promise<void> {
    const timestamp = now(this.#clock).toISOString();
    const config = readClaimConfiguration(this.#database, claim, descriptors(this.#secrets));
    if (
      config === undefined ||
      !config.destination.enabled ||
      config.destination.retiredAt !== null ||
      config.destination.disabledAt !== null
    ) {
      releaseClaim(this.#database, claim, timestamp);
      return;
    }
    let input: OutboundTransportSendInput;
    try {
      input = this.#transportInput(config.destination, config.version, claim.envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "missing outbound secret";
      if (message === "missing token") {
        markTokenMissing(this.#database, claim.destinationId, timestamp);
        setEnabledState(this.#database, claim.destinationId, false, timestamp, "token_missing");
      }
      if (message === "missing header token" || message === "missing endpoint") {
        recordFailure(
          this.#database,
          claim.destinationId,
          message === "missing endpoint" ? "endpoint_missing" : "header_secret_missing",
          "authentication",
          timestamp,
        );
        setEnabledState(this.#database, claim.destinationId, false, timestamp, "secret_missing");
      }
      releaseClaim(this.#database, claim, timestamp);
      this.#transports.closeDestination?.(claim.destinationId);
      return;
    }

    let result: TransportAttemptResult | OutboundTransportOutcome;
    try {
      result = await promiseLike(this.#transports.send(input));
    } catch {
      result = { outcome: "retryable_failure", errorCode: "transport_exception" };
    }
    // Graceful shutdown deliberately leaves an unresolved lease for normal
    // expiry/reclaim. Transport teardown is not evidence of a delivery
    // failure and must not consume retry horizon or terminalize work.
    if (this.#stopRequested) return;
    const normalized = normalizeResult(result);
    this.#database.withTransaction(() => {
      // Sample time only after SQLite grants the write transaction. A wait on
      // BEGIN IMMEDIATE must not let an already-expired lease complete using a
      // stale pre-lock timestamp.
      const completionTimestamp = now(this.#clock).toISOString();
      const applied = applyDeliveryResult(this.#database, {
        deliveryId: claim.deliveryId,
        owner: claim.leaseOwner,
        revision: claim.revision,
        outcome: normalized.outcome,
        ...(normalized.outcome === "success" ? {} : { errorCode: normalized.code }),
        now: completionTimestamp,
      });
      if (!applied) return;
      this.#recordTransportStatus(
        claim.destinationId,
        normalized,
        completionTimestamp,
        config.profileRevision,
      );
    });
    if (
      !this.#stopRequested &&
      config.destination.transport === "home_assistant" &&
      config.version.id !== config.destination.currentVersion?.id
    ) {
      await this.#probeHomeAssistant(claim.destinationId);
    }
  }

  #transportInput(
    destination: OutboundDestination,
    version: OutboundDestinationVersion,
    envelope: EventEnvelope,
  ): OutboundTransportSendInput {
    const config = version.config;
    const secretHeaders: Record<string, string> = {};
    for (const header of config.secretHeaders) {
      if (!header.configured || header.available !== true) throw new Error("missing header token");
      if (this.#secrets === undefined) throw new Error("missing header token");
      secretHeaders[header.name] = this.#secrets.revealPrivileged(
        "outbound",
        destination.id,
        header.slot,
      );
    }
    const headers: Record<string, string> = {};
    for (const header of config.staticHeaders) headers[header.name] = header.value;
    Object.assign(headers, secretHeaders);
    if (config.transport === "home_assistant") {
      if (!config.authConfigured || !config.authAvailable || this.#secrets === undefined)
        throw new Error("missing token");
      const token = this.#secrets.revealPrivileged("outbound", destination.id, HA_TOKEN_SLOT);
      return {
        destination,
        version,
        envelope,
        token,
        secretHeaders,
        headers,
        endpoint: config.baseUrl,
      };
    }
    if (!config.endpointConfigured || !config.endpointAvailable || this.#secrets === undefined)
      throw new Error("missing endpoint");
    const endpoint = this.#secrets.revealPrivileged("outbound", version.id, WEBHOOK_ENDPOINT_SLOT);
    return {
      destination,
      version,
      envelope,
      secretHeaders,
      headers,
      endpoint,
      payloadFormat: config.payloadFormat,
    };
  }

  async #probeEnabledHomeAssistant(): Promise<void> {
    const destinations = listDestinations(this.#database, {
      secrets: descriptors(this.#secrets),
      now: now(this.#clock),
    });
    await Promise.all(
      destinations
        .filter(
          (destination) =>
            destination.enabled &&
            destination.retiredAt === null &&
            destination.transport === "home_assistant",
        )
        .map((destination) => this.#probeHomeAssistant(destination.id)),
    );
  }

  async #probeHomeAssistant(destinationId: string): Promise<void> {
    if (this.#transports.ensureHealthy === undefined && this.#transports.connect === undefined)
      return;
    const destination = listDestinations(this.#database, {
      secrets: descriptors(this.#secrets),
      now: now(this.#clock),
    }).find((item) => item.id === destinationId);
    if (
      destination === undefined ||
      !destination.enabled ||
      destination.retiredAt !== null ||
      destination.transport !== "home_assistant" ||
      destination.currentVersion === null
    )
      return;
    const version = destination.currentVersion;
    if (version.config.transport !== "home_assistant") return;
    const profileRevision = readDestinationProfile(this.#database, destinationId)?.profile_revision;
    if (profileRevision === undefined) return;
    if (
      this.#secrets === undefined ||
      !version.config.authConfigured ||
      !version.config.authAvailable
    ) {
      const timestamp = now(this.#clock).toISOString();
      markTokenMissing(this.#database, destinationId, timestamp);
      setEnabledState(this.#database, destinationId, false, timestamp, "token_missing");
      this.#transports.closeDestination?.(destinationId);
      return;
    }
    let result: TransportAttemptResult | OutboundTransportOutcome;
    try {
      const input = {
        destination,
        version,
        token: this.#secrets.revealPrivileged("outbound", destinationId, HA_TOKEN_SLOT),
        secretHeaders: {},
        endpoint: version.config.baseUrl,
      };
      result =
        this.#transports.ensureHealthy === undefined
          ? await promiseLike(this.#transports.connect!(input))
          : await promiseLike(this.#transports.ensureHealthy(input));
    } catch {
      result = { outcome: "retryable_failure", errorCode: "ha_probe_failed" };
    }
    const normalized = normalizeResult(result);
    const timestamp = now(this.#clock).toISOString();
    this.#database.withTransaction(() => {
      this.#recordTransportStatus(destinationId, normalized, timestamp, profileRevision);
    });
  }

  #recordTransportStatus(
    destinationId: string,
    result: ReturnType<typeof normalizeResult>,
    timestamp: string,
    expectedRevision?: number,
  ): void {
    const before = this.#integrationStatus(destinationId, timestamp);
    const applied =
      result.outcome === "success"
        ? recordSuccess(this.#database, destinationId, timestamp, expectedRevision)
        : recordFailure(
            this.#database,
            destinationId,
            result.code,
            result.failureClass,
            timestamp,
            expectedRevision,
          );
    if (!applied) return;
    const after = this.#integrationStatus(destinationId, timestamp);
    if (before === undefined || after === undefined || before.state === after.state) return;
    this.#onStatusChanged?.(this.#database, {
      destinationId,
      integrationType: after.transport,
      previousState: before.state,
      state: after.state,
      ...(after.state === "degraded" ? { reasonCode: result.code } : {}),
      occurredAt: timestamp,
    });
  }

  #integrationStatus(
    destinationId: string,
    timestamp: string,
  ):
    | {
        readonly state: OutboundIntegrationState;
        readonly transport: OutboundDestination["transport"];
      }
    | undefined {
    const destination = listDestinations(this.#database, {
      secrets: descriptors(this.#secrets),
      now: new Date(timestamp),
    }).find((item) => item.id === destinationId);
    if (destination === undefined) return undefined;
    const state =
      destination.state === "disabled"
        ? "disabled"
        : destination.state === "healthy" || destination.state === "unknown"
          ? "healthy"
          : "degraded";
    return { state, transport: destination.transport };
  }

  #setInterval(callback: () => void, delayMs: number): unknown {
    return this.#clock?.setInterval?.(callback, delayMs) ?? setInterval(callback, delayMs);
  }

  #clearInterval(handle: unknown): void {
    if (this.#clock?.clearInterval !== undefined) this.#clock.clearInterval(handle);
    else clearInterval(handle as NodeJS.Timeout);
  }
}

export function createOutboundWorker(options: OutboundWorkerOptions): OutboundWorker {
  return new OutboundWorker(options);
}
