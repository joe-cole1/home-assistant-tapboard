import { readFormBody } from "../../../infrastructure/http/form.ts";
import { redirect, sendHtml } from "../../../infrastructure/http/html.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { adminFailureMessage, reportFailure } from "../../../shared/diagnostics.ts";
import { displayStylesheetHref } from "../../display/palette.ts";
import type { EventType } from "../../events/types.ts";
import type { OutboundService } from "../../outbound/service.ts";
import {
  validateHeaderSecretValue,
  validateHomeAssistantToken,
} from "../../outbound/outbound-validation.ts";
import type {
  CreateOutboundDestinationInput,
  EditOutboundDestinationInput,
  OutboundDeliveryHistoryItem,
  OutboundDestination,
  OutboundHeader,
} from "../../outbound/types.ts";
import type { TelemetryService } from "../../telemetry/service.ts";
import { registerAdminGet, registerAdminAction } from "./http.ts";
import { renderAdmin, adminNavItems } from "./layout.ts";
import { requestUrl, actor, adminContext, messageLocation, type AdminContext } from "./context.ts";
import { adminTimestampLabel } from "./presentation.ts";
import { invalidForm } from "./forms.ts";
import { humanizeAdminIdentifier } from "./detector-presentation.ts";
import type {
  RegisterIntegrationPagesDependencies,
  RegisterOutboundMutationsDependencies,
  RegisterIntegrationMutationsDependencies,
  RequireOutboundServiceDependencies,
  MachineKeyPageDataDependencies,
} from "../contracts.ts";

