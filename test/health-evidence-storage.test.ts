import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { ApplicationError } from "../src/shared/errors.ts";
import {
  seedHealthCheckStates,
  insertHealthIncident,
  readHealthCheckState,
  readHealthIncident,
  listHealthIncidentTransitions,
} from "../src/features/health/repository.ts";

const iso = "2026-08-01T12:00:00.000Z";
const invalidValues = [
  "{private_marker",
  "[]",
  "null",
  "42",
  "true",
  '"private_marker"',
  '{"private_marker":"secret"}',
  '{"reason":{}}',
  JSON.stringify({ reason: "x".repeat(121) }),
  '{"reason":"\\u0000"}',
  '{"ageMs":1e999}',
  " ".repeat(2047) + "{}",
  JSON.stringify(
    Object.fromEntries(
      [
        "reason",
        "phase",
        "diagnosticCode",
        "measurementAgeMs",
        "authorityAgeMs",
        "unavailableAgeMs",
      ].map((key) => [key, "界".repeat(120)]),
    ),
  ),
  Buffer.from("{}"),
];

function fixture(raw: string | Buffer) {
  const database = openDatabase(":memory:");
  try {
    const tap = createTapService(database, {
      idFactory: () => "00000000-0000-4000-8000-000000000001",
    }).createTap({ tapNumber: 1, name: "Cellar" });
    seedHealthCheckStates(database, tap.id, iso);
    insertHealthIncident(database, {
      id: "00000000-0000-4000-8000-000000000002",
      tapId: tap.id,
      checkId: "low_keg",
      openedAtMs: Date.parse(iso),
      severity: "warning",
      reason: "below_threshold",
      evidence: {},
      updatedAt: iso,
    });
    const oversized = Buffer.byteLength(raw, "utf8") > 2048;
    if (oversized) database.execute("PRAGMA ignore_check_constraints=ON");
    try {
      database
        .prepare(
          "UPDATE health_check_state SET evidence_json=? WHERE tap_id=? AND check_id='low_keg'",
        )
        .run(raw, tap.id);
      database
        .prepare(
          "UPDATE health_incidents SET open_evidence_json=? WHERE id='00000000-0000-4000-8000-000000000002'",
        )
        .run(raw);
      database
        .prepare(
          "INSERT INTO health_incident_transitions (id,incident_id,transition_kind,state,severity,reason_code,evidence_json,occurred_at,created_at) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','opened','active','warning','below_threshold',?,?,?)",
        )
        .run(raw, iso, iso);
    } finally {
      if (oversized) database.execute("PRAGMA ignore_check_constraints=OFF");
    }
    return { database, tap };
  } catch (error) {
    database.close();
    throw error;
  }
}

for (const [index, raw] of invalidValues.entries()) {
  void test(`stored evidence corruption ${index} fails safely in every reader`, () => {
    const { database, tap } = fixture(raw);
    try {
      for (const read of [
        () => readHealthCheckState(database, tap.id, "low_keg"),
        () => readHealthIncident(database, "00000000-0000-4000-8000-000000000002"),
        () => listHealthIncidentTransitions(database, "00000000-0000-4000-8000-000000000002"),
      ]) {
        assert.throws(read, (error: unknown) => {
          assert.ok(error instanceof ApplicationError);
          assert.equal(error.category, "internal");
          assert.equal(error.code, "health.invalid_stored_evidence");
          assert.equal(error.clientMessage, "Stored health evidence is invalid.");
          assert.equal(error.details, undefined);
          assert.equal(error.cause, undefined);
          return true;
        });
      }
    } finally {
      database.close();
    }
  });
}
for (const evidence of [
  {},
  { reason: "generated", ageMs: 42, phase: true, diagnosticCode: null },
]) {
  void test(`stored valid evidence roundtrips ${JSON.stringify(evidence)}`, () => {
    const { database, tap } = fixture(JSON.stringify(evidence));
    try {
      assert.deepEqual(readHealthCheckState(database, tap.id, "low_keg")?.evidence, evidence);
      assert.deepEqual(
        readHealthIncident(database, "00000000-0000-4000-8000-000000000002")?.openEvidence,
        evidence,
      );
      assert.deepEqual(
        listHealthIncidentTransitions(database, "00000000-0000-4000-8000-000000000002")[0]
          ?.evidence,
        evidence,
      );
    } finally {
      database.close();
    }
  });
}

void test("stored evidence accepts exactly 2048 UTF8 bytes in every reader", () => {
  const raw = " ".repeat(2046) + "{}";
  assert.equal(Buffer.byteLength(raw, "utf8"), 2048);
  const { database, tap } = fixture(raw);
  try {
    assert.deepEqual(readHealthCheckState(database, tap.id, "low_keg")?.evidence, {});
    assert.deepEqual(
      readHealthIncident(database, "00000000-0000-4000-8000-000000000002")?.openEvidence,
      {},
    );
    assert.deepEqual(
      listHealthIncidentTransitions(database, "00000000-0000-4000-8000-000000000002")[0]?.evidence,
      {},
    );
  } finally {
    database.close();
  }
});
