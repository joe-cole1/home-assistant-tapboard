import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { test } from "node:test";

import { createAuthService } from "../src/features/auth/service.ts";
import { createMachineKeyService } from "../src/features/machine-keys/service.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import {
  MAX_BATCH_JSON_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
} from "../src/infrastructure/http/security/body.ts";
import { createLogger } from "../src/shared/logging.ts";
import { createTapService } from "../src/features/taps/service.ts";
import { registerTelemetryRoutes } from "../src/features/telemetry/routes.ts";
import { DetectorService } from "../src/features/telemetry/detector-service.ts";
import { TelemetryService } from "../src/features/telemetry/service.ts";

const CANONICAL_ORIGIN = "http://127.0.0.1:3000";
const quietLogger = createLogger({ sink: () => undefined });

interface JsonResponse {
  readonly response: Response;
  readonly body: unknown;
}

type OpenApiObject = Readonly<Record<string, unknown>>;

async function readJsonResponse(response: Response): Promise<JsonResponse> {
  const text = await response.text();
  if (text.length === 0) return { response, body: undefined };
  return { response, body: JSON.parse(text) as unknown };
}

function postChunked(
  port: number,
  path: string,
  headers: Record<string, string>,
  chunks: readonly string[],
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...headers,
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        const body: Buffer[] = [];
        response.on("data", (chunk: Buffer) => body.push(chunk));
        response.on("end", () => {
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(body).toString() });
        });
      },
    );
    request.setTimeout(3_000, () => request.destroy(new Error("chunked body test timed out")));
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function postWithAgent(
  agent: Agent,
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ readonly statusCode: number; readonly localPort: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        agent,
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            localPort: request.socket?.localPort,
          });
        });
      },
    );
    request.setTimeout(3_000, () => request.destroy(new Error("keep-alive body test timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

void test("telemetry HTTP is Bearer-only, strict, and maps durable outcomes", async (context) => {
  let now = new Date("2026-08-14T12:00:00.000Z");
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, {
    canonicalOrigin: CANONICAL_ORIGIN,
    now: () => now,
  });
  const machineKeyService = createMachineKeyService(database, { now: () => now });
  const tapService = createTapService(database, { now: () => now });
  const telemetryService = new TelemetryService({
    database,
    machineKeyService,
    clock: () => now,
  });
  const router = new Router(quietLogger);
  registerTelemetryRoutes({
    router,
    telemetryService,
    detectorService: new DetectorService(database),
    authService,
  });
  const server = new HttpServer({ router, logger: quietLogger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.equal(login.authenticated, true);
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const cookie = `tapboard_admin_session=${login.session}`;
  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const tap1 = tapService.createTap({ tapNumber: 1, name: "Machine Tap 1" });

  // Admin mutation routes never accept a machine/Bearer credential and require cookie + CSRF + origin.
  const noCsrf = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/sources`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP Source" }),
    }),
  );
  assert.equal(noCsrf.response.status, 401);
  const bearerAdmin = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/sources`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${login.session}`,
        origin: CANONICAL_ORIGIN,
        "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "HTTP Source" }),
    }),
  );
  assert.equal(bearerAdmin.response.status, 401);
  const wrongOrigin = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/sources`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://evil.example",
        "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "HTTP Source" }),
    }),
  );
  assert.equal(wrongOrigin.response.status, 401);

  const sourceCreation = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/sources`, {
      method: "POST",
      headers: {
        cookie,
        origin: CANONICAL_ORIGIN,
        "x-csrf-token": login.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "HTTP Source" }),
    }),
  );
  assert.equal(sourceCreation.response.status, 201);
  const created = sourceCreation.body as {
    readonly source: { readonly id: string; readonly currentMachineKeyId: string };
    readonly initialToken: string;
  };
  assert.match(created.initialToken, /^tbk_/);
  assert.equal("initialToken" in created.source, false);

  const source = telemetryService.getSourceById(created.source.id);
  assert.ok(source);
  telemetryService.setTapAuthority(tap1.id, { sourceId: source.id });

  const sourceList = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/sources`, { headers: { cookie } }),
  );
  assert.equal(sourceList.response.status, 200);
  assert.doesNotMatch(JSON.stringify(sourceList.body), new RegExp(created.initialToken));

  const singleHeaders = {
    authorization: `Bearer ${created.initialToken}`,
    "content-type": "application/json",
  } as const;
  const validBody = {
    client_sample_id: "http-sample-1",
    measured_at: "2026-08-14T12:00:00Z",
    measurement: { kind: "total_weight", value: 1_000, unit: "g" },
  } as const;

  const missingBearer = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }),
  );
  assert.equal(missingBearer.response.status, 401);
  const malformedBearer = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: { authorization: "Bearer", "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }),
  );
  assert.equal(malformedBearer.response.status, 401);
  const cookieIsNotTelemetryAuth = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(validBody),
    }),
  );
  assert.equal(cookieIsNotTelemetryAuth.response.status, 401);

  const genericKey = machineKeyService.create("unbound machine key");
  const unboundBearer = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${genericKey.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(validBody),
    }),
  );
  assert.equal(unboundBearer.response.status, 401);

  const malformedJson = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: singleHeaders,
      body: "not-json",
    }),
  );
  assert.equal(malformedJson.response.status, 400);
  const camelCase = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify({
        measuredAt: validBody.measured_at,
        measurement: validBody.measurement,
      }),
    }),
  );
  assert.equal(camelCase.response.status, 400);

  const accepted = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify(validBody),
    }),
  );
  assert.equal(accepted.response.status, 200);
  const acceptedBody = accepted.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(acceptedBody).sort(), [
    "accepted_measurement_id",
    "code",
    "duplicate",
    "outcome",
    "processed_at",
  ]);
  assert.equal(acceptedBody.outcome, "accepted");
  assert.equal(acceptedBody.duplicate, false);

  const semanticDuplicate = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify({
        ...validBody,
        measurement: { kind: "total_weight", value: 1, unit: "kg" },
      }),
    }),
  );
  assert.equal(semanticDuplicate.response.status, 200);
  assert.equal((semanticDuplicate.body as Record<string, unknown>).duplicate, true);

  const conflict = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify({
        ...validBody,
        measurement: { kind: "total_weight", value: 2_000, unit: "g" },
      }),
    }),
  );
  assert.equal(conflict.response.status, 409);
  assert.equal((conflict.body as Record<string, unknown>).code, "telemetry.idempotency_conflict");

  const nonexistentTap = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/99`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify({
        ...validBody,
        client_sample_id: "missing-tap",
      }),
    }),
  );
  assert.equal(nonexistentTap.response.status, 404);

  const retiredTap = tapService.createTap({ tapNumber: 2, name: "Retired Machine Tap" });
  telemetryService.setTapAuthority(retiredTap.id, { sourceId: source.id });
  tapService.retireTap(retiredTap.id);
  now = new Date("2026-08-14T12:00:01.000Z");
  const retired = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/2`, {
      method: "POST",
      headers: singleHeaders,
      body: JSON.stringify({
        client_sample_id: "retired-http",
        measured_at: "2026-08-14T12:00:01Z",
        measurement: { kind: "total_weight", value: 1_000, unit: "g" },
      }),
    }),
  );
  assert.equal(retired.response.status, 409);
  assert.equal((retired.body as Record<string, unknown>).code, "telemetry.tap_retired");

  const revokedSource = telemetryService.createSource({ name: "Revoked HTTP Source" });
  assert.equal(machineKeyService.revoke(revokedSource.source.currentMachineKeyId), true);
  const revoked = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${revokedSource.initialToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...validBody,
        client_sample_id: "revoked-token",
      }),
    }),
  );
  assert.equal(revoked.response.status, 401);
});

