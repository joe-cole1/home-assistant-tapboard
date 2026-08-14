import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/infrastructure/database/connection.ts";
import {
  createMachineKeyService,
  parseMachineKeyToken,
} from "../src/features/machine-keys/index.ts";

void test("machine keys are canonical, shown once, and stored as digests", () => {
  const database = openDatabase(":memory:");
  const service = createMachineKeyService(database, {
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  const created = service.create("Telemetry client");
  assert.match(created.token, /^tbk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseMachineKeyToken(created.token)?.publicId, created.descriptor.publicId);
  assert.equal(service.verifyToken(created.token), true);
  assert.equal(service.verifyToken(`${created.token}x`), false);
  assert.equal(JSON.stringify(service.list()).includes(created.token), false);
  const raw = database.prepare<[], Record<string, unknown>>("SELECT * FROM machine_api_keys").get();
  assert.ok(raw);
  assert.equal(JSON.stringify(raw).includes(created.token), false);
  assert.throws(() => service.create(" label"));
  assert.throws(() => service.create("label\n"));
});

void test("rotation revokes old key and verification touches at most every five minutes", () => {
  const database = openDatabase(":memory:");
  let now = new Date("2026-08-13T12:00:00.000Z");
  const service = createMachineKeyService(database, { now: () => now });
  const first = service.create("client");
  assert.equal(service.verifyToken(first.token), true);
  const used = service.get(first.descriptor.id)?.lastUsedAt;
  assert.equal(used, now.toISOString());
  now = new Date("2026-08-13T12:02:00.000Z");
  assert.equal(service.verifyToken(first.token), true);
  assert.equal(service.get(first.descriptor.id)?.lastUsedAt, used);
  now = new Date("2026-08-13T12:06:00.000Z");
  assert.equal(service.verifyToken(first.token), true);
  assert.equal(service.get(first.descriptor.id)?.lastUsedAt, now.toISOString());
  const replacement = service.rotate(first.descriptor.id, "client rotated");
  assert.equal(service.verifyToken(first.token), false);
  assert.equal(service.verifyToken(replacement.token), true);
  assert.equal(service.get(replacement.descriptor.id)?.replacementForId, first.descriptor.id);
  assert.equal(service.revoke(replacement.descriptor.id), true);
  assert.equal(service.revoke(replacement.descriptor.id), false);
  assert.equal(service.verifyToken(replacement.token), false);
});
