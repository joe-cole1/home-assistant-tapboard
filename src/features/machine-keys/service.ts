import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { appendActivity } from "../activity/operations.ts";
import {
  insertMachineKeyRow,
  listMachineKeyRows,
  readMachineKeyRow,
  readMachineKeyByPublicId,
  revokeMachineKeyRow,
  touchMachineKeyRow,
  type MachineKeyRow,
} from "./repository.ts";

const PUBLIC_ID_BYTES = 12;
const SECRET_BYTES = 32;
const PUBLIC_ID_LENGTH = 16;
const SECRET_LENGTH = 43;
const DUMMY_TOKEN = `tbk_${"A".repeat(PUBLIC_ID_LENGTH)}_${"A".repeat(SECRET_LENGTH)}`;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MachineKeyDescriptor {
  readonly id: string;
  readonly publicId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly replacementForId: string | null;
}

export interface MachineKeyVerification {
  readonly id: string;
  readonly publicId: string;
  readonly label: string;
}

export interface MachineKeyServiceOptions {
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly idFactory?: () => string;
}

export interface MachineKeyMutationOptions {
  readonly now?: () => Date;
  /** Internal owner services can emit their own domain Activity record. */
  readonly suppressActivity?: boolean;
}

function timestamp(factory: (() => Date) | undefined): string {
  const value = factory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid machine-key clock");
  return value.toISOString();
}

function labelValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    throw new TypeError("Machine-key label is invalid");
  if (Buffer.byteLength(value, "utf8") > 120 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new TypeError("Machine-key label is invalid");
  return value;
}

function tokenParts(
  value: unknown,
): { readonly publicId: string; readonly secret: string } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^tbk_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/.exec(value);
  if (match === null) return undefined;
  const publicId = match[1]!;
  const secret = match[2]!;
  try {
    const publicBytes = Buffer.from(publicId, "base64url");
    const secretBytes = Buffer.from(secret, "base64url");
    if (publicBytes.length !== PUBLIC_ID_BYTES || publicBytes.toString("base64url") !== publicId)
      return undefined;
    if (secretBytes.length !== SECRET_BYTES || secretBytes.toString("base64url") !== secret)
      return undefined;
  } catch {
    return undefined;
  }
  return { publicId, secret };
}

export const parseMachineKeyToken = tokenParts;

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "ascii").digest();
}

function descriptor(row: MachineKeyRow): MachineKeyDescriptor {
  return {
    id: row.id,
    publicId: row.publicId,
    label: row.label,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    replacementForId: row.replacementForId,
  };
}

export class MachineKeyService {
  readonly #database: DatabaseExecutor;
  readonly #options: MachineKeyServiceOptions;

  constructor(database: DatabaseExecutor, options: MachineKeyServiceOptions = {}) {
    this.#database = database;
    this.#options = options;
  }

