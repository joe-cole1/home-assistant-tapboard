import type { ServerResponse } from "node:http";

import type { AuthService } from "../auth/service.ts";
import { SseHub, type SseClientContext, type SseHubStats } from "../../infrastructure/sse/hub.ts";

export const LIVE_EVENT_NAMES = [
  "tap.updated",
  "fill.updated",
  "telemetry.updated",
  "health.updated",
  "ondeck.updated",
  "integration_status.updated",
  "display.updated",
] as const;

export type LiveEventName = (typeof LIVE_EVENT_NAMES)[number];

export type PublicLiveEvent =
  | {
      readonly name: "tap.updated" | "fill.updated" | "telemetry.updated" | "health.updated";
      readonly tapId: string;
    }
  | { readonly name: "ondeck.updated"; readonly target: "ondeck" }
  | { readonly name: "integration_status.updated"; readonly target: "header" }
  | { readonly name: "display.updated"; readonly target: "display" };

interface AdminSseContext extends SseClientContext {
  readonly isAdmin: true;
  readonly sessionToken: string;
}

export interface LiveUpdateServiceOptions {
  readonly heartbeatMs?: number;
  readonly publicMaxClients?: number;
  readonly adminMaxClients?: number;
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
  readonly adminRevalidateMs?: number;
}

export class LiveUpdateService {
  readonly #publicHub: SseHub;
  readonly #adminHub: SseHub<AdminSseContext>;

  constructor(authService: AuthService, options: LiveUpdateServiceOptions = {}) {
    const shared = {
      heartbeatMs: options.heartbeatMs ?? 15_000,
      maxQueuedEvents: options.maxQueuedEvents ?? 64,
      maxQueuedBytes: options.maxQueuedBytes ?? 65_536,
      retryMs: 3_000,
    };
    this.#publicHub = new SseHub({
      ...shared,
      maxClients: options.publicMaxClients ?? 32,
    });
    this.#adminHub = new SseHub<AdminSseContext>({
      ...shared,
      maxClients: options.adminMaxClients ?? 16,
      authRevalidateMs: options.adminRevalidateMs ?? 60_000,
      authRevalidate: (context) => authService.validateSession(context.sessionToken) !== undefined,
    });
  }

  connectPublic(response: ServerResponse): boolean {
    return this.#publicHub.connect(response);
  }

  connectAdmin(response: ServerResponse, sessionToken: string): boolean {
    return this.#adminHub.connect(response, { isAdmin: true, sessionToken });
  }

  publish(event: PublicLiveEvent): void {
    const payload = "tapId" in event ? { tapId: event.tapId } : { target: event.target };
    const dirtyKey =
      "tapId" in event ? `${event.name}:tap:${event.tapId}` : `${event.name}:${event.target}`;
    this.#publicHub.publish(event.name, payload, { dirtyKey });
    this.#adminHub.publish(event.name, payload, { dirtyKey });
  }

  stats(): { readonly public: SseHubStats; readonly admin: SseHubStats } {
    return { public: this.#publicHub.stats(), admin: this.#adminHub.stats() };
  }

  stop(): void {
    this.#publicHub.stop();
    this.#adminHub.stop();
  }
}