export function registerIntegrationPages(dependencies: RegisterIntegrationPagesDependencies): void {
  registerAdminGet(dependencies, "/admin/integrations", (request, response, context) => {
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const sources = dependencies.telemetryService.listSources();
    const outboundItems = dependencies.outboundService?.listPage() ?? [];
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations",
      "Integrations",
      "/admin/integrations",
      {
        telemetry: {
          activeCount: sources.filter((source) => source.disabledAt === null).length,
          disabledCount: sources.filter((source) => source.disabledAt !== null).length,
        },
        brewfather: {
          configured: brewfather.configured,
          enabled: brewfather.account?.enabled ?? false,
          apiKeyConfigured: brewfather.apiKeyConfigured,
          linkedBeverages: brewfather.totalLinkedBeverages,
          candidates: brewfather.totalCandidates,
        },
        outbound: {
          available: dependencies.outboundService !== undefined,
          count: outboundItems.filter((item) => item.retiredAt === null).length,
          enabledCount: outboundItems.filter((item) => item.retiredAt === null && item.enabled)
            .length,
          requiredCount: outboundItems.filter((item) => item.retiredAt === null && item.required)
            .length,
        },
      },
    );
  });

  registerAdminGet(dependencies, "/admin/integrations/outbound", (request, response, context) => {
    const destinations = dependencies.outboundService?.listPage() ?? [];
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-outbound",
      "Outbound delivery",
      "/admin/integrations/outbound",
      {
        available: dependencies.outboundService !== undefined,
        destinations: destinations.map((destination) =>
          outboundDestinationPresentation(destination),
        ),
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/integrations/outbound/new",
    (request, response, context) => {
      const requested = requestUrl(request).searchParams.get("transport");
      const transport = requested === "webhook" ? "webhook" : "home_assistant";
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-outbound-new",
        "New outbound destination",
        "/admin/integrations/outbound/new",
        {
          available: dependencies.outboundService !== undefined,
          transport,
          eventFields: OUTBOUND_EVENT_FIELDS,
          maxHeaderRows: OUTBOUND_MAX_HEADER_ROWS,
        },
      );
    },
  );

  registerAdminGet(
    dependencies,
    "/admin/integrations/outbound/:id",
    (request, response, context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const history = outboundHistoryPresentation(
        service.listDeliveries(destination.id, 100),
        destination.retiredAt === null,
      );
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-outbound-detail",
        destination.label,
        `/admin/integrations/outbound/${encodeURIComponent(destination.id)}`,
        {
          available: true,
          destination: outboundDestinationPresentation(destination),
          history,
          eventFields: OUTBOUND_EVENT_FIELDS,
          maxHeaderRows: OUTBOUND_MAX_HEADER_ROWS,
        },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/integrations/brewfather", (request, response, context) => {
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-brewfather",
      "Brewfather",
      "/admin/integrations/brewfather",
      {
        brewfather: {
          configured: brewfather.configured,
          enabled: brewfather.account?.enabled ?? false,
          apiKeyConfigured: brewfather.apiKeyConfigured,
          linkedBeverages: brewfather.totalLinkedBeverages,
          candidates: brewfather.totalCandidates,
          lastDataUpdateAt: brewfather.lastDataUpdateAt,
          lastDataUpdateAtLabel: adminTimestampLabel(brewfather.lastDataUpdateAt),
          connectionState: brewfather.connectionState,
          credentialStorage: brewfather.credentialStorage,
        },
      },
    );
  });

  registerAdminGet(dependencies, "/admin/integrations/telemetry", (request, response, context) => {
    const params = requestUrl(request).searchParams;
    const requestedQuery = (params.get("q") ?? "").trim().slice(0, 80);
    const parsePage = (value: string | null): number => {
      const page = Number(value ?? "1");
      return Number.isInteger(page) && Number.isFinite(page)
        ? Math.min(10_000, Math.max(1, page))
        : 1;
    };
    const activePageNumber = parsePage(params.get("activePage"));
    const historyPageNumber = parsePage(params.get("historyPage"));
    const activePage = dependencies.telemetryService.listAdminSourcePage({
      q: requestedQuery,
      state: "active",
      page: activePageNumber,
    });
    const historyPage = dependencies.telemetryService.listAdminSourcePage({
      q: requestedQuery,
      state: "disabled",
      page: historyPageNumber,
    });
    const query = activePage.query;
    const mapSource = (source: ReturnType<TelemetryService["listSources"]>[number]) => ({
      id: source.id,
      name: source.name,
      keyPublicId: source.currentMachineKey.publicId,
      keyLabel: source.currentMachineKey.label,
      keyCreatedAt: source.currentMachineKey.createdAt,
      keyCreatedAtLabel: adminTimestampLabel(source.currentMachineKey.createdAt),
      createdAt: source.createdAt,
      createdAtLabel: adminTimestampLabel(source.createdAt),
      disabledAt: source.disabledAt,
      disabledAtLabel: adminTimestampLabel(source.disabledAt),
    });
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/integrations-telemetry",
      "Telemetry",
      "/admin/integrations/telemetry",
      {
        activeSources: activePage.items.map(mapSource),
        disabledSources: historyPage.items.map(mapSource),
        query,
        pagination: {
          active: {
            page: activePage.page,
            pageCount: activePage.pageCount,
            total: activePage.total,
          },
          history: {
            page: historyPage.page,
            pageCount: historyPage.pageCount,
            total: historyPage.total,
          },
        },
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/integrations/telemetry-sources/:id",
    (request, response, context, params) => {
      const source = dependencies.telemetryService
        .listSources()
        .find((candidate) => candidate.id === params.id);
      if (source === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "telemetry.source_not_found",
          clientMessage: "Telemetry source was not found.",
        });
      }
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/integrations-telemetry-source",
        source.name,
        `/admin/integrations/telemetry-sources/${encodeURIComponent(source.id)}`,
        {
          source: {
            id: source.id,
            name: source.name,
            keyPublicId: source.currentMachineKey.publicId,
            keyLabel: source.currentMachineKey.label,
            keyCreatedAt: source.currentMachineKey.createdAt,
            keyCreatedAtLabel: adminTimestampLabel(source.currentMachineKey.createdAt),
            createdAt: source.createdAt,
            createdAtLabel: adminTimestampLabel(source.createdAt),
            disabledAt: source.disabledAt,
            disabledAtLabel: adminTimestampLabel(source.disabledAt),
          },
        },
      );
    },
  );
}

