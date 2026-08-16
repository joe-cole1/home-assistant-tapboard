import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { TextDecoder } from "node:util";

import { ApplicationError } from "../../shared/errors.ts";
import { readRequestBody } from "./security/body.ts";

export const MAX_FORM_BODY_BYTES = 16_384;
export const MAX_FORM_FIELDS = 100;

function error(code: string, clientMessage: string): ApplicationError {
  return new ApplicationError({
    category: code === "http.body_too_large" ? "too_large" : "validation",
    code,
    clientMessage,
  });
}

function contentType(headers: IncomingHttpHeaders): string | undefined {
  const value = headers["content-type"];
  if (typeof value === "string") return value;
  return undefined;
}

export function validateFormContentType(headers: IncomingHttpHeaders): void {
  const value = contentType(headers)?.trim().toLowerCase();
  if (
    value !== "application/x-www-form-urlencoded" &&
    value !== "application/x-www-form-urlencoded; charset=utf-8"
  ) {
    throw error("http.unsupported_media_type", "Form content is required.");
  }
}

export interface ReadFormOptions {
  readonly maxBytes?: number;
  readonly maxFields?: number;
  readonly required?: boolean;
}

export async function readFormBody(
  request: IncomingMessage,
  options: ReadFormOptions = {},
): Promise<Readonly<Record<string, string>>> {
  validateFormContentType(request.headers);
  const maxBytes = options.maxBytes ?? MAX_FORM_BODY_BYTES;
  const maxFields = options.maxFields ?? MAX_FORM_FIELDS;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxFields) ||
    maxFields < 1
  ) {
    throw new RangeError("Form limits are invalid");
  }
  const bytes = await readRequestBody(request, {
    maxBytes,
    maxBytesCeiling: maxBytes,
    required: options.required ?? true,
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw error("http.invalid_form", "The form body is invalid.");
  }
  const form: Record<string, string> = Object.create(null) as Record<string, string>;
  if (text === "") return form;
  const fields = text.split("&");
  if (fields.length > maxFields) throw error("http.too_many_form_fields", "Too many form fields.");
  for (const field of fields) {
    const separator = field.indexOf("=");
    const rawKey = separator < 0 ? field : field.slice(0, separator);
    const rawValue = separator < 0 ? "" : field.slice(separator + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
      value = decodeURIComponent(rawValue.replace(/\+/gu, " "));
    } catch {
      throw error("http.invalid_form", "The form body is invalid.");
    }
    if (Object.hasOwn(form, key))
      throw error("http.duplicate_form_field", "Duplicate form fields are not accepted.");
    form[key] = value;
  }
  return form;
}

export const readUrlEncodedForm = readFormBody;
