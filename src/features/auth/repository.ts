import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { isPinVerifier, type PinVerifier } from "./pin.ts";

export interface CredentialRecord extends PinVerifier {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThrottleRecord {
  readonly generation: number;
  readonly attemptSequence: number;
  readonly windowStartedAt: string | null;
  readonly attemptCount: number;
  readonly blockedUntil: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly sessionDigest: Uint8Array;
  readonly csrfDigest: Uint8Array;
  readonly credentialRevision: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
}

interface CredentialRow {
  readonly id: number;
  readonly verifier_version: number;
  readonly scrypt_n: number;
  readonly scrypt_r: number;
  readonly scrypt_p: number;
  readonly scrypt_key_length: number;
  readonly salt: Buffer;
  readonly verifier: Buffer;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ThrottleRow {
  readonly generation: number;
  readonly attempt_sequence: number;
  readonly window_started_at: string | null;
  readonly attempt_count: number;
  readonly blocked_until: string | null;
}

interface SessionRow {
  readonly id: string;
  readonly session_digest: Buffer;
  readonly csrf_digest: Buffer;
  readonly credential_revision: number;
  readonly created_at: string;
  readonly last_used_at: string;
  readonly expires_at: string;
  readonly absolute_expires_at: string;
  readonly revoked_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function mapCredential(row: CredentialRow): CredentialRecord {
  const mapped: CredentialRecord = {
    verifierVersion: row.verifier_version,
    scryptN: row.scrypt_n,
    scryptR: row.scrypt_r,
    scryptP: row.scrypt_p,
    scryptKeyLength: row.scrypt_key_length,
    salt: cloneBytes(row.salt),
    verifier: cloneBytes(row.verifier),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!isCanonicalTimestamp(mapped.createdAt) || !isCanonicalTimestamp(mapped.updatedAt)) {
    throw new Error("Stored credential verifier is invalid");
  }
  return mapped;
}

function mapThrottle(row: ThrottleRow): ThrottleRecord {
  const mapped: ThrottleRecord = {
    generation: row.generation,
    attemptSequence: row.attempt_sequence,
    windowStartedAt: row.window_started_at,
    attemptCount: row.attempt_count,
    blockedUntil: row.blocked_until,
  };
  if (
    !Number.isSafeInteger(mapped.generation) ||
    mapped.generation < 0 ||
    !Number.isSafeInteger(mapped.attemptSequence) ||
    mapped.attemptSequence < 0 ||
    !Number.isSafeInteger(mapped.attemptCount) ||
    mapped.attemptCount < 0 ||
    mapped.attemptCount > 5 ||
    (mapped.windowStartedAt !== null && !isCanonicalTimestamp(mapped.windowStartedAt)) ||
    (mapped.blockedUntil !== null && !isCanonicalTimestamp(mapped.blockedUntil))
  ) {
    throw new Error("Login throttle state is invalid");
  }
  return mapped;
}

function mapSession(row: SessionRow): SessionRecord {
  const mapped: SessionRecord = {
    id: row.id,
    sessionDigest: cloneBytes(row.session_digest),
    csrfDigest: cloneBytes(row.csrf_digest),
    credentialRevision: row.credential_revision,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
  };
  if (
    !UUID.test(mapped.id) ||
    mapped.sessionDigest.byteLength !== 32 ||
    mapped.csrfDigest.byteLength !== 32 ||
    !Number.isSafeInteger(mapped.credentialRevision) ||
    mapped.credentialRevision < 1 ||
    !isCanonicalTimestamp(mapped.createdAt) ||
    !isCanonicalTimestamp(mapped.lastUsedAt) ||
    !isCanonicalTimestamp(mapped.expiresAt) ||
    !isCanonicalTimestamp(mapped.absoluteExpiresAt) ||
    (mapped.revokedAt !== null && !isCanonicalTimestamp(mapped.revokedAt))
  ) {
    throw new Error("Stored session is invalid");
  }
  return mapped;
}

export function readCredential(database: DatabaseExecutor): CredentialRecord | undefined {
  const row = database
    .prepare<[], CredentialRow>(
      `SELECT id, verifier_version, scrypt_n, scrypt_r, scrypt_p,
              scrypt_key_length, salt, verifier, revision, created_at, updated_at
       FROM admin_credentials WHERE id = 1`,
    )
    .get();
  if (row === undefined) return undefined;
  const credential = mapCredential(row);
  if (
    !isPinVerifier(credential) ||
    !Number.isSafeInteger(credential.revision) ||
    credential.revision < 1
  ) {
    throw new Error("Stored credential verifier is invalid");
  }
  return credential;
}

export function insertCredential(
  database: DatabaseExecutor,
  verifier: PinVerifier,
  revision: number,
  createdAt: string,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[number, number, number, number, number, Buffer, Buffer, number, string, string]>(
      `INSERT OR IGNORE INTO admin_credentials
       (id, verifier_version, scrypt_n, scrypt_r, scrypt_p, scrypt_key_length,
        salt, verifier, revision, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      verifier.verifierVersion,
      verifier.scryptN,
      verifier.scryptR,
      verifier.scryptP,
      verifier.scryptKeyLength,
      Buffer.from(verifier.salt),
      Buffer.from(verifier.verifier),
      revision,
      createdAt,
      updatedAt,
    );
  return result.changes === 1;
}

export function replaceCredential(
  database: DatabaseExecutor,
  verifier: PinVerifier,
  expectedRevision: number | null,
  revision: number,
  createdAt: string,
  updatedAt: string,
): boolean {
  const result = database
    .prepare<[number, number, number, number, number, Buffer, Buffer, number, string, number]>(
      `UPDATE admin_credentials
       SET verifier_version = ?, scrypt_n = ?, scrypt_r = ?, scrypt_p = ?,
           scrypt_key_length = ?, salt = ?, verifier = ?, revision = ?, updated_at = ?
       WHERE id = 1 AND revision = ?`,
    )
    .run(
      verifier.verifierVersion,
      verifier.scryptN,
      verifier.scryptR,
      verifier.scryptP,
      verifier.scryptKeyLength,
      Buffer.from(verifier.salt),
      Buffer.from(verifier.verifier),
      revision,
      updatedAt,
      expectedRevision ?? -1,
    );
  return result.changes === 1;
}

export function readThrottle(database: DatabaseExecutor): ThrottleRecord {
  const row = database
    .prepare<[], ThrottleRow>(
      `SELECT generation, attempt_sequence, window_started_at,
              attempt_count, blocked_until
       FROM login_throttle WHERE id = 1`,
    )
    .get();
  if (row === undefined) throw new Error("Login throttle state is missing");
  return mapThrottle(row);
}

export interface ReservedAttempt extends ThrottleRecord {
  readonly allowed: boolean;
}

export interface LoginReservation extends ReservedAttempt {
  readonly credentialRevision: number | null;
}

export function reserveAttempt(database: DatabaseExecutor, now: string): ReservedAttempt {
  const current = readThrottle(database);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid authentication clock");
  if (current.windowStartedAt !== null && !Number.isFinite(Date.parse(current.windowStartedAt))) {
    throw new Error("Login throttle state is invalid");
  }
  if (current.blockedUntil !== null && !Number.isFinite(Date.parse(current.blockedUntil))) {
    throw new Error("Login throttle state is invalid");
  }
  let windowStartedAt = current.windowStartedAt;
  let attemptCount = current.attemptCount;
  let blockedUntil = current.blockedUntil;
  const windowExpired =
    windowStartedAt !== null && nowMs >= Date.parse(windowStartedAt) + 15 * 60_000;
  if (
    windowStartedAt === null ||
    windowExpired ||
    (blockedUntil !== null && nowMs >= Date.parse(blockedUntil))
  ) {
    windowStartedAt = now;
    attemptCount = 0;
    blockedUntil = null;
  }
  const allowed = blockedUntil === null || nowMs >= Date.parse(blockedUntil);
  if (allowed) {
    attemptCount += 1;
    if (attemptCount >= 5) {
      attemptCount = 5;
      blockedUntil = new Date(Date.parse(windowStartedAt) + 15 * 60_000).toISOString();
    }
  }
  const nextSequence = current.attemptSequence + 1;
  database
    .prepare<[string | null, number, string | null, number]>(
      `UPDATE login_throttle
       SET window_started_at = ?, attempt_count = ?, blocked_until = ?, attempt_sequence = ?
       WHERE id = 1`,
    )
    .run(windowStartedAt, attemptCount, blockedUntil, nextSequence);
  return {
    generation: current.generation,
    attemptSequence: nextSequence,
    windowStartedAt,
    attemptCount,
    blockedUntil,
    allowed,
  };
}

export function reserveLoginAttempt(database: DatabaseExecutor, now: string): LoginReservation {
  const credential = readCredential(database);
  const reservation = reserveAttempt(database, now);
  return { ...reservation, credentialRevision: credential?.revision ?? null };
}

export function resetThrottle(database: DatabaseExecutor, generation: number): boolean {
  const result = database
    .prepare<[number]>(
      `UPDATE login_throttle
       SET generation = generation + 1, window_started_at = NULL,
           attempt_count = 0, blocked_until = NULL
       WHERE id = 1 AND generation = ?`,
    )
    .run(generation);
  return result.changes === 1;
}

export function insertSession(database: DatabaseExecutor, session: SessionRecord): void {
  database
    .prepare<[string, Buffer, Buffer, number, string, string, string, string]>(
      `INSERT INTO admin_sessions
       (id, session_digest, csrf_digest, credential_revision, created_at,
        last_used_at, expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      Buffer.from(session.sessionDigest),
      Buffer.from(session.csrfDigest),
      session.credentialRevision,
      session.createdAt,
      session.lastUsedAt,
      session.expiresAt,
      session.absoluteExpiresAt,
    );
}

export function readSessionByDigest(
  database: DatabaseExecutor,
  digest: Uint8Array,
): SessionRecord | undefined {
  const row = database
    .prepare<[Buffer], SessionRow>(
      `SELECT id, session_digest, csrf_digest, credential_revision,
              created_at, last_used_at, expires_at, absolute_expires_at, revoked_at
       FROM admin_sessions WHERE session_digest = ?`,
    )
    .get(Buffer.from(digest));
  return row === undefined ? undefined : mapSession(row);
}

export function revokeSession(database: DatabaseExecutor, id: string, revokedAt: string): boolean {
  const result = database
    .prepare<[string, string]>(
      `UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(revokedAt, id);
  return result.changes === 1;
}

export function revokeAllSessions(database: DatabaseExecutor, revokedAt: string): number {
  return database
    .prepare<[string]>(`UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL`)
    .run(revokedAt).changes;
}

export function conditionalTouchSession(
  database: DatabaseExecutor,
  id: string,
  expectedLastUsedAt: string,
  lastUsedAt: string,
  expiresAt: string,
  absoluteExpiresAt: string,
): boolean {
  const result = database
    .prepare<[string, string, string, string, string]>(
      `UPDATE admin_sessions
       SET last_used_at = ?, expires_at = ?
       WHERE id = ? AND last_used_at = ? AND revoked_at IS NULL
         AND absolute_expires_at = ?`,
    )
    .run(lastUsedAt, expiresAt, id, expectedLastUsedAt, absoluteExpiresAt);
  return result.changes === 1;
}

export function pruneSessions(database: DatabaseExecutor, now: string, limit = 1_000): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError("Session prune limit must be between 1 and 1000");
  }
  return database
    .prepare<[string, string, number]>(
      `DELETE FROM admin_sessions
       WHERE id IN (
         SELECT id FROM admin_sessions
         WHERE (revoked_at IS NOT NULL OR expires_at <= ? OR absolute_expires_at <= ?)
         ORDER BY COALESCE(revoked_at, expires_at), id LIMIT ?
       )`,
    )
    .run(now, now, limit).changes;
}
