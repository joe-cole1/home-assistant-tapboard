import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";

import { ApplicationError } from "../../../shared/errors.ts";

export const MAX_JSON_BODY_BYTES = 16_384;
export const MAX_BATCH_JSON_BODY_BYTES = 262_144;

function bodyError(code: string, message: string): ApplicationError {
  return new ApplicationError({
    category: code === "http.body_too_large" ? "too_large" : "validation",
    code,
    clientMessage: message,
  });
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

export function validateJsonContentType(
  headersOrValue: IncomingHttpHeaders | string | string[] | undefined,
): void {
  const value =
    typeof headersOrValue === "object" && headersOrValue !== null && !Array.isArray(headersOrValue)
      ? oneHeader(headersOrValue["content-type"])
      : oneHeader(headersOrValue);
  if (value === undefined)
    throw bodyError("http.missing_content_type", "JSON content is required.");
  const normalized = value.trim().toLowerCase();
  if (normalized !== "application/json" && normalized !== "application/json; charset=utf-8") {
    throw bodyError("http.unsupported_media_type", "Only JSON content is accepted.");
  }
}

function declaredLength(headers: IncomingHttpHeaders): number | undefined {
  const value = oneHeader(headers["content-length"]);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw bodyError("http.invalid_content_length", "The request body is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw bodyError("http.invalid_content_length", "The request body is invalid.");
  return parsed;
}

export function discardRequestBody(request: IncomingMessage): void {
  if (request.readableEnded || request.destroyed) return;
  request.on("error", () => undefined);
  request.resume();
}

export interface ReadBodyOptions {
  readonly maxBytes?: number;
  /**
   * Explicit callers may opt into a larger bounded body for a narrowly scoped
   * form contract. The ordinary JSON/body ceiling remains unchanged.
   */
  readonly maxBytesCeiling?: number;
  readonly required?: boolean;
}

export function readRequestBody(
  request: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_JSON_BODY_BYTES;
  const maxBytesCeiling = options.maxBytesCeiling ?? MAX_BATCH_JSON_BODY_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxBytesCeiling) ||
    maxBytesCeiling < 1 ||
    maxBytes > maxBytesCeiling
  ) {
    throw new RangeError("Request body limit is invalid");
  }
  const contentLength = declaredLength(request.headers);
  if (contentLength !== undefined && contentLength > maxBytes) {
    discardRequestBody(request);
    return Promise.reject(bodyError("http.body_too_large", "The request body is too large."));
  }
  if (request.readableEnded) {
    if (options.required === true)
      return Promise.reject(bodyError("http.empty_body", "A request body is required."));
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      request.off("close", onClose);
    };
    const fail = (error: ApplicationError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        fail(bodyError("http.body_too_large", "The request body is too large."));
        // Keep the response channel alive so centralized error mapping can
        // return 413 while the remainder is drained without buffering.
        discardRequestBody(request);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const body = Buffer.concat(chunks, total);
      if (options.required === true && body.byteLength === 0) {
        reject(bodyError("http.empty_body", "A request body is required."));
      } else {
        resolve(body);
      }
    };
    const onAborted = (): void =>
      fail(bodyError("http.request_aborted", "The request was interrupted."));
    const onError = (): void =>
      fail(bodyError("http.body_read_failed", "The request body could not be read."));
    const onClose = (): void => {
      if (!settled) fail(bodyError("http.request_aborted", "The request was interrupted."));
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
    request.on("close", onClose);
    request.resume();
  });
}

export async function readJsonBody<T = unknown>(
  request: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<T> {
  validateJsonContentType(request.headers);
  const body = await readRequestBody(request, { ...options, required: options.required ?? true });
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as T;
  } catch {
    throw bodyError("http.invalid_json", "The request body is not valid JSON.");
  }
}

export const readJsonRequestBody = readJsonBody;
export const readBody = readRequestBody;