void test("telemetry HTTP body caps and batch outcomes use the documented statuses", async (context) => {
  let now = new Date("2026-08-14T12:00:00.000Z");
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, {
    canonicalOrigin: CANONICAL_ORIGIN,
    now: () => now,
  });
  const machineKeyService = createMachineKeyService(database, { now: () => now });
  const tapService = createTapService(database, { now: () => now });
  const telemetryService = new TelemetryService({ database, machineKeyService, clock: () => now });
  const router = new Router(quietLogger);
  registerTelemetryRoutes({
    router,
    telemetryService,
    detectorService: new DetectorService(database),
    authService,
  });
  const server = new HttpServer({ router, logger: quietLogger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  const tap = tapService.createTap({ tapNumber: 1, name: "Batch Tap" });
  const sourceResult = telemetryService.createSource({ name: "Batch HTTP Source" });
  telemetryService.setTapAuthority(tap.id, { sourceId: sourceResult.source.id });
  telemetryService.updateSettings({
    maxBatchSize: 2,
    rateLimitBurstSamples: 2,
    rateLimitSamplesPerMinute: 60,
  });
  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    authorization: `Bearer ${sourceResult.initialToken}`,
    "content-type": "application/json",
  } as const;

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  context.after(() => agent.destroy());
  const rejectedAuth = await postWithAgent(
    agent,
    address.port,
    "/api/v1/telemetry/taps/1",
    { "content-type": "application/json" },
    JSON.stringify({ measurement: { kind: "total_weight", value: 1_000, unit: "g" } }),
  );
  assert.equal(rejectedAuth.statusCode, 401);
  const declaredTooLarge = await postWithAgent(
    agent,
    address.port,
    "/api/v1/telemetry/taps/1",
    headers,
    "x".repeat(MAX_JSON_BODY_BYTES + 1),
  );
  assert.equal(declaredTooLarge.statusCode, 413);
  assert.equal(declaredTooLarge.localPort, rejectedAuth.localPort);
  const afterRejectedBodies = await postWithAgent(
    agent,
    address.port,
    "/api/v1/telemetry/taps/999",
    headers,
    JSON.stringify({
      measured_at: "2026-08-14T12:00:00Z",
      measurement: { kind: "total_weight", value: 1_000, unit: "g" },
    }),
  );
  assert.equal(afterRejectedBodies.statusCode, 404);
  assert.equal(afterRejectedBodies.localPort, rejectedAuth.localPort);

  const first = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_sample_id: "batch-existing",
        measured_at: "2026-08-14T12:00:00Z",
        measurement: { kind: "total_weight", value: 1_000, unit: "g" },
      }),
    }),
  );
  assert.equal(first.response.status, 200);
  now = new Date("2026-08-14T12:00:00.100Z");
  const second = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_sample_id: "batch-consume-second-token",
        measured_at: "2026-08-14T12:00:00.100Z",
        measurement: { kind: "total_weight", value: 1_100, unit: "g" },
      }),
    }),
  );
  assert.equal(second.response.status, 200);

  const batch = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        samples: [
          {
            tap_number: 1,
            client_sample_id: "batch-existing",
            measured_at: "2026-08-14T12:00:00Z",
            measurement: { kind: "total_weight", value: 1, unit: "kg" },
          },
          {
            tap_number: 1,
            client_sample_id: "batch-rate-limited",
            measured_at: "2026-08-14T12:00:01Z",
            measurement: { kind: "total_weight", value: 1_200, unit: "g" },
          },
        ],
      }),
    }),
  );
  assert.equal(batch.response.status, 200);
  assert.deepEqual(batch.body, {
    processed_count: 2,
    accepted_count: 1,
    rejected_count: 1,
    duplicate_count: 1,
    results: [
      {
        index: 0,
        tap_number: 1,
        client_sample_id: "batch-existing",
        outcome: "accepted",
        code: "telemetry.accepted",
        duplicate: true,
        accepted_measurement_id: (first.body as Record<string, unknown>).accepted_measurement_id,
        processed_at: "2026-08-14T12:00:00.000Z",
      },
      {
        index: 1,
        tap_number: 1,
        client_sample_id: "batch-rate-limited",
        outcome: "rejected",
        code: "telemetry.rate_limited",
        duplicate: false,
        processed_at: "2026-08-14T12:00:00.100Z",
      },
    ],
  });

  const singleTooLarge = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/taps/1`, {
      method: "POST",
      headers,
      body: "x".repeat(MAX_JSON_BODY_BYTES + 1),
    }),
  );
  assert.equal(singleTooLarge.response.status, 413);
  const batchTooLarge = await readJsonResponse(
    await fetch(`${baseUrl}/api/v1/telemetry/batch`, {
      method: "POST",
      headers,
      body: "x".repeat(MAX_BATCH_JSON_BODY_BYTES + 1),
    }),
  );
  assert.equal(batchTooLarge.response.status, 413);

  // Exercise the streaming path without a declared Content-Length. The
  // endpoint must still produce the centralized 413 response when overflow
  // is discovered after the first chunk.
  const chunkedSingle = await postChunked(address.port, "/api/v1/telemetry/taps/1", headers, [
    '{"measurement":',
    "x".repeat(MAX_JSON_BODY_BYTES),
    "}",
  ]);
  assert.equal(chunkedSingle.statusCode, 413);
  const chunkedBatch = await postChunked(address.port, "/api/v1/telemetry/batch", headers, [
    '{"samples":[',
    "x".repeat(MAX_BATCH_JSON_BODY_BYTES),
    "]}",
  ]);
  assert.equal(chunkedBatch.statusCode, 413);
});

void test("detector admin HTTP routes enforce admin mutation auth and return purpose-built DTOs", async (context) => {
  const database = openDatabase(":memory:");
  const authService = createAuthService(database, { canonicalOrigin: CANONICAL_ORIGIN });
  const machineKeyService = createMachineKeyService(database);
  const tapService = createTapService(database);
  const telemetryService = new TelemetryService({ database, machineKeyService });
  const router = new Router(quietLogger);
  registerTelemetryRoutes({
    router,
    telemetryService,
    detectorService: new DetectorService(database),
    authService,
  });
  const server = new HttpServer({ router, logger: quietLogger, shutdownGraceMs: 250 });
  context.after(async () => {
    await server.stop();
    database.close();
  });

  await authService.setPin("1234");
  const login = await authService.authenticate("1234");
  assert.ok(login.session);
  assert.ok(login.csrfToken);
  const cookie = `tapboard_admin_session=${login.session}`;
  const headers = {
    cookie,
    origin: CANONICAL_ORIGIN,
    "x-csrf-token": login.csrfToken,
    "content-type": "application/json",
  };
  const address = await server.start("127.0.0.1", 0);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tap = tapService.createTap({ tapNumber: 1, name: "Detector Tap" });

  assert.equal((await fetch(`${baseUrl}/api/admin/telemetry/detector-config`)).status, 401);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/detector-config`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  const global = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/detector-config`, { headers: { cookie } }),
  );
  assert.equal(global.response.status, 200);
  assert.equal(
    typeof (global.body as { config: { config: { candidateLossMl: number } } }).config.config
      .candidateLossMl,
    "number",
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/detector-config`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ unknown: 1 }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/detector-config`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ candidateSamples: Infinity }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/detector-config`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ quietPeriodMs: 20_000, hardTimeoutMs: 10_000 }),
      })
    ).status,
    400,
  );

  const override = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/taps/${tap.id}/detector-config`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ candidateLossMl: 12, baselineBandMl: null }),
    }),
  );
  assert.equal(override.response.status, 200);
  assert.equal(
    (override.body as { override: { override: { candidateLossMl: number; baselineBandMl: null } } })
      .override.override.candidateLossMl,
    12,
  );
  const overrideRead = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/taps/${tap.id}/detector-config`, { headers: { cookie } }),
  );
  assert.equal(
    (overrideRead.body as { override: { override: { baselineBandMl: null } } }).override.override
      .baselineBandMl,
    null,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/taps/${tap.id}/detector-config`, {
        method: "DELETE",
        headers,
      })
    ).status,
    200,
  );

  const diagnostics = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/taps/${tap.id}/telemetry/diagnostics`, {
      headers: { cookie },
    }),
  );
  assert.equal(diagnostics.response.status, 200);
  assert.equal(JSON.stringify(diagnostics.body).includes("last_primary_value"), false);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/taps/${tap.id}/telemetry/rebaseline`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/taps/${tap.id}/telemetry/rebaseline`, {
        method: "POST",
        headers,
        body: JSON.stringify({ unexpected: true }),
      })
    ).status,
    400,
  );

  const createdGroup = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/arbitration-groups`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Adjacent taps", tapIds: [tap.id] }),
    }),
  );
  assert.equal(createdGroup.response.status, 201);
  const groupId = (createdGroup.body as { group: { id: string } }).group.id;
  const groups = await readJsonResponse(
    await fetch(`${baseUrl}/api/admin/telemetry/arbitration-groups`, { headers: { cookie } }),
  );
  assert.equal((groups.body as { groups: readonly unknown[] }).groups.length, 1);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/arbitration-groups/${groupId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Renamed" }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/arbitration-groups`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Duplicate", tapIds: [tap.id, tap.id] }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/admin/telemetry/arbitration-groups`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Invalid", tapIds: ["invalid"] }),
      })
    ).status,
    400,
  );
});

