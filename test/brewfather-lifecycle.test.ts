import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  openDatabase,
  type DatabaseConnection,
  type DatabaseExecutor,
} from "../src/infrastructure/database/connection.ts";
import { readActivities } from "../src/features/activity/operations.ts";
import {
  BrewfatherAdapter,
  BrewfatherError,
} from "../src/features/beverages/brewfather/adapter.ts";
import {
  BrewfatherSyncCoordinator,
  type SyncOptions,
} from "../src/features/beverages/brewfather/sync.ts";
import { sanitizeBatchSummary } from "../src/features/beverages/brewfather/sanitizer.ts";
import {
  listCandidates,
  readBeverage,
  readBeverageLink,
  readRecipeSnapshots,
  readSourceProfile,
  upsertCandidate,
} from "../src/features/beverages/repository.ts";
import { createBeverageService } from "../src/features/beverages/service.ts";
import { createSecretsService, type SecretsService } from "../src/features/secrets/service.ts";

const CREATED_AT = "2026-09-30T10:00:00.000Z";
const SYNC_AT = "2026-09-30T11:00:00.000Z";
const INITIAL_BATCH = {
  _id: "lifecycle-batch",
  name: "Original batch",
  status: "Fermenting",
  estimatedFg: 1.018,
  recipe: { _id: "original-recipe", name: "Original recipe", fg: 1.018 },
};
const UPDATED_BATCH = {
  ...INITIAL_BATCH,
  name: "Updated batch",
  measuredFg: 1.01,
  recipe: { _id: "updated-recipe", name: "Updated recipe", fg: 1.01 },
};

function isDisposed(error: unknown) {
  return (
    error instanceof BrewfatherError &&
    error.category === "disposed" &&
    error.message === "Brewfather integration is shut down."
  );
}

function flushContinuations() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function originalAdapterMethod<Method extends "getBatch" | "listBatchesByStatuses">(
  method: Method,
): BrewfatherAdapter[Method] {
  const descriptor = Object.getOwnPropertyDescriptor(BrewfatherAdapter.prototype, method);
  assert.ok(descriptor);
  assert.equal(typeof descriptor.value, "function");
  return descriptor.value as BrewfatherAdapter[Method];
}

function deferredTransport() {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<Response>();
  const requests: Array<{ method: string; path: string; signal: AbortSignal }> = [];
  const fetchFn: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    assert.ok(init?.signal);
    requests.push({ method: init.method ?? "GET", path: url.pathname, signal: init.signal });
    started.resolve();
    // Deliberately ignore AbortSignal: callers must settle without this transport's cooperation.
    return result.promise;
  };
  return {
    fetchFn,
    requests,
    started: started.promise,
    respond: result.resolve,
    fail: result.reject,
  };
}

function unreadResponse(status: number, value: unknown) {
  const state = { reads: 0, cancellations: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.reads += 1;
        controller.enqueue(Buffer.from(JSON.stringify(value)));
        controller.close();
      },
      cancel() {
        state.cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, { status }), state };
}

function trackDatabase(database: DatabaseConnection) {
  let stopped = false;
  const lateCalls: string[] = [];
  const record = (operation: string) => {
    if (stopped) lateCalls.push(operation);
  };
  const executor: DatabaseExecutor = {
    execute(sql) {
      record("execute");
      database.execute(sql);
    },
    prepare<Bindings extends unknown[] = unknown[], Row = unknown>(sql: string) {
      record("prepare");
      const statement = database.prepare<Bindings, Row>(sql);
      return {
        run(...bindings: Bindings) {
          record("run");
          return statement.run(...bindings);
        },
        get(...bindings: Bindings) {
          record("get");
          return statement.get(...bindings);
        },
        all(...bindings: Bindings) {
          record("all");
          return statement.all(...bindings);
        },
      };
    },
    pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }) {
      record("pragma");
      return database.pragma<Result>(statement, options);
    },
    withTransaction<Result>(work: () => Result extends PromiseLike<unknown> ? never : Result) {
      record("withTransaction");
      return database.withTransaction<Result>(work);
    },
  };
  return {
    executor,
    lateCalls,
    stop: () => {
      stopped = true;
    },
  };
}

function seedCandidate(database: DatabaseExecutor, sourceBatchId: string) {
  const summary = sanitizeBatchSummary({ ...INITIAL_BATCH, _id: sourceBatchId });
  assert.ok(summary);
  upsertCandidate(database, {
    ...summary,
    accountId: "default",
    sourceBatchId,
    syncedAt: CREATED_AT,
  });
}

