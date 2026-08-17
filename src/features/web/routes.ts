import type { IncomingMessage, ServerResponse } from "node:http";

import { APPLICATION_SCHEMA_VERSION } from "../../infrastructure/database/migrations.ts";
import { sendJson } from "../../infrastructure/http/error-mapper.ts";
import { readFormBody, type ReadFormOptions } from "../../infrastructure/http/form.ts";
import { readJsonBody } from "../../infrastructure/http/security/body.ts";
import { redirect, sendHtml } from "../../infrastructure/http/html.ts";
import type { Router } from "../../infrastructure/http/router.ts";
import {
  clearCsrfCookie,
  clearSessionCookie,
  parseCsrfCookie,
  parseSessionCookie,
  serializeCsrfCookie,
} from "../../infrastructure/http/security/cookie.ts";
import { requireMutationOrigin } from "../../infrastructure/http/security/origin.ts";
import type { Renderer } from "../../infrastructure/rendering/renderer.ts";
import { ApplicationError, isApplicationError } from "../../shared/errors.ts";
import type { AuthService, AuthenticatedSession } from "../auth/service.ts";
import type { BeverageService } from "../beverages/service.ts";
import type { DashboardService } from "../dashboard/service.ts";
import type { PublicTapCardView } from "../dashboard/types.ts";
import type { DisplaySettingsService } from "../display/service.ts";
import { displayStylesheetHref } from "../display/palette.ts";
import { fillDeletionConfirmationLabel, type FillService } from "../fills/service.ts";
import type { AdminFillPage, AdminFillView } from "../fills/types.ts";
import type { HealthService } from "../health/service.ts";
import { kegDeletionConfirmationLabel, type KegService } from "../kegs/service.ts";
import type { AdminKegPage } from "../kegs/types.ts";
import type { LiveUpdateService } from "../live/service.ts";
import type { PublicTapWarsService } from "../tap-wars/public.ts";
import { tapWarPercentages, type TapWarService } from "../tap-wars/service.ts";
import type { EligibilityReason, TapWar } from "../tap-wars/types.ts";
import { searchAdminDestinations } from "./admin-search.ts";
import type { PublicStoryService } from "../story/service.ts";
import { buildSensoryRadar, VESSEL_IDS } from "../story/index.ts";
import { getVesselDescriptor } from "../story/vessels.ts";
import type { EventType } from "../events/types.ts";
import type { OutboundService } from "../outbound/service.ts";
import {
  validateHeaderSecretValue,
  validateHomeAssistantToken,
} from "../outbound/outbound-validation.ts";
import { dismissDelivery, retryDelivery } from "../outbox/repository.ts";
import type {
  CreateOutboundDestinationInput,
  EditOutboundDestinationInput,
  OutboundDeliveryHistoryItem,
  OutboundDestination,
  OutboundHeader,
} from "../outbound/types.ts";
import {
  BEVERAGE_SENSORY_CANONICAL_MAX,
  BEVERAGE_SENSORY_CANONICAL_MIN,
  BEVERAGE_TYPES,
  type BeverageListRecord,
  type BrewfatherCandidate,
  type UpdateCustomBeverageInput,
} from "../beverages/types.ts";
import type { BeverageDetailResult } from "../beverages/service.ts";
import { tapDeletionConfirmationLabel, type TapService } from "../taps/service.ts";
import type { AdminTapPage, AdminTapPageItem, AdminTapPageState } from "../taps/types.ts";
import {
  DETECTOR_CONFIG_FIELDS,
  mergeDetectorConfig,
  type DetectorConfigOverride,
} from "../telemetry/detector-config.ts";
import type { DetectorService } from "../telemetry/detector-service.ts";
import { validateCompleteDetectorConfig } from "../telemetry/detector-validation.ts";
import type { TelemetryService } from "../telemetry/service.ts";
import {
  HEALTH_CHECK_IDS,
  type HealthCheckId,
  type HealthConfigOverride,
} from "../health/types.ts";

const ADMIN_NAV = [
  {
    key: "overview",
    label: "Overview",
    href: "/admin/overview",
    group: "Overview",
    mark: "O",
    activePaths: ["/admin/overview"],
  },
  {
    key: "keg-room",
    label: "Keg Room",
    href: "/admin/keg-room",
    group: "Manage",
    mark: "K",
    activePaths: ["/admin/fills", "/admin/kegs", "/admin/keg-room"],
  },
  {
    key: "taps",
    label: "Taps",
    href: "/admin/taps",
    group: "Manage",
    mark: "T",
    activePaths: ["/admin/taps"],
  },
  {
    key: "beverages",
    label: "Beverages",
    href: "/admin/beverages",
    group: "Manage",
    mark: "B",
    activePaths: ["/admin/beverages"],
  },
  {
    key: "integrations",
    label: "Integrations",
    href: "/admin/integrations",
    group: "Configure",
    mark: "I",
    activePaths: ["/admin/integrations"],
  },
  {
    key: "display",
    label: "Display",
    href: "/admin/display",
    group: "Configure",
    mark: "D",
    activePaths: ["/admin/display"],
  },
  {
    key: "tap-wars",
    label: "Tap Wars",
    href: "/admin/tap-wars",
    group: "Manage",
    mark: "W",
    activePaths: ["/admin/tap-wars"],
  },
  {
    key: "system",
    label: "System",
    href: "/admin/system",
    group: "Future",
    mark: "S",
    activePaths: ["/admin/system"],
  },
] as const;

function adminNavItems(): readonly (typeof ADMIN_NAV)[number][] {
  return ADMIN_NAV;
}

function volume(ml: number, unit: string): string {
  return unit === "metric" ? `${(ml / 1000).toFixed(1)} L` : `${(ml / 3785.411784).toFixed(1)} gal`;
}

function temperature(c: number, unit: string): string {
  return unit === "metric" ? `${c.toFixed(1)} °C` : `${((c * 9) / 5 + 32).toFixed(1)} °F`;
}

const ADMIN_TIMESTAMP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function adminTimestampLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const hour24 = date.getUTCHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${ADMIN_TIMESTAMP_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${minute} ${hour24 < 12 ? "AM" : "PM"} UTC`;
}

interface AdminConfigFieldPresentation {
  readonly label: string;
  readonly help: string;
  readonly unit?: string;
}

const DETECTOR_FIELD_PRESENTATION = {
  candidateLossMl: {
    label: "Candidate loss (mL)",
    help: "Volume loss that starts a possible pour candidate.",
    unit: "mL",
    group: "detection-start",
  },
  candidateSamples: {
    label: "Candidate samples (count)",
    help: "Samples that must support a candidate before arbitration begins.",
    unit: "samples",
    group: "detection-start",
  },
  candidateSampleWindowMs: {
    label: "Candidate sample window (ms)",
    help: "Time window used to collect candidate samples.",
    unit: "ms",
    group: "detection-start",
  },
  candidateLookbackMs: {
    label: "Candidate lookback (ms)",
    help: "How far back the detector checks for the start of a loss.",
    unit: "ms",
    group: "detection-start",
  },
  arbitrationMs: {
    label: "Arbitration window (ms)",
    help: "Time allowed to confirm that the candidate is a real pour.",
    unit: "ms",
    group: "tap-arbitration",
  },
  arbitrationMinimumMl: {
    label: "Arbitration minimum flow (mL)",
    help: "Minimum flow needed before a candidate can win arbitration.",
    unit: "mL",
    group: "tap-arbitration",
  },
  arbitrationDominanceRatio: {
    label: "Arbitration dominance ratio",
    help: "How much stronger the winning signal must be than competing movement.",
    unit: "ratio",
    group: "tap-arbitration",
  },
  meaningfulFlowMl: {
    label: "Meaningful flow (mL)",
    help: "Flow amount treated as meaningful activity during a pour.",
    unit: "mL",
    group: "pour-completion",
  },
  quietPeriodMs: {
    label: "Quiet period (ms)",
    help: "Quiet time required before the pour can be considered complete.",
    unit: "ms",
    group: "pour-completion",
  },
  hardTimeoutMs: {
    label: "Hard timeout (ms)",
    help: "Maximum time a single pour candidate may remain open.",
    unit: "ms",
    group: "pour-completion",
  },
  minimumPourMl: {
    label: "Minimum pour (mL)",
    help: "Smallest completed pour recorded as a pour event.",
    unit: "mL",
    group: "pour-completion",
  },
  implausibleJumpMl: {
    label: "Implausible jump (mL)",
    help: "Volume jump large enough to require stability checks before acceptance.",
    unit: "mL",
    group: "pour-completion",
  },
  jumpStableSamples: {
    label: "Jump stability samples (count)",
    help: "Samples that must agree before a large jump is accepted.",
    unit: "samples",
    group: "stability-recovery",
  },
  jumpStableSpanMs: {
    label: "Jump stability span (ms)",
    help: "Time span over which large-jump samples must remain stable.",
    unit: "ms",
    group: "stability-recovery",
  },
  jumpBandMl: {
    label: "Jump stability band (mL)",
    help: "Allowed variation while confirming a large jump.",
    unit: "mL",
    group: "stability-recovery",
  },
  baselineSamples: {
    label: "Baseline samples (count)",
    help: "Samples used to establish a stable baseline around the Tap.",
    unit: "samples",
    group: "stability-recovery",
  },
  baselineSpanMs: {
    label: "Baseline span (ms)",
    help: "Time span used to establish the baseline.",
    unit: "ms",
    group: "stability-recovery",
  },
  baselineBandMl: {
    label: "Baseline stability band (mL)",
    help: "Allowed variation while establishing the baseline.",
    unit: "mL",
    group: "stability-recovery",
  },
  settledSamples: {
    label: "Settled samples (count)",
    help: "Samples used to confirm that the reading has settled after a pour.",
    unit: "samples",
    group: "stability-recovery",
  },
  settledSpanMs: {
    label: "Settled span (ms)",
    help: "Time span over which the post-pour reading must stay settled.",
    unit: "ms",
    group: "stability-recovery",
  },
  settledBandMl: {
    label: "Settled stability band (mL)",
    help: "Allowed variation for a reading to count as settled.",
    unit: "mL",
    group: "stability-recovery",
  },
  cooldownMs: {
    label: "Cooldown (ms)",
    help: "Quiet time after a completed pour before another event may start.",
    unit: "ms",
    group: "stability-recovery",
  },
  historyMs: {
    label: "History window (ms)",
    help: "How long recent samples remain available for recovery decisions.",
    unit: "ms",
    group: "stability-recovery",
  },
} as const satisfies Record<
  (typeof DETECTOR_CONFIG_FIELDS)[number],
  AdminConfigFieldPresentation & { readonly group: string }
>;

const DETECTOR_GROUPS = [
  {
    id: "detection-start",
    title: "Detection start",
    description: "These settings decide when measured volume loss becomes a pour candidate.",
  },
  {
    id: "tap-arbitration",
    title: "Tap arbitration",
    description: "These settings confirm that the candidate belongs to this Tap and is meaningful.",
  },
  {
    id: "pour-completion",
    title: "Pour completion",
    description: "These settings decide when a pour is recorded or safely timed out.",
  },
  {
    id: "stability-recovery",
    title: "Stability and recovery",
    description: "These settings keep baselines stable and recover cleanly after noisy readings.",
  },
] as const;

const HEALTH_SECTION_PRESENTATION: Record<
  HealthCheckId,
  {
    readonly title: string;
    readonly description: string;
    readonly fields: Record<string, AdminConfigFieldPresentation>;
  }
> = {
  low_keg: {
    title: "Low keg level",
    description: "Warn when the estimated remaining volume falls below these thresholds.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate low-level thresholds for this Tap.",
      },
      thresholdPercent: {
        label: "Warning threshold (%)",
        help: "Warn when the remaining fill percentage is at or below this value.",
        unit: "%",
      },
      criticalPercent: {
        label: "Critical threshold (%)",
        help: "Mark the Tap critical when the remaining fill percentage is at or below this value.",
        unit: "%",
      },
      fixedThresholdMl: {
        label: "Fixed volume threshold (mL)",
        help: "Optional fixed-volume floor; zero keeps the percentage threshold as the floor.",
        unit: "mL",
      },
      settlingMs: {
        label: "Threshold settling time (ms)",
        help: "How long the reading must remain below a threshold before it is reported.",
        unit: "ms",
      },
    },
  },
  scale_availability: {
    title: "Scale availability",
    description: "Flag when the authoritative scale has not sent a fresh measurement.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate freshness of the authoritative scale measurement.",
      },
      degradedAfterMs: {
        label: "Degraded after (ms)",
        help: "Mark the scale degraded after this much time without a fresh measurement.",
        unit: "ms",
      },
      activeAfterMs: {
        label: "Unavailable after (ms)",
        help: "Mark the scale unavailable after this much time without a fresh measurement.",
        unit: "ms",
      },
    },
  },
  suspected_leak: {
    title: "Suspected leak",
    description: "Look for unexplained volume loss outside the grace period around a pour.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate unexplained volume loss for this Tap.",
      },
      lossThresholdMl: {
        label: "Loss threshold (mL)",
        help: "Minimum unexplained loss that can become a leak signal.",
        unit: "mL",
      },
      windowMs: {
        label: "Observation window (ms)",
        help: "Time window in which unexplained loss is accumulated.",
        unit: "ms",
      },
      pourGraceMs: {
        label: "Pour grace period (ms)",
        help: "Ignore expected movement for this long after a pour.",
        unit: "ms",
      },
      settlingMs: {
        label: "Baseline settling time (ms)",
        help: "Wait this long for a stable baseline before evaluating loss.",
        unit: "ms",
      },
      resetMovementMl: {
        label: "Baseline reset movement (mL)",
        help: "Movement at or above this amount resets the leak baseline.",
        unit: "mL",
      },
      maxSamples: {
        label: "Maximum samples (count)",
        help: "Maximum number of leak samples retained in the evaluation window.",
        unit: "samples",
      },
    },
  },
  serving_temperature: {
    title: "Serving temperature",
    description: "Check whether the latest serving temperature stays within the configured bands.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate serving temperature for this Tap.",
      },
      normalMinC: {
        label: "Normal minimum (°C)",
        help: "Lower edge of the normal serving-temperature range.",
        unit: "°C",
      },
      normalMaxC: {
        label: "Normal maximum (°C)",
        help: "Upper edge of the normal serving-temperature range.",
        unit: "°C",
      },
      criticalMinC: {
        label: "Critical minimum (°C)",
        help: "Temperature at or below which the reading is critical.",
        unit: "°C",
      },
      criticalMaxC: {
        label: "Critical maximum (°C)",
        help: "Temperature at or above which the reading is critical.",
        unit: "°C",
      },
      durationMs: {
        label: "Out-of-range duration (ms)",
        help: "How long temperature must remain outside the normal range before reporting.",
        unit: "ms",
      },
    },
  },
  line_cleaning_due: {
    title: "Line cleaning",
    description:
      "Track when the Tap line should be cleaned and when the due state becomes critical.",
    fields: {
      enabled: {
        label: "Check enabled",
        help: "Evaluate line-cleaning age for this Tap.",
      },
      intervalDays: {
        label: "Cleaning interval (days)",
        help: "Number of days between expected line cleanings.",
        unit: "days",
      },
      criticalGraceDays: {
        label: "Critical grace period (days)",
        help: "Additional days after the due date before cleaning becomes critical.",
        unit: "days",
      },
    },
  },
};

function formatAdminConfigValue(value: unknown, unit?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return typeof value === "boolean" ? (value ? "enabled" : "disabled") : "—";
  }
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  if (unit !== "ms") return unit === undefined ? formatted : `${formatted} ${unit}`;
  const seconds = value / 1000;
  const secondsLabel = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(seconds);
  return `${formatted} ms (${secondsLabel} s)`;
}

function healthCheckPresentation(checkId: string): {
  readonly title: string;
  readonly description: string;
} {
  const presentation = HEALTH_SECTION_PRESENTATION[checkId as HealthCheckId];
  return presentation === undefined
    ? { title: "Health check", description: "Current health evaluation for this Tap." }
    : { title: presentation.title, description: presentation.description };
}

function humanizeAdminIdentifier(value: unknown, fallback = "Unknown"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const words = value.replaceAll(/[_-]+/gu, " ").trim();
  return words.length === 0 ? fallback : words[0]!.toUpperCase() + words.slice(1);
}

function telemetryEndpointUrl(canonicalOrigin: string | undefined): string {
  const origin = (canonicalOrigin ?? "http://localhost:3000").replace(/\/+$/u, "");
  return `${origin}/api/v1/telemetry/taps/1`;
}

export interface WebRouteDependencies {
  readonly router: Router;
  readonly renderer: Renderer;
  readonly canonicalOrigin?: string;
  readonly authService: AuthService;
  readonly dashboardService: DashboardService;
  readonly storyService: PublicStoryService;
  readonly displayService: DisplaySettingsService;
  readonly beverageService: BeverageService;
  readonly kegService: KegService;
  readonly fillService: FillService;
  readonly tapService: TapService;
  readonly telemetryService: TelemetryService;
  readonly detectorService: DetectorService;
  readonly healthService: HealthService;
  readonly liveUpdates: LiveUpdateService;
  readonly tapWarsService: TapWarService;
  readonly publicTapWarsService: PublicTapWarsService;
  /** Optional until the application composition wires Issue 79 outbound UI. */
  readonly outboundService?: OutboundService;
}

interface AdminContext {
  readonly session: AuthenticatedSession;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

function cookieValue(
  request: IncomingMessage,
  parser: typeof parseSessionCookie,
): string | undefined {
  try {
    return request.headers.cookie === undefined ? undefined : parser(request.headers.cookie);
  } catch {
    return undefined;
  }
}

function adminContext(
  request: IncomingMessage,
  authService: AuthService,
): AdminContext | undefined {
  const sessionToken = cookieValue(request, parseSessionCookie);
  if (sessionToken === undefined) return undefined;
  const session = authService.authenticateSession(sessionToken);
  if (session === undefined) return undefined;
  return {
    session,
    sessionToken,
    csrfToken: cookieValue(request, parseCsrfCookie) ?? "",
  };
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://tapboard.local");
}

function pageMessage(request: IncomingMessage): {
  readonly notice?: string;
  readonly error?: string;
} {
  const url = requestUrl(request);
  const notice = url.searchParams.get("notice");
  const error = url.searchParams.get("error");
  return {
    ...(notice === null ? {} : { notice: notice.slice(0, 240) }),
    ...(error === null ? {} : { error: error.slice(0, 240) }),
  };
}

function messageLocation(path: string, kind: "notice" | "error", message: string): string {
  const value = encodeURIComponent(message.slice(0, 240));
  return `${path}?${kind}=${value}`;
}

function actor(context: AdminContext): { readonly actorType: "admin"; readonly sessionId: string } {
  return { actorType: "admin", sessionId: context.session.id };
}

function nullable(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value === "" ? null : value;
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

function safeSensoryOverride(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= BEVERAGE_SENSORY_CANONICAL_MIN &&
    value <= BEVERAGE_SENSORY_CANONICAL_MAX
    ? value
    : null;
}

function nullableNumber(value: string | undefined): number | null | undefined {
  return value === undefined ? undefined : value === "" ? null : Number(value);
}

const TAP_CARD_DISPLAY_FIELDS = [
  ["showAbv", "ABV"],
  ["showIbu", "IBU"],
  ["showOg", "OG"],
  ["showFg", "FG"],
  ["showSrm", "SRM"],
] as const;

function tapCardOverrideFromForm(
  form: Readonly<Record<string, string>>,
): Record<(typeof TAP_CARD_DISPLAY_FIELDS)[number][0], boolean | null> {
  const result = {} as Record<(typeof TAP_CARD_DISPLAY_FIELDS)[number][0], boolean | null>;
  for (const [field, label] of TAP_CARD_DISPLAY_FIELDS) {
    const value = form[field];
    if (value === "inherit") result[field] = null;
    else if (value === "show") result[field] = true;
    else if (value === "hide") result[field] = false;
    else invalidForm(`${label} must be set to Inherit, Show, or Hide.`, field);
  }
  return result;
}

type PresentationField =
  | "name"
  | "beverageType"
  | "style"
  | "abv"
  | "ibu"
  | "og"
  | "fg"
  | "srm"
  | "displayColor"
  | "description"
  | "fillGlass"
  | "manualDensityOverride";
type PresentationOverride =
  { readonly inherit: true } | { readonly clear: true } | { readonly value: string | number };

function presentationOverridesFromForm(
  form: Readonly<Record<string, string>>,
): Partial<Record<PresentationField, PresentationOverride>> {
  const result: Partial<Record<PresentationField, PresentationOverride>> = {};
  const fields: readonly PresentationField[] = [
    "name",
    "beverageType",
    "style",
    "abv",
    "ibu",
    "og",
    "fg",
    "srm",
    "displayColor",
    "description",
    "fillGlass",
    "manualDensityOverride",
  ];
  for (const field of fields) {
    const mode = form[`${field}Mode`];
    if (mode === undefined) {
      // Older forms did not expose a mode for the vessel picker. Preserve
      // that normal form action while keeping newly-supported fields absent
      // unless the detail form explicitly submits them.
      if (field === "fillGlass") {
        result[field] = { value: vesselFromForm(form[field] ?? "") ?? "" };
      }
      continue;
    }
    if (mode === "inherit") {
      result[field] = { inherit: true };
    } else if (mode === "clear" && field !== "name" && field !== "beverageType") {
      result[field] = { clear: true };
    } else if (mode !== "value") {
      invalidForm(`${field} mode must be inherit, clear, or value.`, `${field}Mode`);
    } else {
      const value = form[field] ?? "";
      if (field === "fillGlass") {
        result[field] = { value: vesselFromForm(value) ?? "" };
      } else {
        result[field] = ["abv", "ibu", "og", "fg", "srm", "manualDensityOverride"].includes(field)
          ? { value: Number(value) }
          : { value };
      }
    }
  }
  return result;
}

function invalidForm(message: string, field?: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "request.invalid",
    clientMessage: message,
    ...(field === undefined ? {} : { details: { field, reason: "invalid" } }),
  });
}

const OUTBOUND_EVENT_FIELDS = [
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

const OUTBOUND_MAX_HEADER_ROWS = 8;

interface OutboundHeaderSecretValue {
  readonly name: string;
  readonly value: string;
}

interface ParsedOutboundForm {
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

function requireOutboundService(dependencies: WebRouteDependencies): OutboundService {
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

function outboundDestinationOrNotFound(
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

function outboundShortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-3)}` : value;
}

