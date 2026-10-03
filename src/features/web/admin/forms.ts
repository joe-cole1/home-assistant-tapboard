import { ApplicationError } from "../../../shared/errors.ts";

export function nullable(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value === "" ? null : value;
}

export function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value === "" ? undefined : Number(value);
}

export function nullableNumber(value: string | undefined): number | null | undefined {
  return value === undefined ? undefined : value === "" ? null : Number(value);
}

export function invalidForm(message: string, field?: string): never {
  throw new ApplicationError({
    category: "validation",
    code: "request.invalid",
    clientMessage: message,
    ...(field === undefined ? {} : { details: { field, reason: "invalid" } }),
  });
}