function createLifecycleContext(
  context: TestContext,
  fetchFn: typeof fetch,
  options: { linked?: boolean; syncCoordinator?: BrewfatherSyncCoordinator } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "tapboard-brewfather-lifecycle-"));
  const path = join(directory, "lifecycle.sqlite3");
  const database = openDatabase(path);
  const inspector = openDatabase(path);
  const tracked = trackDatabase(database);
  const secretsService = createSecretsService(tracked.executor, {
    rootKey: Buffer.alloc(32, 9).toString("base64url"),
  });
  const completed: unknown[] = [];
  const densityEvents: unknown[] = [];
  const syncCoordinator = options.syncCoordinator ?? new BrewfatherSyncCoordinator({ fetchFn });
  const beverageService = createBeverageService(tracked.executor, {
    secretsService,
    syncCoordinator,
    now: () => new Date(SYNC_AT),
    onSyncCompleted: (results) => completed.push(results),
    densityExtensionPort: {
      onEffectiveDensityChanged: (_database, event) => densityEvents.push(event),
    },
  });
  context.after(() => {
    beverageService.dispose();
    database.close();
    inspector.close();
    rmSync(directory, { recursive: true, force: true });
  });
  beverageService.configureBrewfatherAccount({
    userId: "lifecycle-user",
    apiKey: "lifecycle-test-key",
    enabled: true,
    discoveryStatuses: options.linked === false ? ["Fermenting", "Conditioning"] : [],
  });
  beverageService.configureBrewfatherAccount({
    accountId: "later-account",
    userId: "later-user",
    apiKey: "later-test-key",
    enabled: true,
    discoveryStatuses: ["Fermenting"],
  });
  seedCandidate(tracked.executor, INITIAL_BATCH._id);
  seedCandidate(tracked.executor, "prunable-candidate");
  const beverageId =
    options.linked === false
      ? undefined
      : beverageService.linkBrewfatherCandidate({ sourceBatchId: INITIAL_BATCH._id }).beverage.id;
  const snapshot = () => ({
    ...(beverageId === undefined
      ? {}
      : {
          beverage: readBeverage(inspector, beverageId),
          link: readBeverageLink(inspector, beverageId),
          source: readSourceProfile(inspector, beverageId),
          recipes: readRecipeSnapshots(inspector, beverageId),
        }),
    candidates: listCandidates(inspector, "default"),
    laterCandidates: listCandidates(inspector, "later-account"),
    activity: readActivities(inspector),
  });
  const disposeAndClose = () => {
    beverageService.dispose();
    beverageService.dispose();
    tracked.stop();
    database.close();
  };
  return {
    database,
    inspector,
    tracked,
    secretsService,
    syncCoordinator,
    beverageService,
    beverageId,
    completed,
    densityEvents,
    snapshot,
    disposeAndClose,
  };
}

void test("adapter disposal aborts ignored fetches, cancels their late bodies, and blocks future I/O", async (context) => {
  const transport = deferredTransport();
  const timer = context.mock.method(globalThis, "setTimeout");
  const clear = context.mock.method(globalThis, "clearTimeout");
  const adapter = new BrewfatherAdapter({
    userId: "fake-user",
    apiKey: "fake-key",
    fetchFn: transport.fetchFn,
    timeoutMs: 60_000,
  });
  const pending = adapter.getBatch("batch");
  const settled = assert.rejects(pending, isDisposed);
  await transport.started;
  adapter.dispose();
  adapter.dispose();
  await settled;
  const signal = transport.requests[0]!.signal;
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.ok(
    timer.mock.calls.every((call) =>
      clear.mock.calls.some((entry) => entry.arguments[0] === call.result),
    ),
  );

  const late = unreadResponse(200, UPDATED_BATCH);
  transport.respond(late.response);
  await flushContinuations();
  assert.deepEqual(late.state, { reads: 0, cancellations: 1 });
  await assert.rejects(() => adapter.getBatch("another"), isDisposed);
  await assert.rejects(() => adapter.listBatchesByStatuses([]), isDisposed);
  await assert.rejects(() => adapter.updateBatchStatus("batch", "Completed"), isDisposed);
  assert.equal(transport.requests.length, 1);
});