function outboundStateLabel(value: string): string {
  return humanizeAdminIdentifier(value, "Unknown");
}

function outboundStateClass(value: string): "healthy" | "degraded" | "muted" {
  if (value === "healthy") return "healthy";
  if (value === "failing" || value === "degraded" || value === "needs_attention") return "degraded";
  return "muted";
}

function outboundConfigPresentation(destination: OutboundDestination): Record<string, unknown> {
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

function outboundDestinationPresentation(
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

function outboundHistoryPresentation(
  rows: readonly OutboundDeliveryHistoryItem[],
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
    canRetry: row.state === "terminal",
    canDismiss: row.state === "terminal",
  }));
}

function outboundSubscriptionsFromForm(
  form: Readonly<Record<string, string>>,
): readonly EventType[] {
  return OUTBOUND_EVENT_FIELDS.filter((field) => form[field.name] === "on").map(
    (field) => field.eventType,
  );
}

function outboundStaticHeadersFromForm(
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

function outboundSecretHeadersFromForm(form: Readonly<Record<string, string>>): {
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

function parseOutboundForm(
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

function mergeOutboundStaticHeaders(
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

function applyOutboundHeaderSecrets(
  service: OutboundService,
  destinationId: string,
  values: readonly OutboundHeaderSecretValue[],
): void {
  if (values.length === 0) return;
  const destination = outboundDestinationOrNotFound(service, destinationId);
  const config = destination.currentVersion?.config;
  if (config === undefined) invalidForm("Outbound configuration is unavailable.");
  for (const value of values) {
    const header = config.secretHeaders.find(
      (candidate) => candidate.name.toLowerCase() === value.name.toLowerCase(),
    );
    if (header === undefined) invalidForm("The submitted secret header is not configured.");
    service.setHeaderSecret(destinationId, header.slot, value.value);
  }
}

function outboundCreateInput(parsed: ParsedOutboundForm): CreateOutboundDestinationInput {
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

function outboundEditInput(
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

function recipeFromForm(
  form: Readonly<Record<string, string>>,
): UpdateCustomBeverageInput["recipe"] {
  const serialized = form.recipeJson ?? "";
  // Whitespace-only input is the no-JS delete affordance. Do not trim a
  // non-empty payload: the service owns validation and the JSON values must
  // retain every supported character exactly as entered.
  if (serialized.trim() === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    invalidForm("Recipe must contain valid JSON.");
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidForm("Recipe must be a JSON object.");
  }
  return parsed;
}

function sensoryOverridesFromForm(
  form: Readonly<Record<string, string>>,
): UpdateCustomBeverageInput["sensoryOverrides"] | undefined {
  if (!ADMIN_BEVERAGE_SENSORY_AXES.some((axis) => form[axis] !== undefined)) return undefined;
  const bitterness = nullableNumber(form.bitterness);
  const sweetness = nullableNumber(form.sweetness);
  const body = nullableNumber(form.body);
  const roast = nullableNumber(form.roast);
  const tartness = nullableNumber(form.tartness);
  const alcohol = nullableNumber(form.alcohol);
  return {
    ...(bitterness === undefined ? {} : { bitterness }),
    ...(sweetness === undefined ? {} : { sweetness }),
    ...(body === undefined ? {} : { body }),
    ...(roast === undefined ? {} : { roast }),
    ...(tartness === undefined ? {} : { tartness }),
    ...(alcohol === undefined ? {} : { alcohol }),
  };
}

function vesselFromForm(value: string | undefined, field = "fillGlass"): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!(VESSEL_IDS as readonly string[]).includes(trimmed)) {
    invalidForm("Fill Glass must be selected from the supported catalog.", field);
  }
  return trimmed;
}

function safeVesselForDisplay(value: unknown): string | null {
  return typeof value === "string" && (VESSEL_IDS as readonly string[]).includes(value)
    ? value
    : null;
}

function safeColorForDisplay(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : null;
}

function vesselDisplayName(value: string): string {
  const names: Readonly<Record<string, string>> = {
    corny_keg: "Corny keg",
    pint_glass: "Pint glass",
    tulip_glass: "Tulip glass",
    wheat_glass: "Wheat glass",
    mug: "Mug",
    stout_glass: "Stout glass",
    snifter: "Snifter",
    nonic_pint: "Nonic pint",
    shaker_pint: "Shaker pint",
    pilsner_flute: "Pilsner flute",
    stange: "Stange",
    goblet: "Goblet",
    teku: "Teku",
    thistle: "Thistle",
    ipa_glass: "IPA glass",
    tasting_glass: "Tasting glass",
    stemmed_lager: "Stemmed lager",
  };
  return names[value] ?? value;
}

function fillGlassOptions() {
  return VESSEL_IDS.map((id) => ({
    id,
    label: vesselDisplayName(id),
    graphic: getVesselDescriptor(id),
  }));
}

const ADMIN_BEVERAGE_SENSORY_AXES = [
  "bitterness",
  "sweetness",
  "body",
  "roast",
  "tartness",
  "alcohol",
] as const;

function boundedAdminString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, maxBytes);
}

function boundedAdminNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeAdminRecipe(value: unknown): {
  readonly notes: string | null;
  readonly ingredients: readonly {
    readonly name: string;
    readonly amount: number | null;
    readonly unit: string | null;
    readonly note: string | null;
  }[];
  readonly steps: readonly {
    readonly name: string;
    readonly temperatureC: number | null;
    readonly timeMinutes: number | null;
    readonly note: string | null;
  }[];
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawIngredients = Array.isArray(record.ingredients) ? record.ingredients : [];
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const ingredients = rawIngredients.slice(0, 200).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const ingredient = item as Record<string, unknown>;
    const name = boundedAdminString(ingredient.name, 160);
    if (name === null) return [];
    return [
      {
        name,
        amount: boundedAdminNumber(ingredient.amount),
        unit: boundedAdminString(ingredient.unit, 32),
        note: boundedAdminString(ingredient.note, 255),
      },
    ];
  });
  const steps = rawSteps.slice(0, 100).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const step = item as Record<string, unknown>;
    const name = boundedAdminString(step.name, 160);
    if (name === null) return [];
    return [
      {
        name,
        temperatureC: boundedAdminNumber(step.temperatureC),
        timeMinutes: boundedAdminNumber(step.timeMinutes),
        note: boundedAdminString(step.note, 1000),
      },
    ];
  });
  return {
    notes: boundedAdminString(record.notes, 4000),
    ingredients,
    steps,
  };
}

function safeAdminGuidance(value: unknown): {
  readonly sensory: Readonly<
    Record<
      string,
      {
        readonly value: number | null;
        readonly source: string;
        readonly confidence: string | null;
        readonly evidence: string;
      }
    >
  >;
  readonly customRecipe: ReturnType<typeof safeAdminRecipe>;
  readonly sourceRecipes: readonly unknown[];
  readonly activeSourceLabel: string | null;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawSensory =
    typeof record.sensory === "object" && record.sensory !== null
      ? (record.sensory as Record<string, unknown>)
      : {};
  const sensory: Record<
    string,
    {
      readonly value: number | null;
      readonly source: string;
      readonly confidence: string | null;
      readonly evidence: string;
    }
  > = {};
  for (const axis of ADMIN_BEVERAGE_SENSORY_AXES) {
    const raw = rawSensory[axis];
    const result = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    sensory[axis] = {
      value: boundedAdminNumber(result.value),
      source: boundedAdminString(result.source, 64) ?? "unavailable",
      confidence: boundedAdminString(result.confidence, 32),
      evidence: boundedAdminString(result.evidence, 240) ?? "Guidance unavailable.",
    };
  }
  const rawSourceRecipes = Array.isArray(record.sourceRecipes) ? record.sourceRecipes : [];
  const sourceRecipes = rawSourceRecipes.slice(0, 5).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const recipe = raw as Record<string, unknown>;
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.slice(0, 200).flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const ingredient = item as Record<string, unknown>;
          const name = boundedAdminString(ingredient.name, 160);
          if (name === null) return [];
          return [
            {
              name,
              amount: boundedAdminNumber(ingredient.amount),
              unit: boundedAdminString(ingredient.unit, 32),
              note: boundedAdminString(ingredient.note, 255),
            },
          ];
        })
      : [];
    const steps = Array.isArray(recipe.steps)
      ? recipe.steps.slice(0, 100).flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const step = item as Record<string, unknown>;
          return [
            {
              name: boundedAdminString(step.name, 160),
              text: boundedAdminString(step.text, 4000),
              temperatureC: boundedAdminNumber(step.temperatureC),
              timeMinutes: boundedAdminNumber(step.timeMinutes),
              note: boundedAdminString(step.note, 1000),
            },
          ];
        })
      : [];
    return [
      {
        kind: boundedAdminString(recipe.kind, 32),
        status: boundedAdminString(recipe.status, 32),
        notes: boundedAdminString(recipe.notes, 4000),
        ingredients,
        steps,
        provenance:
          typeof recipe.provenance === "object" && recipe.provenance !== null
            ? {
                label: boundedAdminString(
                  (recipe.provenance as Record<string, unknown>).label,
                  120,
                ),
                state: boundedAdminString((recipe.provenance as Record<string, unknown>).state, 32),
                version: boundedAdminNumber((recipe.provenance as Record<string, unknown>).version),
                capturedAt: boundedAdminString(
                  (recipe.provenance as Record<string, unknown>).capturedAt,
                  64,
                ),
              }
            : null,
      },
    ];
  });
  return {
    sensory,
    customRecipe: safeAdminRecipe(record.customRecipe),
    sourceRecipes,
    activeSourceLabel: boundedAdminString(record.activeSourceLabel, 120),
  };
}

function adminBeverageListItem(item: BeverageListRecord): Record<string, unknown> {
  const fillGlass = safeVesselForDisplay(item.effectivePresentation.fillGlass);
  return {
    id: item.beverage.id,
    name: item.effectivePresentation.name,
    ownershipType: item.beverage.ownershipType,
    source: item.beverage.ownershipType === "brewfather" ? "Brewfather" : "Custom",
    beverageType: item.effectivePresentation.beverageType,
    style: item.effectivePresentation.style,
    abv: item.effectivePresentation.abv,
    displayColor: safeColorForDisplay(item.effectivePresentation.displayColor),
    fillGlass: fillGlass === null ? null : vesselDisplayName(fillGlass),
    graphic: getVesselDescriptor(fillGlass ?? "pint_glass"),
    fillPercent: 100,
    currentUsage:
      Number.isFinite(item.currentUsage) && item.currentUsage >= 0 ? item.currentUsage : 0,
    updatedAt: item.beverage.updatedAt,
  };
}