export function registerOutboundMutations(
  dependencies: RegisterOutboundMutationsDependencies,
): void {
  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/create",
    "/admin/integrations/outbound",
    (form) => {
      const service = requireOutboundService(dependencies);
      const parsed = parseOutboundForm(form, "create");
      service.createConfigured({
        ...outboundCreateInput(parsed),
        headerSecrets: parsed.secretValues,
      });
    },
    "Outbound destination created.",
    { maxBytes: 16_384, maxFields: 100 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/edit",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (form, _context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const parsed = parseOutboundForm(form, "edit");
      service.updateConfigured(destination.id, {
        ...outboundEditInput(parsed, destination, form),
        enabled: parsed.enabled,
        headerSecrets: parsed.secretValues,
        ...(parsed.token === undefined || parsed.transport !== "home_assistant"
          ? {}
          : { token: parsed.token }),
      });
    },
    "Outbound destination updated.",
    { maxBytes: 16_384, maxFields: 100 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/enable",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (_form, _context, params) => {
      requireOutboundService(dependencies).enable(params.id ?? "");
    },
    "Outbound destination enabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/disable",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (_form, _context, params) => {
      requireOutboundService(dependencies).disable(params.id ?? "");
    },
    "Outbound destination disabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/required",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (form, _context, params) => {
      requireOutboundService(dependencies).setRequired(
        params.id ?? "",
        form.required === "true" || form.required === "on",
      );
    },
    "Required-delivery setting updated.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/token",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (form, _context, params) => {
      const token = form.token ?? "";
      if (token === "") invalidForm("A replacement Home Assistant token is required.", "token");
      requireOutboundService(dependencies).setToken(params.id ?? "", token);
    },
    "Home Assistant token replaced.",
    { maxBytes: 16_384, maxFields: 20 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/token/remove",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (_form, _context, params) => {
      requireOutboundService(dependencies).removeToken(params.id ?? "");
    },
    "Home Assistant token removed and delivery disabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/header-secret",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (form, _context, params) => {
      const slot = (form.slot ?? "").trim();
      const secret = form.secret ?? "";
      if (slot === "" || secret === "") invalidForm("A header secret replacement is required.");
      requireOutboundService(dependencies).setHeaderSecret(params.id ?? "", slot, secret);
    },
    "Header secret replaced.",
    { maxBytes: 16_384, maxFields: 20 },
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/header-secret/remove",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (form, _context, params) => {
      const slot = (form.slot ?? "").trim();
      if (slot === "") invalidForm("A header secret slot is required.");
      requireOutboundService(dependencies).removeHeaderSecret(params.id ?? "", slot);
    },
    "Header secret removed and delivery disabled.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/retire",
    "/admin/integrations/outbound",
    (_form, _context, params) => {
      requireOutboundService(dependencies).retire(params.id ?? "");
    },
    "Outbound destination retired.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/deliveries/:deliveryId/retry",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (_form, _context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const delivery = service
        .listDeliveries(destination.id, 100)
        .find((item) => item.id === params.deliveryId);
      if (delivery === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "outbound.delivery_not_found",
          clientMessage: "Delivery history item not found.",
        });
      }
      if (!service.retryDelivery(destination.id, delivery.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "outbound.delivery_not_retryable",
          clientMessage: "That delivery is no longer waiting for retry.",
        });
      }
    },
    "Delivery scheduled for retry.",
  );

  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/:id/deliveries/:deliveryId/dismiss",
    (params) => `/admin/integrations/outbound/${encodeURIComponent(params.id ?? "")}`,
    (_form, _context, params) => {
      const service = requireOutboundService(dependencies);
      const destination = outboundDestinationOrNotFound(service, params.id ?? "");
      const delivery = service
        .listDeliveries(destination.id, 100)
        .find((item) => item.id === params.deliveryId);
      if (delivery === undefined) {
        throw new ApplicationError({
          category: "not_found",
          code: "outbound.delivery_not_found",
          clientMessage: "Delivery history item not found.",
        });
      }
      if (!service.dismissDelivery(destination.id, delivery.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "outbound.delivery_not_dismissible",
          clientMessage: "That delivery is no longer open for dismissal.",
        });
      }
    },
    "Delivery dismissed.",
  );
}

