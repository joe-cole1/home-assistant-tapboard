import { randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { appendActivity } from "../activity/operations.ts";
import { createEventEnvelope } from "../events/envelope.ts";
import type { EventEnvelope, EventType } from "../events/types.ts";
import type { EventIdentifiers } from "../events/types.ts";
import { findActiveAssignmentByTapId } from "../taps/repository.ts";
import { findFillById } from "../fills/repository.ts";
import type {
  AssignmentClosedEventContext,
  AssignmentOpenedEventContext,
  CompletedPourEventContext,
  CreateConfiguredOutboundDestinationInput,
  CreateOutboundDestinationInput,
  EditOutboundDestinationInput,
  HealthTransitionEventContext,
  IntegrationStatusEventContext,
  OutboundAdmissionPort,
  OutboundAdmissionResult,
  OutboundConfig,
  OutboundDestination,
  OutboundDestinationListItem,
  OutboundDestinationPatch,
  OutboundEventInput,
  OutboundHeaderSecretReplacement,
  OutboundSecretStore,
  OutboundServiceOptions,
  UpdateConfiguredOutboundDestinationInput,
} from "./types.ts";
import {
  HA_TOKEN_SLOT,
  MAX_OUTBOUND_DESTINATIONS,
  WEBHOOK_ENDPOINT_SLOT,
  MAX_HEADER_TOTAL_BYTES,
  configuredHeaderBytes,
  normalizeCreateInput,
  normalizeDestinationConfig,
  validateDestinationId,
  validateDestinationLabel,
  validateOutboundTransport,
  validateHeaderSecretValue,
  validateHomeAssistantToken,
  parseOutboundUrl,
  validateSubscriptions,
} from "./outbound-validation.ts";
import {
  admitOutboxIntent,
  deliveryBelongsToDestination,
  insertDestinationBase,
  insertVersionConfig,
  listDeliveryHistory,
  listDestinationPage,
  listDestinationProfiles,
  listDestinationConfigJson,
  listDestinationVersionIds,
  listUnfinishedSecretSlots,
  listDestinations,
  markTokenMissing,
  nextVersionNumber,
  projectConnectivity,
  readCurrentDestinationVersion,
  readDestination,
  recordFailure as recordFailureRow,
  recordSuccess as recordSuccessRow,
  resolveTargets,
  setEnabledState,
  setRetired,
  shiftDestinationDeliveries,
  touchDestinationProfile,
  updateDestinationLabelRequired,
  type OutboundSecretDescriptorLike,
} from "./repository.ts";
import {
  dismissDelivery as dismissOutboxDelivery,
  retryDelivery as retryOutboxDelivery,
} from "../outbox/repository.ts";

const DEFAULT_NOW = (): Date => new Date();

function clock(factory: (() => Date) | undefined): Date {
  const value = factory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid outbound clock");
  return new Date(value.getTime());
}

function iso(factory: (() => Date) | undefined): string {
  return clock(factory).toISOString();
}

function safeSecretDescriptors(
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

function canonicalId(value: string | undefined, factory: () => string): string {
  const result = value ?? factory();
  return validateDestinationId(result, "destinationId");
}

function secretAvailable(
  secrets: OutboundSecretStore | undefined,
  recordId: string,
  fieldName: string,
): boolean {
  return safeSecretDescriptors(secrets).some(
    (row) =>
      row.integrationType === "outbound" &&
      row.recordId === recordId &&
      row.fieldName === fieldName &&
      row.configured &&
      row.available,
  );
}

function requireSecretStore(secrets: OutboundSecretStore | undefined): OutboundSecretStore {
  if (secrets === undefined) throw new Error("Outbound secret storage is unavailable");
  return secrets;
}

function normalizedHeaderReplacements(
  values: readonly OutboundHeaderSecretReplacement[] | undefined,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const item of values ?? []) {
    if (typeof item !== "object" || item === null) {
      throw new TypeError("Invalid outbound header secret replacement");
    }
    const name = item.name.trim().toLowerCase();
    if (name.length === 0 || result.has(name)) {
      throw new TypeError("Invalid outbound header secret replacement name");
    }
    result.set(name, validateHeaderSecretValue(item.value));
  }
  return result;
}

function appendOutboundActivity(
  database: DatabaseExecutor,
  action: string,
  destinationId: string,
  occurredAt: string,
  details: Record<string, string | number | boolean | null> = {},
): void {
  appendActivity(database, {
    category: action === "configuration_changed" ? "admin" : "integration",
    action,
    actorType: "system",
    entityType: "outbound_destination",
    entityId: destinationId,
    details,
    occurredAt,
  });
}

function fillIdentifiers(
  database: DatabaseExecutor,
  fillId: string,
  tapId?: string,
): EventIdentifiers {
  const fill = findFillById(database, fillId);
  return {
    ...(tapId === undefined ? {} : { tap_id: tapId }),
    fill_id: fillId,
    ...(fill === undefined ? {} : { keg_id: fill.kegId, beverage_id: fill.beverageId }),
  };
}

function activeFillForTap(
  database: DatabaseExecutor,
  tapId: string,
): { readonly fillId: string; readonly kegId: string; readonly beverageId: string } | undefined {
  const assignment = findActiveAssignmentByTapId(database, tapId);
  if (assignment === undefined) return undefined;
  const fill = findFillById(database, assignment.fillId);
  return fill === undefined
    ? undefined
    : { fillId: fill.id, kegId: fill.kegId, beverageId: fill.beverageId };
}

function changedSemantic(
  previousState: string | null | undefined,
  previousSeverity: string | null | undefined,
  state: string,
  severity: string,
): boolean {
  return (
    previousState === undefined ||
    previousState === null ||
    previousSeverity === undefined ||
    previousSeverity === null ||
    previousState !== state ||
    previousSeverity !== severity
  );
}

function healthState(value: string): "healthy" | "degraded" | "active" | undefined {
  return value === "healthy" || value === "degraded" || value === "active" ? value : undefined;
}

function healthSeverity(value: string): "none" | "info" | "warning" | "critical" | undefined {
  return value === "none" || value === "info" || value === "warning" || value === "critical"
    ? value
    : undefined;
}

function numberEvidence(evidence: unknown, names: readonly string[]): number | undefined {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence))
    return undefined;
  const record = evidence as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
      return value;
  }
  return undefined;
}