function adminBrewfatherCandidate(candidate: BrewfatherCandidate): Record<string, unknown> {
  return {
    sourceBatchId: boundedAdminString(candidate.sourceBatchId, 256) ?? "",
    name: boundedAdminString(candidate.batchName ?? candidate.recipeName, 160) ?? "Unnamed batch",
    number: boundedAdminString(candidate.batchNumber, 64),
    status: boundedAdminString(candidate.status, 32) ?? "Unknown",
    style: boundedAdminString(candidate.style, 120),
  };
}

function listQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 80);
  const parsedPage = Number(params.get("page") ?? "1");
  return {
    q,
    page:
      Number.isInteger(parsedPage) && Number.isFinite(parsedPage)
        ? Math.min(10_000, Math.max(1, parsedPage))
        : 1,
  };
}

function beveragePageHref(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/beverages" : `/admin/beverages?${encoded}`;
}

function adminFillPageQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly state: string;
  readonly sort: string;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const rawPage = Number(params.get("page") ?? "1");
  const history = params.get("history") === "1" || params.get("history") === "true";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    state: history ? "ended" : (params.get("state") ?? "active").trim().toLowerCase(),
    sort: (params.get("sort") ?? "state").trim().toLowerCase(),
    page:
      Number.isInteger(rawPage) && Number.isFinite(rawPage)
        ? Math.min(10_000, Math.max(1, rawPage))
        : 1,
  };
}

function adminKegPageQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly status: string;
  readonly sort: string;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const rawPage = Number(params.get("page") ?? "1");
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    status: (params.get("status") ?? "active").trim().toLowerCase(),
    sort: (params.get("sort") ?? "number").trim().toLowerCase(),
    page:
      Number.isInteger(rawPage) && Number.isFinite(rawPage)
        ? Math.min(10_000, Math.max(1, rawPage))
        : 1,
  };
}

function adminFillPageHref(query: Readonly<Record<string, string | number>>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "page" || value === "" || value === "active" || value === "state") continue;
    params.set(key, String(value));
  }
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/keg-room" : `/admin/keg-room?${encoded}`;
}

function adminKegPageHref(query: Readonly<Record<string, string | number>>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "page" || value === "" || value === "active" || value === "number") continue;
    params.set(key, String(value));
  }
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/keg-room/kegs" : `/admin/keg-room/kegs?${encoded}`;
}

function adminTapPageQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly state: AdminTapPageState;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const rawPage = Number(params.get("page") ?? "1");
  const rawState = (params.get("state") ?? "all").trim().toLowerCase();
  if (!["all", "assigned", "unassigned", "disabled", "retired"].includes(rawState)) {
    invalidForm("Tap state must be all, assigned, unassigned, disabled, or retired.");
  }
  const state = rawState as AdminTapPageState;
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    state,
    page:
      Number.isInteger(rawPage) && Number.isFinite(rawPage)
        ? Math.min(10_000, Math.max(1, rawPage))
        : 1,
  };
}

function adminTapPageHref(
  query: Readonly<{ readonly q: string; readonly state: AdminTapPageState }>,
  page: number,
): string {
  const params = new URLSearchParams();
  if (query.q.length > 0) params.set("q", query.q);
  if (query.state !== "all") params.set("state", query.state);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? "/admin/taps" : `/admin/taps?${encoded}`;
}

function fallbackAdminTapPage(
  tapService: TapService,
  query: Readonly<{ readonly q: string; readonly state: AdminTapPageState; readonly page: number }>,
): AdminTapPage {
  const candidate = tapService as TapService & {
    readonly listAdminPage?: (input?: unknown) => AdminTapPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);

  const all = tapService.listTaps();
  const filtered = all
    .filter((tap) => {
      switch (query.state) {
        case "assigned":
          return tap.activeAssignment !== null && tap.activeAssignment !== undefined;
        case "unassigned":
          return tap.activeAssignment === null || tap.activeAssignment === undefined;
        case "disabled":
          return !tap.enabled;
        case "retired":
          return tap.isRetired;
        case "all":
          return true;
      }
    })
    .sort((left, right) => left.tapNumber - right.tapNumber || left.id.localeCompare(right.id));
  const needle = query.q.toLocaleLowerCase();
  const searched =
    needle.length === 0
      ? filtered
      : filtered.filter((tap) => {
          const assignment = tap.activeAssignment;
          const lifecycle = tap.isRetired ? "retired" : tap.enabled ? "enabled" : "disabled";
          const assignmentState =
            assignment === undefined || assignment === null ? "unassigned" : "assigned";
          return `${tap.tapNumber} ${tap.name ?? ""} ${assignment?.beverageName ?? ""} ${assignment?.kegNumber ?? ""} ${assignment?.kegLabel ?? ""} ${lifecycle} ${assignmentState}`
            .toLocaleLowerCase()
            .includes(needle);
        });
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(query.page, pageCount);
  const items: AdminTapPageItem[] = searched.slice((page - 1) * 25, page * 25).map((tap) => ({
    id: tap.id,
    tapNumber: tap.tapNumber,
    name: tap.name,
    enabled: tap.enabled,
    isRetired: tap.isRetired,
    firstUsedAt: tap.firstUsedAt,
    retiredAt: tap.retiredAt,
    assignment:
      tap.activeAssignment === null || tap.activeAssignment === undefined
        ? null
        : {
            id: tap.activeAssignment.id,
            fillId: tap.activeAssignment.fillId,
            beverageId: tap.activeAssignment.beverageId,
            beverageName: tap.activeAssignment.beverageName,
            kegId: tap.activeAssignment.kegId,
            kegNumber: tap.activeAssignment.kegNumber,
            kegLabel: tap.activeAssignment.kegLabel,
            assignedAt: tap.activeAssignment.assignedAt,
          },
    updatedAt: tap.updatedAt,
  }));
  return { items, total, page, pageSize: 25, pageCount, query: query.q, state: query.state };
}

function safeDashboardTap(
  dashboardService: DashboardService,
  tapId: string,
): PublicTapCardView | null {
  const candidate = dashboardService as DashboardService & {
    readonly getTap?: (id: string) => PublicTapCardView | undefined;
  };
  if (typeof candidate.getTap !== "function") return null;
  try {
    const card = candidate.getTap(tapId);
    return card === undefined ? null : card;
  } catch {
    return null;
  }
}

function safeHealthOverview(healthService: HealthService, tapId: string): Record<string, unknown> {
  try {
    const overview = healthService.getAdminOverview(tapId) as unknown as Record<string, unknown>;
    const aggregate = overview.aggregate as Record<string, unknown> | undefined;
    const state = typeof aggregate?.state === "string" ? aggregate.state : "unknown";
    const severity = typeof aggregate?.severity === "string" ? aggregate.severity : "none";
    return {
      state,
      stateLabel: humanizeAdminIdentifier(state),
      severity,
      severityLabel: humanizeAdminIdentifier(severity),
      activeIncidentCount:
        typeof overview.activeIncidentCount === "number" ? overview.activeIncidentCount : 0,
      checks: Array.isArray(overview.checks)
        ? overview.checks.map((check) => {
            const value = check as Record<string, unknown>;
            const id = typeof value.checkId === "string" ? value.checkId : "unknown";
            const state = typeof value.state === "string" ? value.state : "unknown";
            const severity = typeof value.severity === "string" ? value.severity : "none";
            const reason = typeof value.reason === "string" ? value.reason : null;
            return {
              id,
              label: healthCheckPresentation(id).title,
              state,
              stateLabel: humanizeAdminIdentifier(state),
              severity,
              severityLabel: humanizeAdminIdentifier(severity),
              reason,
              reasonLabel: reason === null ? null : humanizeAdminIdentifier(reason),
            };
          })
        : [],
      lineCleaning: overview.lineCleaning ?? null,
    };
  } catch {
    return {
      state: "unknown",
      stateLabel: "Unknown",
      severity: "none",
      severityLabel: "None",
      activeIncidentCount: 0,
      checks: [],
      lineCleaning: null,
    };
  }
}

function tapRemainingLabel(card: PublicTapCardView | null, assigned: boolean): string {
  if (card?.waitingForMeasurement === true) return "Waiting for measurement";
  if (typeof card?.fillPercent === "number" && Number.isFinite(card.fillPercent)) {
    return `${Math.round(Math.min(100, Math.max(0, card.fillPercent)))}% remaining`;
  }
  if (assigned) return "Measurement unavailable";
  return "Not assigned";
}

function safeMysteryPreview(
  card: PublicTapCardView | null,
  isMystery: boolean,
): PublicTapCardView | null {
  if (card === null) return null;
  if (!isMystery) return card;
  // The public projection is authoritative, but its normal dashboard identity
  // attributes are not appropriate inside the privileged page's Mystery
  // preview. Preserve only the public Mystery-safe content and exemptions.
  return {
    ...card,
    id: "",
    tapName: null,
    beverageName: null,
    fillId: null,
    storyPath: null,
    title: "Mystery Tap",
    accessibleLabel: `Tap ${card.tapNumber}, Mystery Tap`,
  };
}

function fallbackAdminFillPage(
  fillService: FillService,
  query: Readonly<Record<string, unknown>>,
): AdminFillPage {
  const candidate = fillService as FillService & {
    readonly listAdminPage?: (input?: unknown) => AdminFillPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedState = typeof query.state === "string" ? query.state : "active";
  const all = fillService.listFills();
  const filtered = all.filter((fill) => {
    if (requestedState === "active") return fill.state !== "ended";
    if (requestedState === "all") return true;
    return fill.state === requestedState;
  });
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((fill) =>
          `${fill.beverageName} ${fill.kegNumber} ${fill.kegLabel ?? ""}`
            .toLocaleLowerCase()
            .includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    state: requestedState as AdminFillPage["state"],
    sort: (typeof query.sort === "string" ? query.sort : "state") as AdminFillPage["sort"],
  };
}

function fallbackAdminKegPage(
  kegService: KegService,
  query: Readonly<Record<string, unknown>>,
): AdminKegPage {
  const candidate = kegService as KegService & {
    readonly listAdminPage?: (input?: unknown) => AdminKegPage;
  };
  if (typeof candidate.listAdminPage === "function") return candidate.listAdminPage(query);
  const requestedStatus = typeof query.status === "string" ? query.status : "active";
  const all = kegService.listKegs();
  const filtered = all.filter(
    (keg) =>
      requestedStatus === "all" || (requestedStatus === "active" ? keg.isActive : !keg.isActive),
  );
  const q = typeof query.q === "string" ? query.q.toLocaleLowerCase() : "";
  const searched =
    q.length === 0
      ? filtered
      : filtered.filter((keg) =>
          `keg ${keg.kegNumber} ${keg.label ?? ""}`.toLocaleLowerCase().includes(q),
        );
  const pageSize = 25;
  const total = searched.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(typeof query.page === "number" ? query.page : 1, pageCount);
  return {
    items: searched.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pageCount,
    query: typeof query.q === "string" ? query.q : "",
    status: requestedStatus as AdminKegPage["status"],
    sort: (typeof query.sort === "string" ? query.sort : "number") as AdminKegPage["sort"],
  };
}

function safePublicTapCards(dashboardService: DashboardService): readonly PublicTapCardView[] {
  const candidate = dashboardService as DashboardService & {
    readonly listTaps?: () => readonly PublicTapCardView[];
  };
  if (typeof candidate.listTaps !== "function") return [];
  try {
    const cards = candidate.listTaps();
    return [...cards].slice(0, 1_000);
  } catch {
    // The privileged Admin projection remains usable if a public preview is
    // unavailable. Public card data is enhancement-only here.
    return [];
  }
}

function boundedFillPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function boundedRemainingMetric(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, 1_000_000);
}

function safeRemainingEstimate(
  state: AdminFillView["state"],
  publicCard: PublicTapCardView | null,
  fillPercent: number,
  servingsRemaining: number | null,
  daysRemaining: number | null,
): string {
  if (publicCard?.waitingForMeasurement === true) return "Waiting for measurement";
  if (servingsRemaining !== null) return `${Math.floor(servingsRemaining)} servings estimated`;
  if (daysRemaining !== null) return `${Math.round(daysRemaining * 10) / 10} days estimated`;
  if (publicCard?.fillPercent !== null && publicCard?.fillPercent !== undefined) {
    return `${fillPercent}% remaining`;
  }
  if (state === "on_tap") return "Estimate unavailable";
  if (state === "ended") return "Ended";
  return "Not on tap";
}

function safeFillCard(
  fill: AdminFillView,
  dashboardService: DashboardService,
  publicCards: readonly PublicTapCardView[] = safePublicTapCards(dashboardService),
): Record<string, unknown> {
  // Match only by the non-Mystery public fillId. Public projections may hide
  // identity for Mystery Taps; their runtime metrics must not cross that
  // visibility boundary into this privileged Admin card.
  const publicCard = publicCards.find((candidate) => candidate.fillId === fill.id) ?? null;
  const publicPercent = boundedFillPercent(publicCard?.fillPercent);
  const fallbackPercent =
    fill.state === "ended" ? 0 : fill.state === "available" || fill.state === "on_deck" ? 100 : 0;
  const fillPercent = publicPercent ?? fallbackPercent;
  const servingsRemaining = boundedRemainingMetric(publicCard?.servingsRemaining);
  const daysRemaining = boundedRemainingMetric(publicCard?.daysRemaining);
  const authoritativeTapId = fill.tapId ?? publicCard?.id ?? null;
  const authoritativeTapNumber = fill.tapNumber ?? publicCard?.tapNumber ?? null;
  const fillGlass = safeVesselForDisplay(fill.fillGlass);
  const displayColor = safeColorForDisplay(fill.displayColor);
  const graphicId = fillGlass ?? "pint_glass";
  return {
    id: fill.id,
    beverageName: boundedAdminString(fill.beverageName, 160) ?? "Unknown Beverage",
    beverageType: boundedAdminString(fill.beverageType, 32) ?? "other",
    beverageStyle: boundedAdminString(fill.beverageStyle, 120),
    beverageAbv: Number.isFinite(fill.beverageAbv) ? fill.beverageAbv : null,
    kegId: fill.kegId,
    kegNumber: fill.kegNumber,
    kegLabel: boundedAdminString(fill.kegLabel, 120),
    confirmationLabel: fillDeletionConfirmationLabel(fill),
    fillDate: fill.fillDate,
    state: fill.state,
    stateLabel:
      fill.state === "on_deck"
        ? "On Deck"
        : fill.state === "on_tap"
          ? "On Tap"
          : fill.state === "ended"
            ? "Ended"
            : "Available",
    onDeckOrder: fill.onDeckOrder,
    tapNumber: authoritativeTapNumber,
    tapId: authoritativeTapId,
    queuePosition: fill.onDeckOrder,
    fillPercent,
    servingsRemaining,
    daysRemaining,
    waitingForMeasurement: publicCard?.waitingForMeasurement ?? false,
    remainingEstimate: safeRemainingEstimate(
      fill.state,
      publicCard,
      fillPercent,
      servingsRemaining,
      daysRemaining,
    ),
    fillGlass: fillGlass ?? "pint_glass",
    displayColor: displayColor ?? "#D97706",
    graphic: getVesselDescriptor(graphicId),
    updatedAt: fill.updatedAt,
  };
}

