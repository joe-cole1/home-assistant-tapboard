import type { ServerResponse } from "node:http";

import {
  isApplicationError,
  redactSafeErrorDetails,
  type ApplicationErrorCategory,
} from "../../shared/errors.ts";
import type { Logger } from "../../shared/logging.ts";

const STATUS_BY_CATEGORY: Readonly<Record<ApplicationErrorCategory, number>> = {
  validation: 400,
  too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload).toString(),
    "content-type": "application/json; charset=utf-8",
    ...additionalHeaders,
  });
  response.end(payload);
}

export function sendHttpError(error: unknown, response: ServerResponse, logger: Logger): void {
  if (isApplicationError(error)) {
    const body: Record<string, unknown> = {
      error: {
        code: error.code,
        message: error.clientMessage,
        ...(error.details === undefined ? {} : { details: redactSafeErrorDetails(error.details) }),
      },
    };
    sendJson(response, STATUS_BY_CATEGORY[error.category], body);
    return;
  }

  logger.error("Unhandled HTTP request error", { error });
  sendJson(response, 500, {
    error: {
      code: "internal.unexpected",
      message: "An unexpected error occurred.",
    },
  });
}
