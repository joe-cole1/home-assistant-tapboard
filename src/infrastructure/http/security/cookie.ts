import { ApplicationError } from "../../../shared/errors.ts";

export const ADMIN_SESSION_COOKIE = "tapboard_admin_session";
export const ADMIN_CSRF_COOKIE = "tapboard_admin_csrf";
const MAX_COOKIE_BYTES = 8 * 1024;
const MAX_COOKIE_PAIRS = 50;

export interface CookieSerializeOptions {
  readonly now?: Date;
  readonly secure?: boolean;
}

function canonicalToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function cookieError(): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "http.invalid_cookie",
    clientMessage: "Authentication failed.",
  });
}

export function serializeSessionCookie(
  token: string,
  absoluteExpiresAt: string | Date,
  options: CookieSerializeOptions = {},
): string {
  if (!canonicalToken(token)) throw cookieError();
  const now = options.now ?? new Date();
  const expires =
    absoluteExpiresAt instanceof Date ? absoluteExpiresAt : new Date(absoluteExpiresAt);
  if (Number.isNaN(now.getTime()) || Number.isNaN(expires.getTime())) throw cookieError();
  const maxAge = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1_000));
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    ...(options.secure === true ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearSessionCookie(options: Pick<CookieSerializeOptions, "secure"> = {}): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    ...(options.secure === true ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}

export function serializeCsrfCookie(
  token: string,
  absoluteExpiresAt: string | Date,
  options: CookieSerializeOptions = {},
): string {
  if (!canonicalToken(token)) throw cookieError();
  const now = options.now ?? new Date();
  const expires =
    absoluteExpiresAt instanceof Date ? absoluteExpiresAt : new Date(absoluteExpiresAt);
  if (Number.isNaN(now.getTime()) || Number.isNaN(expires.getTime())) throw cookieError();
  const maxAge = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 1_000));
  return [
    `${ADMIN_CSRF_COOKIE}=${token}`,
    "Path=/",
    "SameSite=Strict",
    ...(options.secure === true ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearCsrfCookie(options: Pick<CookieSerializeOptions, "secure"> = {}): string {
  return [
    `${ADMIN_CSRF_COOKIE}=`,
    "Path=/",
    "SameSite=Strict",
    ...(options.secure === true ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}

export const serializeClearSessionCookie = clearSessionCookie;

function headerValue(header: string | readonly string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (Array.isArray(header)) {
    if (header.length !== 1 || typeof header[0] !== "string") throw cookieError();
    return header[0];
  }
  return typeof header === "string" ? header : undefined;
}

export function parseCookieHeader(
  header: string | readonly string[] | undefined,
): ReadonlyMap<string, string> {
  const value = headerValue(header);
  if (
    value === undefined ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_COOKIE_BYTES
  ) {
    throw cookieError();
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw cookieError();
  const pairs = value.split(";");
  if (pairs.length > MAX_COOKIE_PAIRS) throw cookieError();
  const result = new Map<string, string>();
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) throw cookieError();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || separator !== trimmed.lastIndexOf("=")) throw cookieError();
    const name = trimmed.slice(0, separator);
    const raw = trimmed.slice(separator + 1);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || raw.includes('"') || /\s/u.test(raw))
      throw cookieError();
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw cookieError();
    }
    if (/[\u0000-\u0020\u007f;=]/u.test(decoded) || result.has(name)) throw cookieError();
    result.set(name, decoded);
  }
  return result;
}

export function parseSessionCookie(
  header: string | readonly string[] | undefined,
): string | undefined {
  const cookies = parseCookieHeader(header);
  const token = cookies.get(ADMIN_SESSION_COOKIE);
  if (token === undefined) return undefined;
  return canonicalToken(token) ? token : undefined;
}

export function parseCsrfCookie(
  header: string | readonly string[] | undefined,
): string | undefined {
  const token = parseCookieHeader(header).get(ADMIN_CSRF_COOKIE);
  return token !== undefined && canonicalToken(token) ? token : undefined;
}

export const parseCookies = parseCookieHeader;
export const parseCookie = parseCookieHeader;
export const serializeCookie = serializeSessionCookie;
