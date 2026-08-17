import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import type { EventEnvelope } from "../events/types.ts";
import { OutboundService } from "./service.ts";
import type {
  AssignmentClosedEventContext,
  AssignmentOpenedEventContext,
  CompletedPourEventContext,
  HealthTransitionEventContext,
  IntegrationStatusEventContext,
  OutboundAdmissionPort,
  OutboundAdmissionResult,
  OutboundEventInput,
  OutboundServiceOptions,
} from "./types.ts";

/**
 * Small transaction-local producer boundary. The service owns destination
 * resolution and delegates admission to the existing bounded outbox. It does
 * not begin a transaction, perform I/O, or expose secrets.
 */
export class OutboundAdmission implements OutboundAdmissionPort {
  readonly #service: OutboundService;

  constructor(database: DatabaseExecutor, options: OutboundServiceOptions = {}) {
    this.#service = new OutboundService(database, options);
  }

  admit(
    database: DatabaseExecutor,
    event: EventEnvelope | OutboundEventInput,
  ): OutboundAdmissionResult {
    return this.#service.admit(database, event);
  }

  assignmentOpened(
    database: DatabaseExecutor,
    context: AssignmentOpenedEventContext,
  ): OutboundAdmissionResult {
    return this.#service.assignmentOpened(database, context);
  }

  assignmentClosed(
    database: DatabaseExecutor,
    context: AssignmentClosedEventContext,
    mappedReason?: "kicked" | "manual" | "deleted" | "other",
  ): OutboundAdmissionResult {
    return this.#service.assignmentClosed(database, context, mappedReason);
  }

  pourCompleted(
    database: DatabaseExecutor,
    pour: CompletedPourEventContext,
  ): OutboundAdmissionResult {
    return this.#service.pourCompleted(database, pour);
  }

  healthTransitioned(
    database: DatabaseExecutor,
    context: HealthTransitionEventContext,
  ): OutboundAdmissionResult {
    return this.#service.healthTransitioned(database, context);
  }

  integrationStatusChanged(
    database: DatabaseExecutor,
    context: IntegrationStatusEventContext,
  ): OutboundAdmissionResult {
    return this.#service.integrationStatusChanged(database, context);
  }
}

export function createOutboundAdmission(
  database: DatabaseExecutor,
  options: OutboundServiceOptions = {},
): OutboundAdmission {
  return new OutboundAdmission(database, options);
}
