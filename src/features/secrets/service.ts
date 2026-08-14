import { randomUUID } from "node:crypto";

import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { appendActivity } from "../activity/operations.ts";
import {
  decryptSecret,
  encryptSecret,
  parseRootKey,
  validateSecretIdentity,
  type SecretEnvelope,
  type SecretIdentity,
} from "./crypto.ts";
import {
  deleteSecretRow,
  insertSecretRow,
  listSecretRows,
  readRotationState,
  readSecretRow,
  updateRotationState,
  updateSecretRow,
  type SecretRow,
} from "./repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SecretDescriptor {
  readonly id: string;
  readonly integrationType: string;
  readonly recordId: string;
  readonly fieldName: string;
  readonly revision: number;
  readonly configured: boolean;
  readonly available: boolean;
}

export interface SecretsServiceOptions {
  readonly rootKey?: unknown;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly idFactory?: () => string;
}

export interface SecretRotationResult {
  readonly generation: number;
  readonly rotated: number;
}

function nowTimestamp(factory: (() => Date) | undefined): string {
  const value = factory?.() ?? new Date();
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError("Invalid secret clock");
  return value.toISOString();
}

function identity(integrationType: string, recordId: string, fieldName: string): SecretIdentity {
  return validateSecretIdentity({ integrationType, recordId, fieldName });
}

function rowEnvelope(row: SecretRow): SecretEnvelope {
  return {
    envelopeVersion: row.envelopeVersion,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
  };
}

function descriptor(row: SecretRow, configured: boolean): SecretDescriptor {
  return {
    id: row.id,
    integrationType: row.integrationType,
    recordId: row.recordId,
    fieldName: row.fieldName,
    revision: row.revision,
    configured: true,
    available: configured,
  };
}

export class SecretsService {
  readonly #database: DatabaseExecutor;
  readonly #options: SecretsServiceOptions;
  #rootKey: Uint8Array | undefined;

  constructor(database: DatabaseExecutor, options: SecretsServiceOptions = {}) {
    this.#database = database;
    this.#options = options;
    this.#rootKey = parseRootKey(options.rootKey);
  }

