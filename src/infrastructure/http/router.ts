import type { IncomingMessage, ServerResponse } from "node:http";

import { ApplicationError } from "../../shared/errors.ts";
import type { Logger } from "../../shared/logging.ts";
import { sendHttpError, sendJson } from "./error-mapper.ts";

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: RouteHandler;
}

const MAX_REQUEST_TARGET_LENGTH = 8192;

export class Router {
  readonly #routes = new Map<string, Route>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  register(method: string, path: string, handler: RouteHandler): void {
    const normalizedMethod = method.toUpperCase();
    if (!normalizedMethod || !path.startsWith("/") || path.includes("?") || path.includes("#")) {
      throw new TypeError("Routes require an HTTP method and an absolute pathname");
    }

    const key = this.#key(normalizedMethod, path);
    if (this.#routes.has(key)) {
      throw new Error(`Duplicate route registration: ${normalizedMethod} ${path}`);
    }

    this.#routes.set(key, { method: normalizedMethod, path, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.register("GET", path, handler);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method?.toUpperCase() ?? "";
      const path = this.#pathname(request.url);
      const route = this.#routes.get(this.#key(method, path));

      if (route !== undefined) {
        await route.handler(request, response);
        return;
      }

      const allowed = [...this.#routes.values()]
        .filter((candidate) => candidate.path === path)
        .map((candidate) => candidate.method)
        .sort();
      if (allowed.length > 0) {
        sendJson(
          response,
          405,
          { error: { code: "http.method_not_allowed", message: "Method not allowed." } },
          { allow: allowed.join(", ") },
        );
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

  #key(method: string, path: string): string {
    return `${method}\u0000${path}`;
  }
}