function eventEnvelope(
  eventType: EventType,
  identifiers: EventIdentifiers,
  data: unknown,
  occurredAt: string,
  idFactory: () => string,
  coalescingKey?: string,
): EventEnvelope {
  return createEventEnvelope(
    {
      event_type: eventType,
      identifiers,
      data,
      occurred_at: occurredAt,
      ...(coalescingKey === undefined ? {} : { coalescing_key: coalescingKey }),
    },
    { idFactory, now: () => new Date(occurredAt) },
  );
}

function integrationEventState(
  destination: OutboundDestination,
): "healthy" | "degraded" | "disabled" {
  if (!destination.enabled || destination.retiredAt !== null || destination.state === "disabled") {
    return "disabled";
  }
  return destination.state === "healthy" || destination.state === "unknown"
    ? "healthy"
    : "degraded";
}

export class OutboundService implements OutboundAdmissionPort {
  readonly #database: DatabaseExecutor;
  readonly #options: OutboundServiceOptions;
  readonly #now: () => Date;
  readonly #ids: () => string;
  #lifecycleSuppression = 0;

  constructor(database: DatabaseExecutor, options: OutboundServiceOptions = {}) {
    this.#database = database;
    this.#options = options;
    this.#now = options.now ?? DEFAULT_NOW;
    this.#ids = options.idFactory ?? randomUUID;
  }

  get database(): DatabaseExecutor {
    return this.#database;
  }