export function registerIntegrationMutations(
  dependencies: RegisterIntegrationMutationsDependencies,
): void {
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather",
    "/admin/integrations/brewfather",
    (form, context) => {
      dependencies.beverageService.configureBrewfatherAccount(
        {
          userId: form.userId,
          ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          enabled: form.enabled === "true",
        },
        actor(context),
      );
    },
    "Brewfather configuration saved. Stored secrets are never displayed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/sync",
    "/admin/integrations/brewfather",
    async (_form, _context) => {
      const results = await dependencies.beverageService.syncBrewfather();
      const failed = results.find(
        (result) =>
          result.error !== undefined ||
          result.authenticationFailed ||
          result.linkedErrors > 0 ||
          (result.failures?.length ?? 0) > 0,
      );
      if (failed !== undefined) {
        const failure = failed.failures?.[0];
        throw new ApplicationError({
          category: failure?.category ?? "unavailable",
          code: failure?.code ?? "brewfather.sync_failed",
          clientMessage: `Brewfather refresh incomplete. ${failure?.message ?? "The provider could not complete the refresh. Try again later."}`,
          ...(failure
            ? {
                details: {
                  providerStatus: failure.providerStatus,
                  retryAfterMs: failure.retryAfterMs,
                },
              }
            : {}),
        });
      }
      if (results.length === 0 || results.some((result) => result.connectionVerified !== true)) {
        return {
          notice:
            "Brewfather was not verified. Enable a configured account and try the refresh again.",
        };
      }
    },
    "Brewfather refresh completed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/brewfather/remove-key",
    "/admin/integrations/brewfather",
    (_form, context) => {
      dependencies.beverageService.removeBrewfatherApiKey("default", actor(context));
    },
    "Brewfather API key removed.",
  );

  dependencies.router.post(
    "/admin/integrations/telemetry-sources/create",
    async (request, response) => {
      const context = adminContext(request, dependencies.authService);
      let committed = false;
      try {
        if (context === undefined)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const form = await readFormBody(request);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const issued = dependencies.telemetryService.createSource(
          { name: form.name, ...(form.label ? { label: form.label } : {}) },
          actor(context),
        );
        committed = true;
        sendHtml(
          response,
          200,
          dependencies.renderer.render(
            "/admin/machine-key",
            machineKeyPageData(
              dependencies,
              context,
              "Telemetry key created",
              issued.source.name,
              issued.initialToken,
            ),
          ),
        );
      } catch (error) {
        if (response.headersSent) throw error;
        const failure = reportFailure(error, {
          operation: "admin.telemetry.create",
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        });
        redirect(
          response,
          messageLocation(
            "/admin/integrations/telemetry",
            "error",
            context === undefined
              ? "The form could not be authorized. Reload and try again."
              : committed
                ? adminFailureMessage(
                    {
                      ...failure,
                      expected: true,
                      message:
                        "Telemetry source and key created, but the token could not be shown. Rotate the key again to get a replacement; rotation invalidates the previous key.",
                    },
                    "",
                  )
                : adminFailureMessage(failure, "Telemetry source could not be created."),
          ),
        );
      }
    },
  );
  dependencies.router.post(
    "/admin/integrations/telemetry-sources/:id/rotate",
    async (request, response, params) => {
      const context = adminContext(request, dependencies.authService);
      let committed = false;
      try {
        if (context === undefined)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const form = await readFormBody(request);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new ApplicationError({
            category: "forbidden",
            code: "auth.mutation_forbidden",
            clientMessage: "The form could not be authorized. Reload and try again.",
          });
        const issued = dependencies.telemetryService.rotateSourceKey(
          params.id!,
          form.label ? { label: form.label } : {},
          actor(context),
        );
        committed = true;
        sendHtml(
          response,
          200,
          dependencies.renderer.render(
            "/admin/machine-key",
            machineKeyPageData(
              dependencies,
              context,
              "Telemetry key rotated",
              issued.source.name,
              issued.replacementToken,
            ),
          ),
        );
      } catch (error) {
        if (response.headersSent) throw error;
        const failure = reportFailure(error, {
          operation: "admin.telemetry.rotate",
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        });
        redirect(
          response,
          messageLocation(
            "/admin/integrations/telemetry",
            "error",
            context === undefined
              ? "The form could not be authorized. Reload and try again."
              : committed
                ? adminFailureMessage(
                    {
                      ...failure,
                      expected: true,
                      message:
                        "Telemetry key rotated, but the token could not be shown. Rotate the key again to get a replacement; rotation invalidates the previous key.",
                    },
                    "",
                  )
                : adminFailureMessage(failure, "Telemetry key could not be rotated."),
          ),
        );
      }
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/integrations/telemetry-sources/:id/disable",
    "/admin/integrations/telemetry",
    (_form, context, params) => {
      dependencies.telemetryService.disableSource(params.id!, actor(context));
    },
    "Telemetry source disabled and its current key revoked.",
  );
}

export function telemetryEndpointUrl(canonicalOrigin: string | undefined): string {
  const origin = (canonicalOrigin ?? "http://localhost:3000").replace(/\/+$/u, "");
  return `${origin}/api/v1/telemetry/taps/1`;
}

