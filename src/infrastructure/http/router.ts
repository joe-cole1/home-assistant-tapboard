import type { IncomingMessage, ServerResponse } from "node:http";

import { ApplicationError } from "../../shared/errors.ts";
import type { Logger } from "../../shared/logging.ts";
import { sendHttpError, sendJson } from "./error-mapper.ts";

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: Readonly<Record<string, string>>,
) => void | Promise<void>;

/**
 * Optional presentation hook for an otherwise unmatched pathname.  The
 * router deliberately keeps this hook out of route matching so that a
 * caller can provide an HTML 404 for one namespace without changing the
 * JSON/error semantics of every other namespace.
 */
export type NotFoundHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) => void | Promise<void>;

interface Route {
  readonly method: string;
  readonly path: string;
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
  readonly handler: RouteHandler;
}

const MAX_REQUEST_TARGET_LENGTH = 8192;

function parseSegments(path: string): {
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
} {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  const paramNames: string[] = [];
  for (const part of parts) {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0) {
        throw new TypeError(`Invalid parameter in route path: ${path}`);
      }
      paramNames.push(name);
    }
  }
  return { segments: parts, paramNames };
}

function matchRoute(
  route: Route,
  pathSegments: readonly string[],
): Record<string, string> | undefined {
  if (route.segments.length !== pathSegments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const patternSegment = route.segments[index]!;
    const requestSegment = pathSegments[index]!;
    if (patternSegment.startsWith(":")) {
      const paramName = patternSegment.slice(1);
      try {
        params[paramName] = decodeURIComponent(requestSegment);
      } catch (cause) {
        throw new ApplicationError({
          category: "validation",
          code: "http.invalid_request_target",
          clientMessage: "Invalid request target.",
          cause,
        });
      }
    } else if (patternSegment !== requestSegment) {
      return undefined;
    }
  }
  return params;
}

export class Router {
  readonly #routes: Route[] = [];
  readonly #logger: Logger;
  #notFoundHandler: NotFoundHandler | undefined;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  setNotFoundHandler(handler: NotFoundHandler | undefined): void {
    this.#notFoundHandler = handler;
  }

  register(method: string, path: string, handler: RouteHandler): void {
    const normalizedMethod = method.toUpperCase();
    if (!normalizedMethod || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw new TypeError("Routes require an HTTP method and an absolute pathname");
    }

    const { segments, paramNames } = parseSegments(path);
    const existing = this.#routes.find(
      (candidate) => candidate.method === normalizedMethod && candidate.path === path,
    );
    if (existing !== undefined) {
      throw new Error(`Duplicate route registration: ${normalizedMethod} ${path}`);
    }

    this.#routes.push({
      method: normalizedMethod,
      path,
      segments,
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void {
    this.register("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.register("POST", path, handler);
  }

  patch(path: string, handler: RouteHandler): void {
    this.register("PATCH", path, handler);
  }

  put(path: string, handler: RouteHandler): void {
    this.register("PUT", path, handler);
  }

  delete(path: string, handler: RouteHandler): void {
    this.register("DELETE", path, handler);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method?.toUpperCase() ?? "";
      const path = this.#pathname(request.url);
      const requestSegments = path.split("/").filter((segment) => segment.length > 0);

      let matchedHandler: RouteHandler | undefined;
      let matchedParams: Record<string, string> = {};

      const allowedMethods = new Set<string>();

      for (const route of this.#routes) {
        const params = matchRoute(route, requestSegments);
        if (params !== undefined) {
          allowedMethods.add(route.method);
          if (route.method === method && matchedHandler === undefined) {
            matchedHandler = route.handler;
            matchedParams = params;
          }
        }
      }

      if (matchedHandler !== undefined) {
        await matchedHandler(request, response, matchedParams);
        return;
      }

      if (allowedMethods.size > 0) {
        const allowed = [...allowedMethods].sort();
        sendJson(
          response,
          405,
          { error: { code: "http.method_not_allowed", message: "Method not allowed." } },
          { allow: allowed.join(", ") },
        );
        return;
      }

      if (this.#notFoundHandler !== undefined) {
        await this.#notFoundHandler(request, response, path);
        return;
      }

      throw new ApplicationError({
        category: "not_found",
        code: "http.not_found",
        clientMessage: "Resource not found.",
      });
    } catch (error) {
      sendHttpError(error, response, this.#logger);
    }
  }

  #pathname(requestTarget: string | undefined): string {
    if (
      requestTarget === undefined ||
      requestTarget.length === 0 ||
      requestTarget.length > MAX_REQUEST_TARGET_LENGTH
    ) {
      throw new ApplicationError({
        category: "validation",
        code: "http.invalid_request_target",
        clientMessage: "Invalid request target.",
      });
    }

    try {
      return new URL(requestTarget, "http://tapboard.local").pathname;
    } catch (cause) {
      throw new ApplicationError({
        category: "validation",
        code: "http.invalid_request_target",
        clientMessage: "Invalid request target.",
        cause,
      });
    }
  }
}