  status(): { readonly configured: boolean; readonly count: number; readonly available: boolean } {
    const rows = listSecretRows(this.#database);
    return {
      configured: this.#rootKey !== undefined,
      count: rows.length,
      available:
        this.#rootKey !== undefined && rows.every((row) => this.#canDecrypt(row, this.#rootKey!)),
    };
  }

  list(): readonly SecretDescriptor[] {
    return listSecretRows(this.#database).map((row) =>
      descriptor(row, this.#rootKey !== undefined && this.#canDecrypt(row, this.#rootKey)),
    );
  }

  listDescriptors(): readonly SecretDescriptor[] {
    return this.list();
  }

  upsert(
    integrationType: string,
    recordId: string,
    fieldName: string,
    plaintext: unknown,
    options: { readonly now?: () => Date } = {},
  ): SecretDescriptor {
    if (this.#rootKey === undefined) throw new Error("Secret storage is unavailable");
    this.#requireUsableRootKey();
    const secretIdentity = identity(integrationType, recordId, fieldName);
    const now = nowTimestamp(options.now ?? this.#options.now);
    const current = readSecretRow(
      this.#database,
      secretIdentity.integrationType,
      secretIdentity.recordId,
      secretIdentity.fieldName,
    );
    const envelope = encryptSecret(
      plaintext,
      this.#rootKey,
      secretIdentity,
      this.#options.randomBytes === undefined ? {} : { randomBytes: this.#options.randomBytes },
    );
    const id = current?.id ?? (this.#options.idFactory ?? randomUUID)();
    if (!UUID.test(id)) throw new Error("Secret storage is unavailable");
    const row: SecretRow = {
      id,
      ...secretIdentity,
      envelopeVersion: 1,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      authTag: envelope.authTag,
      revision: current === undefined ? 1 : current.revision + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.#database.withTransaction(() => {
      const latest = readSecretRow(
        this.#database,
        secretIdentity.integrationType,
        secretIdentity.recordId,
        secretIdentity.fieldName,
      );
      const accepted =
        current === undefined
          ? latest === undefined && insertSecretRow(this.#database, row)
          : latest !== undefined &&
            latest.id === current.id &&
            latest.revision === current.revision &&
            updateSecretRow(this.#database, row, current.revision);
      if (!accepted) throw new Error("Secret changed concurrently");
      appendActivity(this.#database, {
        category: "integration",
        action: "secret_configured",
        actorType: "system",
        entityType: "secret",
        entityId: row.id,
        occurredAt: now,
      });
    });
    return descriptor(row, true);
  }

  remove(
    integrationType: string,
    recordId: string,
    fieldName: string,
    options: { readonly now?: () => Date } = {},
  ): boolean {
    if (this.#rootKey === undefined) throw new Error("Secret storage is unavailable");
    this.#requireUsableRootKey();
    const secretIdentity = identity(integrationType, recordId, fieldName);
    const now = nowTimestamp(options.now ?? this.#options.now);
    return this.#database.withTransaction(() => {
      const existing = readSecretRow(
        this.#database,
        secretIdentity.integrationType,
        secretIdentity.recordId,
        secretIdentity.fieldName,
      );
      if (existing === undefined) return false;
      const removed = deleteSecretRow(
        this.#database,
        secretIdentity.integrationType,
        secretIdentity.recordId,
        secretIdentity.fieldName,
      );
      if (removed) {
        appendActivity(this.#database, {
          category: "integration",
          action: "secret_removed",
          actorType: "system",
          entityType: "secret",
          entityId: existing.id,
          occurredAt: now,
        });
      }
      return removed;
    });
  }

  /** Privileged adapter boundary: the only API that may return decrypted plaintext. */
  revealPrivileged(integrationType: string, recordId: string, fieldName: string): string {
    if (this.#rootKey === undefined) throw new Error("Secret storage is unavailable");
    const secretIdentity = identity(integrationType, recordId, fieldName);
    const row = readSecretRow(
      this.#database,
      secretIdentity.integrationType,
      secretIdentity.recordId,
      secretIdentity.fieldName,
    );
    if (row === undefined) throw new Error("Secret was not found");
    return decryptSecret(rowEnvelope(row), this.#rootKey, secretIdentity);
  }

  revealSecretPrivileged(integrationType: string, recordId: string, fieldName: string): string {
    return this.revealPrivileged(integrationType, recordId, fieldName);
  }

  rotateRootKey(
    oldKeyInput: unknown,
    newKeyInput: unknown,
    options: { readonly now?: () => Date } = {},
  ): SecretRotationResult {
    const oldKey = parseRootKey(oldKeyInput);
    const newKey = parseRootKey(newKeyInput);
    if (oldKey === undefined || newKey === undefined)
      throw new Error("Secret rotation is unavailable");
    const snapshotGeneration = readRotationState(this.#database).generation;
    const snapshot = listSecretRows(this.#database);
    const candidates: SecretRow[] = [];
    const now = nowTimestamp(options.now ?? this.#options.now);
    for (const row of snapshot) {
      const secretIdentity = identity(row.integrationType, row.recordId, row.fieldName);
      const plaintext = decryptSecret(rowEnvelope(row), oldKey, secretIdentity);
      const envelope = encryptSecret(
        plaintext,
        newKey,
        secretIdentity,
        this.#options.randomBytes === undefined ? {} : { randomBytes: this.#options.randomBytes },
      );
      if (decryptSecret(envelope, newKey, secretIdentity) !== plaintext)
        throw new Error("Secret rotation failed");
      candidates.push({
        ...row,
        ...envelope,
        revision: row.revision + 1,
        updatedAt: now,
      });
    }
    this.#database.withTransaction(() => {
      if (readRotationState(this.#database).generation !== snapshotGeneration)
        throw new Error("Secret rotation changed concurrently");
      const latest = listSecretRows(this.#database);
      if (
        latest.length !== snapshot.length ||
        latest.some((row, index) => {
          const expected = snapshot[index];
          return (
            expected === undefined ||
            row.id !== expected.id ||
            row.revision !== expected.revision ||
            row.integrationType !== expected.integrationType ||
            row.recordId !== expected.recordId ||
            row.fieldName !== expected.fieldName ||
            row.createdAt !== expected.createdAt ||
            row.updatedAt !== expected.updatedAt ||
            !Buffer.from(row.nonce).equals(Buffer.from(expected.nonce)) ||
            !Buffer.from(row.ciphertext).equals(Buffer.from(expected.ciphertext)) ||
            !Buffer.from(row.authTag).equals(Buffer.from(expected.authTag))
          );
        })
      )
        throw new Error("Secret rotation changed concurrently");
      for (const row of candidates) {
        if (!updateSecretRow(this.#database, row, row.revision - 1))
          throw new Error("Secret rotation changed concurrently");
      }
      if (!updateRotationState(this.#database, snapshotGeneration, now))
        throw new Error("Secret rotation changed concurrently");
      appendActivity(this.#database, {
        category: "integration",
        action: "secret_rotation_completed",
        actorType: "system",
        occurredAt: now,
      });
    });
    this.#rootKey = new Uint8Array(newKey);
    return { generation: snapshotGeneration + 1, rotated: candidates.length };
  }

  rotate(
    oldKeyInput: unknown,
    newKeyInput: unknown,
    options?: { readonly now?: () => Date },
  ): SecretRotationResult {
    return this.rotateRootKey(oldKeyInput, newKeyInput, options);
  }

  #canDecrypt(row: SecretRow, key: Uint8Array): boolean {
    try {
      decryptSecret(
        rowEnvelope(row),
        key,
        identity(row.integrationType, row.recordId, row.fieldName),
      );
      return true;
    } catch {
      return false;
    }
  }

  #requireUsableRootKey(): void {
    const key = this.#rootKey;
    if (
      key === undefined ||
      !listSecretRows(this.#database).every((row) => this.#canDecrypt(row, key))
    ) {
      throw new Error("Secret storage is unavailable");
    }
  }
}

export function createSecretsService(
  database: DatabaseExecutor,
  options?: SecretsServiceOptions,
): SecretsService {
  return new SecretsService(database, options);
}
