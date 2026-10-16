import { ApplicationError } from "../../../shared/errors.ts";

export function parseCanonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0020\u007f]/u.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    return parsed.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function originError(): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "http.origin_forbidden",
    clientMessage: "Authentication failed.",
  });
}

export function validateMutationOrigin(
  supplied: string | readonly string[] | undefined | null,
  configured: unknown,
): boolean {
  const expected = parseCanonicalOrigin(configured);
  if (expected === undefined || supplied === undefined || supplied === null) return false;
  if (Array.isArray(supplied)) {
    if (supplied.length !== 1 || typeof supplied[0] !== "string") return false;
    supplied = supplied[0];
  }
  if (typeof supplied !== "string" || supplied.includes(",")) return false;
  return parseCanonicalOrigin(supplied) === expected;
}

export function requireMutationOrigin(
  supplied: string | readonly string[] | undefined | null,
  configured: unknown,
): void {
  if (!validateMutationOrigin(supplied, configured)) throw originError();
}
