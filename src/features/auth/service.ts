import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { ApplicationError } from "../../shared/errors.ts";
import { appendActivity } from "../activity/operations.ts";
import {
  insertCredential,
  insertSession,
  limitSessionLifetimes,
  listActiveSessionSummaries,
  pruneSessions,
  readCredential,
  readSessionByDigest,
  readSessionById,
  readSessionPolicy,
  replaceCredential,
  resetThrottle,
  reserveAttempt,
  revokeAllSessions,
  revokeSession,
  conditionalTouchSession,
  updateSessionPolicy as persistSessionPolicy,
  type SessionRecord,
} from "./repository.ts";
import { hashPin, verifyPin, type PinVerifier } from "./pin.ts";
import { serializeSessionCookie } from "../../infrastructure/http/security/cookie.ts";
import {
  authorizeCookieMutation as authorizeCookieMutationGuard,
  type CookieMutationInput,
} from "../../infrastructure/http/security/csrf.ts";
import { parseCanonicalOrigin } from "../../infrastructure/http/security/origin.ts";

const DAY_MS = 86_400_000;
const MAX_TIMEOUT_MS = 31_536_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DUMMY_VERIFIER: PinVerifier = {
  verifierVersion: 1,
  scryptN: 16_384,
  scryptR: 8,
  scryptP: 1,
  scryptKeyLength: 32,
  salt: new Uint8Array(16),
  verifier: new Uint8Array(32),
};

export interface SessionSettings {
  readonly inactivityMs: number;
  readonly absoluteMs: number;
}

export interface SessionPolicy extends SessionSettings {
  readonly configured: boolean;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ActiveAdminSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly current: boolean;
}

export interface AuthClockOptions {
  readonly now?: () => Date;
}

export interface AuthManagementOptions extends AuthClockOptions {
  readonly actorType?: "admin" | "operator" | "system";
  readonly actorId?: string;
  readonly sessionId?: string;
}

export interface ActiveSessionListOptions extends AuthClockOptions {
  readonly limit?: number;
  readonly currentSessionId?: string;
}

export interface AuthServiceOptions extends AuthClockOptions {
  readonly session?: Partial<SessionSettings>;
  readonly idFactory?: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly canonicalOrigin?: string;
  readonly externalOrigin?: string;
}

export interface CredentialStatus {
  readonly configured: boolean;
  readonly revision: number | null;
}

export interface AuthenticationResult {
  readonly authenticated: boolean;
  readonly success: boolean;
  readonly throttled: boolean;
  readonly session?: string;
  readonly csrfToken?: string;
  readonly csrf?: string;
  readonly sessionId?: string;
  readonly cookie?: string;
  readonly expiresAt?: string;
  readonly absoluteExpiresAt?: string;
}

export interface AuthenticatedSession {
  readonly id: string;
  readonly credentialRevision: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface SessionMaterial {
  readonly session: string;
  readonly csrfToken: string;
  readonly cookie: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface CredentialChangeOptions extends AuthClockOptions {
  readonly actorType?: "admin" | "operator" | "system";
  readonly actorId?: string;
  readonly randomBytes?: (size: number) => Uint8Array;
}

function dateNow(factory: (() => Date) | undefined): Date {
  const value = factory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("Invalid authentication clock");
  }
  return value;
}

function timestamp(factory: (() => Date) | undefined): string {
  return dateNow(factory).toISOString();
}

function validateSettings(settings: SessionSettings): SessionSettings {
  if (
    !Number.isSafeInteger(settings.inactivityMs) ||
    !Number.isSafeInteger(settings.absoluteMs) ||
    settings.inactivityMs < 60_000 ||
    settings.inactivityMs > MAX_TIMEOUT_MS ||
    settings.absoluteMs < 60_000 ||
    settings.absoluteMs > MAX_TIMEOUT_MS ||
    settings.inactivityMs > settings.absoluteMs
  ) {
    throw new RangeError("Session lifetimes are invalid");
  }
  return settings;
}

function defaults(options: AuthServiceOptions): SessionSettings {
  return validateSettings({
    inactivityMs: options.session?.inactivityMs ?? 30 * DAY_MS,
    absoluteMs: options.session?.absoluteMs ?? 365 * DAY_MS,
  });
}

function invalidPolicy(): never {
  throw new ApplicationError({
    category: "validation",
    code: "auth.invalid_session_policy",
    clientMessage:
      "Session lifetimes must be whole milliseconds from one minute to one year, with inactivity no longer than the absolute lifetime.",
  });
}

function policyInput(value: unknown): SessionSettings & { readonly expectedRevision: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidPolicy();
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalidPolicy();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => !["inactivityMs", "absoluteMs", "expectedRevision"].includes(String(key)))
  ) {
    invalidPolicy();
  }
  const values: Record<string, unknown> = {};
  for (const key of ["inactivityMs", "absoluteMs", "expectedRevision"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) invalidPolicy();
    values[key] = descriptor.value;
  }
  const { inactivityMs, absoluteMs, expectedRevision } = values;
  if (
    typeof inactivityMs !== "number" ||
    typeof absoluteMs !== "number" ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    invalidPolicy();
  }
  try {
    validateSettings({ inactivityMs, absoluteMs });
  } catch {
    invalidPolicy();
  }
  return { inactivityMs, absoluteMs, expectedRevision };
}