  list(): readonly MachineKeyDescriptor[] {
    return listMachineKeyRows(this.#database).map(descriptor);
  }

  get(id: string): MachineKeyDescriptor | undefined {
    const row = readMachineKeyRow(this.#database, id);
    return row === undefined ? undefined : descriptor(row);
  }

  create(
    label: unknown,
    options: MachineKeyMutationOptions = {},
  ): { readonly token: string; readonly descriptor: MachineKeyDescriptor } {
    const normalizedLabel = labelValue(label);
    const random = this.#options.randomBytes ?? nodeRandomBytes;
    const publicBytes = random(PUBLIC_ID_BYTES);
    const secretBytes = random(SECRET_BYTES);
    if (
      !(publicBytes instanceof Uint8Array) ||
      !(secretBytes instanceof Uint8Array) ||
      publicBytes.byteLength !== PUBLIC_ID_BYTES ||
      secretBytes.byteLength !== SECRET_BYTES
    )
      throw new Error("Machine-key generation failed");
    const publicId = Buffer.from(publicBytes).toString("base64url");
    const secret = Buffer.from(secretBytes).toString("base64url");
    const token = `tbk_${publicId}_${secret}`;
    const now = timestamp(options.now ?? this.#options.now);
    const id = (this.#options.idFactory ?? randomUUID)();
    if (!UUID.test(id)) throw new Error("Machine-key generation failed");
    const row: MachineKeyRow = {
      id,
      publicId,
      verificationDigest: new Uint8Array(tokenDigest(token)),
      label: normalizedLabel,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      replacementForId: null,
    };
    this.#database.withTransaction(() => {
      if (!insertMachineKeyRow(this.#database, row))
        throw new Error("Machine-key generation failed");
      if (options.suppressActivity !== true) {
        appendActivity(this.#database, {
          category: "integration",
          action: "api_key_created",
          actorType: "system",
          entityType: "machine_api_key",
          entityId: row.id,
          occurredAt: now,
        });
      }
    });
    return { token, descriptor: descriptor(row) };
  }

  rotate(
    id: string,
    label?: unknown,
    options: MachineKeyMutationOptions = {},
  ): { readonly token: string; readonly descriptor: MachineKeyDescriptor } {
    const old = readMachineKeyRow(this.#database, id);
    if (old === undefined || old.revokedAt !== null) throw new Error("Machine-key rotation failed");
    const normalizedLabel = label === undefined ? old.label : labelValue(label);
    const random = this.#options.randomBytes ?? nodeRandomBytes;
    const publicBytes = random(PUBLIC_ID_BYTES);
    const secretBytes = random(SECRET_BYTES);
    if (
      !(publicBytes instanceof Uint8Array) ||
      !(secretBytes instanceof Uint8Array) ||
      publicBytes.byteLength !== PUBLIC_ID_BYTES ||
      secretBytes.byteLength !== SECRET_BYTES
    )
      throw new Error("Machine-key generation failed");
    const publicId = Buffer.from(publicBytes).toString("base64url");
    const secret = Buffer.from(secretBytes).toString("base64url");
    const token = `tbk_${publicId}_${secret}`;
    const now = timestamp(options.now ?? this.#options.now);
    const replacementId = (this.#options.idFactory ?? randomUUID)();
    if (!UUID.test(replacementId)) throw new Error("Machine-key generation failed");
    const replacement: MachineKeyRow = {
      id: replacementId,
      publicId,
      verificationDigest: new Uint8Array(tokenDigest(token)),
      label: normalizedLabel,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      replacementForId: old.id,
    };
    this.#database.withTransaction(() => {
      if (
        !revokeMachineKeyRow(this.#database, old.id, now) ||
        !insertMachineKeyRow(this.#database, replacement)
      )
        throw new Error("Machine-key rotation failed");
      if (options.suppressActivity !== true) {
        appendActivity(this.#database, {
          category: "integration",
          action: "api_key_rotated",
          actorType: "system",
          entityType: "machine_api_key",
          entityId: replacement.id,
          occurredAt: now,
        });
      }
    });
    return { token, descriptor: descriptor(replacement) };
  }

  revoke(id: string, options: MachineKeyMutationOptions = {}): boolean {
    const now = timestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const row = readMachineKeyRow(this.#database, id);
      if (row === undefined || row.revokedAt !== null) return false;
      const revoked = revokeMachineKeyRow(this.#database, id, now);
      if (revoked && options.suppressActivity !== true)
        appendActivity(this.#database, {
          category: "integration",
          action: "api_key_revoked",
          actorType: "system",
          entityType: "machine_api_key",
          entityId: id,
          occurredAt: now,
        });
      return revoked;
    });
  }

  verify(
    token: unknown,
    options: { readonly now?: () => Date } = {},
  ): MachineKeyVerification | undefined {
    const parsed = tokenParts(token);
    const candidateDigest = tokenDigest(
      typeof token === "string" && parsed !== undefined ? token : DUMMY_TOKEN,
    );
    const row =
      parsed === undefined ? undefined : readMachineKeyByPublicId(this.#database, parsed.publicId);
    const expectedDigest = row?.verificationDigest ?? new Uint8Array(tokenDigest(DUMMY_TOKEN));
    const matches = timingSafeEqual(candidateDigest, Buffer.from(expectedDigest));
    const now = timestamp(options.now ?? this.#options.now);
    if (!matches || row === undefined || row.revokedAt !== null) {
      return undefined;
    }
    if (
      row.lastUsedAt === null ||
      Date.parse(now) - Date.parse(row.lastUsedAt) >= TOUCH_INTERVAL_MS
    ) {
      touchMachineKeyRow(this.#database, row.id, row.lastUsedAt, now);
    }
    return { id: row.id, publicId: row.publicId, label: row.label };
  }

  verifyToken(token: unknown, options: { readonly now?: () => Date } = {}): boolean {
    return this.verify(token, options) !== undefined;
  }
}

export function createMachineKeyService(
  database: DatabaseExecutor,
  options?: MachineKeyServiceOptions,
): MachineKeyService {
  return new MachineKeyService(database, options);
}