void test("telemetry OpenAPI declares strict schemas, Bearer auth, limits, and error responses", () => {
  const document = JSON.parse(
    readFileSync(new URL("../openapi/telemetry-v1.json", import.meta.url), "utf8"),
  ) as {
    readonly openapi: string;
    readonly info: { readonly description: string };
    readonly paths: Readonly<Record<string, { readonly post: OpenApiObject }>>;
    readonly components: {
      readonly securitySchemes: Readonly<Record<string, OpenApiObject>>;
      readonly schemas: Readonly<Record<string, OpenApiObject>>;
    };
  };
  assert.equal(document.openapi, "3.1.0");
  const single = document.paths["/api/v1/telemetry/taps/{tapNumber}"]?.post;
  const batch = document.paths["/api/v1/telemetry/batch"]?.post;
  assert.ok(single);
  assert.ok(batch);
  assert.deepEqual(single.security, [{ BearerAuth: [] }]);
  assert.deepEqual(batch.security, [{ BearerAuth: [] }]);
  assert.equal(document.components.securitySchemes.BearerAuth?.type, "http");
  assert.equal(document.components.securitySchemes.BearerAuth?.scheme, "bearer");
  assert.match(document.info.description, /16 KiB/);
  assert.match(document.info.description, /256 KiB/);

  const telemetrySample = document.components.schemas.TelemetrySample;
  const telemetryBatch = document.components.schemas.TelemetryBatch;
  const measurement = document.components.schemas.Measurement;
  assert.equal(telemetrySample?.additionalProperties, false);
  assert.equal(telemetryBatch?.additionalProperties, false);
  const batchProperties = telemetryBatch?.properties as OpenApiObject | undefined;
  const batchSamples = batchProperties?.samples as OpenApiObject | undefined;
  assert.equal(batchSamples?.maxItems, 100);
  const oneOf = measurement?.oneOf;
  assert.equal(Array.isArray(oneOf) ? oneOf.length : undefined, 3);
  for (const schemaName of [
    "TotalWeightMeasurement",
    "RemainingVolumeMeasurement",
    "FillPercentageMeasurement",
    "Temperature",
  ]) {
    assert.equal(document.components.schemas[schemaName]?.additionalProperties, false);
  }
  assert.equal(document.components.schemas.PercentageUnit?.const, "percent");
  const singleResponses = single.responses as OpenApiObject;
  const batchResponses = batch.responses as OpenApiObject;
  const single413 = singleResponses["413"] as OpenApiObject;
  const batch413 = batchResponses["413"] as OpenApiObject;
  assert.equal(single413.$ref, "#/components/responses/ContentTooLarge");
  assert.equal(batch413.$ref, "#/components/responses/ContentTooLarge");
  const rateDescription = (singleResponses["429"] as OpenApiObject).description;
  const conflictDescription = (singleResponses["409"] as OpenApiObject).description;
  const operationDescription = single.description;
  assert.equal(typeof rateDescription, "string");
  assert.equal(typeof conflictDescription, "string");
  assert.equal(typeof operationDescription, "string");
  assert.match(rateDescription as string, /Rate limit/);
  assert.match(conflictDescription as string, /idempotency_conflict/);
  assert.match(operationDescription as string, /does not create or replace a durable receipt/);
});
