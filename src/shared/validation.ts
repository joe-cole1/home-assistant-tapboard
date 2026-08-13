import { ApplicationError } from "./errors.ts";

function validationError(field: string, reason: string): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "validation.invalid_value",
    clientMessage: "The request contains an invalid value.",
    details: { field, reason },
  });
}

export function requirePlainObject(value: unknown, field = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(field, "must be a plain object");
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(field, "must be a plain object");
  }

  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  field = "value",
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();

  if (unknown.length > 0) {
    throw validationError(field, `contains unknown key: ${unknown[0]}`);
  }
}

export interface BoundedStringOptions {
  readonly minLength?: number;
  readonly maxLength: number;
  readonly trim?: boolean;
}

export function requireBoundedNonemptyString(
  value: unknown,
  field: string,
  options: BoundedStringOptions,
): string {
  if (typeof value !== "string") {
    throw validationError(field, "must be a string");
  }

  const normalized = options.trim === false ? value : value.trim();
  const minimum = options.minLength ?? 1;
  if (normalized.length < minimum || normalized.length > options.maxLength) {
    throw validationError(
      field,
      `must contain between ${minimum} and ${options.maxLength} characters`,
    );
  }

  return normalized;
}

export function requireIntegerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  let parsed: number;

  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw validationError(field, "must be an integer");
  }

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw validationError(field, `must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}