function adminBeverageDetailDto(
  detail: BeverageDetailResult,
  usage: { readonly current: number; readonly total: number },
  deletionImpacts: readonly { readonly code: string; readonly count: number }[],
  guidance: unknown,
): Record<string, unknown> {
  const effective = detail.effectivePresentation;
  const source = detail.brewfatherSourceProfile;
  const overrides = detail.presentationOverrides;
  const customRecipe = safeAdminRecipe(detail.customRecipe);
  const sourceProjection =
    source === undefined
      ? null
      : {
          name: source.name,
          beverageType: source.beverageType,
          style: source.style,
          abv: source.abv,
          ibu: source.ibu,
          og: source.og,
          fg: source.fg,
          srm: source.srm,
          displayColor: safeColorForDisplay(source.displayColor),
          description: source.description,
          updatedAt: source.updatedAt,
        };
  const overrideProjection = {
    name: overrides?.name ?? null,
    beverageType: overrides?.beverageType ?? null,
    style: overrides?.style ?? null,
    abv: overrides?.abv ?? null,
    ibu: overrides?.ibu ?? null,
    og: overrides?.og ?? null,
    fg: overrides?.fg ?? null,
    srm: overrides?.srm ?? null,
    displayColor: safeColorForDisplay(overrides?.displayColor),
    description: overrides?.description ?? null,
    fillGlass: safeVesselForDisplay(overrides?.fillGlass),
    manualDensityOverride: overrides?.manualDensityOverride ?? null,
    overrideNamePresent: overrides?.overrideNamePresent ?? false,
    overrideBeverageTypePresent: overrides?.overrideBeverageTypePresent ?? false,
    overrideStylePresent: overrides?.overrideStylePresent ?? false,
    overrideAbvPresent: overrides?.overrideAbvPresent ?? false,
    overrideIbuPresent: overrides?.overrideIbuPresent ?? false,
    overrideOgPresent: overrides?.overrideOgPresent ?? false,
    overrideFgPresent: overrides?.overrideFgPresent ?? false,
    overrideSrmPresent: overrides?.overrideSrmPresent ?? false,
    overrideDisplayColorPresent: overrides?.overrideDisplayColorPresent ?? false,
    overrideDescriptionPresent: overrides?.overrideDescriptionPresent ?? false,
    overrideFillGlassPresent: overrides?.overrideFillGlassPresent ?? false,
    overrideManualDensityOverridePresent: overrides?.overrideManualDensityOverridePresent ?? false,
  };
  return {
    id: detail.beverage.id,
    ownershipType: detail.beverage.ownershipType,
    name: effective.name,
    beverageType: effective.beverageType,
    style: effective.style,
    abv: effective.abv,
    ibu: effective.ibu,
    og: effective.og,
    fg: effective.fg,
    srm: effective.srm,
    displayColor: safeColorForDisplay(effective.displayColor),
    description: effective.description,
    fillGlass: safeVesselForDisplay(effective.fillGlass),
    manualDensityOverride: effective.manualDensityOverride,
    createdAt: detail.beverage.createdAt,
    updatedAt: detail.beverage.updatedAt,
    density: detail.density,
    usage,
    source: sourceProjection,
    overrides: source === undefined ? null : overrideProjection,
    syncState: detail.brewfatherLink?.syncState ?? null,
    lastSyncedAt: detail.brewfatherLink?.lastSyncedAt ?? null,
    sensoryOverrides:
      detail.sensoryOverrides === undefined
        ? null
        : Object.fromEntries(
            ADMIN_BEVERAGE_SENSORY_AXES.map((axis) => [
              axis,
              safeSensoryOverride(detail.sensoryOverrides?.[axis]),
            ]),
          ),
    customRecipe,
    customRecipeJson: customRecipe === null ? "" : JSON.stringify(customRecipe, null, 2),
    guidance: safeAdminGuidance(guidance),
    deletionImpacts: deletionImpacts.map((impact) => ({
      code: boundedAdminString(impact.code, 80) ?? "related records",
      count: Number.isFinite(impact.count) && impact.count >= 0 ? impact.count : 0,
    })),
  };
}

function detectorOverrideFromForm(form: Readonly<Record<string, string>>): DetectorConfigOverride {
  return Object.fromEntries(
    DETECTOR_CONFIG_FIELDS.flatMap((field) => {
      const value = form[`detector.${field}`];
      return value === undefined || value === "" ? [] : [[field, Number(value)]];
    }),
  );
}

function healthOverrideFromForm(
  form: Readonly<Record<string, string>>,
  effective: ReturnType<HealthService["getEffectiveConfig"]>["effective"],
): HealthConfigOverride | null {
  const override: Record<string, Record<string, boolean | number>> = {};
  for (const checkId of HEALTH_CHECK_IDS) {
    for (const [field, inheritedValue] of Object.entries(effective[checkId])) {
      const raw = form[`health.${checkId}.${field}`];
      if (raw === undefined || raw === "") continue;
      const section = (override[checkId] ??= {});
      section[field] = typeof inheritedValue === "boolean" ? raw === "true" : Number(raw);
    }
  }
  return Object.keys(override).length === 0 ? null : override;
}

function renderAdmin(
  dependencies: WebRouteDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  view: string,
  title: string,
  path: string,
  data: Readonly<Record<string, unknown>> = {},
): void {
  const message = pageMessage(request);
  const display = dependencies.displayService.getSettings();
  const {
    includeDashboardStyles: requestedDashboardStyles,
    displayStylesheetHref: requestedDisplayStylesheetHref,
    ...viewData
  } = data;
  const page = {
    title,
    path,
    csrfToken: context.csrfToken,
    siteName: display.tapboardName,
    adminAccent: display.accent,
    ...(requestedDashboardStyles === true ? { includeDashboardStyles: true } : {}),
    // Every authenticated Admin page receives the configured external display
    // stylesheet. Dedicated preview pages may explicitly request a different
    // font set (the shared preview uses `all`); ordinary pages never do.
    displayStylesheetHref:
      requestedDisplayStylesheetHref ??
      displayStylesheetHref(display.theme, display.accent, display.font),
    ...message,
  };
  sendHtml(
    response,
    200,
    dependencies.renderer.render(view, {
      page,
      navItems: adminNavItems(),
      ...viewData,
    }),
  );
}

function registerAdminGet(
  dependencies: WebRouteDependencies,
  path: string,
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => void | Promise<void>,
): void {
  dependencies.router.get(path, async (request, response, params) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }
    try {
      await handler(request, response, context, params);
    } catch (error) {
      if (isApplicationError(error) && error.category === "not_found") {
        renderAdminNotFound(dependencies, response, request, context, requestUrl(request).pathname);
        return;
      }
      throw error;
    }
  });
}

function renderAdminNotFound(
  dependencies: WebRouteDependencies,
  response: ServerResponse,
  request: IncomingMessage,
  context: AdminContext,
  pathname: string,
): void {
  const display = dependencies.displayService.getSettings();
  sendHtml(
    response,
    404,
    dependencies.renderer.render("/admin/not-found", {
      page: {
        title: "Page not found",
        path: pathname,
        csrfToken: context.csrfToken,
        siteName: display.tapboardName,
        adminAccent: display.accent,
        displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      },
      navItems: adminNavItems(),
      ...pageMessage(request),
    }),
  );
}

interface AdminAutosaveResult {
  /** Safe, server-authoritative values for the marked form controls. */
  readonly resource: Readonly<Record<string, unknown>>;
  readonly revision: string | number;
}

type AutosaveValidationFields = (error: ApplicationError) => Readonly<Record<string, string>>;

interface AdminAutosaveSpec {
  readonly handle: (
    body: Readonly<Record<string, unknown>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => AdminAutosaveResult | Promise<AdminAutosaveResult>;
  readonly current: (params: Readonly<Record<string, string>>) => {
    readonly current: unknown;
    readonly revision: string | number;
  };
  /** Maps service validation failures to safe, form-linked field names. */
  readonly validationFields?: AutosaveValidationFields;
}

function oneRequestHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function acceptsJson(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(",").some((part) => {
    const [mediaType, ...parameters] = part.trim().toLowerCase().split(";");
    if (mediaType !== "application/json") return false;
    const quality = parameters.find((parameter) => /^q=/u.test(parameter.trim()));
    if (quality === undefined) return true;
    const parsed = Number(quality.trim().slice(2));
    return Number.isFinite(parsed) && parsed > 0;
  });
}

function isAutosaveRequest(request: IncomingMessage): boolean {
  return (
    oneRequestHeader(request.headers["x-tapboard-enhancement"]) === "autosave" &&
    acceptsJson(oneRequestHeader(request.headers.accept)) &&
    ["application/json", "application/json; charset=utf-8"].includes(
      oneRequestHeader(request.headers["content-type"])?.trim().toLowerCase() ?? "",
    )
  );
}

function autosaveBodyRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError({
      category: "validation",
      code: "http.invalid_json",
      clientMessage: "The request body must be a JSON object.",
    });
  }
  return value as Readonly<Record<string, unknown>>;
}

function autosaveFieldStrings(
  body: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new ApplicationError({
          category: "validation",
          code: "validation.invalid_value",
          clientMessage: "Autosave fields must be strings.",
          details: { field, reason: "must be a string" },
        });
      }
      result[field] = value;
    }
  }
  return result;
}

function requiredAutosaveField(fields: Readonly<Record<string, string>>, field: string): string {
  const value = fields[field];
  if (value === undefined || value.length === 0) {
    throw new ApplicationError({
      category: "validation",
      code: "validation.invalid_value",
      clientMessage: `${field} is required before saving.`,
      details: { field, reason: "required" },
    });
  }
  return value;
}

const AUTOSAVE_BEVERAGE_FIELDS = [
  "name",
  "beverageType",
  "style",
  "abv",
  "ibu",
  "og",
  "fg",
  "srm",
  "displayColor",
  "description",
  "fillGlass",
] as const;

function customBeverageAutosaveInput(
  body: Readonly<Record<string, unknown>>,
): UpdateCustomBeverageInput {
  const values = autosaveFieldStrings(body, AUTOSAVE_BEVERAGE_FIELDS);
  return {
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.beverageType === undefined
      ? {}
      : {
          beverageType: values.beverageType as NonNullable<
            UpdateCustomBeverageInput["beverageType"]
          >,
        }),
    ...(values.style === undefined ? {} : { style: nullable(values.style)! }),
    ...(values.abv === undefined ? {} : { abv: optionalNumber(values.abv) ?? null }),
    ...(values.ibu === undefined ? {} : { ibu: optionalNumber(values.ibu) ?? null }),
    ...(values.og === undefined ? {} : { og: optionalNumber(values.og) ?? null }),
    ...(values.fg === undefined ? {} : { fg: optionalNumber(values.fg) ?? null }),
    ...(values.srm === undefined ? {} : { srm: optionalNumber(values.srm) ?? null }),
    ...(values.displayColor === undefined ? {} : { displayColor: nullable(values.displayColor)! }),
    ...(values.description === undefined ? {} : { description: nullable(values.description)! }),
    ...(values.fillGlass === undefined ? {} : { fillGlass: vesselFromForm(values.fillGlass)! }),
  };
}

function safeBeverageCurrent(detail: BeverageDetailResult): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style,
    abv: detail.effectivePresentation.abv,
    ibu: detail.effectivePresentation.ibu,
    og: detail.effectivePresentation.og,
    fg: detail.effectivePresentation.fg,
    srm: detail.effectivePresentation.srm,
    displayColor: detail.effectivePresentation.displayColor,
    description: detail.effectivePresentation.description,
    fillGlass: detail.effectivePresentation.fillGlass,
    updatedAt: detail.beverage.updatedAt,
  };
}

function safeCustomBeverageResource(
  detail: BeverageDetailResult,
): Readonly<Record<string, unknown>> {
  return {
    name: detail.effectivePresentation.name,
    beverageType: detail.effectivePresentation.beverageType,
    style: detail.effectivePresentation.style ?? "",
    abv: detail.effectivePresentation.abv ?? "",
    ibu: detail.effectivePresentation.ibu ?? "",
    og: detail.effectivePresentation.og ?? "",
    fg: detail.effectivePresentation.fg ?? "",
    srm: detail.effectivePresentation.srm ?? "",
    displayColor: detail.effectivePresentation.displayColor ?? "",
    description: detail.effectivePresentation.description ?? "",
    fillGlass: detail.effectivePresentation.fillGlass ?? "",
  };
}

function safeBrewfatherResource(detail: BeverageDetailResult): Readonly<Record<string, unknown>> {
  const overrides = detail.presentationOverrides;
  const effective = detail.effectivePresentation;
  const fields = [
    ["name", "Name"],
    ["beverageType", "Beverage type"],
    ["style", "Style"],
    ["abv", "ABV"],
    ["ibu", "IBU"],
    ["og", "OG"],
    ["fg", "FG"],
    ["srm", "SRM"],
    ["displayColor", "Display color"],
    ["description", "Description"],
    ["fillGlass", "Fill Glass"],
  ] as const;
  const result: Record<string, unknown> = {};
  for (const [field] of fields) {
    const capitalized = `${field[0]!.toUpperCase()}${field.slice(1)}`;
    const present = Boolean(overrides?.[`override${capitalized}Present` as keyof typeof overrides]);
    const overrideValue = overrides?.[field as keyof typeof overrides];
    const canClear = field !== "name" && field !== "beverageType";
    const value = effective[field as keyof typeof effective];
    result[`${field}Mode`] = !present
      ? "inherit"
      : canClear && overrideValue === null
        ? "clear"
        : "value";
    result[field] = value ?? "";
  }
  return result;
}

function safeDisplayResource(
  settings: ReturnType<DisplaySettingsService["getSettings"]>,
): Readonly<Record<string, unknown>> {
  return {
    tapboardName: settings.tapboardName,
    theme: settings.theme,
    font: settings.font,
    accent: settings.accent,
    unitSystem: settings.unitSystem,
    showServingTemperature: settings.showServingTemperature,
    layoutMode: settings.layoutMode,
  };
}

function safeTapCardResource(
  settings: ReturnType<DisplaySettingsService["getTapCardSettings"]>,
): Readonly<Record<string, unknown>> {
  return {
    showAbv: settings.showAbv,
    showIbu: settings.showIbu,
    showOg: settings.showOg,
    showFg: settings.showFg,
    showSrm: settings.showSrm,
    remainingMode: settings.remainingMode,
  };
}

function safeTapOverrideResource(
  settings: ReturnType<DisplaySettingsService["getEffectiveTapCardSettings"]>,
): Readonly<Record<string, unknown>> {
  const override = settings.override;
  return {
    showAbv:
      override?.showAbv === null || override?.showAbv === undefined
        ? "inherit"
        : override.showAbv
          ? "show"
          : "hide",
    showIbu:
      override?.showIbu === null || override?.showIbu === undefined
        ? "inherit"
        : override.showIbu
          ? "show"
          : "hide",
    showOg:
      override?.showOg === null || override?.showOg === undefined
        ? "inherit"
        : override.showOg
          ? "show"
          : "hide",
    showFg:
      override?.showFg === null || override?.showFg === undefined
        ? "inherit"
        : override.showFg
          ? "show"
          : "hide",
    showSrm:
      override?.showSrm === null || override?.showSrm === undefined
        ? "inherit"
        : override.showSrm
          ? "show"
          : "hide",
  };
}

function validationFieldsFor(allowedFields: readonly string[]): AutosaveValidationFields {
  return (error) => {
    const field = error.details?.field;
    if (typeof field === "string" && allowedFields.includes(field)) {
      return { [field]: error.clientMessage };
    }
    const message = error.clientMessage.toLocaleLowerCase();
    const inferred = [...allowedFields]
      .sort((left, right) => right.length - left.length)
      .find(
        (candidate) =>
          message.includes(candidate.toLocaleLowerCase()) ||
          (candidate.endsWith("Mode") &&
            message.includes(candidate.slice(0, -"Mode".length).toLocaleLowerCase())),
      );
    return inferred === undefined
      ? { _form: error.clientMessage }
      : { [inferred]: error.clientMessage };
  };
}

async function runAdminAutosave(
  dependencies: WebRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  params: Readonly<Record<string, string>>,
  spec: AdminAutosaveSpec,
): Promise<void> {
  try {
    const body = autosaveBodyRecord(await readJsonBody<unknown>(request));
    const context = adminContext(request, dependencies.authService);
    const authorized = dependencies.authService.authorizeCookieMutation({
      cookieHeader: request.headers.cookie,
      originHeader: request.headers.origin,
      csrfHeader: request.headers["x-csrf-token"],
      canonicalOrigin: dependencies.canonicalOrigin,
    });
    if (context === undefined || authorized?.id !== context.session.id) {
      sendJson(response, 403, { message: "The autosave request could not be authorized." });
      return;
    }
    const result = await spec.handle(body, context, params);
    sendJson(response, 200, { message: "Saved.", ...result });
  } catch (error) {
    if (isApplicationError(error)) {
      if (error.category === "conflict") {
        let current: { readonly current: unknown; readonly revision: string | number } | undefined;
        try {
          current = spec.current(params);
        } catch {
          current = undefined;
        }
        sendJson(response, 409, {
          message: error.clientMessage,
          current: current?.current ?? null,
          revision: current?.revision ?? null,
        });
        return;
      }
      if (error.category === "validation") {
        const fields = spec.validationFields?.(error) ?? validationFieldsFor([])(error);
        sendJson(response, 422, {
          message: error.clientMessage,
          fields,
        });
        return;
      }
      const status = error.category === "not_found" ? 404 : 403;
      sendJson(response, status, { message: error.clientMessage });
      return;
    }
    sendJson(response, 500, { message: "The autosave could not be completed." });
  }
}

