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

export const canonicalExternalOrigin = parseCanonicalOrigin;
export const parseOrigin = parseCanonicalOrigin;

export function requireCanonicalOrigin(value: unknown): string {
  const origin = parseCanonicalOrigin(value);
  if (origin === undefined) {
    throw new ApplicationError({
      category: "validation",
      code: "http.invalid_origin_configuration",
      clientMessage: "The external origin configuration is invalid.",
    });
  }
  return origin;
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

export const isAllowedOrigin = validateMutationOrigin;

/** Exact membership check. Forwarded headers never affect this decision. */
export function isTrustedProxy(
  remoteAddress: string | undefined,
  trusted: string | readonly string[] | ReadonlySet<string>,
): boolean {
  if (remoteAddress === undefined) return false;
  if (typeof trusted === "string") return remoteAddress === trusted;
  if (trusted instanceof Set) return trusted.has(remoteAddress);
  if (Array.isArray(trusted)) return trusted.includes(remoteAddress);
  return "has" in trusted ? trusted.has(remoteAddress) : false;
}

export interface ForwardedDiagnosticInput {
  readonly remoteAddress?: string;
  readonly trustedProxies?: readonly string[] | ReadonlySet<string>;
  readonly forwardedProto?: string;
  readonly forwardedHost?: string;
}

/** Optional diagnostics only; callers must pass the result explicitly to any log/UI. */
export function diagnosticForwardedOrigin(input: ForwardedDiagnosticInput): string | undefined {
  if (!isTrustedProxy(input.remoteAddress, input.trustedProxies ?? [])) return undefined;
  if (typeof input.forwardedProto !== "string" || typeof input.forwardedHost !== "string")
    return undefined;
  const proto = input.forwardedProto.trim();
  const host = input.forwardedHost.trim();
  if (!/^(?:https?|wss?):$/u.test(`${proto}:`) || !/^[A-Za-z0-9.-]+(?::\d+)?$/u.test(host))
    return undefined;
  return `${proto}://${host}`;
}