void test("adapter disposal cancels a pending body and releases its reader even when cancellation stalls", async () => {
  const reading = Promise.withResolvers<void>();
  const readGate = Promise.withResolvers<void>();
  const cancelGate = Promise.withResolvers<void>();
  let cancellations = 0;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve();
        return readGate.promise;
      },
      cancel() {
        cancellations += 1;
        return cancelGate.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const adapter = new BrewfatherAdapter({
    userId: "fake-user",
    apiKey: "fake-key",
    timeoutMs: 60_000,
    fetchFn: (_input, init) => {
      assert.ok(init?.signal);
      signal = init.signal;
      return Promise.resolve(new Response(body));
    },
  });
  const pending = adapter.getBatch("batch");
  const settled = assert.rejects(pending, isDisposed);
  await reading.promise;
  adapter.dispose();
  await settled;
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
  assert.ok(signal);
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  readGate.resolve();
  cancelGate.resolve();
  await flushContinuations();
});

void test("adapter disposal clears a long retry wait without issuing another attempt", async (context) => {
  const waiting = Promise.withResolvers<void>();
  const timer = context.mock.method(globalThis, "setTimeout");
  const clear = context.mock.method(globalThis, "clearTimeout");
  let calls = 0;
  const adapter = new BrewfatherAdapter({
    userId: "fake-user",
    apiKey: "fake-key",
    timeoutMs: 60_000,
    maxRetries: 1,
    retryDelayMs: () => {
      waiting.resolve();
      return 60_000;
    },
    fetchFn: () => {
      calls += 1;
      return Promise.resolve(new Response("private error", { status: 503 }));
    },
  });
  const settled = assert.rejects(adapter.getBatch("batch"), isDisposed);
  await waiting.promise;
  adapter.dispose();
  await settled;
  assert.equal(calls, 1);
  assert.equal(timer.mock.calls.length, 2);
  assert.ok(
    timer.mock.calls.every((call) =>
      clear.mock.calls.some((entry) => entry.arguments[0] === call.result),
    ),
  );
});

const LATE_OUTCOMES = [
  { label: "success", status: 200 },
  { label: "404", status: 404 },
  { label: "ordinary error", status: 400 },
  { label: "authentication error", status: 401 },
  { label: "authorization error", status: 403 },
  { label: "transport rejection", status: null },
] as const;

for (const outcome of LATE_OUTCOMES) {
  void test(`service disposal prevents linked ${outcome.label} from touching closed SQLite or callbacks`, async (context) => {
    const transport = deferredTransport();
    const lifecycle = createLifecycleContext(context, transport.fetchFn);
    const expected = lifecycle.snapshot();
    const settled = assert.rejects(lifecycle.beverageService.syncBrewfather(), isDisposed);
    await transport.started;
    lifecycle.disposeAndClose();
    await settled;
    assert.equal(transport.requests[0]?.signal.aborted, true);
    let late: ReturnType<typeof unreadResponse> | undefined;
    if (outcome.status === null) transport.fail(new Error("private late transport error"));
    else {
      late = unreadResponse(
        outcome.status,
        outcome.status === 200 ? UPDATED_BATCH : "private body",
      );
      transport.respond(late.response);
    }
    await flushContinuations();
    if (late) assert.deepEqual(late.state, { reads: 0, cancellations: 1 });
    assert.deepEqual(lifecycle.tracked.lateCalls, []);
    assert.deepEqual(lifecycle.snapshot(), expected);
    assert.deepEqual(lifecycle.completed, []);
    assert.deepEqual(lifecycle.densityEvents, []);
    assert.equal(
      transport.requests.length,
      1,
      "no discovery, next link, or next account may start",
    );
    await assert.rejects(() => lifecycle.beverageService.syncBrewfather(), isDisposed);
    await assert.rejects(
      () => lifecycle.syncCoordinator.sync(lifecycle.tracked.executor, lifecycle.secretsService),
      isDisposed,
    );
    assert.deepEqual(
      await lifecycle.beverageService.completeBrewfatherBatch(lifecycle.beverageId!),
      {
        outcome: "failed",
        message: "Brewfather integration is shut down.",
      },
    );
    assert.deepEqual(lifecycle.tracked.lateCalls, []);
  });
}

for (const discovered of [[], [{ ...UPDATED_BATCH, _id: "new-candidate" }]]) {
  void test(`disposal prevents discovery ${discovered.length === 0 ? "pruning" : "inserts"} and sequential account work`, async (context) => {
    const transport = deferredTransport();
    const lifecycle = createLifecycleContext(context, transport.fetchFn, { linked: false });
    const expected = lifecycle.snapshot();
    const settled = assert.rejects(lifecycle.beverageService.syncBrewfather(), isDisposed);
    await transport.started;
    assert.equal(transport.requests[0]?.path, "/v2/batches");
    lifecycle.disposeAndClose();
    await settled;
    const late = unreadResponse(200, discovered);
    transport.respond(late.response);
    await flushContinuations();
    assert.deepEqual(late.state, { reads: 0, cancellations: 1 });
    assert.deepEqual(lifecycle.snapshot(), expected);
    assert.deepEqual(lifecycle.tracked.lateCalls, []);
    assert.deepEqual(lifecycle.completed, []);
    assert.equal(transport.requests.length, 1, "later statuses and accounts cannot start");
  });
}

