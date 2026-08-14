import { resolve } from "node:path";
import { isIP } from "node:net";

import { requireBoundedNonemptyString, requireIntegerInRange } from "./shared/validation.ts";

export interface ApplicationConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly shutdownGraceMs: number;
  readonly canonicalExternalOrigin?: string;
  readonly trustedProxies?: readonly string[];
  readonly sessionInactivityMs?: number;
  readonly sessionAbsoluteMs?: number;
  readonly secretKey?: string;
  readonly secretKeyState?: "missing" | "available" | "invalid";
}

export interface LoadConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly baseDirectory?: string;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string,
): string {
  return env[key] ?? fallback;
}

const SESSION_MIN_MS = 60_000;
const SESSION_MAX_MS = 31_536_000_000;
const SECRET_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function optionalCanonicalOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("TAPBOARD_EXTERNAL_ORIGIN is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("TAPBOARD_EXTERNAL_ORIGIN is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new TypeError("TAPBOARD_EXTERNAL_ORIGIN is invalid");
  }
  return value;
}

function optionalTrustedProxies(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(",");
  if (parts.length === 0 || parts.length > 32 || parts.some((part) => part.length === 0)) {
    throw new TypeError("TAPBOARD_TRUSTED_PROXIES is invalid");
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (
      part.length > 255 ||
      /\s|[\u0000-\u001f\u007f]/u.test(part) ||
      isIP(part) === 0 ||
      seen.has(part)
    ) {
      throw new TypeError("TAPBOARD_TRUSTED_PROXIES is invalid");
    }
    seen.add(part);
  }
  return Object.freeze(parts);
}

function secretKeyConfiguration(value: string | undefined): {
  readonly key?: string;
  readonly state: "missing" | "available" | "invalid";
} {
  if (value === undefined) return { state: "missing" };
  if (!SECRET_KEY_PATTERN.test(value)) return { state: "invalid" };
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
      return { state: "invalid" };
    }
  } catch {
    return { state: "invalid" };
  }
  return { key: value, state: "available" };
}

export function loadConfig(options: LoadConfigOptions = {}): ApplicationConfig {
  const env = options.env ?? process.env;
  const baseDirectory = resolve(options.baseDirectory ?? process.cwd());
  const host = requireBoundedNonemptyString(
    envValue(env, "TAPBOARD_HOST", "127.0.0.1"),
    "TAPBOARD_HOST",
    { maxLength: 255 },
  );
  const port = requireIntegerInRange(
    envValue(env, "TAPBOARD_PORT", "3000"),
    "TAPBOARD_PORT",
    0,
    65_535,
  );
  const databasePathValue = requireBoundedNonemptyString(
    envValue(env, "TAPBOARD_DATABASE_PATH", "data/tapboard-v2.sqlite3"),
    "TAPBOARD_DATABASE_PATH",
    { maxLength: 4096 },
  );
  const shutdownGraceMs = requireIntegerInRange(
    envValue(env, "TAPBOARD_SHUTDOWN_GRACE_MS", "5000"),
    "TAPBOARD_SHUTDOWN_GRACE_MS",
    1,
    300_000,
  );
  const sessionInactivityMs = requireIntegerInRange(
    envValue(env, "TAPBOARD_SESSION_INACTIVITY_MS", String(30 * 86_400_000)),
    "TAPBOARD_SESSION_INACTIVITY_MS",
    SESSION_MIN_MS,
    SESSION_MAX_MS,
  );
  const sessionAbsoluteMs = requireIntegerInRange(
    envValue(env, "TAPBOARD_SESSION_ABSOLUTE_MS", String(365 * 86_400_000)),
    "TAPBOARD_SESSION_ABSOLUTE_MS",
    SESSION_MIN_MS,
    SESSION_MAX_MS,
  );
  if (sessionInactivityMs > sessionAbsoluteMs) {
    throw new TypeError("TAPBOARD_SESSION_INACTIVITY_MS must not exceed absolute lifetime");
  }
  const canonicalExternalOrigin = optionalCanonicalOrigin(env.TAPBOARD_EXTERNAL_ORIGIN);
  const trustedProxies = optionalTrustedProxies(env.TAPBOARD_TRUSTED_PROXIES);
  const secretKey = secretKeyConfiguration(env.TAPBOARD_SECRET_KEY);

  return {
    host,
    port,
    databasePath: resolve(baseDirectory, databasePathValue),
    shutdownGraceMs,
    sessionInactivityMs,
    sessionAbsoluteMs,
    ...(canonicalExternalOrigin === undefined ? {} : { canonicalExternalOrigin }),
    trustedProxies: trustedProxies ?? [],
    ...(secretKey.key === undefined ? {} : { secretKey: secretKey.key }),
    secretKeyState: secretKey.state,
  } satisfies ApplicationConfig;
}
