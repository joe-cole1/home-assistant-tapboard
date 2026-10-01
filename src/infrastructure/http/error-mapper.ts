import type { ServerResponse } from "node:http";

import { isApplicationError, redactSafeErrorDetails } from "../../shared/errors.ts";
import { reportFailure } from "../../shared/diagnostics.ts";
import type { Logger } from "../../shared/logging.ts";

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
  const report = reportFailure(error, { operation: "http.request", logger });
  if (isApplicationError(error)) {
    const body: Record<string, unknown> = {
      error: {
        code: error.code,
        message: error.clientMessage,
        ...(error.details === undefined ? {} : { details: redactSafeErrorDetails(error.details) }),
      },
    };
    sendJson(response, report.status, body);
    return;
  }

  sendJson(response, 500, {
    error: {
      code: "internal.unexpected",
      message: "An unexpected error occurred.",
    },
  });
}
