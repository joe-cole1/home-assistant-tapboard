import { promisify } from "node:util";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { ApplicationError } from "../../shared/errors.ts";

const scryptAsync = promisify(scrypt);

export const PIN_PATTERN = /^[0-9]{4}$/;
export const PIN_VERIFIER_VERSION = 1;
export const PIN_SCRYPT_N = 16_384;
export const PIN_SCRYPT_R = 8;
export const PIN_SCRYPT_P = 1;
export const PIN_SCRYPT_KEY_LENGTH = 32;
export const PIN_SCRYPT_MAXMEM = 64 * 1024 * 1024;
export const PIN_SALT_LENGTH = 16;

export interface PinVerifier {
  readonly verifierVersion: number;
  readonly scryptN: number;
  readonly scryptR: number;
  readonly scryptP: number;
  readonly scryptKeyLength: number;
  readonly salt: Uint8Array;
  readonly verifier: Uint8Array;
}

export interface PinHashOptions {
  readonly randomBytes?: (size: number) => Uint8Array;
}

export function isPin(value: unknown): value is string {
  return typeof value === "string" && PIN_PATTERN.test(value);
}

export const isValidPin = isPin;
export const validatePin = isPin;
export type PinVerifierRecord = PinVerifier;

function invalidPin(): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "auth.invalid_pin",
    clientMessage: "The PIN is invalid.",
  });
}

export function requirePin(value: unknown): string {
  if (!isPin(value)) throw invalidPin();
  return value;
}

export const assertPin = requirePin;

function bytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function verifierShape(value: unknown): value is PinVerifier {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "salt",
    "scryptKeyLength",
    "scryptN",
    "scryptP",
    "scryptR",
    "verifier",
    "verifierVersion",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return false;
  return (
    candidate.verifierVersion === PIN_VERIFIER_VERSION &&
    candidate.scryptN === PIN_SCRYPT_N &&
    candidate.scryptR === PIN_SCRYPT_R &&
    candidate.scryptP === PIN_SCRYPT_P &&
    candidate.scryptKeyLength === PIN_SCRYPT_KEY_LENGTH &&
    candidate.salt instanceof Uint8Array &&
    candidate.salt.byteLength === PIN_SALT_LENGTH &&
    candidate.verifier instanceof Uint8Array &&
    candidate.verifier.byteLength === PIN_SCRYPT_KEY_LENGTH &&
    (candidate.revision === undefined ||
      (typeof candidate.revision === "number" &&
        Number.isSafeInteger(candidate.revision) &&
        candidate.revision >= 1)) &&
    (candidate.createdAt === undefined || typeof candidate.createdAt === "string") &&
    (candidate.updatedAt === undefined || typeof candidate.updatedAt === "string")
  );
}

function fixedMetadata(value: unknown): value is PinVerifier {
  return verifierShape(value);
}

async function derive(
  pin: string,
  salt: Uint8Array,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const deriveAsync = scryptAsync as unknown as (
    password: string,
    salt: Buffer,
    keyLength: number,
    options: {
      readonly N: number;
      readonly r: number;
      readonly p: number;
      readonly maxmem: number;
    },
  ) => Promise<Buffer>;
  const result = await deriveAsync(pin, bytes(salt), PIN_SCRYPT_KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: PIN_SCRYPT_MAXMEM,
  });
  return result;
}

/** Hash a validated four-digit PIN using the fixed, versioned verifier format. */
export async function hashPin(pin: unknown, options: PinHashOptions = {}): Promise<PinVerifier> {
  const value = requirePin(pin);
  const salt = options.randomBytes?.(PIN_SALT_LENGTH) ?? randomBytes(PIN_SALT_LENGTH);
  if (!(salt instanceof Uint8Array) || salt.byteLength !== PIN_SALT_LENGTH) {
    throw new TypeError("Invalid PIN salt");
  }
  const verifier = await derive(value, salt, PIN_SCRYPT_N, PIN_SCRYPT_R, PIN_SCRYPT_P);
  return {
    verifierVersion: PIN_VERIFIER_VERSION,
    scryptN: PIN_SCRYPT_N,
    scryptR: PIN_SCRYPT_R,
    scryptP: PIN_SCRYPT_P,
    scryptKeyLength: PIN_SCRYPT_KEY_LENGTH,
    salt: new Uint8Array(salt),
    verifier: new Uint8Array(verifier),
  };
}

/**
 * Verify a PIN without disclosing malformed verifier metadata. Unknown or
 * tampered records still execute a bounded dummy scrypt operation.
 */
export async function verifyPin(pin: unknown, record: unknown): Promise<boolean> {
  const validInput = isPin(pin);
  const value = validInput ? pin : "0000";
  if (!fixedMetadata(record)) {
    await derive(value, new Uint8Array(PIN_SALT_LENGTH), PIN_SCRYPT_N, PIN_SCRYPT_R, PIN_SCRYPT_P);
    return false;
  }
  try {
    const derived = await derive(
      value,
      record.salt,
      record.scryptN,
      record.scryptR,
      record.scryptP,
    );
    return (
      validInput &&
      derived.byteLength === record.verifier.byteLength &&
      timingSafeEqual(derived, bytes(record.verifier))
    );
  } catch {
    return false;
  }
}

export function isPinVerifier(value: unknown): value is PinVerifier {
  return fixedMetadata(value);
}
