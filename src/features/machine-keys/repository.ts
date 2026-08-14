import type { DatabaseExecutor } from "../../infrastructure/database/connection.ts";

export interface MachineKeyRow {
  readonly id: string;
  readonly publicId: string;
  readonly verificationDigest: Uint8Array;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly replacementForId: string | null;
}

interface RawMachineKeyRow {
  readonly id: string;
  readonly public_id: string;
  readonly verification_digest: Buffer;
  readonly label: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly replacement_for_id: string | null;
}

function timestamp(value: string | null): boolean {
  if (value === null) return true;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function mapRow(row: RawMachineKeyRow): MachineKeyRow {
  let publicCanonical = false;
  try {
    const decoded = Buffer.from(row.public_id, "base64url");
    publicCanonical = decoded.byteLength === 12 && decoded.toString("base64url") === row.public_id;
  } catch {
    publicCanonical = false;
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) ||
    !/^[A-Za-z0-9_-]{16}$/.test(row.public_id) ||
    !publicCanonical ||
    row.verification_digest.byteLength !== 32 ||
    Buffer.byteLength(row.label, "utf8") < 1 ||
    Buffer.byteLength(row.label, "utf8") > 120 ||
    row.label.trim() !== row.label ||
    /[\u0000-\u001f\u007f]/u.test(row.label) ||
    !timestamp(row.created_at) ||
    !timestamp(row.last_used_at) ||
    !timestamp(row.revoked_at) ||
    (row.replacement_for_id !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        row.replacement_for_id,
      ))
  )
    throw new Error("Stored machine key is invalid");
  return {
    id: row.id,
    publicId: row.public_id,
    verificationDigest: new Uint8Array(row.verification_digest),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    replacementForId: row.replacement_for_id,
  };
}

const SELECT = `SELECT id, public_id, verification_digest, label, created_at,
                       last_used_at, revoked_at, replacement_for_id
                FROM machine_api_keys`;

export function listMachineKeyRows(database: DatabaseExecutor): MachineKeyRow[] {
  return database
    .prepare<[], RawMachineKeyRow>(`${SELECT} ORDER BY created_at, id`)
    .all()
    .map(mapRow);
}

export function readMachineKeyRow(
  database: DatabaseExecutor,
  id: string,
): MachineKeyRow | undefined {
  const row = database.prepare<[string], RawMachineKeyRow>(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? undefined : mapRow(row);
}

export function readMachineKeyByPublicId(
  database: DatabaseExecutor,
  publicId: string,
): MachineKeyRow | undefined {
  const row = database
    .prepare<[string], RawMachineKeyRow>(`${SELECT} WHERE public_id = ?`)
    .get(publicId);
  return row === undefined ? undefined : mapRow(row);
}

export function insertMachineKeyRow(database: DatabaseExecutor, row: MachineKeyRow): boolean {
  return (
    database
      .prepare<
        [string, string, Buffer, string, string, string | null, string | null, string | null]
      >(
        `INSERT INTO machine_api_keys
     (id, public_id, verification_digest, label, created_at, last_used_at, revoked_at, replacement_for_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.publicId,
        Buffer.from(row.verificationDigest),
        row.label,
        row.createdAt,
        row.lastUsedAt,
        row.revokedAt,
        row.replacementForId,
      ).changes === 1
  );
}

export function revokeMachineKeyRow(
  database: DatabaseExecutor,
  id: string,
  revokedAt: string,
): boolean {
  return (
    database
      .prepare<[string, string]>(
        `UPDATE machine_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, id).changes === 1
  );
}

export function touchMachineKeyRow(
  database: DatabaseExecutor,
  id: string,
  expectedLastUsedAt: string | null,
  lastUsedAt: string,
): boolean {
  return (
    database
      .prepare<[string, string, string | null, string]>(
        `UPDATE machine_api_keys SET last_used_at = ?
     WHERE id = ? AND revoked_at IS NULL
       AND (last_used_at IS ? OR last_used_at = ?)`,
      )
      .run(lastUsedAt, id, expectedLastUsedAt, expectedLastUsedAt ?? "").changes === 1
  );
}
