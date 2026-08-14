import { createHash, timingSafeEqual } from "node:crypto";

import { parseSessionCookie } from "./cookie.ts";
import { validateMutationOrigin } from "./origin.ts";

export interface CookieMutationInput {
  readonly cookieHeader: string | readonly string[] | undefined;
  readonly originHeader: string | readonly string[] | undefined | null;
  readonly csrfHeader: string | readonly string[] | undefined | null;
  readonly canonicalOrigin: unknown;
}

export interface CookieMutationSession {
  readonly id: string;
  readonly credentialRevision: number;
}

export type CookieMutationAuthorization = CookieMutationSession;

function canonicalToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function oneHeader(value: string | readonly string[] | undefined | null): string | undefined {
  if (Array.isArray(value))
    return value.length === 1 && typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

export function csrfDigest(value: string): Buffer {
  return createHash("sha256").update(value, "ascii").digest();
}

export function validateCsrfToken(provided: unknown, expectedDigest: Uint8Array): boolean {
  if (typeof provided !== "string" || !canonicalToken(provided)) return false;
  const candidate = csrfDigest(provided);
  return (
    candidate.length === expectedDigest.byteLength &&
    timingSafeEqual(candidate, Buffer.from(expectedDigest))
  );
}

export function authorizeCookieMutation(
  input: CookieMutationInput,
  authenticate: (sessionToken: string) => CookieMutationSession | undefined,
  expectedCsrfDigest: (session: CookieMutationSession) => Uint8Array,
): CookieMutationAuthorization | undefined {
  try {
    const token = parseSessionCookie(input.cookieHeader);
    if (token === undefined) return undefined;
    if (!validateMutationOrigin(input.originHeader, input.canonicalOrigin)) return undefined;
    const csrf = oneHeader(input.csrfHeader);
    if (csrf === undefined || csrf.includes(",") || !canonicalToken(csrf)) return undefined;
    const session = authenticate(token);
    if (session === undefined) return undefined;
    if (!validateCsrfToken(csrf, expectedCsrfDigest(session))) {
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export const authorizeMutation = authorizeCookieMutation;