for (const status of [200, 404, 401]) {
  void test(`coordinator rechecks disposal when a linked ${status} response has already settled`, async (context) => {
    const received = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const getBatch = originalAdapterMethod("getBatch");
    context.mock.method(
      BrewfatherAdapter.prototype,
      "getBatch",
      function (this: BrewfatherAdapter, batchId: string) {
        return getBatch.call(this, batchId).then(
          async (batch) => {
            received.resolve();
            await delivered.promise;
            return batch;
          },
          async (error: unknown) => {
            received.resolve();
            await delivered.promise;
            throw error;
          },
        );
      },
    );
    const fetchFn: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify(UPDATED_BATCH), { status }));
    const lifecycle = createLifecycleContext(context, fetchFn);
    const expected = lifecycle.snapshot();
    const settled = assert.rejects(lifecycle.beverageService.syncBrewfather(), isDisposed);
    await received.promise;
    lifecycle.disposeAndClose();
    delivered.resolve();
    await settled;
    assert.deepEqual(lifecycle.snapshot(), expected);
    assert.deepEqual(lifecycle.tracked.lateCalls, []);
    assert.deepEqual(lifecycle.completed, []);
    assert.deepEqual(lifecycle.densityEvents, []);
  });
}

void test("coordinator rechecks disposal before applying already-completed discovery and pruning", async (context) => {
  const received = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const listBatches = originalAdapterMethod("listBatchesByStatuses");
  context.mock.method(
    BrewfatherAdapter.prototype,
    "listBatchesByStatuses",
    async function (this: BrewfatherAdapter, statuses: readonly string[]) {
      const result = await listBatches.call(this, statuses);
      received.resolve();
      await delivered.promise;
      return result;
    },
  );
  const fetchFn: typeof fetch = () =>
    Promise.resolve(new Response(JSON.stringify([{ ...UPDATED_BATCH, _id: "new-candidate" }])));
  const lifecycle = createLifecycleContext(context, fetchFn, { linked: false });
  const expected = lifecycle.snapshot();
  const settled = assert.rejects(lifecycle.beverageService.syncBrewfather(), isDisposed);
  await received.promise;
  lifecycle.disposeAndClose();
  delivered.resolve();
  await settled;
  assert.deepEqual(lifecycle.snapshot(), expected);
  assert.deepEqual(lifecycle.tracked.lateCalls, []);
  assert.deepEqual(lifecycle.completed, []);
});

void test("disposal cancels replaced in-flight adapters and stops completeBatch between precheck and PATCH", async (context) => {
  const completionTransport = deferredTransport();
  const syncTransport = deferredTransport();
  const lifecycle = createLifecycleContext(context, syncTransport.fetchFn);
  const expected = lifecycle.snapshot();
  const completion = lifecycle.beverageService.completeBrewfatherBatch(lifecycle.beverageId!, {
    fetchFn: completionTransport.fetchFn,
  });
  await completionTransport.started;
  const syncSettled = assert.rejects(lifecycle.beverageService.syncBrewfather(), isDisposed);
  await syncTransport.started;
  lifecycle.disposeAndClose();
  await syncSettled;
  assert.deepEqual(await completion, {
    outcome: "failed",
    message: "Brewfather integration is shut down.",
  });
  assert.equal(completionTransport.requests[0]?.signal.aborted, true);
  assert.equal(syncTransport.requests[0]?.signal.aborted, true);
  completionTransport.respond(new Response(JSON.stringify(UPDATED_BATCH)));
  syncTransport.respond(new Response(JSON.stringify(UPDATED_BATCH)));
  await flushContinuations();
  assert.equal(completionTransport.requests.length, 1);
  assert.equal(completionTransport.requests[0]?.method, "GET");
  assert.equal(syncTransport.requests.length, 1);
  assert.deepEqual(lifecycle.tracked.lateCalls, []);
  assert.deepEqual(lifecycle.snapshot(), expected);
  assert.deepEqual(
    await lifecycle.syncCoordinator.completeBatch(
      lifecycle.tracked.executor,
      lifecycle.secretsService,
      lifecycle.beverageId!,
    ),
    { outcome: "failed", message: "Brewfather integration is shut down." },
  );
  assert.deepEqual(lifecycle.tracked.lateCalls, []);
});

