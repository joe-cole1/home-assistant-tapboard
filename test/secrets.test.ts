import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