  create(input: CreateOutboundDestinationInput): OutboundDestination {
    const normalized = normalizeCreateInput(input);
    const now = iso(this.#now);
    const destinationId = canonicalId(input.id, this.#ids);
    const missingToken =
      normalized.transport === "home_assistant" && normalized.secret === undefined;
    const missingHeaderSecret = normalized.config.secretHeaders.length > 0;
    const enabled = normalized.enabled && !missingToken && !missingHeaderSecret;
    const result = this.#database.withTransaction(() => {
      const activeCount = listDestinationProfiles(this.#database).filter(
        (row) => row.retired_at === null,
      ).length;
      if (activeCount >= MAX_OUTBOUND_DESTINATIONS)
        throw new Error("Outbound destination limit reached");
      insertDestinationBase(this.#database, {
        id: destinationId,
        label: normalized.label,
        enabled,
        required: normalized.required,
        transport: normalized.transport,
        now,
      });
      insertVersionConfig(this.#database, {
        id: this.#ids(),
        destinationId,
        versionNumber: 1,
        createdAt: now,
        config: normalized.config,
        subscriptions: normalized.subscriptions,
        required: normalized.required,
      });
      this.#storeInitialSecret(destinationId, normalized.config, normalized.secret, now);
      if (!enabled) {
        const reason = missingToken
          ? "token_missing"
          : missingHeaderSecret
            ? "secret_missing"
            : "created_disabled";
        setEnabledState(this.#database, destinationId, false, now, reason);
        if (missingToken) markTokenMissing(this.#database, destinationId, now);
      }
      appendOutboundActivity(this.#database, "configuration_changed", destinationId, now, {
        change: "created",
        transport: normalized.config.transportKind,
        required: normalized.required,
        enabled,
      });
      return this.#requireDestination(destinationId);
    });
    if (result.enabled && result.transport === "home_assistant") {
      this.#emitLifecycle("enabled", destinationId);
    }
    return result;
  }

  /** Apply one complete Admin create submission atomically, including write-only headers. */
  createConfigured(input: CreateConfiguredOutboundDestinationInput): OutboundDestination {
    const { headerSecrets, ...destinationInput } = input;
    const normalized = normalizeCreateInput(destinationInput);
    const replacements = normalizedHeaderReplacements(headerSecrets);
    const valuesBySlot = this.#resolveReplacementSlots(
      normalized.config.secretHeaders,
      replacements,
    );
    this.#assertHeaderTotal(
      normalized.config.staticHeaders,
      normalized.config.secretHeaders,
      valuesBySlot,
    );
    const requestedEnabled = normalized.enabled;
    const canEnable =
      (normalized.transport !== "home_assistant" || normalized.secret !== undefined) &&
      normalized.config.secretHeaders.every((header) => valuesBySlot.has(header.slot));

    return this.#withDeferredLifecycle(
      () =>
        this.#database.withTransaction(() => {
          const created = this.create({
            ...destinationInput,
            enabled: requestedEnabled && canEnable,
          });
          for (const [slot, value] of valuesBySlot) {
            this.setHeaderSecret(created.id, slot, value);
          }
          if (requestedEnabled && canEnable && !created.enabled) {
            this.enable(created.id);
          }
          return this.#requireDestination(created.id);
        }),
      (created) => {
        if (created.enabled && created.transport === "home_assistant") {
          this.#emitLifecycle("enabled", created.id);
        }
      },
    );
  }

  createDestination(input: CreateOutboundDestinationInput): OutboundDestination {
    return this.create(input);
  }

  edit(destinationId: string, input: EditOutboundDestinationInput): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    let removedSecretSlot = false;
    let versioned = false;
    let previousTransport: OutboundDestination["transport"] | undefined;
    const result = this.#database.withTransaction(() => {
      const current = this.#requireMutableDestination(id);
      previousTransport = current.transport;
      const currentVersion = current.currentVersion;
      if (currentVersion === null) throw new Error("Outbound destination configuration is missing");
      const currentConfig = currentVersion.config;
      const label =
        input.label === undefined ? current.label : validateDestinationLabel(input.label);
      const required = input.required === undefined ? current.required : input.required;
      if (typeof required !== "boolean") throw new TypeError("required must be boolean");
      const transport =
        input.transport === undefined
          ? current.transport
          : validateOutboundTransport(input.transport);
      const configChanged =
        input.transport !== undefined ||
        input.baseUrl !== undefined ||
        input.webhookUrl !== undefined ||
        input.payloadFormat !== undefined ||
        input.staticHeaders !== undefined ||
        input.secretHeaders !== undefined;
      const subscriptionsChanged = input.subscriptions !== undefined;
      if (!configChanged && !subscriptionsChanged) {
        updateDestinationLabelRequired(this.#database, id, label, required, now);
        appendOutboundActivity(this.#database, "configuration_changed", id, now, {
          change: "metadata",
          required,
        });
        return this.#requireDestination(id);
      }
      let endpoint: string | undefined;
      if (transport === "webhook") {
        if (input.webhookUrl !== undefined) {
          endpoint = parseOutboundUrl(input.webhookUrl, "webhookUrl").url;
        } else if (currentConfig.transport === "webhook" && currentConfig.endpointConfigured) {
          endpoint = this.#revealSecret(currentVersion.id, WEBHOOK_ENDPOINT_SLOT);
        }
      }
      const config = normalizeDestinationConfig({
        transport,
        ...(input.baseUrl !== undefined
          ? { baseUrl: input.baseUrl }
          : currentConfig.transport === "home_assistant"
            ? { baseUrl: currentConfig.baseUrl }
            : {}),
        ...(input.webhookUrl !== undefined
          ? { webhookUrl: input.webhookUrl }
          : endpoint !== undefined
            ? { webhookUrl: endpoint }
            : {}),
        ...(input.payloadFormat !== undefined
          ? { payloadFormat: input.payloadFormat }
          : currentConfig.transport === "webhook"
            ? { payloadFormat: currentConfig.payloadFormat }
            : {}),
        staticHeaders: input.staticHeaders ?? currentConfig.staticHeaders,
        secretHeaders:
          input.secretHeaders ??
          currentConfig.secretHeaders.map((header) => ({ name: header.name, slot: header.slot })),
      });
      for (const header of config.secretHeaders) {
        const previous = currentConfig.secretHeaders.find(
          (candidate) => candidate.slot === header.slot,
        );
        if (previous !== undefined && previous.name.toLowerCase() !== header.name.toLowerCase()) {
          throw new Error("A secret header slot cannot be reused for another header");
        }
      }
      this.#assertHistoricalSecretSlots(id, config.secretHeaders);
      versioned = true;
      updateDestinationLabelRequired(this.#database, id, label, required, now);
      const versionId = this.#ids();
      insertVersionConfig(this.#database, {
        id: versionId,
        destinationId: id,
        versionNumber: nextVersionNumber(this.#database, id),
        createdAt: now,
        config,
        subscriptions: validateSubscriptions(input.subscriptions ?? current.subscriptions),
      });
      this.#copyVersionSecrets(currentVersion.id, versionId, currentConfig, config, endpoint);
      const store = this.#options.secrets;
      for (const previous of currentConfig.secretHeaders) {
        if (config.secretHeaders.some((header) => header.slot === previous.slot)) continue;
        removedSecretSlot = true;
        store?.remove("outbound", id, previous.slot, { now: this.#now });
      }
      if (removedSecretSlot) setEnabledState(this.#database, id, false, now, "secret_missing");
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "versioned",
        version: nextVersionNumber(this.#database, id) - 1,
        subscriptions_changed: subscriptionsChanged,
      });
      return this.#requireDestination(id);
    });
    if (
      removedSecretSlot ||
      (previousTransport === "home_assistant" && result.transport !== "home_assistant")
    ) {
      this.#emitLifecycle("disabled", id);
    } else if (versioned && result.enabled && result.transport === "home_assistant") {
      this.#emitLifecycle("credentials_changed", id);
    }
    return result;
  }

  editDestination(destinationId: string, input: EditOutboundDestinationInput): OutboundDestination {
    return this.edit(destinationId, input);
  }

  /** Apply one complete Admin edit submission atomically, including secrets and enabled state. */
  updateConfigured(
    destinationId: string,
    input: UpdateConfiguredOutboundDestinationInput,
  ): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    if (typeof input.enabled !== "boolean") throw new TypeError("enabled must be boolean");
    const { enabled, token, headerSecrets, ...editInput } = input;
    const before = this.#requireMutableDestination(id);
    const currentVersion = before.currentVersion;
    if (currentVersion === null) throw new Error("Outbound destination configuration is missing");
    const currentConfig = currentVersion.config;
    const transport =
      editInput.transport === undefined
        ? before.transport
        : validateOutboundTransport(editInput.transport);
    let endpoint: string | undefined;
    if (transport === "webhook") {
      endpoint =
        editInput.webhookUrl === undefined
          ? currentConfig.transport === "webhook" && currentConfig.endpointConfigured
            ? this.#revealSecret(currentVersion.id, WEBHOOK_ENDPOINT_SLOT)
            : undefined
          : parseOutboundUrl(editInput.webhookUrl, "webhookUrl").url;
    }
    const config = normalizeDestinationConfig({
      transport,
      ...(editInput.baseUrl !== undefined
        ? { baseUrl: editInput.baseUrl }
        : currentConfig.transport === "home_assistant"
          ? { baseUrl: currentConfig.baseUrl }
          : {}),
      ...(editInput.webhookUrl !== undefined
        ? { webhookUrl: editInput.webhookUrl }
        : endpoint === undefined
          ? {}
          : { webhookUrl: endpoint }),
      ...(editInput.payloadFormat !== undefined
        ? { payloadFormat: editInput.payloadFormat }
        : currentConfig.transport === "webhook"
          ? { payloadFormat: currentConfig.payloadFormat }
          : {}),
      staticHeaders: editInput.staticHeaders ?? currentConfig.staticHeaders,
      secretHeaders:
        editInput.secretHeaders ??
        currentConfig.secretHeaders.map((header) => ({ name: header.name, slot: header.slot })),
    });
    for (const header of config.secretHeaders) {
      const previous = currentConfig.secretHeaders.find(
        (candidate) => candidate.slot === header.slot,
      );
      if (previous !== undefined && previous.name.toLowerCase() !== header.name.toLowerCase()) {
        throw new Error("A secret header slot cannot be reused for another header");
      }
    }
    this.#assertHistoricalSecretSlots(id, config.secretHeaders);
    validateSubscriptions(editInput.subscriptions ?? before.subscriptions);
    const replacements = normalizedHeaderReplacements(headerSecrets);
    const replacementValues = this.#resolveReplacementSlots(config.secretHeaders, replacements);
    const finalHeaderValues = new Map(replacementValues);
    for (const header of config.secretHeaders) {
      if (finalHeaderValues.has(header.slot)) continue;
      if (secretAvailable(this.#options.secrets, id, header.slot)) {
        finalHeaderValues.set(header.slot, this.#revealSecret(id, header.slot));
      }
    }
    this.#assertHeaderTotal(config.staticHeaders, config.secretHeaders, finalHeaderValues);
    const submittedToken = token === undefined ? undefined : validateHomeAssistantToken(token);
    const finalTokenAvailable =
      submittedToken !== undefined ||
      (transport === "home_assistant" && secretAvailable(this.#options.secrets, id, HA_TOKEN_SLOT));
    if (token !== undefined && transport !== "home_assistant") {
      throw new Error("Only Home Assistant destinations have tokens");
    }
    if (enabled) {
      if (transport === "home_assistant" && !finalTokenAvailable) {
        throw new Error("Home Assistant token is required before enabling");
      }
      if (transport === "webhook" && endpoint === undefined) {
        throw new Error("Webhook endpoint is required before enabling");
      }
      if (config.secretHeaders.some((header) => !finalHeaderValues.has(header.slot))) {
        throw new Error("Every configured secret header requires a value before enabling");
      }
      const finalSlots = new Set(config.secretHeaders.map((header) => header.slot));
      const unavailableHistoricalSlot = listUnfinishedSecretSlots(this.#database, id).find(
        (slot) =>
          (currentConfig.secretHeaders.some((header) => header.slot === slot) &&
            !finalSlots.has(slot)) ||
          (!replacementValues.has(slot) && !secretAvailable(this.#options.secrets, id, slot)),
      );
      if (unavailableHistoricalSlot !== undefined) {
        throw new Error("Pending delivery requires a removed secret header value");
      }
    }

    return this.#withDeferredLifecycle(
      () =>
        this.#database.withTransaction(() => {
          this.edit(id, editInput);
          if (submittedToken !== undefined) this.setToken(id, submittedToken);
          const updatedConfig = this.#requireDestination(id).currentVersion?.config;
          if (updatedConfig === undefined)
            throw new Error("Outbound destination configuration is missing");
          for (const [slot, value] of replacementValues) {
            if (!updatedConfig.secretHeaders.some((header) => header.slot === slot)) {
              throw new Error("Header secret slot is not configured");
            }
            this.setHeaderSecret(id, slot, value);
          }
          const current = this.#requireDestination(id);
          if (current.enabled !== enabled) this.setEnabled(id, enabled);
          return this.#requireDestination(id);
        }),
      (updated) => {
        if (updated.enabled && updated.transport === "home_assistant") {
          this.#emitLifecycle("credentials_changed", id);
        } else if (before.transport === "home_assistant" || !updated.enabled) {
          this.#emitLifecycle("disabled", id);
        }
      },
    );
  }

  patch(destinationId: string, input: OutboundDestinationPatch): OutboundDestination {
    const current = this.#requireMutableDestination(
      validateDestinationId(destinationId, "destinationId"),
    );
    return this.updateConfigured(destinationId, {
      ...input,
      enabled: input.enabled ?? current.enabled,
    });
  }

  setRequired(destinationId: string, required: boolean): OutboundDestination {
    if (typeof required !== "boolean") throw new TypeError("required must be boolean");
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      updateDestinationLabelRequired(
        this.#database,
        id,
        this.#requireDestination(id).label,
        required,
        now,
      );
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "required",
        required,
      });
      return this.#requireDestination(id);
    });
  }

  enable(destinationId: string): OutboundDestination {
    return this.#setEnabled(destinationId, true);
  }

  disable(destinationId: string): OutboundDestination {
    return this.#setEnabled(destinationId, false);
  }

  setEnabled(destinationId: string, enabled: boolean): OutboundDestination {
    return enabled ? this.enable(destinationId) : this.disable(destinationId);
  }

  retire(destinationId: string): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const before = this.#requireMutableDestination(id);
      setRetired(this.#database, id, now);
      this.#revokeSecrets(id);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "retired",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: before.transport,
        previousState: integrationEventState(before),
        state: integrationEventState(after),
        reasonCode: "retired",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("retired", id);
    return result;
  }

  retireDestination(destinationId: string): OutboundDestination {
    return this.retire(destinationId);
  }

  setToken(destinationId: string, plaintext: string): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const token = validateHomeAssistantToken(plaintext);
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      if (destination.transport !== "home_assistant")
        throw new Error("Only Home Assistant destinations have tokens");
      requireSecretStore(this.#options.secrets).upsert("outbound", id, HA_TOKEN_SLOT, token, {
        now: this.#now,
      });
      touchDestinationProfile(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "token_configured",
      });
      return this.#requireDestination(id);
    });
    this.#emitLifecycle("credentials_changed", id);
    return result;
  }

  removeToken(destinationId: string): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      if (destination.transport !== "home_assistant")
        throw new Error("Only Home Assistant destinations have tokens");
      requireSecretStore(this.#options.secrets).remove("outbound", id, HA_TOKEN_SLOT, {
        now: this.#now,
      });
      setEnabledState(this.#database, id, false, now, "token_missing");
      markTokenMissing(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "token_removed",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: destination.transport,
        previousState: integrationEventState(destination),
        state: integrationEventState(after),
        reasonCode: "token_missing",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("disabled", id);
    return result;
  }

  setHeaderSecret(destinationId: string, slot: string, plaintext: string): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const secretValue = validateHeaderSecretValue(plaintext);
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      const versionId = destination.currentVersion?.id;
      if (versionId === undefined) throw new Error("Outbound destination configuration is missing");
      const currentVersion = destination.currentVersion;
      if (
        currentVersion === null ||
        !currentVersion.config.secretHeaders.some((header) => header.slot === slot)
      )
        throw new Error("Header secret slot is not configured");
      const configuredHeaders = [...currentVersion.config.staticHeaders];
      for (const header of currentVersion.config.secretHeaders) {
        if (header.slot === slot) {
          configuredHeaders.push({ name: header.name, value: secretValue });
        } else if (header.configured && header.available === true) {
          configuredHeaders.push({
            name: header.name,
            value: requireSecretStore(this.#options.secrets).revealPrivileged(
              "outbound",
              id,
              header.slot,
            ),
          });
        }
      }
      if (configuredHeaderBytes(configuredHeaders) > MAX_HEADER_TOTAL_BYTES) {
        throw new TypeError("Configured outbound headers exceed 4096 total bytes");
      }
      requireSecretStore(this.#options.secrets).upsert("outbound", id, slot, secretValue, {
        now: this.#now,
      });
      touchDestinationProfile(this.#database, id, now);
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "header_secret_configured",
      });
      return this.#requireDestination(id);
    });
  }

  removeHeaderSecret(destinationId: string, slot: string): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const destination = this.#requireMutableDestination(id);
      const versionId = destination.currentVersion?.id;
      if (versionId === undefined) throw new Error("Outbound destination configuration is missing");
      const currentVersion = destination.currentVersion;
      if (
        currentVersion === null ||
        !currentVersion.config.secretHeaders.some((header) => header.slot === slot)
      )
        throw new Error("Header secret slot is not configured");
      requireSecretStore(this.#options.secrets).remove("outbound", id, slot, { now: this.#now });
      setEnabledState(this.#database, id, false, now, "secret_missing");
      appendOutboundActivity(this.#database, "configuration_changed", id, now, {
        change: "header_secret_removed",
      });
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: destination.transport,
        previousState: integrationEventState(destination),
        state: integrationEventState(after),
        reasonCode: "secret_missing",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle("disabled", id);
    return result;
  }

  list(): readonly OutboundDestination[] {
    return listDestinations(this.#database, {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  listDestinations(): readonly OutboundDestination[] {
    return this.list();
  }

  listPage(): readonly OutboundDestinationListItem[] {
    return listDestinationPage(this.#database, {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  get(destinationId: string): OutboundDestination | undefined {
    return readDestination(this.#database, validateDestinationId(destinationId, "destinationId"), {
      secrets: safeSecretDescriptors(this.#options.secrets),
      now: clock(this.#now),
    });
  }

  getDestination(destinationId: string): OutboundDestination | undefined {
    return this.get(destinationId);
  }

  listDeliveries(destinationId: string, limit = 100) {
    return listDeliveryHistory(this.#database, destinationId, limit);
  }

  retryDelivery(destinationId: string, deliveryId: string): boolean {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = clock(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      this.#requireOwnedDelivery(id, deliveryId);
      return retryOutboxDelivery(this.#database, deliveryId, now);
    });
  }

  dismissDelivery(destinationId: string, deliveryId: string): boolean {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = clock(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      this.#requireOwnedDelivery(id, deliveryId);
      return dismissOutboxDelivery(this.#database, deliveryId, now);
    });
  }

  connectivity(): ReturnType<typeof projectConnectivity> {
    const missing = this.list()
      .filter(
        (destination) =>
          destination.enabled &&
          destination.currentVersion !== null &&
          destination.currentVersion.config.transport === "home_assistant" &&
          !destination.currentVersion.config.authConfigured,
      )
      .map((destination) => destination.id);
    return projectConnectivity(this.#database, clock(this.#now), missing);
  }

  recordFailure(
    destinationId: string,
    errorCode: string,
    failureClass: "authentication" | "connectivity" | "unknown" = "unknown",
  ): OutboundDestination | undefined {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      recordFailureRow(this.#database, id, errorCode, failureClass, now);
      const safeCode = /^[a-z0-9][a-z0-9_.:-]{0,119}$/u.test(errorCode)
        ? errorCode
        : "delivery_failed";
      appendOutboundActivity(this.#database, "status_degraded", id, now, {
        code: safeCode,
        failure_class: failureClass,
      });
      return this.get(id);
    });
  }

  recordSuccess(destinationId: string): OutboundDestination | undefined {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    return this.#database.withTransaction(() => {
      this.#requireMutableDestination(id);
      recordSuccessRow(this.#database, id, now);
      appendOutboundActivity(this.#database, "status_recovered", id, now);
      return this.get(id);
    });
  }

  admit(
    database: DatabaseExecutor,
    input: EventEnvelope | OutboundEventInput,
  ): OutboundAdmissionResult {
    const event = "event" in input ? input.event : input;
    const targets = resolveTargets(database, event.event_type);
    if (targets.length === 0) return { status: "no_targets" };
    return this.#admitEnvelope(database, event, targets);
  }

  assignmentOpened(
    database: DatabaseExecutor,
    context: AssignmentOpenedEventContext,
  ): OutboundAdmissionResult {
    const event = eventEnvelope(
      "fill.assigned",
      fillIdentifiers(database, context.fillId, context.tapId),
      { assignment_id: context.assignmentId },
      context.occurredAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  assignmentClosed(
    database: DatabaseExecutor,
    context: AssignmentClosedEventContext,
    mappedReason?: "kicked" | "manual" | "deleted" | "other",
  ): OutboundAdmissionResult {
    // Assignment lifecycle closure (including a move) is not itself a fill
    // ending. The FillService supplies an explicit mapped reason only when a
    // persisted fill end/delete/kick has committed.
    if (mappedReason === undefined) return { status: "no_targets" };
    const event = eventEnvelope(
      "fill.ended",
      fillIdentifiers(database, context.fillId, context.tapId),
      { reason: mappedReason },
      context.occurredAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  pourCompleted(
    database: DatabaseExecutor,
    pour: CompletedPourEventContext,
  ): OutboundAdmissionResult {
    const event = eventEnvelope(
      "pour.completed",
      fillIdentifiers(database, pour.fillId, pour.tapId),
      { volume_ml: pour.canonicalVolumeMl },
      pour.completedAt,
      this.#ids,
    );
    return this.admit(database, event);
  }

  healthTransitioned(
    database: DatabaseExecutor,
    context: HealthTransitionEventContext,
  ): OutboundAdmissionResult {
    const state = healthState(context.current.state);
    const severity = healthSeverity(context.current.severity);
    if (
      state === undefined ||
      severity === undefined ||
      !changedSemantic(context.previousState, context.previousSeverity, state, severity)
    )
      return { status: "no_targets" };
    const active = activeFillForTap(database, context.tapId);
    const identifiers: EventIdentifiers = {
      tap_id: context.tapId,
      ...(active === undefined
        ? {}
        : { fill_id: active.fillId, keg_id: active.kegId, beverage_id: active.beverageId }),
    };
    const event = eventEnvelope(
      "health.transitioned",
      identifiers,
      { check_id: context.checkId, state, severity },
      context.occurredAt,
      this.#ids,
    );
    const result = this.admit(database, event);
    if (context.checkId === "low_keg" && state !== "healthy") {
      const remaining = numberEvidence(context.current.evidence, [
        "currentPercent",
        "remainingPercent",
        "remaining_percent",
      ]);
      const threshold = numberEvidence(context.current.evidence, [
        "thresholdPercent",
        "threshold_percent",
      ]);
      if (remaining !== undefined && threshold !== undefined) {
        const lowEvent = eventEnvelope(
          "keg.low",
          identifiers,
          { remaining_percent: remaining, threshold_percent: threshold },
          context.occurredAt,
          this.#ids,
        );
        this.admit(database, lowEvent);
      }
    }
    return result;
  }

  integrationStatusChanged(
    database: DatabaseExecutor,
    context: IntegrationStatusEventContext,
  ): OutboundAdmissionResult {
    if (
      context.previousState !== undefined &&
      context.previousState !== null &&
      context.previousState === context.state
    )
      return { status: "no_targets" };
    const key =
      context.coalescingKey ??
      `integration_${(context.destinationId ?? context.integrationType)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/gu, "_")}`;
    const event = eventEnvelope(
      "integration.status_changed",
      {},
      {
        integration_type: context.integrationType,
        state: context.state,
        reason_code: context.reasonCode ?? null,
      },
      context.occurredAt,
      this.#ids,
      key,
    );
    const targets = resolveTargets(database, event.event_type);
    if (targets.length === 0) return { status: "no_targets" };
    return this.#admitEnvelope(database, event, targets, key);
  }

  #admitEnvelope(
    database: DatabaseExecutor,
    event: EventEnvelope,
    targets: readonly { readonly destinationId: string; readonly destinationVersionId: string }[],
    coalescingKey?: string,
  ): OutboundAdmissionResult {
    const result = admitOutboxIntent(
      database,
      {
        event,
        ...(coalescingKey === undefined ? {} : { coalescingKey }),
        targets,
      },
      { now: this.#now, idFactory: this.#ids },
    );
    return result.status === "queued"
      ? result
      : result.status === "not_queued_capacity"
        ? result
        : { status: "no_targets" };
  }

  #setEnabled(destinationId: string, enabled: boolean): OutboundDestination {
    const id = validateDestinationId(destinationId, "destinationId");
    const now = iso(this.#now);
    const result = this.#database.withTransaction(() => {
      const current = this.#requireMutableDestination(id);
      if (enabled) {
        if (
          current.transport === "home_assistant" &&
          !secretAvailable(this.#options.secrets, id, HA_TOKEN_SLOT)
        ) {
          markTokenMissing(this.#database, id, now);
          throw new Error("Home Assistant token is required before enabling");
        }
        if (
          current.transport === "webhook" &&
          (current.currentVersion === null ||
            current.currentVersion.config.transport !== "webhook" ||
            current.currentVersion.config.endpointAvailable !== true)
        ) {
          throw new Error("Webhook endpoint is required before enabling");
        }
        if (
          current.currentVersion?.config.secretHeaders.some(
            (header) => !header.configured || header.available !== true,
          ) === true
        ) {
          throw new Error("Every configured secret header requires a value before enabling");
        }
        const unavailableHistoricalSlot = listUnfinishedSecretSlots(this.#database, id).find(
          (slot) => !secretAvailable(this.#options.secrets, id, slot),
        );
        if (unavailableHistoricalSlot !== undefined) {
          throw new Error("Pending delivery requires a removed secret header value");
        }
      }
      if (!enabled) {
        setEnabledState(this.#database, id, false, now, "operator_disabled");
        appendOutboundActivity(this.#database, "configuration_changed", id, now, {
          change: "disabled",
        });
      } else {
        const disabledAt = current.disabledAt;
        setEnabledState(this.#database, id, true, now);
        if (disabledAt !== null) shiftDestinationDeliveries(this.#database, id, disabledAt, now);
        appendOutboundActivity(this.#database, "configuration_changed", id, now, {
          change: "enabled",
        });
      }
      const after = this.#requireDestination(id);
      this.integrationStatusChanged(this.#database, {
        destinationId: id,
        integrationType: after.transport,
        previousState: integrationEventState(current),
        state: integrationEventState(after),
        reasonCode: enabled ? "enabled" : "operator_disabled",
        occurredAt: now,
      });
      return after;
    });
    this.#emitLifecycle(enabled ? "enabled" : "disabled", id);
    return result;
  }

  #requireDestination(destinationId: string): OutboundDestination {
    const result = this.get(destinationId);
    if (result === undefined) throw new Error("Outbound destination was not found");
    return result;
  }

  #requireMutableDestination(destinationId: string): OutboundDestination {
    const result = this.#requireDestination(destinationId);
    if (result.retiredAt !== null) {
      throw new Error("Retired outbound destinations are read-only");
    }
    return result;
  }

  #requireOwnedDelivery(destinationId: string, deliveryId: string): void {
    if (
      !deliveryBelongsToDestination(
        this.#database,
        destinationId,
        validateDestinationId(deliveryId, "deliveryId"),
      )
    ) {
      throw new Error("Outbound delivery was not found");
    }
  }

  #resolveReplacementSlots(
    headers: readonly { readonly name: string; readonly slot: string }[],
    replacements: ReadonlyMap<string, string>,
  ): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const [name, value] of replacements) {
      const header = headers.find((candidate) => candidate.name.toLowerCase() === name);
      if (header === undefined) throw new Error("The submitted secret header is not configured");
      result.set(header.slot, value);
    }
    return result;
  }

  #assertHeaderTotal(
    staticHeaders: readonly { readonly name: string; readonly value: string }[],
    secretHeaders: readonly { readonly name: string; readonly slot: string }[],
    secretValues: ReadonlyMap<string, string>,
  ): void {
    const configured = [
      ...staticHeaders,
      ...secretHeaders.flatMap((header) => {
        const value = secretValues.get(header.slot);
        return value === undefined ? [] : [{ name: header.name, value }];
      }),
    ];
    if (configuredHeaderBytes(configured) > MAX_HEADER_TOTAL_BYTES) {
      throw new TypeError("Configured outbound headers exceed 4096 total bytes");
    }
  }

  #withDeferredLifecycle<Result>(
    work: () => Result,
    afterCommit: (result: Result) => void,
  ): Result {
    this.#lifecycleSuppression += 1;
    let result: Result;
    try {
      result = work();
    } finally {
      this.#lifecycleSuppression -= 1;
    }
    afterCommit(result);
    return result;
  }

  #emitLifecycle(
    action: "enabled" | "disabled" | "credentials_changed" | "retired",
    destinationId: string,
  ): void {
    if (this.#lifecycleSuppression > 0) return;
    if (action === "enabled") this.#options.lifecycle?.onEnabled?.(destinationId);
    else if (action === "disabled") this.#options.lifecycle?.onDisabled?.(destinationId);
    else if (action === "credentials_changed")
      this.#options.lifecycle?.onCredentialsChanged?.(destinationId);
    else this.#options.lifecycle?.onRetired?.(destinationId);
  }

  #storeInitialSecret(
    destinationId: string,
    config: ReturnType<typeof normalizeDestinationConfig>,
    secret: string | undefined,
    _now: string,
  ): void {
    if (secret === undefined) return;
    const store = requireSecretStore(this.#options.secrets);
    if (config.transport === "home_assistant")
      store.upsert("outbound", destinationId, HA_TOKEN_SLOT, secret, { now: this.#now });
    else if (config.endpointSlot !== undefined)
      store.upsert("outbound", this.#currentVersionId(destinationId), config.endpointSlot, secret, {
        now: this.#now,
      });
  }

  #currentVersionId(destinationId: string): string {
    const result = readCurrentDestinationVersion(this.#database, destinationId);
    if (result === undefined) throw new Error("Outbound destination configuration is missing");
    return result.id;
  }

  #revealSecret(recordId: string, fieldName: string): string {
    return requireSecretStore(this.#options.secrets).revealPrivileged(
      "outbound",
      recordId,
      fieldName,
    );
  }

  #assertHistoricalSecretSlots(
    destinationId: string,
    headers: readonly { readonly name: string; readonly slot: string }[],
  ): void {
    const historical = listDestinationConfigJson(this.#database, destinationId);
    const namesBySlot = new Map<string, string>();
    for (const configJson of historical) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(configJson) as unknown;
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const raw = (parsed as Record<string, unknown>).secretHeaders;
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.slot !== "string" || typeof record.name !== "string") continue;
        namesBySlot.set(record.slot, record.name.toLowerCase());
      }
    }
    for (const header of headers) {
      const previousName = namesBySlot.get(header.slot);
      if (previousName !== undefined && previousName !== header.name.toLowerCase()) {
        throw new Error("A secret header slot cannot be reused for another header");
      }
    }
  }

  #copyVersionSecrets(
    oldVersionId: string,
    newVersionId: string,
    oldConfig: OutboundConfig,
    newConfig: ReturnType<typeof normalizeDestinationConfig>,
    endpoint: string | undefined,
  ): void {
    const store = this.#options.secrets;
    if (store === undefined) return;
    if (newConfig.transport === "webhook") {
      const endpointValue =
        endpoint ??
        (oldConfig.transport === "webhook" && oldConfig.endpointConfigured
          ? this.#revealSecret(oldVersionId, WEBHOOK_ENDPOINT_SLOT)
          : undefined);
      if (endpointValue !== undefined)
        store.upsert("outbound", newVersionId, WEBHOOK_ENDPOINT_SLOT, endpointValue, {
          now: this.#now,
        });
    }
  }

  #revokeSecrets(destinationId: string): void {
    const store = this.#options.secrets;
    if (store === undefined) return;
    const versionIds = new Set(listDestinationVersionIds(this.#database, destinationId));
    for (const descriptor of safeSecretDescriptors(store)) {
      if (descriptor.integrationType !== "outbound") continue;
      if (descriptor.recordId !== destinationId && !versionIds.has(descriptor.recordId)) continue;
      if (descriptor.configured)
        store.remove("outbound", descriptor.recordId, descriptor.fieldName, { now: this.#now });
    }
  }
}

export function createOutboundService(
  database: DatabaseExecutor,
  options: OutboundServiceOptions = {},
): OutboundService {
  return new OutboundService(database, options);
}

export type { OutboundAdmissionPort };
