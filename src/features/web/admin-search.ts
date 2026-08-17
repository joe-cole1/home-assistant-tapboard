import type { BeverageListPage } from "../beverages/types.ts";
import type { AdminFillPage } from "../fills/types.ts";
import type { AdminKegPage } from "../kegs/types.ts";
import type { AdminTapPage } from "../taps/types.ts";

export const ADMIN_JUMP_MAX_QUERY_BYTES = 80;
export const ADMIN_JUMP_MAX_RESULTS = 20;

export type AdminJumpResultKind =
  "destination" | "tap" | "beverage" | "filled_keg" | "physical_keg" | "telemetry_source";

export interface AdminJumpResult {
  readonly kind: AdminJumpResultKind;
  readonly label: string;
  readonly context: string;
  readonly href: string;
  readonly mark: string;
}

export interface AdminJumpDestination {
  readonly label: string;
  readonly href: string;
  readonly mark: string;
}

export interface AdminJumpSearchServices {
  readonly taps: {
    readonly listAdminPage?: (query: unknown) => AdminTapPage;
  };
  readonly beverages: {
    readonly listBeveragePage?: (query: {
      readonly q?: string;
      readonly page?: number;
    }) => BeverageListPage;
  };
  readonly fills: {
    readonly listAdminPage?: (query: unknown) => AdminFillPage;
  };
  readonly kegs: {
    readonly listAdminPage?: (query: unknown) => AdminKegPage;
  };
  readonly telemetry: {
    readonly searchAdminSources?: (
      query: string,
      limit?: number,
    ) => readonly {
      readonly id: string;
      readonly name: string;
      readonly disabledAt: string | null;
    }[];
  };
}

export interface AdminJumpSearchInput {
  readonly query: unknown;
  readonly destinations: readonly AdminJumpDestination[];
  readonly services: AdminJumpSearchServices;
}

interface Candidate extends AdminJumpResult {
  readonly ordinal: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Trim and bound the operator's search text before it reaches any query. */
export function normalizeAdminJumpQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  let bounded = value.trim();
  if (byteLength(bounded) <= ADMIN_JUMP_MAX_QUERY_BYTES) return bounded;

  const characters = Array.from(bounded);
  while (characters.length > 0 && byteLength(characters.join("")) > ADMIN_JUMP_MAX_QUERY_BYTES) {
    characters.pop();
  }
  bounded = characters.join("");
  return bounded;
}

function rank(query: string, label: string, context: string, href: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const lowerContext = context.toLowerCase();
  const lowerHref = href.toLowerCase();
  if (lowerLabel === lowerQuery) return 0;
  if (lowerLabel.startsWith(lowerQuery)) return 1;
  if (lowerLabel.includes(lowerQuery)) return 2;
  if (lowerContext.includes(lowerQuery)) return 3;
  if (lowerHref.includes(lowerQuery)) return 4;
  return 5;
}

/** Compare JavaScript UTF-16 code units without host-locale collation. */
function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const ordinalDifference = left.ordinal - right.ordinal;
  if (ordinalDifference !== 0) return ordinalDifference;

  const normalizedLabelDifference = compareCodeUnits(
    left.label.toLowerCase(),
    right.label.toLowerCase(),
  );
  if (normalizedLabelDifference !== 0) return normalizedLabelDifference;

  const labelDifference = compareCodeUnits(left.label, right.label);
  if (labelDifference !== 0) return labelDifference;

  return compareCodeUnits(left.href, right.href);
}

function addCandidate(
  candidates: Candidate[],
  query: string,
  result: Omit<AdminJumpResult, "kind"> & { readonly kind: AdminJumpResultKind },
  ordinalOffset = 0,
): void {
  candidates.push({
    ...result,
    ordinal: rank(query, result.label, result.context, result.href) + ordinalOffset,
  });
}

function stateLabel(state: string): string {
  switch (state) {
    case "on_tap":
      return "On Tap";
    case "on_deck":
      return "On Deck";
    case "available":
      return "Available";
    case "ended":
      return "Ended";
    default:
      return state;
  }
}

/**
 * Build the bounded Admin destination/resource projection.  Every resource
 * source is queried through its SQL-backed page API, then only its first
 * bounded page is converted to fixed internal links.
 */
