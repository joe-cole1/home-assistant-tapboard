import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeJson } from "../src/shared/canonical-json.ts";

void test("canonical JSON sorts keys and counts UTF-8 bytes", () => {
  assert.equal(canonicalizeJson({ z: 1, a: "é" }), '{"a":"é","z":1}');
  assert.equal(Buffer.byteLength(canonicalizeJson({ value: "é" }), "utf8"), 14);
});

void test("canonical JSON rejects unsupported and secret-bearing values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson(cyclic), /cyclic/i);
  assert.throws(() => canonicalizeJson({ api_key: "hidden" }), /secret/i);
  assert.throws(() => canonicalizeJson([, 1]), /hole/i);
  assert.throws(() => canonicalizeJson({ nested: { value: 1 } }, { maxDepth: 0 }), /depth/i);
  assert.throws(() => canonicalizeJson({ value: "é" }, { maxBytes: 13 }), /byte/i);
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /finite/i);
});