void test("completeBatch cannot PATCH after a successful precheck is delivered after disposal", async (context) => {
  const received = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const getBatch = originalAdapterMethod("getBatch");
  context.mock.method(
    BrewfatherAdapter.prototype,
    "getBatch",
    async function (this: BrewfatherAdapter, batchId: string) {
      const batch = await getBatch.call(this, batchId);
      received.resolve();
      await delivered.promise;
      return batch;
    },
  );
  const methods: string[] = [];
  const fetchFn: typeof fetch = (_input, init) => {
    methods.push(init?.method ?? "GET");
    return Promise.resolve(new Response(JSON.stringify(UPDATED_BATCH)));
  };
  const lifecycle = createLifecycleContext(context, fetchFn);
  const expected = lifecycle.snapshot();
  const pending = lifecycle.beverageService.completeBrewfatherBatch(lifecycle.beverageId!);
  await received.promise;
  lifecycle.disposeAndClose();
  delivered.resolve();
  assert.deepEqual(await pending, {
    outcome: "failed",
    message: "Brewfather integration is shut down.",
  });
  assert.deepEqual(methods, ["GET"]);
  assert.deepEqual(lifecycle.tracked.lateCalls, []);
  assert.deepEqual(lifecycle.snapshot(), expected);
});

void test("service ignores a completed coordinator result delivered after disposal", async (context) => {
  const completed = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  class DeferredDeliveryCoordinator extends BrewfatherSyncCoordinator {
    override async sync(
      database: DatabaseExecutor,
      secrets: SecretsService,
      options: SyncOptions = {},
    ) {
      const results = await super.sync(database, secrets, options);
      completed.resolve();
      await delivered.promise;
      return results;
    }
  }
  const fetchFn: typeof fetch = () => Promise.resolve(new Response("[]"));
  const coordinator = new DeferredDeliveryCoordinator({ fetchFn });
  const lifecycle = createLifecycleContext(context, fetchFn, {
    linked: false,
    syncCoordinator: coordinator,
  });
  const settled = assert.rejects(
    lifecycle.beverageService.syncBrewfather({ accountId: "default" }),
    isDisposed,
  );
  await completed.promise;
  const expected = lifecycle.snapshot();
  lifecycle.disposeAndClose();
  delivered.resolve();
  await settled;
  assert.deepEqual(lifecycle.tracked.lateCalls, []);
  assert.deepEqual(lifecycle.snapshot(), expected);
  assert.deepEqual(lifecycle.completed, []);
});

void test(
  "periodic stop remains restartable and leaves current work alive; dispose permanently stops it",
  { timeout: 2_000 },
  async (context) => {
    const firstStarted = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<Response>();
    const secondFinished = Promise.withResolvers<void>();
    const thirdFinished = Promise.withResolvers<void>();
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (_input, init) => {
      calls += 1;
      if (calls === 1) {
        assert.ok(init?.signal);
        firstSignal = init.signal;
        firstStarted.resolve();
        return firstResponse.promise;
      }
      if (calls === 2) secondFinished.resolve();
      if (calls === 3) thirdFinished.resolve();
      return Promise.resolve(new Response("[]"));
    };
    const lifecycle = createLifecycleContext(context, fetchFn, { linked: false });
    lifecycle.beverageService.startPeriodicSync({ initialDelayMs: 0, intervalMs: 60_000 });
    await firstStarted.promise;
    lifecycle.beverageService.stopPeriodicSync();
    assert.equal(firstSignal?.aborted, false);
    firstResponse.resolve(new Response("[]"));
    await lifecycle.beverageService.syncBrewfather();
    // Each successful sync fetches both statuses for default, then the later account.
    assert.equal(calls, 3);
    await secondFinished.promise;
    await thirdFinished.promise;
    lifecycle.beverageService.startPeriodicSync({ initialDelayMs: 0, intervalMs: 60_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 6);
    lifecycle.beverageService.stopPeriodicSync();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 6);
    lifecycle.disposeAndClose();
    lifecycle.beverageService.startPeriodicSync({ initialDelayMs: 0, intervalMs: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    assert.equal(calls, 6);
    assert.deepEqual(lifecycle.tracked.lateCalls, []);
    assert.equal(lifecycle.completed.length, 2);
  },
);