function registerAdminAction(
  dependencies: WebRouteDependencies,
  path: string,
  returnPath: string | ((params: Readonly<Record<string, string>>) => string),
  handler: (
    form: Readonly<Record<string, string>>,
    context: AdminContext,
    params: Readonly<Record<string, string>>,
  ) => void | string | Promise<void | string>,
  successMessage = "Saved.",
  readFormOptions: ReadFormOptions = {},
  autosave?: AdminAutosaveSpec,
): void {
  dependencies.router.post(path, async (request, response, params) => {
    try {
      if (autosave !== undefined && isAutosaveRequest(request)) {
        await runAdminAutosave(dependencies, request, response, params, autosave);
        return;
      }
      const form = await readFormBody(request, readFormOptions);
      const context = adminContext(request, dependencies.authService);
      const authorized = dependencies.authService.authorizeCookieMutation({
        cookieHeader: request.headers.cookie,
        originHeader: request.headers.origin,
        csrfHeader: form._csrf,
        canonicalOrigin: dependencies.canonicalOrigin,
      });
      if (
        context === undefined ||
        authorized === undefined ||
        authorized.id !== context.session.id
      ) {
        throw new ApplicationError({
          category: "forbidden",
          code: "auth.mutation_forbidden",
          clientMessage: "The form could not be authorized. Reload and try again.",
        });
      }
      const handlerResult = await handler(form, context, params);
      const resolvedReturnPath = typeof returnPath === "function" ? returnPath(params) : returnPath;
      const destination = typeof handlerResult === "string" ? handlerResult : resolvedReturnPath;
      redirect(response, messageLocation(destination, "notice", successMessage));
    } catch (error) {
      const message = isApplicationError(error)
        ? error.clientMessage
        : "The change could not be completed.";
      const errorPath = typeof returnPath === "function" ? returnPath(params) : returnPath;
      redirect(response, messageLocation(errorPath, "error", message));
    }
  });
}

function registerAdminNotFound(dependencies: WebRouteDependencies): void {
  dependencies.router.setNotFoundHandler((request, response, pathname) => {
    if (!pathname.startsWith("/admin/")) {
      throw new ApplicationError({
        category: "not_found",
        code: "http.not_found",
        clientMessage: "Resource not found.",
      });
    }

    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      redirect(response, "/admin/login");
      return;
    }

    renderAdminNotFound(dependencies, response, request, context, pathname);
  });
}

function tapWarsErrorStatus(error: ApplicationError): number {
  switch (error.category) {
    case "validation":
      return 400;
    case "too_large":
      return 413;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "forbidden":
      return 403;
    case "unauthorized":
      return 401;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
}

function sendTapWarsVoteError(
  dependencies: WebRouteDependencies,
  response: ServerResponse,
  error: unknown,
): void {
  if (isApplicationError(error)) {
    sendJson(response, tapWarsErrorStatus(error), {
      error: { code: error.code, message: error.clientMessage },
      tapWars: dependencies.publicTapWarsService.getVisible(),
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: "internal.unexpected", message: "The vote could not be recorded." },
    tapWars: dependencies.publicTapWarsService.getVisible(),
  });
}

function tapWarUnavailabilityLabel(reason: EligibilityReason | null): string | null {
  switch (reason) {
    case "disabled":
      return "This Tap is disabled.";
    case "retired":
      return "This Tap has been retired.";
    case "original_assignment_ended_or_replaced":
      return "The original Tap assignment ended or changed.";
    case "fill_ended_or_missing":
      return "The original filled keg ended or is unavailable.";
    case null:
      return null;
  }
}

function adminTapWarView(war: TapWar | undefined): Readonly<Record<string, unknown>> | null {
  if (war === undefined) return null;
  const [first, second] = war.competitors;
  const firstVotes = war.status === "completed" ? (first.finalVoteCount ?? 0) : first.voteCount;
  const secondVotes = war.status === "completed" ? (second.finalVoteCount ?? 0) : second.voteCount;
  const percentages = tapWarPercentages(firstVotes, secondVotes);
  const totalVotes = firstVotes + secondVotes;
  const leaderSide =
    firstVotes === secondVotes ? null : firstVotes > secondVotes ? (1 as const) : (2 as const);
  return {
    id: war.id,
    status: war.status,
    result: war.result,
    startedAt: war.startedAt,
    pausedAt: war.pausedAt,
    completedAt: war.completedAt,
    publishedAt: war.publishedAt,
    dismissedAt: war.dismissedAt,
    totalVotes,
    leaderSide: war.status === "completed" ? null : leaderSide,
    isTie:
      war.status === "completed" ? war.result === "tie" : totalVotes > 0 && leaderSide === null,
    completionPublicTitleSide1: war.completionPublicTitleSide1,
    completionPublicTitleSide2: war.completionPublicTitleSide2,
    competitors: war.competitors.map((competitor) => ({
      side: competitor.side,
      assignmentId: competitor.assignmentId,
      tapId: competitor.tapId,
      tapNumber: competitor.tapNumber,
      adminBeverageTitle: competitor.adminBeverageTitle,
      voteCount:
        war.status === "completed" ? (competitor.finalVoteCount ?? 0) : competitor.voteCount,
      percentage:
        competitor.side === 1 ? (percentages?.side1 ?? null) : (percentages?.side2 ?? null),
      eligible: competitor.eligibility.eligible,
      unavailableReason: tapWarUnavailabilityLabel(competitor.eligibility.reason),
    })),
  };
}

function adminTapWarsPageData(
  dependencies: WebRouteDependencies,
): Readonly<Record<string, unknown>> {
  const rawCurrent = dependencies.tapWarsService.getCurrentUnfinished();
  return {
    current: adminTapWarView(rawCurrent),
    published: adminTapWarView(dependencies.tapWarsService.getPublishedResult()),
    publicVisible: dependencies.publicTapWarsService.getVisible(),
    history: dependencies.tapWarsService
      .listCompletedHistory()
      .map((completed) => adminTapWarView(completed)!),
    eligible: dependencies.tapWarsService.listEligibleParticipants().map((participant) => ({
      assignmentId: participant.assignmentId,
      tapId: participant.tapId,
      tapNumber: participant.tapNumber,
      preview: dependencies.publicTapWarsService.previewEligible(participant.assignmentId),
    })),
    canResume:
      rawCurrent?.status === "paused" &&
      rawCurrent.competitors.every((side) => side.eligibility.eligible),
  };
}

function registerPublicRoutes(dependencies: WebRouteDependencies): void {
  dependencies.router.get("/", (request, response) => {
    const isAdmin = adminContext(request, dependencies.authService) !== undefined;
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/dashboard", {
        ...dependencies.dashboardService.getDashboard(),
        adminPourPreview: isAdmin,
      }),
      { vary: "Cookie" },
    );
  });
  dependencies.router.get("/taps/:tapId/story", (request, response, params) => {
    const isAdmin = adminContext(request, dependencies.authService) !== undefined;
    const story = dependencies.storyService.getStory(params.tapId!);
    if (story === undefined) {
      sendHtml(
        response,
        404,
        dependencies.renderer.render("/public/story", {
          sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
          header: dependencies.dashboardService.getHeader(),
          story: undefined,
          isAdmin,
        }),
        { vary: "Cookie" },
      );
      return;
    }
    sendHtml(
      response,
      200,
      dependencies.renderer.render("/public/story", {
        sharedDisplay: dependencies.dashboardService.getDisplayDefaults(),
        header: dependencies.dashboardService.getHeader(),
        ssePath: isAdmin ? "/api/admin/events" : "/api/public/events",
        tapId: params.tapId,
        isAdmin,
        sensoryRadar: buildSensoryRadar(story.sensory),
        temperature,
        volume,
        story,
      }),
      { vary: "Cookie" },
    );
  });
  dependencies.router.get("/api/public/dashboard", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getDashboard() });
  });
  dependencies.router.get("/api/public/dashboard/header", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getHeader() });
  });
  dependencies.router.get("/api/public/dashboard/display", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getDisplayDefaults() });
  });
  dependencies.router.get("/api/public/dashboard/on-deck", (_request, response) => {
    sendJson(response, 200, { ...dependencies.dashboardService.getOnDeck() });
  });
  dependencies.router.get("/api/public/tap-wars", (_request, response) => {
    sendJson(response, 200, { tapWars: dependencies.publicTapWarsService.getVisible() });
  });
  dependencies.router.post(
    "/api/public/tap-wars/:warId/votes",
    async (request, response, params) => {
      const wantsJson = acceptsJson(oneRequestHeader(request.headers.accept));
      try {
        requireMutationOrigin(request.headers.origin, dependencies.canonicalOrigin);
        const form = await readFormBody(request, { maxBytes: 256, maxFields: 1 });
        if (
          Object.keys(form).length !== 1 ||
          !Object.hasOwn(form, "side") ||
          (form.side !== "1" && form.side !== "2")
        ) {
          throw new ApplicationError({
            category: "validation",
            code: "tap_war.invalid_vote",
            clientMessage: "Choose one valid Tap War side.",
          });
        }
        dependencies.tapWarsService.vote(params.warId!, form.side === "1" ? 1 : 2);
        if (wantsJson) {
          sendJson(response, 200, { tapWars: dependencies.publicTapWarsService.getVisible() });
          return;
        }
        redirect(response, "/#tap-wars");
      } catch (error) {
        if (isApplicationError(error) && error.code === "tap_war.ineligible") {
          // vote() commits the pause before reporting this conflict, so it is a
          // real state change rather than a rejected attempt.
          dependencies.liveUpdates.publish({ name: "tap_wars.updated", target: "tap-wars" });
        }
        if (wantsJson) {
          sendTapWarsVoteError(dependencies, response, error);
          return;
        }
        const message = isApplicationError(error)
          ? error.clientMessage
          : "The vote could not be recorded.";
        redirect(response, `${messageLocation("/", "error", message)}#tap-wars`);
      }
    },
  );
  dependencies.router.get("/api/public/dashboard/taps/:tapId", (_request, response, params) => {
    const tap = dependencies.dashboardService.getTap(params.tapId!);
    if (tap === undefined) {
      sendJson(response, 404, { error: { code: "tap.not_public", message: "Tap not found." } });
      return;
    }
    sendJson(response, 200, { ...tap });
  });
  dependencies.router.get("/api/public/taps/:tapId/story", (_request, response, params) => {
    const story = dependencies.storyService.getStory(params.tapId!);
    if (story === undefined) {
      sendJson(response, 404, {
        error: { code: "tap.story_not_public", message: "Story not found." },
      });
      return;
    }
    sendJson(response, 200, { ...story });
  });
  dependencies.router.get("/api/public/events", (_request, response) => {
    dependencies.liveUpdates.connectPublic(response);
  });
}

function registerAuthenticationRoutes(dependencies: WebRouteDependencies): void {
  dependencies.router.get("/admin", (request, response) => {
    redirect(
      response,
      adminContext(request, dependencies.authService) === undefined
        ? "/admin/login"
        : "/admin/overview",
    );
  });
  dependencies.router.get("/admin/login", (request, response) => {
    if (adminContext(request, dependencies.authService) !== undefined) {
      redirect(response, "/admin/overview");
      return;
    }
    const display = dependencies.displayService.getSettings();
    const page = {
      title: "Admin sign in",
      path: "/admin/login",
      siteName: display.tapboardName,
      adminAccent: display.accent,
      displayStylesheetHref: displayStylesheetHref(display.theme, display.accent, display.font),
      ...pageMessage(request),
    };
    sendHtml(response, 200, dependencies.renderer.render("/admin/login", { page }));
  });
  dependencies.router.post("/admin/login", async (request, response) => {
    try {
      requireMutationOrigin(request.headers.origin, dependencies.canonicalOrigin);
      const form = await readFormBody(request, { maxFields: 4, maxBytes: 1_024 });
      const previous = cookieValue(request, parseSessionCookie);
      const result = await dependencies.authService.authenticate(form.pin, previous);
      if (
        !result.authenticated ||
        result.cookie === undefined ||
        result.csrfToken === undefined ||
        result.absoluteExpiresAt === undefined
      ) {
        redirect(response, messageLocation("/admin/login", "error", "Sign-in failed."));
        return;
      }
      const secure = dependencies.canonicalOrigin?.startsWith("https://") === true;
      response.setHeader("set-cookie", [
        result.cookie,
        serializeCsrfCookie(result.csrfToken, result.absoluteExpiresAt, { secure }),
      ]);
      redirect(response, "/admin/overview");
    } catch {
      redirect(response, messageLocation("/admin/login", "error", "Sign-in failed."));
    }
  });
  dependencies.router.post("/admin/logout", async (request, response) => {
    try {
      const form = await readFormBody(request, { maxFields: 4, maxBytes: 1_024 });
      const context = adminContext(request, dependencies.authService);
      const authorized = dependencies.authService.authorizeCookieMutation({
        cookieHeader: request.headers.cookie,
        originHeader: request.headers.origin,
        csrfHeader: form._csrf,
        canonicalOrigin: dependencies.canonicalOrigin,
      });
      if (context === undefined || authorized?.id !== context.session.id) {
        throw new Error("unauthorized");
      }
      dependencies.authService.revoke(context.sessionToken);
      const secure = dependencies.canonicalOrigin?.startsWith("https://") === true;
      response.setHeader("set-cookie", [
        clearSessionCookie({ secure }),
        clearCsrfCookie({ secure }),
      ]);
      redirect(response, messageLocation("/admin/login", "notice", "Signed out."));
    } catch {
      redirect(response, messageLocation("/admin/login", "error", "Sign-out failed."));
    }
  });
}