function policyConflict(): never {
  throw new ApplicationError({
    category: "conflict",
    code: "auth.session_policy_changed",
    clientMessage: "Session settings changed concurrently. Reload before saving.",
  });
}

function sessionIdentifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApplicationError({
      category: "validation",
      code: "auth.invalid_session_id",
      clientMessage: "Choose a valid session.",
    });
  }
  return value;
}

function activeSession(
  row: SessionRecord | undefined,
  credentialRevision: number | undefined,
  nowMs: number,
  policy: SessionPolicy,
): SessionRecord | undefined {
  if (
    row === undefined ||
    credentialRevision === undefined ||
    row.revokedAt !== null ||
    row.credentialRevision !== credentialRevision
  ) {
    return undefined;
  }
  const createdAt = canonicalTimestamp(row.createdAt);
  const lastUsedAt = canonicalTimestamp(row.lastUsedAt);
  const storedExpiresAt = canonicalTimestamp(row.expiresAt);
  const storedAbsoluteExpiresAt = canonicalTimestamp(row.absoluteExpiresAt);
  if (
    createdAt === undefined ||
    lastUsedAt === undefined ||
    storedExpiresAt === undefined ||
    storedAbsoluteExpiresAt === undefined
  ) {
    return undefined;
  }
  const absoluteExpiresAt = policy.configured
    ? Math.min(storedAbsoluteExpiresAt, createdAt + policy.absoluteMs)
    : storedAbsoluteExpiresAt;
  const expiresAt = policy.configured
    ? Math.min(storedExpiresAt, absoluteExpiresAt, lastUsedAt + policy.inactivityMs)
    : storedExpiresAt;
  if (nowMs >= expiresAt || nowMs >= absoluteExpiresAt) return undefined;
  return {
    ...row,
    expiresAt: new Date(expiresAt).toISOString(),
    absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "ascii").digest();
}

function tokenFromBytes(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function canonicalTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined;
  return parsed;
}

export function parseSessionToken(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== value) return undefined;
    return new Uint8Array(decoded);
  } catch {
    return undefined;
  }
}

function rawSessionRecord(
  id: string,
  sessionDigest: Uint8Array,
  csrfDigest: Uint8Array,
  revision: number,
  now: string,
  expires: string,
  absoluteExpires: string,
): SessionRecord {
  return {
    id,
    sessionDigest,
    csrfDigest,
    credentialRevision: revision,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: expires,
    absoluteExpiresAt: absoluteExpires,
    revokedAt: null,
  };
}

