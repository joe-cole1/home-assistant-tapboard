import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ApplicationError } from "../src/shared/errors.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  createSecretsService,
  decryptSecret,
  encryptSecret,
  parseRootKey,
} from "../src/features/secrets/index.ts";

const keyText = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");

void test("AES-GCM encrypt/decrypt uses fresh nonces and authenticates identity", () => {
  const key = parseRootKey(keyText(1));
  assert.ok(key);
  const identity = { integrationType: "ha", recordId: "one", fieldName: "token" };
  const first = encryptSecret("plaintext", key, identity);
  const second = encryptSecret("plaintext", key, identity);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.equal(decryptSecret(first, key, identity), "plaintext");
  assert.throws(() =>
    decryptSecret({ ...first, authTag: new Uint8Array(first.authTag).fill(3) }, key, identity),
  );
  assert.throws(() => decryptSecret(first, key, { ...identity, recordId: "other" }));
  assert.throws(() => parseRootKey(""));
  assert.equal(parseRootKey(undefined), undefined);
});

void test("secret descriptors stay plaintext-free and persist across restart", () => {
  const path = join(mkdtempSync("/tmp/tapboard-secrets-"), "secrets.sqlite3");
  const rootKey = keyText(2);
  const first = openDatabase(path);
  const service = createSecretsService(first, {
    rootKey,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  const descriptor = service.upsert("brewfather", "brewery-1", "api_token", "super-secret");
  assert.equal(JSON.stringify(descriptor).includes("super-secret"), false);
  assert.equal(service.revealPrivileged("brewfather", "brewery-1", "api_token"), "super-secret");
  const raw = first.prepare<[], Record<string, unknown>>("SELECT * FROM encrypted_secrets").get();
  assert.ok(raw);
  assert.equal(JSON.stringify(raw).includes("super-secret"), false);
  first.close();
  const second = openDatabase(path);
  assert.equal(
    createSecretsService(second, { rootKey }).revealPrivileged(
      "brewfather",
      "brewery-1",
      "api_token",
    ),
    "super-secret",
  );
  second.close();
});

void test("missing key leaves existing rows safe and rotation is atomic", () => {
  const database = openDatabase(":memory:");
  const oldKey = keyText(4);
  const newKey = keyText(5);
  const service = createSecretsService(database, {
    rootKey: oldKey,
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  service.upsert("ha", "one", "token", "one-secret");
  service.upsert("ha", "two", "token", "two-secret");
  const unavailable = createSecretsService(database);
  const wrong = createSecretsService(database, { rootKey: keyText(9) });
  assert.equal(unavailable.status().available, false);
  assert.equal(unavailable.list()[0]?.configured, true);
  assert.equal(unavailable.list()[0]?.available, false);
  assert.equal(wrong.status().available, false);
  assert.equal(wrong.list()[0]?.available, false);
  assert.throws(() => wrong.upsert("ha", "three", "token", "must-not-write"));
  assert.equal(wrong.list().length, 2);
  assert.throws(() => unavailable.revealPrivileged("ha", "one", "token"));
  const rotated = service.rotateRootKey(oldKey, newKey);
  assert.equal(rotated.rotated, 2);
  assert.equal(service.revealPrivileged("ha", "one", "token"), "one-secret");
  assert.throws(() =>
    createSecretsService(database, { rootKey: oldKey }).revealPrivileged("ha", "one", "token"),
  );
  assert.equal(service.list()[0]?.revision, 2);
});

void test("rotation rolls back completely when any ciphertext is corrupted", () => {
  const database = openDatabase(":memory:");
  const oldKey = keyText(6);
  const newKey = keyText(7);
  const service = createSecretsService(database, { rootKey: oldKey });
  service.upsert("ha", "one", "token", "one-secret");
  service.upsert("ha", "two", "token", "two-secret");
  const before = database
    .prepare<[], { readonly generation: number }>(
      "SELECT generation FROM secret_rotation_state WHERE id = 1",
    )
    .get()?.generation;
  database
    .prepare<[Buffer]>("UPDATE encrypted_secrets SET ciphertext = ? WHERE record_id = 'two'")
    .run(Buffer.from([1]));
  assert.throws(() => service.rotateRootKey(oldKey, newKey));
  assert.equal(
    database
      .prepare<[], { readonly generation: number }>(
        "SELECT generation FROM secret_rotation_state WHERE id = 1",
      )
      .get()?.generation,
    before,
  );
  assert.equal(
    database
      .prepare<[], { readonly revision: number }>(
        "SELECT revision FROM encrypted_secrets WHERE record_id = 'one'",
      )
      .get()?.revision,
    1,
  );
});

void test("credential failures are actionable typed errors and preserve encrypted rows", () => {
  const database = openDatabase(":memory:");
  const service = createSecretsService(database, { rootKey: keyText(10) });
  service.upsert("brewfather", "one", "api_token", "private-credential");
  const snapshot = () => database.prepare("SELECT * FROM encrypted_secrets").all();
  const before = snapshot();
  const missing = createSecretsService(database);
  const wrong = createSecretsService(database, { rootKey: keyText(11) });
  const check =
    (code: string) =>
    (error: unknown): boolean => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.category, "unavailable");
      assert.equal(error.code, code);
      assert.equal(error.message.includes("private-credential"), false);
      return true;
    };
  assert.throws(
    () => missing.upsert("brewfather", "one", "api_token", "replacement"),
    check("secrets.key_missing"),
  );
  assert.throws(
    () => missing.remove("brewfather", "one", "api_token"),
    check("secrets.key_missing"),
  );
  assert.throws(
    () => missing.revealPrivileged("brewfather", "one", "api_token"),
    check("secrets.key_missing"),
  );
  assert.throws(
    () => wrong.upsert("brewfather", "one", "api_token", "replacement"),
    check("secrets.key_unusable"),
  );
  assert.throws(
    () => wrong.remove("brewfather", "one", "api_token"),
    check("secrets.key_unusable"),
  );
  assert.deepEqual(snapshot(), before);
  assert.throws(
    () => service.revealPrivileged("brewfather", "absent", "api_token"),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.code, "secrets.not_found");
      assert.equal(error.category, "not_found");
      return true;
    },
  );
  database.close();
});

void test("a concurrent credential write reports a conflict without replacing the row", () => {
  const database = openDatabase(":memory:");
  const rootKey = keyText(12);
  createSecretsService(database, { rootKey }).upsert("ha", "one", "token", "original");
  const service = createSecretsService(database, {
    rootKey,
    randomBytes: (size) => {
      database
        .prepare("UPDATE encrypted_secrets SET revision = revision + 1 WHERE record_id = 'one'")
        .run();
      return new Uint8Array(size).fill(1);
    },
  });
  assert.throws(
    () => service.upsert("ha", "one", "token", "replacement"),
    (error: unknown) => {
      assert.ok(error instanceof ApplicationError);
      assert.equal(error.category, "conflict");
      assert.equal(error.code, "secrets.conflict");
      assert.match(error.clientMessage, /retry/);
      return true;
    },
  );
  assert.equal(service.revealPrivileged("ha", "one", "token"), "original");
  assert.equal(service.list()[0]?.revision, 2);
  database.close();
});
