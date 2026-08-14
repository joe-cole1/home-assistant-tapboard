import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";
import { validateSecretIdentity, type SecretEnvelope } from "./crypto.ts";

export interface SecretRow extends SecretEnvelope {
  readonly id: string;
  readonly integrationType: string;
  readonly recordId: string;
  readonly fieldName: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SecretRotationState {
  readonly generation: number;
  readonly updatedAt: string;
}

interface RawSecretRow {
  readonly id: string;
  readonly integration_type: string;
  readonly record_id: string;
  readonly field_name: string;
  readonly envelope_version: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly auth_tag: Buffer;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RawRotationState {
  readonly generation: number;
  readonly updated_at: string;
}

function canonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function mapSecret(row: RawSecretRow): SecretRow {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id)) {
    throw new Error("Stored secret envelope is invalid");
  }
  validateSecretIdentity({
    integrationType: row.integration_type,
    recordId: row.record_id,
    fieldName: row.field_name,
  });
  if (
    row.envelope_version !== 1 ||
    row.nonce.byteLength !== 12 ||
    row.auth_tag.byteLength !== 16 ||
    row.ciphertext.byteLength < 1 ||
    row.ciphertext.byteLength > 16_384 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !canonicalTimestamp(row.created_at) ||
    !canonicalTimestamp(row.updated_at)
  )
    throw new Error("Stored secret envelope is invalid");
  return {
    id: row.id,
    integrationType: row.integration_type,
    recordId: row.record_id,
    fieldName: row.field_name,
    envelopeVersion: 1,
    nonce: new Uint8Array(row.nonce),
    ciphertext: new Uint8Array(row.ciphertext),
    authTag: new Uint8Array(row.auth_tag),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSecretRows(database: DatabaseExecutor): SecretRow[] {
  return database
    .prepare<[], RawSecretRow>(
      `SELECT id, integration_type, record_id, field_name, envelope_version,
              nonce, ciphertext, auth_tag, revision, created_at, updated_at
       FROM encrypted_secrets
       ORDER BY integration_type, record_id, field_name, id`,
    )
    .all()
    .map(mapSecret);
}

export function readSecretRow(
  database: DatabaseExecutor,
  integrationType: string,
  recordId: string,
  fieldName: string,
): SecretRow | undefined {
  const row = database
    .prepare<[string, string, string], RawSecretRow>(
      `SELECT id, integration_type, record_id, field_name, envelope_version,
              nonce, ciphertext, auth_tag, revision, created_at, updated_at
       FROM encrypted_secrets
       WHERE integration_type = ? AND record_id = ? AND field_name = ?`,
    )
    .get(integrationType, recordId, fieldName);
  return row === undefined ? undefined : mapSecret(row);
}

export function insertSecretRow(database: DatabaseExecutor, row: SecretRow): boolean {
  const result = database
    .prepare<
      [string, string, string, string, number, Buffer, Buffer, Buffer, number, string, string]
    >(
      `INSERT INTO encrypted_secrets
       (id, integration_type, record_id, field_name, envelope_version,
        nonce, ciphertext, auth_tag, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.integrationType,
      row.recordId,
      row.fieldName,
      row.envelopeVersion,
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.authTag),
      row.revision,
      row.createdAt,
      row.updatedAt,
    );
  return result.changes === 1;
}

export function updateSecretRow(
  database: DatabaseExecutor,
  row: SecretRow,
  expectedRevision: number,
): boolean {
  const result = database
    .prepare<
      [number, Buffer, Buffer, Buffer, number, string, string, string, string, string, number]
    >(
      `UPDATE encrypted_secrets
       SET envelope_version = ?, nonce = ?, ciphertext = ?, auth_tag = ?,
           revision = ?, updated_at = ?
       WHERE id = ? AND integration_type = ? AND record_id = ? AND field_name = ?
         AND revision = ?`,
    )
    .run(
      row.envelopeVersion,
      Buffer.from(row.nonce),
      Buffer.from(row.ciphertext),
      Buffer.from(row.authTag),
      row.revision,
      row.updatedAt,
      row.id,
      row.integrationType,
      row.recordId,
      row.fieldName,
      expectedRevision,
    );
  return result.changes === 1;
}

export function deleteSecretRow(
  database: DatabaseExecutor,
  integrationType: string,
  recordId: string,
  fieldName: string,
): boolean {
  return (
    database
      .prepare<[string, string, string]>(
        `DELETE FROM encrypted_secrets
       WHERE integration_type = ? AND record_id = ? AND field_name = ?`,
      )
      .run(integrationType, recordId, fieldName).changes === 1
  );
}

export function readRotationState(database: DatabaseExecutor): SecretRotationState {
  const row = database
    .prepare<[], RawRotationState>(
      `SELECT generation, updated_at FROM secret_rotation_state WHERE id = 1`,
    )
    .get();
  if (
    row === undefined ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 0 ||
    !canonicalTimestamp(row.updated_at)
  ) {
    throw new Error("Secret rotation state is invalid");
  }
  return { generation: row.generation, updatedAt: row.updated_at };
}

export function updateRotationState(
  database: DatabaseExecutor,
  expectedGeneration: number,
  updatedAt: string,
): boolean {
  return (
    database
      .prepare<[string, number]>(
        `UPDATE secret_rotation_state
     SET generation = generation + 1, updated_at = ?
     WHERE id = 1 AND generation = ?`,
      )
      .run(updatedAt, expectedGeneration).changes === 1
  );
}
