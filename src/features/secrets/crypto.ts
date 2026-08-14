import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";
import { TextDecoder } from "node:util";

import { ApplicationError } from "../../shared/errors.ts";

export const SECRET_ENVELOPE_VERSION = 1;
export const SECRET_NONCE_BYTES = 12;
export const SECRET_TAG_BYTES = 16;
export const SECRET_KEY_BYTES = 32;
export const SECRET_MAX_PLAINTEXT_BYTES = 16_384;
export const SECRET_DOMAIN = "tapboard.secrets.v1";
const MACHINE_IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export interface SecretIdentity {
  readonly integrationType: string;
  readonly recordId: string;
  readonly fieldName: string;
  readonly envelopeVersion?: number;
}

export interface SecretEnvelope {
  readonly envelopeVersion: 1;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

function unavailable(): ApplicationError {
  return new ApplicationError({
    category: "unavailable",
    code: "secrets.unavailable",
    clientMessage: "Secret storage is unavailable.",
  });
}

function invalidSecret(): ApplicationError {
  return new ApplicationError({
    category: "validation",
    code: "secrets.invalid",
    clientMessage: "The secret is invalid.",
  });
}

export function parseRootKey(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw unavailable();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw unavailable();
  }
  if (decoded.byteLength !== SECRET_KEY_BYTES || decoded.toString("base64url") !== value) {
    throw unavailable();
  }
  return new Uint8Array(decoded);
}

export function requireRootKey(value: unknown): Uint8Array {
  const parsed = parseRootKey(value);
  if (parsed === undefined) throw unavailable();
  return parsed;
}

export function validateIdentityPart(value: unknown, _field = "identity"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw invalidSecret();
  if (Buffer.byteLength(value, "utf8") > 255 || !MACHINE_IDENTIFIER.test(value))
    throw invalidSecret();
  return value;
}

export function validateSecretIdentity(identity: SecretIdentity): SecretIdentity {
  const integrationType = validateIdentityPart(identity.integrationType, "integrationType");
  const recordId = validateIdentityPart(identity.recordId, "recordId");
  const fieldName = validateIdentityPart(identity.fieldName, "fieldName");
  const envelopeVersion = identity.envelopeVersion ?? SECRET_ENVELOPE_VERSION;
  if (envelopeVersion !== SECRET_ENVELOPE_VERSION) throw invalidSecret();
  return { integrationType, recordId, fieldName, envelopeVersion: SECRET_ENVELOPE_VERSION };
}

export function associatedData(identity: SecretIdentity): Buffer {
  const normalized = validateSecretIdentity(identity);
  return Buffer.from(
    `${SECRET_DOMAIN}\u0000integrationType=${normalized.integrationType}\u0000recordId=${normalized.recordId}\u0000fieldName=${normalized.fieldName}\u0000envelopeVersion=${SECRET_ENVELOPE_VERSION}`,
    "utf8",
  );
}

export const buildAssociatedData = associatedData;

function plaintextBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) throw invalidSecret();
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > SECRET_MAX_PLAINTEXT_BYTES)
    throw invalidSecret();
  return bytes;
}

export interface SecretCryptoOptions {
  readonly randomBytes?: (size: number) => Uint8Array;
}

export function encryptSecret(
  plaintext: unknown,
  key: Uint8Array,
  identity: SecretIdentity,
  options: SecretCryptoOptions = {},
): SecretEnvelope {
  if (!(key instanceof Uint8Array) || key.byteLength !== SECRET_KEY_BYTES) throw unavailable();
  const bytes = plaintextBytes(plaintext);
  const random = options.randomBytes ?? nodeRandomBytes;
  const nonce = random(SECRET_NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== SECRET_NONCE_BYTES)
    throw unavailable();
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(nonce));
  cipher.setAAD(associatedData(identity));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    envelopeVersion: SECRET_ENVELOPE_VERSION,
    nonce: new Uint8Array(nonce),
    ciphertext: new Uint8Array(ciphertext),
    authTag: new Uint8Array(cipher.getAuthTag()),
  };
}

export function decryptSecret(
  envelope: SecretEnvelope,
  key: Uint8Array,
  identity: SecretIdentity,
): string {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !(key instanceof Uint8Array) ||
    key.byteLength !== SECRET_KEY_BYTES ||
    envelope.envelopeVersion !== SECRET_ENVELOPE_VERSION ||
    !(envelope.nonce instanceof Uint8Array) ||
    envelope.nonce.byteLength !== SECRET_NONCE_BYTES ||
    !(envelope.authTag instanceof Uint8Array) ||
    envelope.authTag.byteLength !== SECRET_TAG_BYTES ||
    !(envelope.ciphertext instanceof Uint8Array) ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.ciphertext.byteLength > SECRET_MAX_PLAINTEXT_BYTES
  )
    throw unavailable();
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(envelope.nonce));
    decipher.setAAD(associatedData(identity));
    decipher.setAuthTag(Buffer.from(envelope.authTag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext)),
      decipher.final(),
    ]);
    if (plaintext.byteLength === 0 || plaintext.byteLength > SECRET_MAX_PLAINTEXT_BYTES)
      throw unavailable();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (decoded.length === 0) throw unavailable();
    return decoded;
  } catch {
    throw unavailable();
  }
}