export const OUTBOUND_EVENT_FIELDS = [
  { eventType: "fill.assigned", name: "subscription_fill_assigned", label: "Fill assigned" },
  { eventType: "fill.ended", name: "subscription_fill_ended", label: "Fill ended" },
  { eventType: "pour.completed", name: "subscription_pour_completed", label: "Pour completed" },
  { eventType: "keg.low", name: "subscription_keg_low", label: "Keg low" },
  {
    eventType: "health.transitioned",
    name: "subscription_health_transitioned",
    label: "Health transitioned",
  },
  {
    eventType: "integration.status_changed",
    name: "subscription_integration_status_changed",
    label: "Integration status changed",
  },
] as const satisfies readonly {
  readonly eventType: EventType;
  readonly name: string;
  readonly label: string;
}[];

export const OUTBOUND_MAX_HEADER_ROWS = 8;

export interface OutboundHeaderSecretValue {
  readonly name: string;
  readonly value: string;
}

export interface ParsedOutboundForm {
  readonly label: string;
  readonly transport: "home_assistant" | "webhook";
  readonly required: boolean;
  readonly enabled: boolean;
  readonly subscriptions: readonly EventType[];
  readonly staticHeaders: readonly OutboundHeader[];
  readonly secretHeaders: readonly { readonly name: string; readonly slot?: string }[];
  readonly secretValues: readonly OutboundHeaderSecretValue[];
  readonly token?: string;
  readonly baseUrl?: string;
  readonly webhookUrl?: string;
  readonly payloadFormat?: "standard" | "discord";
}

export function requireOutboundService(
  dependencies: RequireOutboundServiceDependencies,
): OutboundService {
  const service = dependencies.outboundService;
  if (service === undefined) {
    throw new ApplicationError({
      category: "unavailable",
      code: "outbound.unavailable",
      clientMessage: "Outbound integrations are not available in this application.",
    });
  }
  return service;
}

export function outboundDestinationOrNotFound(
  service: OutboundService,
  destinationId: string,
): OutboundDestination {
  const destination = service.get(destinationId);
  if (destination === undefined) {
    throw new ApplicationError({
      category: "not_found",
      code: "outbound.destination_not_found",
      clientMessage: "Outbound destination not found.",
    });
  }
  return destination;
}