function publicSession(row: SessionRecord): AuthenticatedSession {
  return {
    id: row.id,
    credentialRevision: row.credentialRevision,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

function genericResult(throttled: boolean): AuthenticationResult {
  return { authenticated: false, success: false, throttled };
}

export class AuthService {
  readonly #database: DatabaseExecutor;
  readonly #options: AuthServiceOptions;
  readonly #settings: SessionSettings;

  constructor(database: DatabaseExecutor, options: AuthServiceOptions = {}) {
    const configuredOrigin = options.canonicalOrigin ?? options.externalOrigin;
    if (
      options.canonicalOrigin !== undefined &&
      options.externalOrigin !== undefined &&
      options.canonicalOrigin !== options.externalOrigin
    ) {
      throw new TypeError("Conflicting external origins");
    }
    if (configuredOrigin !== undefined && parseCanonicalOrigin(configuredOrigin) === undefined) {
      throw new TypeError("Invalid canonical external origin");
    }
    this.#database = database;
    this.#options = options;
    this.#settings = defaults(options);
  }

  getCredentialStatus(): CredentialStatus {
    const credential = readCredential(this.#database);
    return credential === undefined
      ? { configured: false, revision: null }
      : { configured: true, revision: credential.revision };
  }

  status(): CredentialStatus {
    return this.getCredentialStatus();
  }

  getSessionPolicy(): SessionPolicy {
    const stored = readSessionPolicy(this.#database);
    return {
      inactivityMs: stored.inactivityMs ?? this.#settings.inactivityMs,
      absoluteMs: stored.absoluteMs ?? this.#settings.absoluteMs,
      configured: stored.inactivityMs !== null,
      revision: stored.revision,
      updatedAt: stored.updatedAt,
    };
  }

  updateSessionPolicy(input: unknown, options: AuthManagementOptions = {}): SessionPolicy {
    const parsed = policyInput(input);
    return this.#database.withTransaction(() => {
      const current = this.getSessionPolicy();
      if (current.revision !== parsed.expectedRevision) policyConflict();
      if (
        current.configured &&
        current.inactivityMs === parsed.inactivityMs &&
        current.absoluteMs === parsed.absoluteMs
      ) {
        return current;
      }
      const now = timestamp(options.now ?? this.#options.now);
      if (!persistSessionPolicy(this.#database, parsed, now)) policyConflict();
      limitSessionLifetimes(this.#database, parsed.inactivityMs, parsed.absoluteMs);
      const updated = this.getSessionPolicy();
      appendActivity(this.#database, {
        category: "admin",
        action: "configuration_changed",
        actorType: options.actorType ?? "admin",
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        entityType: "auth_session_settings",
        entityId: "1",
        details: {
          inactivity_ms: updated.inactivityMs,
          absolute_ms: updated.absoluteMs,
          revision: updated.revision,
        },
        occurredAt: now,
      });
      return updated;
    });
  }

  listActiveSessions(options: ActiveSessionListOptions = {}): ActiveAdminSession[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError({
        category: "validation",
        code: "auth.invalid_session_limit",
        clientMessage: "Session list limit must be between 1 and 100.",
      });
    }
    const currentSessionId =
      options.currentSessionId === undefined
        ? undefined
        : sessionIdentifier(options.currentSessionId);
    const now = timestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const credential = readCredential(this.#database);
      if (credential === undefined) return [];
      return listActiveSessionSummaries(
        this.#database,
        credential.revision,
        now,
        limit,
        currentSessionId,
      ).map((row) => ({ ...row, current: row.id === currentSessionId }));
    });
  }

  revokeSessionById(id: unknown, options: AuthManagementOptions = {}): boolean {
    const sessionId = sessionIdentifier(id);
    const now = timestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const row = activeSession(
        readSessionById(this.#database, sessionId),
        readCredential(this.#database)?.revision,
        Date.parse(now),
        this.getSessionPolicy(),
      );
      if (row === undefined || !revokeSession(this.#database, sessionId, now)) return false;
      appendActivity(this.#database, {
        category: "security",
        action: "session_revoked",
        actorType: options.actorType ?? "admin",
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        entityType: "admin_session",
        entityId: sessionId,
        occurredAt: now,
      });
      return true;
    });
  }

  async setPin(pin: unknown, options: CredentialChangeOptions = {}): Promise<CredentialStatus> {
    const verifier = await hashPin(
      pin,
      options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes },
    );
    const now = timestamp(options.now ?? this.#options.now);
    this.#database.withTransaction(() => {
      if (readCredential(this.#database) !== undefined) {
        throw new Error("Credential is already configured");
      }
      if (!insertCredential(this.#database, verifier, 1, now, now)) {
        throw new Error("Credential is already configured");
      }
      revokeAllSessions(this.#database, now);
      this.#activity("credential_changed", options, now);
    });
    return this.getCredentialStatus();
  }

  async changePin(
    currentPin: unknown,
    newPin: unknown,
    options: CredentialChangeOptions = {},
  ): Promise<CredentialStatus> {
    const current = readCredential(this.#database);
    if (current === undefined || !(await verifyPin(currentPin, current))) {
      throw new Error("Credential change was rejected");
    }
    const verifier = await hashPin(
      newPin,
      options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes },
    );
    const now = timestamp(options.now ?? this.#options.now);
    this.#database.withTransaction(() => {
      const latest = readCredential(this.#database);
      if (latest === undefined || latest.revision !== current.revision) {
        throw new Error("Credential change was rejected");
      }
      if (
        !replaceCredential(
          this.#database,
          verifier,
          current.revision,
          current.revision + 1,
          latest.createdAt,
          now,
        )
      ) {
        throw new Error("Credential change was rejected");
      }
      revokeAllSessions(this.#database, now);
      this.#activity("credential_changed", options, now);
    });
    return this.getCredentialStatus();
  }

  async resetPin(pin: unknown, options: CredentialChangeOptions = {}): Promise<CredentialStatus> {
    const actorType = options.actorType ?? "operator";
    if (actorType !== "operator" && actorType !== "system") {
      throw new Error("Credential reset was rejected");
    }
    const expected = readCredential(this.#database);
    const verifier = await hashPin(
      pin,
      options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes },
    );
    const now = timestamp(options.now ?? this.#options.now);
    this.#database.withTransaction(() => {
      const current = readCredential(this.#database);
      if (current?.revision !== expected?.revision) {
        throw new Error("Credential reset was rejected");
      }
      if (expected === undefined) {
        if (!insertCredential(this.#database, verifier, 1, now, now)) {
          throw new Error("Credential reset was rejected");
        }
      } else if (
        !replaceCredential(
          this.#database,
          verifier,
          expected.revision,
          expected.revision + 1,
          expected.createdAt,
          now,
        )
      ) {
        throw new Error("Credential reset was rejected");
      }
      revokeAllSessions(this.#database, now);
      this.#activity("operator_pin_reset", options, now, actorType);
    });
    return this.getCredentialStatus();
  }

  resetOperatorPin(pin: unknown, options: CredentialChangeOptions = {}): Promise<CredentialStatus> {
    return this.resetPin(pin, { ...options, actorType: "operator" });
  }

  async authenticate(
    pin: unknown,
    presentedSession?: unknown,
    options: AuthClockOptions = {},
  ): Promise<AuthenticationResult> {
    const nowDate = dateNow(options.now ?? this.#options.now);
    const now = nowDate.toISOString();
    const reservation = this.#database.withTransaction(() => {
      const credential = readCredential(this.#database);
      const throttle = reserveAttempt(this.#database, now);
      return { credential, throttle };
    });
    const verifier = reservation.throttle.allowed
      ? (reservation.credential ?? DUMMY_VERIFIER)
      : DUMMY_VERIFIER;
    const validPin = await verifyPin(pin, verifier);
    if (!reservation.throttle.allowed) {
      return genericResult(true);
    }
    if (!validPin || reservation.credential === undefined) {
      if (reservation.throttle.attemptCount === 5 && reservation.throttle.blockedUntil !== null) {
        this.#recordLoginActivity("auth_throttled", now);
      } else if (reservation.throttle.attemptCount === 1) {
        this.#recordLoginActivity("auth_login_failed", now);
      }
      return genericResult(false);
    }

    const material = this.#database.withTransaction(() => {
      const latest = readCredential(this.#database);
      if (
        latest === undefined ||
        latest.revision !== reservation.credential?.revision ||
        !resetThrottle(this.#database, reservation.throttle.generation)
      ) {
        return undefined;
      }
      const presentedBytes = parseSessionToken(presentedSession);
      if (presentedBytes !== undefined) {
        const old = readSessionByDigest(this.#database, digest(tokenFromBytes(presentedBytes)));
        if (old !== undefined) revokeSession(this.#database, old.id, now);
      }
      const created = this.#makeSession(latest.revision, now);
      insertSession(this.#database, created.record);
      this.#activity("auth_login_succeeded", options, now, "admin", created.record.id);
      return created;
    });
    if (material === undefined) {
      this.#recordLoginActivity("auth_login_failed", now);
      return genericResult(false);
    }
    return {
      authenticated: true,
      success: true,
      throttled: false,
      session: material.public.session,
      csrfToken: material.public.csrfToken,
      csrf: material.public.csrfToken,
      sessionId: material.public.sessionId,
      cookie: material.public.cookie,
      expiresAt: material.public.expiresAt,
      absoluteExpiresAt: material.public.absoluteExpiresAt,
    };
  }

  authenticateSession(
    token: unknown,
    options: AuthClockOptions = {},
  ): AuthenticatedSession | undefined {
    const parsed = parseSessionToken(token);
    if (parsed === undefined) return undefined;
    const nowDate = dateNow(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const nowMs = nowDate.getTime();
      const row = readSessionByDigest(this.#database, digest(token as string));
      const credential = readCredential(this.#database);
      const policy = this.getSessionPolicy();
      const active = activeSession(row, credential?.revision, nowMs, policy);
      if (row === undefined || active === undefined) return undefined;
      // A longer policy must still refresh an active session before its
      // previously captured, shorter inactivity deadline elapses.
      const capturedWindow = Date.parse(active.expiresAt) - Date.parse(active.lastUsedAt);
      const due = Math.min(5 * 60_000, policy.inactivityMs / 4, capturedWindow / 4);
      if (nowMs - Date.parse(active.lastUsedAt) >= due) {
        const nextExpires = new Date(
          Math.min(nowMs + policy.inactivityMs, Date.parse(active.absoluteExpiresAt)),
        ).toISOString();
        conditionalTouchSession(
          this.#database,
          row.id,
          row.lastUsedAt,
          nowDate.toISOString(),
          nextExpires,
          row.absoluteExpiresAt,
        );
        const refreshed = activeSession(
          readSessionByDigest(this.#database, digest(token as string)),
          credential?.revision,
          nowMs,
          policy,
        );
        return refreshed === undefined ? undefined : publicSession(refreshed);
      }
      return publicSession(active);
    });
  }

  validateSession(token: unknown, options?: AuthClockOptions): AuthenticatedSession | undefined {
    const parsed = parseSessionToken(token);
    if (parsed === undefined) return undefined;
    const nowDate = dateNow(options?.now ?? this.#options.now);
    const nowMs = nowDate.getTime();
    const row = readSessionByDigest(this.#database, digest(token as string));
    const credential = readCredential(this.#database);
    const active = activeSession(row, credential?.revision, nowMs, this.getSessionPolicy());
    return active === undefined ? undefined : publicSession(active);
  }

  revoke(token: unknown, options: AuthClockOptions = {}): boolean {
    if (typeof token !== "string") return false;
    const parsed = parseSessionToken(token);
    if (parsed === undefined) return false;
    const now = timestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const row = readSessionByDigest(this.#database, digest(token));
      if (row === undefined || !revokeSession(this.#database, row.id, now)) return false;
      appendActivity(this.#database, {
        category: "security",
        action: "session_revoked",
        actorType: "system",
        sessionId: row.id,
        occurredAt: now,
      });
      return true;
    });
  }

  revokeAll(options: AuthClockOptions = {}): number {
    const now = timestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const count = revokeAllSessions(this.#database, now);
      if (count > 0) {
        appendActivity(this.#database, {
          category: "security",
          action: "sessions_revoked",
          actorType: "system",
          details: { count },
          occurredAt: now,
        });
      }
      return count;
    });
  }

  /** Rotate the active Admin session and invalidate stale forms in every workspace. */
  rotateForWorkspace(token: string): SessionMaterial | undefined {
    return this.#database.withTransaction(() => {
      const current = this.validateSession(token);
      if (current === undefined) return undefined;
      const now = timestamp(this.#options.now);
      const material = this.#makeSession(
        current.credentialRevision,
        now,
        current.absoluteExpiresAt,
      );
      const count = revokeAllSessions(this.#database, now);
      insertSession(this.#database, material.record);
      appendActivity(this.#database, {
        category: "security",
        action: "sessions_revoked",
        actorType: "admin",
        sessionId: current.id,
        details: { count, reason: "workspace_changed" },
        occurredAt: now,
      });
      return material.public;
    });
  }

  prune(options: AuthClockOptions = {}): number {
    return pruneSessions(this.#database, timestamp(options.now ?? this.#options.now), 1_000);
  }

  pruneExpiredSessions(options: AuthClockOptions = {}): number {
    return this.prune(options);
  }

  authorizeCookieMutation(
    input: CookieMutationInput,
    options: AuthClockOptions = {},
  ): AuthenticatedSession | undefined {
    const canonicalOrigin = this.#options.canonicalOrigin ?? this.#options.externalOrigin;
    return this.#database.withTransaction(() => {
      let token: string | undefined;
      return authorizeCookieMutationGuard(
        { ...input, canonicalOrigin },
        (candidate) => {
          token = candidate;
          return this.authenticateSession(candidate, options);
        },
        () => {
          if (token === undefined) return new Uint8Array(0);
          const row = readSessionByDigest(this.#database, digest(token));
          return row?.csrfDigest ?? new Uint8Array(0);
        },
      ) as AuthenticatedSession | undefined;
    });
  }

  #makeSession(
    revision: number,
    now: string,
    absoluteExpiresAt?: string,
  ): { readonly record: SessionRecord; readonly public: SessionMaterial } {
    const random = this.#options.randomBytes ?? randomBytes;
    const sessionBytes = random(32);
    const csrfBytes = random(32);
    if (
      !(sessionBytes instanceof Uint8Array) ||
      !(csrfBytes instanceof Uint8Array) ||
      sessionBytes.byteLength !== 32 ||
      csrfBytes.byteLength !== 32
    ) {
      throw new TypeError("Invalid session randomness");
    }
    const token = tokenFromBytes(sessionBytes);
    const csrfToken = tokenFromBytes(csrfBytes);
    const policy = this.getSessionPolicy();
    const absolute = new Date(
      Math.min(
        Date.parse(now) + policy.absoluteMs,
        absoluteExpiresAt === undefined ? Infinity : Date.parse(absoluteExpiresAt),
      ),
    ).toISOString();
    const expires = new Date(
      Math.min(Date.parse(now) + policy.inactivityMs, Date.parse(absolute)),
    ).toISOString();
    const id = (this.#options.idFactory ?? randomUUID)();
    if (!UUID.test(id)) throw new TypeError("Invalid session identifier");
    const configuredOrigin = parseCanonicalOrigin(
      this.#options.canonicalOrigin ?? this.#options.externalOrigin,
    );
    const secure = configuredOrigin !== undefined && configuredOrigin.startsWith("https:");
    const record = rawSessionRecord(
      id,
      digest(token),
      digest(csrfToken),
      revision,
      now,
      expires,
      absolute,
    );
    return {
      record,
      public: {
        session: token,
        csrfToken,
        cookie: serializeSessionCookie(token, absolute, { now: new Date(now), secure }),
        sessionId: id,
        expiresAt: expires,
        absoluteExpiresAt: absolute,
      },
    };
  }

  #activity(
    action: "credential_changed" | "operator_pin_reset" | "auth_login_succeeded",
    options: { readonly now?: () => Date; readonly actorId?: string },
    occurredAt: string,
    actorType = "admin",
    sessionId?: string,
  ): void {
    appendActivity(this.#database, {
      category: action === "operator_pin_reset" ? "system" : "security",
      action,
      actorType,
      ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      occurredAt,
    });
  }

  #recordLoginActivity(action: "auth_login_failed" | "auth_throttled", occurredAt: string): void {
    appendActivity(this.#database, {
      category: "security",
      action,
      actorType: "system",
      occurredAt,
    });
  }
}

export function createAuthService(
  database: DatabaseExecutor,
  options?: AuthServiceOptions,
): AuthService {
  return new AuthService(database, options);
}