function registerAdminPages(dependencies: WebRouteDependencies): void {
  registerAdminGet(dependencies, "/admin/overview", (request, response, context) => {
    const taps = dependencies.tapService.listTaps();
    const fills = dependencies.fillService.listFills();
    const health = dependencies.healthService.listAdminOverview();
    const kegs = dependencies.kegService.listKegs();
    const brewfather = dependencies.beverageService.getBrewfatherStatus();
    const header = dependencies.dashboardService.getHeader();
    const telemetryConfigured = dependencies.telemetryService.listSources().length;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/overview",
      "Overview",
      "/admin/overview",
      {
        metrics: [
          {
            label: "Enabled taps",
            value: taps.filter((tap) => tap.enabled && !tap.isRetired).length,
          },
          { label: "Active fills", value: fills.filter((fill) => fill.state !== "ended").length },
          { label: "On deck", value: fills.filter((fill) => fill.state === "on_deck").length },
          {
            label: "Health warnings",
            value: health.filter(
              (item) =>
                item.aggregate.state === "degraded" ||
                item.aggregate.severity === "warning" ||
                item.aggregate.severity === "critical",
            ).length,
          },
        ],
        taps: taps.map((tap) => ({
          id: tap.id,
          tapNumber: tap.tapNumber,
          name: tap.name,
          enabled: tap.enabled,
          isRetired: tap.isRetired,
          beverageName: tap.activeAssignment?.beverageName ?? null,
          href: `/admin/taps/${encodeURIComponent(tap.id)}`,
        })),
        health: health.map((item) => ({
          tapId: item.tapId,
          tapNumber: taps.find((tap) => tap.id === item.tapId)?.tapNumber ?? null,
          tapName: item.name,
          href: `/admin/taps/${encodeURIComponent(item.tapId)}`,
          state: item.aggregate.state,
          stateLabel: humanizeAdminIdentifier(item.aggregate.state),
          severity: item.aggregate.severity,
          severityLabel: humanizeAdminIdentifier(item.aggregate.severity),
          checks: (item.checks ?? [])
            .filter(
              (check) =>
                check.state === "degraded" ||
                check.severity === "warning" ||
                check.severity === "critical",
            )
            .map((check) => ({
              id: check.checkId,
              label: healthCheckPresentation(check.checkId).title,
              state: check.state,
              stateLabel: humanizeAdminIdentifier(check.state),
              severity: check.severity,
              severityLabel: humanizeAdminIdentifier(check.severity),
              reason: check.reason,
              reasonLabel: check.reason === null ? null : humanizeAdminIdentifier(check.reason),
            })),
        })),
        kegRoom: {
          activeKegs: kegs.filter((keg) => keg.isActive).length,
          onTap: fills.filter((fill) => fill.state === "on_tap").length,
          onDeck: fills.filter((fill) => fill.state === "on_deck").length,
          available: fills.filter((fill) => fill.state === "available").length,
          href: "/admin/keg-room",
        },
        connectivity: { state: header.connectivity, label: header.connectivityLabel },
        integrations: {
          telemetryConfigured,
          brewfatherConfigured: brewfather.configured,
          brewfatherEnabled: brewfather.account?.enabled ?? false,
          brewfatherApiKeyConfigured: brewfather.apiKeyConfigured,
          brewfatherLinkedBeverages: brewfather.totalLinkedBeverages,
        },
        quickLinks: [
          { label: "Manage Taps", href: "/admin/taps" },
          { label: "Open Keg Room", href: "/admin/keg-room" },
          { label: "Manage Beverages", href: "/admin/beverages" },
          { label: "Configure Integrations", href: "/admin/integrations" },
          { label: "Adjust Display", href: "/admin/display" },
        ],
      },
    );
  });

  registerAdminGet(dependencies, "/admin/jump", (request, response, context) => {
    const rawQuery = requestUrl(request).searchParams.get("q") ?? "";
    const jump = searchAdminDestinations({
      query: rawQuery,
      destinations: adminNavItems(),
      services: {
        taps: dependencies.tapService,
        beverages: dependencies.beverageService,
        fills: dependencies.fillService,
        kegs: dependencies.kegService,
        telemetry: dependencies.telemetryService,
      },
    });
    renderAdmin(dependencies, response, request, context, "/admin/jump", "Jump", "/admin/jump", {
      jump,
    });
  });

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
      const history = outboundHistoryPresentation(service.listDeliveries(destination.id, 100));
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

  registerAdminGet(dependencies, "/admin/beverages", (request, response, context) => {
    const query = listQueryFromRequest(request);
    const index = dependencies.beverageService.listBeveragePage(query);
    const previousPage = index.page > 1 ? beveragePageHref(index.query, index.page - 1) : null;
    const nextPage =
      index.page < index.pageCount ? beveragePageHref(index.query, index.page + 1) : null;
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverages",
      "Beverages",
      "/admin/beverages",
      {
        beverages: index.items.map(adminBeverageListItem),
        brewfatherCandidates: dependencies.beverageService
          .listCandidates()
          .map(adminBrewfatherCandidate),
        query: index.query,
        pagination: {
          page: index.page,
          pageCount: index.pageCount,
          total: index.total,
          previousHref: previousPage,
          nextHref: nextPage,
        },
      },
    );
  });

  // Keep the static create path ahead of /:id so "new" can never be treated
  // as a beverage identifier by the small path router.
  registerAdminGet(dependencies, "/admin/beverages/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverage-new",
      "New Beverage",
      "/admin/beverages/new",
      { beverageTypes: BEVERAGE_TYPES, fillGlassOptions: fillGlassOptions() },
    );
  });

  registerAdminGet(dependencies, "/admin/beverages/:id", (request, response, context, params) => {
    const id = params.id ?? "";
    const detail = dependencies.beverageService.getBeverage(id);
    const serviceWithUsage = dependencies.beverageService as BeverageService & {
      readonly getBeverageUsage?: (beverageId: string) => {
        readonly current: number;
        readonly total: number;
      };
      readonly listCurrentFills?: (
        beverageId: string,
        limit?: number,
      ) => readonly Record<string, unknown>[];
    };
    const usage =
      typeof serviceWithUsage.getBeverageUsage === "function"
        ? serviceWithUsage.getBeverageUsage(id)
        : { current: 0, total: 0 };
    const currentFills =
      typeof serviceWithUsage.listCurrentFills === "function"
        ? serviceWithUsage.listCurrentFills(id, 25)
        : [];
    const impact = dependencies.beverageService.getDeletionImpact(id);
    const guidance =
      typeof dependencies.storyService?.getBeverageGuidance === "function"
        ? dependencies.storyService.getBeverageGuidance(id)
        : undefined;
    const availableKegs = dependencies.kegService
      .listKegs({ isActive: true })
      .filter(
        (keg) =>
          !dependencies.fillService
            .listFills({ kegId: keg.id })
            .some((fill) => fill.state !== "ended"),
      )
      .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label }));
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/beverage-detail",
      detail.effectivePresentation.name,
      "/admin/beverages",
      {
        beverage: {
          ...adminBeverageDetailDto(detail, usage, impact.impacts, guidance),
          currentFills,
        },
        beverageTypes: BEVERAGE_TYPES,
        fillGlassOptions: fillGlassOptions(),
        availableKegs,
      },
    );
  });

  // Canonical Keg Room index. Ended fills are deliberately omitted unless the
  // operator asks for history through the validated state filter.
  registerAdminGet(dependencies, "/admin/keg-room", (request, response, context) => {
    const requested = adminFillPageQueryFromRequest(request);
    const page = fallbackAdminFillPage(dependencies.fillService, requested);
    const publicCards = safePublicTapCards(dependencies.dashboardService);
    const fills = page.items.map((fill) =>
      safeFillCard(fill, dependencies.dashboardService, publicCards),
    );
    const section = (state: "available" | "on_deck" | "on_tap" | "ended") =>
      fills.filter((fill) => fill.state === state);
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room",
      "Keg Room",
      "/admin/keg-room",
      {
        fills,
        sections: [
          { id: "available", title: "Available", items: section("available") },
          { id: "on-deck", title: "On Deck", items: section("on_deck") },
          { id: "on-tap", title: "On Tap", items: section("on_tap") },
          ...(page.state === "ended" || page.state === "all"
            ? [{ id: "history", title: "History", items: section("ended") }]
            : []),
        ],
        query: requested,
        pagination: {
          page: page.page,
          pageCount: page.pageCount,
          total: page.total,
          previousHref: page.page > 1 ? adminFillPageHref(requested, page.page - 1) : null,
          nextHref: page.page < page.pageCount ? adminFillPageHref(requested, page.page + 1) : null,
        },
        historyHref: "/admin/keg-room?state=ended",
        inventoryHref: "/admin/keg-room/kegs",
        newFillHref: "/admin/keg-room/fills/new",
      },
    );
  });

  // Secondary physical inventory tab. The repository owns search/filter/page
  // SQL; the bounded per-keg history is an explicitly requested detail rail.
  registerAdminGet(dependencies, "/admin/keg-room/kegs", (request, response, context) => {
    const requested = adminKegPageQueryFromRequest(request);
    const page = fallbackAdminKegPage(dependencies.kegService, requested);
    const fillsFor = (kegId: string) => dependencies.fillService.listFills({ kegId });
    const kegs = page.items.map((keg) => {
      const detail = dependencies.kegService.getKeg(keg.id);
      const detailRecord = detail as unknown as {
        readonly keg?: typeof keg;
        readonly tareHistory?: readonly {
          readonly previousTareG: number | null;
          readonly newTareG: number;
          readonly recordedAt: string;
          readonly reason: string | null;
        }[];
        readonly maintenanceHistory?: readonly {
          readonly maintenanceType: string;
          readonly recordedAt: string;
        }[];
      };
      const impact = dependencies.kegService.getDeletionImpact(keg.id);
      const fillHistory = fillsFor(keg.id).map((fill) => ({
        id: fill.id,
        beverageName: fill.beverageName,
        fillDate: fill.fillDate,
        state: fill.state,
        endedAt: fill.endedAt,
      }));
      const currentFill = fillHistory.find((fill) => fill.state !== "ended") ?? null;
      const recentFill = fillHistory[0] ?? null;
      return {
        id: keg.id,
        kegNumber: keg.kegNumber,
        label: keg.label,
        capacityMl: keg.capacityMl,
        currentTareG: keg.currentTareG,
        isActive: keg.isActive,
        updatedAt: keg.updatedAt,
        currentFill: currentFill?.beverageName ?? null,
        currentFillId: currentFill?.id ?? null,
        currentFillRecord: currentFill,
        recentFillRecord: recentFill,
        fillHistorySummary:
          fillHistory.length === 0
            ? "No fills recorded"
            : `${fillHistory.length} fill record${fillHistory.length === 1 ? "" : "s"} · ${recentFill?.beverageName ?? "History available"}`,
        fillHistory,
        tareHistory: (detailRecord.tareHistory ?? []).map((item) => ({
          previousTareG: item.previousTareG,
          newTareG: item.newTareG,
          recordedAt: item.recordedAt,
          reason: item.reason,
        })),
        maintenanceHistory: (detailRecord.maintenanceHistory ?? []).map((item) => ({
          maintenanceType: item.maintenanceType,
          recordedAt: item.recordedAt,
        })),
        deletionImpacts: impact.impacts,
      };
    });
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-kegs",
      "Kegs",
      "/admin/keg-room/kegs",
      {
        kegs,
        query: requested,
        pagination: {
          page: page.page,
          pageCount: page.pageCount,
          total: page.total,
          previousHref: page.page > 1 ? adminKegPageHref(requested, page.page - 1) : null,
          nextHref: page.page < page.pageCount ? adminKegPageHref(requested, page.page + 1) : null,
        },
        roomHref: "/admin/keg-room",
        newKegHref: "/admin/keg-room/kegs/new",
      },
    );
  });

  // Static create path must be registered before /:id for the small path router.
  registerAdminGet(dependencies, "/admin/keg-room/kegs/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-keg-new",
      "New Keg",
      "/admin/keg-room/kegs/new",
      {},
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/kegs/:id",
    (request, response, context, params) => {
      const detail = dependencies.kegService.getKeg(params.id ?? "");
      const detailRecord = detail as unknown as {
        readonly keg?: typeof detail.keg;
        readonly tareHistory?: typeof detail.tareHistory;
        readonly maintenanceHistory?: typeof detail.maintenanceHistory;
      };
      const physical = detailRecord.keg ?? (detail as unknown as typeof detail.keg);
      const tareHistory = detailRecord.tareHistory ?? [];
      const maintenanceHistory = detailRecord.maintenanceHistory ?? [];
      const impact = dependencies.kegService.getDeletionImpact(params.id ?? "");
      const fillHistory = dependencies.fillService
        .listFills({ kegId: physical.id })
        .map((fill) => ({
          id: fill.id,
          beverageName: fill.beverageName,
          fillDate: fill.fillDate,
          state: fill.state,
          endedAt: fill.endedAt,
        }));
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-keg-detail",
        `Keg ${physical.kegNumber}`,
        "/admin/keg-room/kegs",
        {
          keg: {
            ...physical,
            confirmationLabel: kegDeletionConfirmationLabel(physical),
            tareHistory,
            maintenanceHistory,
            deletionImpacts: impact.impacts,
            fillHistory,
          },
          roomHref: "/admin/keg-room",
          inventoryHref: "/admin/keg-room/kegs",
        },
      );
    },
  );

  registerAdminGet(dependencies, "/admin/keg-room/fills/new", (request, response, context) => {
    const activeKegs = dependencies.kegService.listKegs({ isActive: true });
    const occupiedKegIds = new Set(
      dependencies.fillService
        .listFills()
        .filter((fill) => fill.state !== "ended")
        .map((fill) => fill.kegId),
    );
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/keg-room-fill",
      "Fill a Keg",
      "/admin/keg-room/fills/new",
      {
        beverages: dependencies.beverageService
          .listBeverages()
          .map((item) => ({ id: item.beverage.id, name: item.effectivePresentation.name })),
        kegs: activeKegs
          .filter((keg) => !occupiedKegIds.has(keg.id))
          .map((keg) => ({ id: keg.id, kegNumber: keg.kegNumber, label: keg.label })),
        roomHref: "/admin/keg-room",
      },
    );
  });

  registerAdminGet(
    dependencies,
    "/admin/keg-room/fills/:id",
    (request, response, context, params) => {
      const fill = dependencies.fillService.getFill(params.id ?? "");
      const taps = dependencies.tapService.listTaps();
      const activeTap = taps.find((tap) => tap.activeAssignment?.fillId === fill.id) ?? null;
      const availableTaps = taps
        .filter((tap) => !tap.isRetired && !tap.isOccupied)
        .map((tap) => ({ id: tap.id, tapNumber: tap.tapNumber, name: tap.name }));
      const publicCards = safePublicTapCards(dependencies.dashboardService);
      const card = safeFillCard(fill, dependencies.dashboardService, publicCards);
      renderAdmin(
        dependencies,
        response,
        request,
        context,
        "/admin/keg-room-fill",
        "Filled Keg",
        "/admin/keg-room",
        {
          fill: card,
          fillRecord: fill,
          activeTap,
          availableTaps,
          roomHref: "/admin/keg-room",
        },
      );
    },
  );
  registerAdminGet(dependencies, "/admin/keg-room/fill", (_request, response) => {
    redirect(response, "/admin/keg-room/fills/new");
  });
  registerAdminGet(
    dependencies,
    "/admin/keg-room/fill/:id",
    (_request, response, _context, params) => {
      redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
    },
  );

  // Legacy authenticated GET entry points remain redirects only.
  registerAdminGet(dependencies, "/admin/fills", (_request, response) => {
    redirect(response, "/admin/keg-room");
  });
  registerAdminGet(dependencies, "/admin/kegs", (_request, response) => {
    redirect(response, "/admin/keg-room/kegs");
  });
  registerAdminGet(dependencies, "/admin/kegs/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/kegs/${encodeURIComponent(params.id ?? "")}`);
  });
  registerAdminGet(dependencies, "/admin/fills/:id", (_request, response, _context, params) => {
    redirect(response, `/admin/keg-room/fills/${encodeURIComponent(params.id ?? "")}`);
  });

  // Keep the static create path ahead of /:id so "new" can never be treated
  // as a Tap identifier by the small path router.
  registerAdminGet(dependencies, "/admin/taps", (request, response, context) => {
    const query = adminTapPageQueryFromRequest(request);
    const index = fallbackAdminTapPage(dependencies.tapService, query);
    const previousPage =
      index.page > 1
        ? adminTapPageHref({ q: index.query, state: index.state }, index.page - 1)
        : null;
    const nextPage =
      index.page < index.pageCount
        ? adminTapPageHref({ q: index.query, state: index.state }, index.page + 1)
        : null;
    const rows = index.items.map((item) => {
      const publicCard = safeDashboardTap(dependencies.dashboardService, item.id);
      const health = safeHealthOverview(dependencies.healthService, item.id);
      return {
        ...item,
        assignmentLabel:
          item.assignment === null
            ? "Unassigned"
            : (item.assignment.beverageName ?? "Assigned fill"),
        kegLabel:
          item.assignment === null || item.assignment.kegNumber === null
            ? null
            : `Keg ${item.assignment.kegNumber}${item.assignment.kegLabel ? ` — ${item.assignment.kegLabel}` : ""}`,
        remaining: tapRemainingLabel(publicCard, item.assignment !== null),
        healthLabel:
          health.state === "healthy"
            ? "Healthy"
            : health.state === "degraded"
              ? "Degraded"
              : health.state === "not_configured"
                ? "Not configured"
                : health.state === "active"
                  ? "Active"
                  : "Unknown",
        statusLabel: item.isRetired ? "Retired" : item.enabled ? "Enabled" : "Disabled",
        publicCard,
        health,
      };
    });
    renderAdmin(dependencies, response, request, context, "/admin/taps", "Taps", "/admin/taps", {
      taps: rows,
      query: index.query,
      state: index.state,
      pagination: {
        page: index.page,
        pageCount: index.pageCount,
        total: index.total,
        previousHref: previousPage,
        nextHref: nextPage,
      },
    });
  });

  registerAdminGet(dependencies, "/admin/taps/new", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-new",
      "New Tap",
      "/admin/taps/new",
    );
  });

  registerAdminGet(dependencies, "/admin/taps/:id", (request, response, context, params) => {
    const id = params.id ?? "";
    const tap = dependencies.tapService.getTap(id);
    const assignment = tap.activeAssignment ?? null;
    const publicCard = safeDashboardTap(dependencies.dashboardService, id);
    let mystery: ReturnType<TapService["getAssignmentMystery"]> | null = null;
    let mysteryLookupFailed = false;
    try {
      if (assignment !== null) mystery = dependencies.tapService.getAssignmentMystery(id);
    } catch {
      mystery = null;
      mysteryLookupFailed = assignment !== null;
    }
    const preview = mysteryLookupFailed
      ? null
      : safeMysteryPreview(publicCard, mystery?.enabled === true);
    const telemetrySources = dependencies.telemetryService
      .listSources()
      .slice(0, 200)
      .map((source) => ({ id: source.id, name: source.name }));
    const sourceNames = new Map(telemetrySources.map((source) => [source.id, source.name]));

    let authoritySourceId = "";
    let authorityName = "None";
    try {
      const authority = dependencies.telemetryService.getTapAuthority(id);
      authoritySourceId = authority?.sourceId ?? "";
      authorityName =
        authority === undefined
          ? "None"
          : (sourceNames.get(authority.sourceId) ?? "Configured source");
    } catch {
      authorityName = "Unavailable";
    }

    let detectorFields: readonly Record<string, unknown>[] = [];
    try {
      const detectorGlobal = dependencies.detectorService.getGlobalConfig();
      const detectorOverride = dependencies.detectorService.getTapOverride(id)?.override ?? {};
      const detectorEffective = mergeDetectorConfig(detectorGlobal.config, detectorOverride);
      detectorFields = DETECTOR_CONFIG_FIELDS.map((field) => ({
        name: field,
        ...DETECTOR_FIELD_PRESENTATION[field],
        effective: detectorEffective[field],
        override: detectorOverride[field] ?? null,
        effectiveLabel: formatAdminConfigValue(
          detectorEffective[field],
          DETECTOR_FIELD_PRESENTATION[field].unit,
        ),
      }));
    } catch {
      detectorFields = [];
    }

    let healthConfig: {
      readonly effective: Record<string, unknown>;
      readonly override: Record<string, unknown> | null;
    } | null = null;
    try {
      const value = dependencies.healthService.getEffectiveConfig(id) as unknown as {
        readonly effective: Record<string, unknown>;
        readonly override?: Record<string, unknown> | null;
      };
      healthConfig = { effective: value.effective, override: value.override ?? null };
    } catch {
      healthConfig = null;
    }
    const healthOverview = safeHealthOverview(dependencies.healthService, id);
    const healthSections =
      healthConfig === null
        ? []
        : HEALTH_CHECK_IDS.map((checkId) => {
            const presentation = HEALTH_SECTION_PRESENTATION[checkId];
            const effective = healthConfig?.effective[checkId];
            const effectiveFields =
              effective !== null && typeof effective === "object"
                ? Object.entries(effective as Record<string, unknown>)
                : [];
            const rawOverride = healthConfig?.override?.[checkId];
            const overrideFields =
              rawOverride !== null && typeof rawOverride === "object"
                ? new Map(Object.entries(rawOverride as Record<string, unknown>))
                : new Map<string, unknown>();
            return {
              id: checkId,
              title: presentation.title,
              description: presentation.description,
              fields: effectiveFields.map(([field, value]) => ({
                name: field,
                ...(presentation.fields[field] ?? {
                  label: "Setting",
                  help: "Tap-specific health setting.",
                }),
                effective: value,
                override: overrideFields.get(field) ?? null,
                effectiveLabel: formatAdminConfigValue(value, presentation.fields[field]?.unit),
              })),
            };
          });

    const detectorGroups = DETECTOR_GROUPS.map((group) => ({
      ...group,
      fields: detectorFields.filter((field) => field.group === group.id),
    })).filter((group) => group.fields.length > 0);

    let tapCard: Record<string, unknown> | null = null;
    try {
      const effective = dependencies.displayService.getEffectiveTapCardSettings?.(id);
      if (effective !== undefined)
        tapCard = { override: effective.override, effective: effective.settings };
    } catch {
      tapCard = null;
    }

    let maintenance: readonly Record<string, unknown>[] = [];
    try {
      const candidate = dependencies.healthService as HealthService & {
        readonly getAdminMaintenancePage?: (
          tapId: string,
          options?: unknown,
        ) => { readonly records: readonly Record<string, unknown>[] };
      };
      const page = candidate.getAdminMaintenancePage?.(id, { limit: 25 });
      maintenance = (page?.records ?? []) as unknown as readonly Record<string, unknown>[];
    } catch {
      maintenance = [];
    }

    let assignableFills: readonly Record<string, unknown>[] = [];
    try {
      const fillsById = new Map<
        string,
        ReturnType<typeof dependencies.fillService.listFills>[number]
      >();
      for (const fill of [
        ...dependencies.fillService.listFills({ state: "available" }),
        ...dependencies.fillService.listFills({ state: "on_deck" }),
      ]) {
        if (!fillsById.has(fill.id)) fillsById.set(fill.id, fill);
      }
      assignableFills = [...fillsById.values()]
        .sort((left, right) => {
          const stateOrder = (state: string): number => (state === "available" ? 0 : 1);
          const stateDifference = stateOrder(left.state) - stateOrder(right.state);
          if (stateDifference !== 0) return stateDifference;
          const leftQueueOrder = left.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
          const rightQueueOrder = right.onDeckOrder ?? Number.MAX_SAFE_INTEGER;
          if (leftQueueOrder !== rightQueueOrder) return leftQueueOrder - rightQueueOrder;
          const dateDifference = left.fillDate.localeCompare(right.fillDate);
          return dateDifference !== 0 ? dateDifference : left.id.localeCompare(right.id);
        })
        .slice(0, 200)
        .map((fill) => ({
          id: fill.id,
          beverageName: fill.beverageName,
          kegNumber: fill.kegNumber,
          kegLabel: fill.kegLabel,
          label: `${fill.beverageName} — Keg ${fill.kegNumber}${fill.kegLabel ? ` — ${fill.kegLabel}` : ""}`,
        }));
    } catch {
      assignableFills = [];
    }

    const moveTargets = dependencies.tapService
      .listTaps()
      .filter((candidate) => candidate.id !== id && !candidate.isRetired)
      .slice(0, 200)
      .map((candidate) => ({
        id: candidate.id,
        tapNumber: candidate.tapNumber,
        name: candidate.name,
      }));
    let deletionImpact: ReturnType<TapService["getTapDeletionImpact"]> | null = null;
    try {
      deletionImpact = dependencies.tapService.getTapDeletionImpact(id);
    } catch {
      deletionImpact = null;
    }
    let displayDefaults: Record<string, unknown> = { unitSystem: "us", remainingMode: "percent" };
    try {
      displayDefaults = dependencies.dashboardService.getDisplayDefaults() as unknown as Record<
        string,
        unknown
      >;
    } catch {
      // Keep the deterministic preview fallback for small service doubles.
    }

    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-detail",
      `Tap ${tap.tapNumber}${tap.name ? ` — ${tap.name}` : ""}`,
      "/admin/taps",
      {
        tap: {
          identity: {
            id: tap.id,
            tapNumber: tap.tapNumber,
            name: tap.name,
            createdAt: tap.createdAt,
            updatedAt: tap.updatedAt,
            updatedAtLabel: adminTimestampLabel(tap.updatedAt),
            confirmationLabel: tapDeletionConfirmationLabel(tap),
          },
          lifecycle: {
            enabled: tap.enabled,
            isRetired: tap.isRetired,
            firstUsedAt: tap.firstUsedAt,
            firstUsedAtLabel: adminTimestampLabel(tap.firstUsedAt),
            retiredAt: tap.retiredAt,
          },
          configuration: {
            gasType: tap.gasType,
            servingPressureKpa: tap.servingPressureKpa,
            lineLengthMm: tap.lineLengthMm,
            lineDiameterMm: tap.lineDiameterMm,
            notes: tap.notes,
          },
          assignment: {
            active:
              assignment === null
                ? null
                : {
                    ...assignment,
                    assignedAtLabel: adminTimestampLabel(assignment.assignedAt),
                  },
            mystery,
          },
          telemetry: { authorityName, authoritySourceId, sources: telemetrySources },
          detector: { fields: detectorFields, groups: detectorGroups },
          health: { overview: healthOverview, sections: healthSections },
          display: { tapCard },
          maintenance: { records: maintenance },
          assignableFills,
          moveTargets,
          deletionImpact,
          publicPreview: preview,
          publicCard,
          displayDefaults,
        },
        includeDashboardStyles: true,
      },
    );
  });

  registerAdminGet(dependencies, "/admin/tap-wars", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/tap-wars",
      "Tap Wars",
      "/admin/tap-wars",
      {
        tapWars: adminTapWarsPageData(dependencies),
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display",
      "Display",
      "/admin/display",
      {
        sharedDisplay,
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/shared", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-shared",
      "Shared defaults",
      "/admin/display/shared",
      {
        sharedDisplay,
        tapCardSettings:
          typeof dependencies.displayService.getTapCardSettings === "function"
            ? dependencies.displayService.getTapCardSettings()
            : undefined,
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          "all",
        ),
      },
    );
  });
  registerAdminGet(dependencies, "/admin/display/this-display", (request, response, context) => {
    const sharedDisplay = dependencies.displayService.getSettings();
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/display-this-display",
      "This display",
      "/admin/display/this-display",
      {
        displayStylesheetHref: displayStylesheetHref(
          sharedDisplay.theme,
          sharedDisplay.accent,
          sharedDisplay.font,
        ),
      },
    );
  });
  registerAdminGet(dependencies, "/admin/system", (request, response, context) => {
    renderAdmin(
      dependencies,
      response,
      request,
      context,
      "/admin/system",
      "System",
      "/admin/system",
      {
        system: {
          schemaVersion: APPLICATION_SCHEMA_VERSION,
          liveClients: dependencies.liveUpdates.stats(),
        },
      },
    );
  });
  dependencies.router.get("/api/admin/events", (request, response) => {
    const context = adminContext(request, dependencies.authService);
    if (context === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    dependencies.liveUpdates.connectAdmin(response, context.sessionToken);
  });
  dependencies.router.get("/api/admin/tap-wars", (request, response) => {
    if (adminContext(request, dependencies.authService) === undefined) {
      sendJson(response, 401, {
        error: { code: "auth.unauthorized", message: "Authentication is required." },
      });
      return;
    }
    sendJson(response, 200, { ...adminTapWarsPageData(dependencies) });
  });
}