export function searchAdminDestinations(input: AdminJumpSearchInput): {
  readonly query: string;
  readonly results: readonly AdminJumpResult[];
} {
  const query = normalizeAdminJumpQuery(input.query);
  if (query.length === 0) return { query, results: [] };

  const candidates: Candidate[] = [];
  const normalized = query.toLowerCase();
  for (const destination of input.destinations) {
    if (`${destination.label} ${destination.href}`.toLowerCase().includes(normalized)) {
      addCandidate(
        candidates,
        query,
        {
          kind: "destination",
          label: destination.label,
          context: "Admin destination",
          href: destination.href,
          mark: destination.mark,
        },
        -1,
      );
    }
  }

  const tapPage = input.services.taps.listAdminPage?.({ q: query, state: "all", page: 1 });
  for (const tap of tapPage?.items ?? []) {
    const label = `Tap ${tap.tapNumber}${tap.name ? ` — ${tap.name}` : ""}`;
    const context = tap.assignment?.beverageName
      ? `Assigned · ${tap.assignment.beverageName}`
      : tap.isRetired
        ? "Retired"
        : tap.enabled
          ? "Unassigned"
          : "Disabled";
    addCandidate(candidates, query, {
      kind: "tap",
      label,
      context,
      href: `/admin/taps/${encodeURIComponent(tap.id)}`,
      mark: "T",
    });
  }

  const beveragePage = input.services.beverages.listBeveragePage?.({ q: query, page: 1 });
  for (const record of beveragePage?.items ?? []) {
    const label = record.effectivePresentation.name || "Unknown Beverage";
    const context = [record.effectivePresentation.style, `${record.currentUsage} current use`]
      .filter((value): value is string => value !== null && value !== undefined && value !== "")
      .join(" · ");
    addCandidate(candidates, query, {
      kind: "beverage",
      label,
      context: context || "Beverage",
      href: `/admin/beverages/${encodeURIComponent(record.beverage.id)}`,
      mark: "B",
    });
  }

  const fillPage = input.services.fills.listAdminPage?.({
    q: query,
    state: "active",
    sort: "name",
    page: 1,
  });
  for (const fill of fillPage?.items ?? []) {
    const label = `Filled Keg · ${fill.beverageName}`;
    const context = [
      `Keg #${fill.kegNumber}`,
      stateLabel(fill.state),
      fill.tapNumber === null || fill.tapNumber === undefined ? null : `Tap ${fill.tapNumber}`,
    ]
      .filter((value): value is string => value !== null)
      .join(" · ");
    addCandidate(candidates, query, {
      kind: "filled_keg",
      label,
      context,
      href: `/admin/keg-room/fills/${encodeURIComponent(fill.id)}`,
      mark: "F",
    });
  }

  const kegPage = input.services.kegs.listAdminPage?.({
    q: query,
    status: "all",
    sort: "number",
    page: 1,
  });
  for (const keg of kegPage?.items ?? []) {
    const label = `Keg #${keg.kegNumber}`;
    addCandidate(candidates, query, {
      kind: "physical_keg",
      label,
      context: keg.label || (keg.isActive ? "Active inventory" : "Inactive inventory"),
      href: `/admin/keg-room/kegs/${encodeURIComponent(keg.id)}`,
      mark: "K",
    });
  }

  const sources =
    input.services.telemetry.searchAdminSources?.(query, ADMIN_JUMP_MAX_RESULTS) ?? [];
  for (const source of sources) {
    addCandidate(candidates, query, {
      kind: "telemetry_source",
      label: source.name,
      context: source.disabledAt === null ? "Telemetry · Active" : "Telemetry · Disabled",
      href: `/admin/integrations/telemetry-sources/${encodeURIComponent(source.id)}`,
      mark: "I",
    });
  }

  const seen = new Set<string>();
  return {
    query,
    results: candidates
      .sort(compareCandidates)
      .filter((candidate) => {
        if (seen.has(candidate.href)) return false;
        seen.add(candidate.href);
        return true;
      })
      .slice(0, ADMIN_JUMP_MAX_RESULTS)
      .map(({ ordinal: _ordinal, ...result }) => result),
  };
}
