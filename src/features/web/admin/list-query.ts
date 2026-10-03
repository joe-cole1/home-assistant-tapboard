import type { IncomingMessage } from "node:http";
import type { AdminTapPageState } from "../../taps/types.ts";
import { ApplicationError } from "../../../shared/errors.ts";
import { paginationHref } from "../pagination.ts";

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://tapboard.local");
}
export function adminFillPageQueryFromRequest(request: IncomingMessage): {
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

export function adminKegPageQueryFromRequest(request: IncomingMessage): {
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

export function adminTapPageQueryFromRequest(request: IncomingMessage): {
  readonly q: string;
  readonly state: AdminTapPageState;
  readonly page: number;
} {
  const params = requestUrl(request).searchParams;
  const rawPage = Number(params.get("page") ?? "1");
  const rawState = (params.get("state") ?? "all").trim().toLowerCase();
  if (!["all", "assigned", "unassigned", "disabled", "retired"].includes(rawState)) {
    throw new ApplicationError({
      category: "validation",
      code: "request.invalid",
      clientMessage: "Tap state must be all, assigned, unassigned, disabled, or retired.",
    });
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

export function adminFillPageHref(
  query: Readonly<{ q: string; state: string; sort: string; page?: number }>,
  page: number,
): string {
  return paginationHref("/admin/keg-room", query, page, { state: "active", sort: "state" });
}
export function adminKegPageHref(
  query: Readonly<{ q: string; status: string; sort: string; page?: number }>,
  page: number,
): string {
  return paginationHref("/admin/keg-room/kegs", query, page, { status: "active", sort: "number" });
}
export function adminTapPageHref(
  query: Readonly<{ q: string; state: AdminTapPageState }>,
  page: number,
): string {
  return paginationHref("/admin/taps", query, page, { state: "all" });
}