function machineKeyPageData(
  dependencies: WebRouteDependencies,
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

function isTapNameOnlyForm(form: Readonly<Record<string, string>>): boolean {
  if (form.updatedAt === undefined || form.name === undefined) return false;
  return Object.keys(form).every(
    (field) => field === "_csrf" || field === "updatedAt" || field === "name",
  );
}

function registerAdminMutations(dependencies: WebRouteDependencies): void {
  registerAdminAction(
    dependencies,
    "/admin/integrations/outbound/create",
    "/admin/integrations/outbound",
    (form) => {
      const service = requireOutboundService(dependencies);
      const parsed = parseOutboundForm(form, "create");
      const created = service.create(outboundCreateInput(parsed));
      applyOutboundHeaderSecrets(service, created.id, parsed.secretValues);
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
      service.edit(destination.id, outboundEditInput(parsed, destination, form));
      if (parsed.token !== undefined && parsed.transport === "home_assistant") {
        service.setToken(destination.id, parsed.token);
      }
      applyOutboundHeaderSecrets(service, destination.id, parsed.secretValues);
      const updated = service.get(destination.id);
      if (updated !== undefined && updated.enabled !== parsed.enabled) {
        service.setEnabled(destination.id, parsed.enabled);
      }
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
      if (!retryDelivery(service.database, delivery.id)) {
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
      if (!dismissDelivery(service.database, delivery.id)) {
        throw new ApplicationError({
          category: "conflict",
          code: "outbound.delivery_not_dismissible",
          clientMessage: "That delivery is no longer open for dismissal.",
        });
      }
    },
    "Delivery dismissed.",
  );

  registerAdminAction(
    dependencies,
    "/admin/display/shared",
    "/admin/display/shared",
    (form, context) => {
      dependencies.displayService.updateSettings(
        {
          expectedRevision: Number(form.expectedRevision),
          tapboardName: form.tapboardName,
          theme: form.theme,
          font: form.font,
          accent: form.accent,
          unitSystem: form.unitSystem,
          showServingTemperature: form.showServingTemperature === "true",
          layoutMode: form.layoutMode,
        },
        actor(context),
      );
    },
    "Shared display defaults saved.",
    {},
    {
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, [
          "expectedRevision",
          "tapboardName",
          "theme",
          "font",
          "accent",
          "unitSystem",
          "showServingTemperature",
          "layoutMode",
        ]);
        const updated = dependencies.displayService.updateSettings(
          {
            expectedRevision: Number(requiredAutosaveField(fields, "expectedRevision")),
            tapboardName: fields.tapboardName,
            theme: fields.theme,
            font: fields.font,
            accent: fields.accent,
            unitSystem: fields.unitSystem,
            showServingTemperature: fields.showServingTemperature === "true",
            layoutMode: fields.layoutMode,
          },
          actor(context),
        );
        return {
          resource: safeDisplayResource(updated),
          revision: updated.revision,
        };
      },
      current: () => {
        const current = dependencies.displayService.getSettings();
        return { current, revision: current.revision };
      },
      validationFields: validationFieldsFor([
        "expectedRevision",
        "tapboardName",
        "theme",
        "font",
        "accent",
        "unitSystem",
        "showServingTemperature",
        "layoutMode",
      ]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/display/tap-card",
    "/admin/display/shared",
    (form, context) => {
      dependencies.displayService.updateTapCardSettings(
        {
          expectedRevision: Number(form.expectedRevision),
          showAbv: form.showAbv === "true",
          showIbu: form.showIbu === "true",
          showOg: form.showOg === "true",
          showFg: form.showFg === "true",
          showSrm: form.showSrm === "true",
          remainingMode: form.remainingMode,
        },
        actor(context),
      );
    },
    "Shared Tap-card settings saved.",
    {},
    {
      handle: (body, context) => {
        const fields = autosaveFieldStrings(body, [
          "expectedRevision",
          "showAbv",
          "showIbu",
          "showOg",
          "showFg",
          "showSrm",
          "remainingMode",
        ]);
        const updated = dependencies.displayService.updateTapCardSettings(
          {
            expectedRevision: Number(requiredAutosaveField(fields, "expectedRevision")),
            showAbv: fields.showAbv === "true",
            showIbu: fields.showIbu === "true",
            showOg: fields.showOg === "true",
            showFg: fields.showFg === "true",
            showSrm: fields.showSrm === "true",
            remainingMode: fields.remainingMode,
          },
          actor(context),
        );
        return {
          resource: safeTapCardResource(updated),
          revision: updated.revision,
        };
      },
      current: () => {
        const current = dependencies.displayService.getTapCardSettings();
        return { current, revision: current.revision };
      },
      validationFields: validationFieldsFor([
        "expectedRevision",
        "showAbv",
        "showIbu",
        "showOg",
        "showFg",
        "showSrm",
        "remainingMode",
      ]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/presentation",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.beverageService.updatePresentationOverrides(
        params.id!,
        presentationOverridesFromForm(form),
        actor(context),
      );
    },
    "Brewfather presentation overrides saved.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, [
          "updatedAt",
          "nameMode",
          "name",
          "beverageTypeMode",
          "beverageType",
          "styleMode",
          "style",
          "abvMode",
          "abv",
          "ibuMode",
          "ibu",
          "ogMode",
          "og",
          "fgMode",
          "fg",
          "srmMode",
          "srm",
          "displayColorMode",
          "displayColor",
          "descriptionMode",
          "description",
          "fillGlassMode",
          "fillGlass",
        ]);
        const updated = dependencies.beverageService.autosavePresentationOverrides(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          presentationOverridesFromForm(fields),
          actor(context),
        );
        return {
          resource: safeBrewfatherResource(updated),
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor([
        "updatedAt",
        "nameMode",
        "name",
        "beverageTypeMode",
        "beverageType",
        "styleMode",
        "style",
        "abvMode",
        "abv",
        "ibuMode",
        "ibu",
        "ogMode",
        "og",
        "fgMode",
        "fg",
        "srmMode",
        "srm",
        "displayColorMode",
        "displayColor",
        "descriptionMode",
        "description",
        "fillGlassMode",
        "fillGlass",
      ]),
    },
  );

  registerAdminAction(
    dependencies,
    "/admin/beverages/create",
    "/admin/beverages",
    (form, context) => {
      const sensoryOverrides = sensoryOverridesFromForm(form);
      const created = dependencies.beverageService.createCustomBeverage(
        {
          name: form.name,
          beverageType: form.beverageType || "beer",
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          ibu: optionalNumber(form.ibu),
          og: optionalNumber(form.og),
          fg: optionalNumber(form.fg),
          srm: optionalNumber(form.srm),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
          manualDensityOverride: optionalNumber(form.manualDensityOverride),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
      return `/admin/beverages/${created.beverage.id}`;
    },
    "Beverage created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/create-fill",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.fillService.createFill(
        {
          beverageId: params.id!,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/update",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      const sensoryOverrides = sensoryOverridesFromForm(form);
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        {
          name: form.name,
          beverageType: form.beverageType,
          style: nullable(form.style),
          abv: optionalNumber(form.abv),
          ibu: optionalNumber(form.ibu),
          og: optionalNumber(form.og),
          fg: optionalNumber(form.fg),
          srm: optionalNumber(form.srm),
          displayColor: nullable(form.displayColor),
          description: nullable(form.description),
          fillGlass: vesselFromForm(form.fillGlass),
          manualDensityOverride: optionalNumber(form.manualDensityOverride),
          ...(form.recipeJson !== undefined ? { recipe: recipeFromForm(form) } : {}),
          ...(sensoryOverrides !== undefined ? { sensoryOverrides } : {}),
        },
        actor(context),
      );
    },
    "Beverage updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS]);
        const updated = dependencies.beverageService.autosaveCustomPresentation(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          customBeverageAutosaveInput(fields),
          actor(context),
        );
        return {
          resource: safeCustomBeverageResource(updated),
          revision: updated.beverage.updatedAt,
        };
      },
      current: (params) => {
        const detail = dependencies.beverageService.getBeverage(params.id!);
        return { current: safeBeverageCurrent(detail), revision: detail.beverage.updatedAt };
      },
      validationFields: validationFieldsFor(["updatedAt", ...AUTOSAVE_BEVERAGE_FIELDS]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/delete",
    "/admin/beverages",
    (form, context, params) => {
      if (form.confirmationName === undefined || form.confirmationName.trim() === "") {
        invalidForm("Type the exact current beverage name to confirm permanent deletion.");
      }
      const reason = nullable(form.reason);
      dependencies.beverageService.deleteBeverage(
        params.id!,
        {
          confirmationName: form.confirmationName,
          ...(reason === undefined ? {} : { reason }),
        },
        actor(context),
      );
    },
    "Beverage deleted.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/sensory",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      const sensory = sensoryOverridesFromForm(form);
      dependencies.beverageService.updateSensoryOverrides(
        params.id!,
        sensory ?? {},
        actor(context),
      );
    },
    "Sensory guidance saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/recipe",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (form, context, params) => {
      dependencies.beverageService.updateCustomBeverage(
        params.id!,
        { recipe: recipeFromForm(form) },
        actor(context),
      );
    },
    "Custom recipe saved.",
    { maxFields: 3, maxBytes: 3_000_000 },
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/:id/unlink",
    (params) => `/admin/beverages/${params.id ?? ""}`,
    (_form, context, params) => {
      dependencies.beverageService.unlinkBeverage(params.id!, actor(context));
    },
    "Beverage unlinked from Brewfather and retained as a Custom Beverage.",
  );
  registerAdminAction(
    dependencies,
    "/admin/beverages/brewfather/link",
    "/admin/beverages",
    (form, context) => {
      const linked = dependencies.beverageService.linkBrewfatherCandidate(
        { sourceBatchId: form.sourceBatchId },
        actor(context),
      );
      return `/admin/beverages/${linked.beverage.id}`;
    },
    "Brewfather batch linked.",
  );

  registerAdminAction(
    dependencies,
    "/admin/kegs/create",
    "/admin/keg-room/kegs",
    (form, context) => {
      dependencies.kegService.createKeg(
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: optionalNumber(form.currentTareG),
          isActive: form.isActive !== "false",
        },
        actor(context),
      );
    },
    "Keg created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/update",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      dependencies.kegService.updateKeg(
        params.id!,
        {
          kegNumber: Number(form.kegNumber),
          label: nullable(form.label),
          capacityMl: Number(form.capacityMl),
          currentTareG: Number(form.currentTareG),
          isActive: form.isActive === "true",
          reason: nullable(form.reason),
        },
        actor(context),
      );
    },
    "Keg updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", "label"]);
        const updated = dependencies.kegService.autosaveLabel(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          { label: nullable(fields.label) },
          actor(context),
        );
        return {
          resource: { label: updated.label },
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.kegService.getKeg(params.id!).keg;
        return {
          current: { label: current.label, updatedAt: current.updatedAt },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor(["updatedAt", "label"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/maintenance",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      dependencies.kegService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/kegs/:id/delete",
    "/admin/keg-room/kegs",
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Keg number and label to confirm permanent deletion.");
      }
      dependencies.kegService.deleteKeg(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
    },
    "Keg deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/fills/create",
    "/admin/keg-room",
    (form, context) => {
      dependencies.fillService.createFill(
        {
          beverageId: form.beverageId,
          kegId: form.kegId,
          ...(form.fillDate ? { fillDate: form.fillDate } : {}),
        },
        actor(context),
      );
    },
    "Fill created.",
  );
  // Static queue reorder path is registered before /:id action paths. The
  // browser enhancement submits the complete ordered list; the service
  // validates membership and remains the sole owner of queue state.
  registerAdminAction(
    dependencies,
    "/admin/fills/reorder-on-deck",
    "/admin/keg-room",
    (form, context) => {
      const fillIds = (form.fillIds ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (
        fillIds.length === 0 ||
        fillIds.length > 200 ||
        new Set(fillIds).size !== fillIds.length
      ) {
        invalidForm("On Deck order must contain each Filled Keg exactly once.");
      }
      dependencies.fillService.reorderOnDeck({ fillIds }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.markOnDeck(params.id!, actor(context));
    },
    "Fill placed On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/remove-on-deck",
    "/admin/keg-room",
    (_form, context, params) => {
      dependencies.fillService.removeFromOnDeck(params.id!, actor(context));
    },
    "Fill removed from On Deck.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/move",
    "/admin/keg-room",
    (form, context, params) => {
      const ids = dependencies.fillService.getPublicOnDeck().map((item) => item.fillId);
      const index = ids.indexOf(params.id!);
      const destination = form.direction === "up" ? index - 1 : index + 1;
      if (index < 0 || destination < 0 || destination >= ids.length) return;
      [ids[index], ids[destination]] = [ids[destination]!, ids[index]!];
      dependencies.fillService.reorderOnDeck({ fillIds: ids }, actor(context));
    },
    "On Deck order updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/kick",
    "/admin/keg-room",
    async (form, context, params) => {
      await dependencies.fillService.kickFill(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Fill ended.",
  );
  registerAdminAction(
    dependencies,
    "/admin/fills/:id/delete",
    "/admin/keg-room",
    (form, context, params) => {
      if (form.confirmation === undefined || form.confirmation.trim() === "") {
        invalidForm("Type the exact visible Filled Keg label to confirm permanent deletion.");
      }
      dependencies.fillService.deleteFill(
        params.id!,
        { reason: nullable(form.reason), confirmation: form.confirmation },
        actor(context),
      );
    },
    "Fill deleted.",
  );

  registerAdminAction(
    dependencies,
    "/admin/taps/create",
    "/admin/taps",
    (form, context) => {
      dependencies.tapService.createTap(
        {
          tapNumber: Number(form.tapNumber),
          name: nullable(form.name),
          enabled: form.enabled !== "false",
          gasType: nullable(form.gasType),
          servingPressureKpa: nullableNumber(form.servingPressureKpa),
          lineLengthMm: nullableNumber(form.lineLengthMm),
          lineDiameterMm: nullableNumber(form.lineDiameterMm),
          notes: nullable(form.notes),
        },
        actor(context),
      );
    },
    "Tap created.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/update",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      if (isTapNameOnlyForm(form)) {
        dependencies.tapService.autosaveName(
          params.id!,
          form.updatedAt!,
          { name: nullable(form.name) },
          actor(context),
        );
        return;
      }
      dependencies.tapService.updateTap(
        params.id!,
        {
          tapNumber: Number(form.tapNumber),
          name: nullable(form.name),
          enabled: form.enabled === "true",
          gasType: nullable(form.gasType),
          servingPressureKpa: nullableNumber(form.servingPressureKpa),
          lineLengthMm: nullableNumber(form.lineLengthMm),
          lineDiameterMm: nullableNumber(form.lineDiameterMm),
          notes: nullable(form.notes),
          acknowledgeTelemetryEndpointImpact: form.acknowledgeTelemetryEndpointImpact === "true",
        },
        actor(context),
      );
    },
    "Tap updated.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, ["updatedAt", "name"]);
        const updated = dependencies.tapService.autosaveName(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          { name: nullable(fields.name) },
          actor(context),
        );
        return {
          resource: { name: updated.name },
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.tapService.getTap(params.id!);
        return {
          current: { name: current.name, updatedAt: current.updatedAt },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor(["updatedAt", "name"]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/assign",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.tapService.assignFill(params.id!, { fillId: form.fillId }, actor(context));
    },
    "Fill assigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/mystery",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.tapService.updateAssignmentMystery(
        params.id!,
        {
          enabled: form.enabled === "true",
          revealBeverageType: form.revealBeverageType === "true",
          revealStyle: form.revealStyle === "true",
          revealAbv: form.revealAbv === "true",
          revealIbu: form.revealIbu === "true",
          revealOg: form.revealOg === "true",
          revealFg: form.revealFg === "true",
          revealSrm: form.revealSrm === "true",
          revealDescription: form.revealDescription === "true",
          revealRecipe: form.revealRecipe === "true",
          revealSensory: form.revealSensory === "true",
          revealHistory: form.revealHistory === "true",
        },
        actor(context),
      );
    },
    "Mystery Tap settings saved.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/display",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.displayService.setTapCardOverride(
        params.id!,
        tapCardOverrideFromForm(form),
        actor(context),
      );
    },
    "Tap-card display override saved.",
    {},
    {
      handle: (body, context, params) => {
        const fields = autosaveFieldStrings(body, [
          "updatedAt",
          "showAbv",
          "showIbu",
          "showOg",
          "showFg",
          "showSrm",
        ]);
        const updated = dependencies.displayService.autosaveTapCardOverride(
          params.id!,
          requiredAutosaveField(fields, "updatedAt"),
          tapCardOverrideFromForm(fields),
          actor(context),
        );
        return {
          resource: safeTapOverrideResource(
            dependencies.displayService.getEffectiveTapCardSettings(params.id!),
          ),
          revision: updated.updatedAt,
        };
      },
      current: (params) => {
        const current = dependencies.tapService.getTap(params.id!);
        return {
          current: {
            tapId: params.id,
            updatedAt: current.updatedAt,
            settings: dependencies.displayService.getEffectiveTapCardSettings(params.id!).settings,
          },
          revision: current.updatedAt,
        };
      },
      validationFields: validationFieldsFor([
        "updatedAt",
        "showAbv",
        "showIbu",
        "showOg",
        "showFg",
        "showSrm",
      ]),
    },
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/unassign",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (_form, context, params) => {
      dependencies.tapService.unassign(params.id!, actor(context));
    },
    "Tap unassigned.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/move",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      const tap = dependencies.tapService.getTap(params.id!);
      if (tap.activeAssignment === undefined || tap.activeAssignment === null) {
        throw new ApplicationError({
          category: "conflict",
          code: "tap.unassigned",
          clientMessage: "The Tap has no Fill to move.",
        });
      }
      dependencies.tapService.moveFill(
        { fillId: tap.activeAssignment.fillId },
        { targetTapId: form.targetTapId },
        actor(context),
      );
    },
    "Fill moved to the selected Tap.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/authority",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.telemetryService.setTapAuthority(
        params.id!,
        { sourceId: form.sourceId === "" ? null : form.sourceId },
        actor(context),
      );
    },
    "Telemetry authority updated; a fresh baseline is required.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/detector-config",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      const override = detectorOverrideFromForm(form);
      if (Object.keys(override).length === 0) {
        dependencies.detectorService.clearTapOverride(params.id!, actor(context));
        return;
      }
      const effective = mergeDetectorConfig(
        dependencies.detectorService.getGlobalConfig().config,
        override,
      );
      validateCompleteDetectorConfig(effective);
      dependencies.detectorService.setTapOverride(params.id!, override, actor(context));
    },
    "Pour-detector override updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/health-config",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      const effective = dependencies.healthService.getEffectiveConfig(params.id!).effective;
      const override = healthOverrideFromForm(form, effective);
      if (override === null) {
        dependencies.healthService.clearTapOverride(params.id!, actor(context));
        return;
      }
      dependencies.healthService.setTapOverride(params.id!, override, actor(context));
    },
    "Health override updated.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/rebaseline",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (_form, context, params) => {
      dependencies.detectorService.manualRebaseline(params.id!, actor(context));
    },
    "Tap rebaseline requested.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/maintenance",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.healthService.recordMaintenance(
        params.id!,
        { maintenanceType: form.maintenanceType, notes: nullable(form.notes) },
        actor(context),
      );
    },
    "Line maintenance recorded.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/retire",
    (params) => `/admin/taps/${encodeURIComponent(params.id ?? "")}`,
    (form, context, params) => {
      dependencies.tapService.retireTap(
        params.id!,
        { reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Tap retired.",
  );
  registerAdminAction(
    dependencies,
    "/admin/taps/:id/delete",
    "/admin/taps",
    (form, context, params) => {
      const confirmation = form.confirmation ?? "";
      if (confirmation.trim().length === 0) {
        invalidForm("Type the exact visible Tap label to confirm permanent deletion.");
      }
      const service = dependencies.tapService as TapService & {
        readonly deleteTapConfirmed?: (
          tapId: unknown,
          confirmation: unknown,
          input?: { readonly reason?: string | null },
          actor?: { readonly actorType?: "admin"; readonly sessionId?: string },
        ) => void;
      };
      if (typeof service.deleteTapConfirmed === "function") {
        const reason = nullable(form.reason);
        service.deleteTapConfirmed(
          params.id!,
          confirmation,
          reason === undefined ? {} : { reason },
          actor(context),
        );
        return;
      }
      // Compatibility for narrow service doubles; the production service
      // always takes the confirmed transactional path above.
      dependencies.tapService.deleteTap(
        params.id!,
        { confirmation, reason: nullable(form.reason) },
        actor(context),
      );
    },
    "Tap deleted.",
  );

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
      await dependencies.beverageService.syncBrewfather();
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
      try {
        const form = await readFormBody(request);
        const context = adminContext(request, dependencies.authService);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new Error("unauthorized");
        const issued = dependencies.telemetryService.createSource(
          { name: form.name, ...(form.label ? { label: form.label } : {}) },
          actor(context),
        );
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
      } catch {
        redirect(
          response,
          messageLocation(
            "/admin/integrations/telemetry",
            "error",
            "Telemetry source could not be created.",
          ),
        );
      }
    },
  );
  dependencies.router.post(
    "/admin/integrations/telemetry-sources/:id/rotate",
    async (request, response, params) => {
      try {
        const form = await readFormBody(request);
        const context = adminContext(request, dependencies.authService);
        const authorized = dependencies.authService.authorizeCookieMutation({
          cookieHeader: request.headers.cookie,
          originHeader: request.headers.origin,
          csrfHeader: form._csrf,
          canonicalOrigin: dependencies.canonicalOrigin,
        });
        if (context === undefined || authorized?.id !== context.session.id)
          throw new Error("unauthorized");
        const issued = dependencies.telemetryService.rotateSourceKey(
          params.id!,
          form.label ? { label: form.label } : {},
          actor(context),
        );
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
      } catch {
        redirect(
          response,
          messageLocation(
            "/admin/integrations/telemetry",
            "error",
            "Telemetry key could not be rotated.",
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
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/start",
    "/admin/tap-wars",
    (form, context) => {
      dependencies.tapWarsService.start(
        {
          competitor1AssignmentId: form.competitor1AssignmentId,
          competitor2AssignmentId: form.competitor2AssignmentId,
        },
        actor(context),
      );
    },
    "Tap War started.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/resume",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.resume(params.id!, actor(context));
    },
    "Tap War resumed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/stop",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.stop(params.id!, actor(context));
    },
    "Tap War completed.",
  );
  registerAdminAction(
    dependencies,
    "/admin/tap-wars/:id/dismiss",
    "/admin/tap-wars",
    (_form, context, params) => {
      dependencies.tapWarsService.dismissPublicResult(params.id!, actor(context));
    },
    "Tap War result dismissed.",
  );
}

export function registerWebRoutes(dependencies: WebRouteDependencies): void {
  registerAdminNotFound(dependencies);
  registerPublicRoutes(dependencies);
  registerAuthenticationRoutes(dependencies);
  registerAdminPages(dependencies);
  registerAdminMutations(dependencies);
}