export function outboundShortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-3)}` : value;
}

export function outboundStateLabel(value: string): string {
  return humanizeAdminIdentifier(value, "Unknown");
}

export function outboundStateClass(value: string): "healthy" | "degraded" | "muted" {
  if (value === "healthy") return "healthy";
  if (value === "failing" || value === "degraded" || value === "needs_attention") return "degraded";
  return "muted";
}

export function outboundConfigPresentation(
  destination: OutboundDestination,
): Record<string, unknown> {
  const version = destination.currentVersion;
  const config = version?.config;
  if (config === undefined) {
    return {
      available: false,
      transportLabel: humanizeAdminIdentifier(destination.transport),
      staticHeaders: [],
      secretHeaders: [],
    };
  }
  const isHa = config.transport === "home_assistant";
  const configured = isHa ? config.authConfigured : config.endpointConfigured;
  const available = isHa ? config.authAvailable : config.endpointAvailable;
  return {
    available: true,
    transportLabel: isHa ? "Home Assistant" : "Webhook",
    payloadFormat: isHa ? null : config.payloadFormat,
    endpointConfigured: isHa ? config.authConfigured : config.endpointConfigured,
    endpointAvailable: isHa ? config.authAvailable : config.endpointAvailable,
    credentialStateLabel: available
      ? "Configured"
      : configured
        ? "Configured but unavailable"
        : isHa
          ? "Token not configured"
          : "Endpoint not configured",
    staticHeaders: config.staticHeaders.map((header) => ({ name: header.name })),
    secretHeaders: config.secretHeaders.map((header) => ({
      name: header.name,
      slot: header.slot,
      configured: header.configured,
      available: header.available === true,
    })),
  };
}

export function outboundDestinationPresentation(
  destination: OutboundDestination,
): Record<string, unknown> {
  const version = destination.currentVersion;
  return {
    id: destination.id,
    label: destination.label,
    transport: destination.transport,
    transportLabel: destination.transport === "home_assistant" ? "Home Assistant" : "Webhook",
    subscriptions: destination.subscriptions,
    required: destination.required,
    enabled: destination.enabled,
    retired: destination.retiredAt !== null,
    state: destination.state,
    stateLabel: outboundStateLabel(destination.state),
    stateClass: outboundStateClass(destination.state),
    disabledReason:
      destination.disabledReason === null ? null : outboundStateLabel(destination.disabledReason),
    failure:
      destination.failure === null
        ? null
        : {
            code: destination.failure.code,
            failureClass: outboundStateLabel(destination.failure.failureClass),
            occurredAt: destination.failure.occurredAt,
            occurredAtLabel: adminTimestampLabel(destination.failure.occurredAt),
          },
    lastSuccessAt: destination.lastSuccessAt,
    lastSuccessAtLabel:
      destination.lastSuccessAt === null
        ? "No confirmed success"
        : adminTimestampLabel(destination.lastSuccessAt),
    version:
      version === null
        ? null
        : {
            id: version.id,
            versionNumber: version.versionNumber,
            createdAt: version.createdAt,
            createdAtLabel: adminTimestampLabel(version.createdAt),
          },
    config: outboundConfigPresentation(destination),
  };
}

export function outboundHistoryPresentation(
  rows: readonly OutboundDeliveryHistoryItem[],
  mutable = true,
): readonly Record<string, unknown>[] {
  return rows.slice(0, 100).map((row) => ({
    id: row.id,
    shortId: outboundShortId(row.id),
    eventId: outboundShortId(row.eventId),
    eventType:
      OUTBOUND_EVENT_FIELDS.find((field) => field.eventType === row.eventType)?.label ??
      row.eventType,
    state: row.state,
    stateLabel: outboundStateLabel(row.state),
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastAttemptAt: row.lastAttemptAt,
    lastAttemptAtLabel:
      row.lastAttemptAt === null ? "Not attempted" : adminTimestampLabel(row.lastAttemptAt),
    nextAttemptAt: row.nextAttemptAt,
    nextAttemptAtLabel: adminTimestampLabel(row.nextAttemptAt),
    canRetry: mutable && row.state === "terminal",
    canDismiss: mutable && row.state === "terminal",
  }));
}

export function outboundSubscriptionsFromForm(
  form: Readonly<Record<string, string>>,
): readonly EventType[] {
  return OUTBOUND_EVENT_FIELDS.filter((field) => form[field.name] === "on").map(
    (field) => field.eventType,
  );
}

export function outboundStaticHeadersFromForm(
  form: Readonly<Record<string, string>>,
): readonly OutboundHeader[] {
  const rows: OutboundHeader[] = [];
  for (let index = 0; index < OUTBOUND_MAX_HEADER_ROWS; index += 1) {
    const name = (form[`static_header_${index}_name`] ?? "").trim();
    const value = form[`static_header_${index}_value`] ?? "";
    if (name === "" && value.trim() === "") continue;
    rows.push({ name, value });
  }
  return rows;
}

export function outboundSecretHeadersFromForm(form: Readonly<Record<string, string>>): {
  readonly headers: readonly { readonly name: string; readonly slot?: string }[];
  readonly values: readonly OutboundHeaderSecretValue[];
} {
  const headers: { name: string; slot?: string }[] = [];
  const values: OutboundHeaderSecretValue[] = [];
  for (let index = 0; index < OUTBOUND_MAX_HEADER_ROWS; index += 1) {
    const name = (form[`secret_header_${index}_name`] ?? "").trim();
    const slot = (form[`secret_header_${index}_slot`] ?? "").trim();
    const value = form[`secret_header_${index}_value`] ?? "";
    if (name === "" && slot === "" && value.trim() === "") continue;
    headers.push({ name, ...(slot === "" ? {} : { slot }) });
    if (value !== "") values.push({ name, value: validateHeaderSecretValue(value) });
  }
  return { headers, values };
}

export function parseOutboundForm(
  form: Readonly<Record<string, string>>,
  mode: "create" | "edit",
): ParsedOutboundForm {
  const transport =
    form.transport === "webhook"
      ? "webhook"
      : form.transport === "home_assistant" || form.transport === "ha"
        ? "home_assistant"
        : invalidForm("Choose an outbound transport.", "transport");
  const label = form.label ?? "";
  const required = form.required === "on";
  const enabled = form.enabled === "on";
  const subscriptions = outboundSubscriptionsFromForm(form);
  const staticHeaders = outboundStaticHeadersFromForm(form);
  const secretRows = outboundSecretHeadersFromForm(form);
  const result: ParsedOutboundForm = {
    label,
    transport,
    required,
    enabled,
    subscriptions,
    staticHeaders,
    secretHeaders: secretRows.headers,
    secretValues: secretRows.values,
  };
  if (transport === "home_assistant") {
    const baseUrl = (form.baseUrl ?? "").trim();
    if (mode === "create" && baseUrl === "")
      invalidForm("Home Assistant base URL is required.", "baseUrl");
    return {
      ...result,
      ...(baseUrl === "" ? {} : { baseUrl }),
      ...(form.token === undefined || form.token === ""
        ? {}
        : { token: validateHomeAssistantToken(form.token) }),
    };
  }
  const webhookUrl = (form.webhookUrl ?? "").trim();
  if (mode === "create" && webhookUrl === "")
    invalidForm("Webhook endpoint is required.", "webhookUrl");
  const payloadFormat =
    form.payloadFormat === undefined || form.payloadFormat === "standard"
      ? "standard"
      : form.payloadFormat === "discord"
        ? "discord"
        : invalidForm("Payload format is invalid.", "payloadFormat");
  return {
    ...result,
    ...(webhookUrl === "" ? {} : { webhookUrl }),
    payloadFormat,
  };
}

export function mergeOutboundStaticHeaders(
  submitted: readonly OutboundHeader[],
  existing: readonly OutboundHeader[] | undefined,
  form: Readonly<Record<string, string>>,
): readonly OutboundHeader[] {
  const hasRows = Object.keys(form).some((key) => key.startsWith("static_header_"));
  if (!hasRows && existing !== undefined) return existing;
  return submitted.map((header) => {
    if (header.value !== "" || existing === undefined) return header;
    const match = existing.find(
      (candidate) => candidate.name.toLowerCase() === header.name.toLowerCase(),
    );
    return match === undefined ? header : match;
  });
}

export function outboundCreateInput(parsed: ParsedOutboundForm): CreateOutboundDestinationInput {
  return {
    label: parsed.label,
    transport: parsed.transport,
    required: parsed.required,
    enabled: parsed.enabled,
    subscriptions: parsed.subscriptions,
    staticHeaders: parsed.staticHeaders,
    secretHeaders: parsed.secretHeaders,
    ...(parsed.token === undefined ? {} : { secret: parsed.token }),
    ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
    ...(parsed.webhookUrl === undefined ? {} : { webhookUrl: parsed.webhookUrl }),
    ...(parsed.payloadFormat === undefined ? {} : { payloadFormat: parsed.payloadFormat }),
  };
}

export function outboundEditInput(
  parsed: ParsedOutboundForm,
  existing: OutboundDestination,
  form: Readonly<Record<string, string>>,
): EditOutboundDestinationInput {
  const existingConfig = existing.currentVersion?.config;
  const staticHeaders = mergeOutboundStaticHeaders(
    parsed.staticHeaders,
    existingConfig?.staticHeaders,
    form,
  );
  const hasSecretRows = Object.keys(form).some((key) => key.startsWith("secret_header_"));
  const secretHeaders =
    !hasSecretRows && existingConfig !== undefined
      ? existingConfig.secretHeaders.map((header) => ({ name: header.name, slot: header.slot }))
      : parsed.secretHeaders;
  return {
    label: parsed.label,
    transport: parsed.transport,
    required: parsed.required,
    subscriptions: parsed.subscriptions,
    staticHeaders,
    secretHeaders,
    ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
    ...(parsed.webhookUrl === undefined ? {} : { webhookUrl: parsed.webhookUrl }),
    ...(parsed.payloadFormat === undefined ? {} : { payloadFormat: parsed.payloadFormat }),
  };
}

export function machineKeyPageData(
  dependencies: MachineKeyPageDataDependencies,
  context: AdminContext,
  title: string,
  sourceName: string,
  machineKey: string,
): Readonly<Record<string, unknown>> {
  const display = dependencies.displayService.getSettings();
  return {
    page: {
      title,
      path: "/admin/integrations/telemetry",
      csrfToken: context.csrfToken,
      siteName: display.tapboardName,
      adminAccent: display.accent,
      displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      returnPath: "/admin/integrations/telemetry",
    },
    navItems: adminNavItems(),
    source: { name: sourceName },
    machineKey,
    endpointUrl: telemetryEndpointUrl(dependencies.canonicalOrigin),
  };
}
