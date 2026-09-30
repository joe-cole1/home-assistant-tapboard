import assert from "node:assert/strict";
import test from "node:test";
import {
  BrewfatherAdapter,
  BrewfatherError,
  type BrewfatherAdapterOptions,
  type BrewfatherErrorCategory,
} from "../src/features/beverages/brewfather/adapter.ts";

function createAdapter(
  fetchFn: typeof fetch,
  options: Omit<BrewfatherAdapterOptions, "userId" | "apiKey" | "fetchFn"> = {},
): BrewfatherAdapter {
  return new BrewfatherAdapter({
    userId: "fake-user",
    apiKey: "fake-key",
    fetchFn,
    maxRetries: 0,
    retryDelayMs: 0,
    ...options,
  });
}

function trackedResponse(
  chunks: readonly Uint8Array[],
  options: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
    readonly stallAfterChunks?: boolean;
    readonly readError?: Error;
    readonly onCancel?: () => void | Promise<void>;
  } = {},
) {
  const state = { reads: 0, chunksRead: 0, cancellations: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.reads += 1;
        const chunk = chunks[state.chunksRead];
        if (chunk !== undefined) {
          state.chunksRead += 1;
          controller.enqueue(chunk);
        } else if (options.stallAfterChunks) {
          return new Promise<void>(() => undefined);
        } else if (options.readError) {
          controller.error(options.readError);
        } else {
          controller.close();
        }
      },
      cancel() {
        state.cancellations += 1;
        return options.onCancel?.();
      },
    },
    // Avoid prefetch so these tests can distinguish reading surplus data from cancelling it.
    { highWaterMark: 0 },
  );
  return {
    state,
    response: new Response(body, {
      status: options.status ?? 200,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }),
  };
}

function hasCategory(category: BrewfatherErrorCategory) {
  return (error: unknown) => error instanceof BrewfatherError && error.category === category;
}

void test("streaming byte limits ignore missing or understated Content-Length and cancel unread surplus", async () => {
  for (const headers of [{}, { "Content-Length": "1" }]) {
    const streamed = trackedResponse(
      [Buffer.from('{"name":"'), Buffer.from("éé"), Buffer.from('"}'), Buffer.from("surplus")],
      { headers },
    );
    let signal: AbortSignal | null | undefined;
    const adapter = createAdapter(
      (_url, init) => {
        signal = init?.signal;
        return Promise.resolve(streamed.response);
      },
      { maxResponseBytes: 12 },
    );

    await assert.rejects(() => adapter.getBatch("batch"), hasCategory("response_too_large"));
    assert.equal(streamed.state.chunksRead, 2);
    assert.equal(streamed.state.reads, 2);
    assert.equal(streamed.state.cancellations, 1);
    assert.equal(streamed.response.body?.locked, false);
    assert.equal(signal?.aborted, true);
  }
});

void test("an oversized declared Content-Length rejects without reading the body", async () => {
  const streamed = trackedResponse([Buffer.from("surplus")], {
    headers: { "Content-Length": "1000" },
  });
  const adapter = createAdapter(() => Promise.resolve(streamed.response), {
    maxResponseBytes: 12,
  });

  await assert.rejects(() => adapter.getRecipe("recipe"), hasCategory("response_too_large"));
  assert.equal(streamed.state.reads, 0);
  assert.equal(streamed.state.cancellations, 1);
});

void test("an exact-limit record decodes UTF-8 split across chunks and releases its reader", async () => {
  const record = { _id: "batch-é🍺", recipe: { name: "Märzen" } };
  const bytes = Buffer.from(JSON.stringify(record));
  const streamed = trackedResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  const adapter = createAdapter(() => Promise.resolve(streamed.response), {
    maxResponseBytes: bytes.byteLength,
  });

  assert.deepEqual(await adapter.getBatch("batch"), record);
  assert.equal(streamed.state.chunksRead, bytes.byteLength);
  assert.equal(streamed.state.cancellations, 0);
  assert.equal(streamed.response.body?.locked, false);
});

void test("unsuccessful responses cancel unread bodies and preserve HTTP categories and backoff", async () => {
  const cases: readonly [number, BrewfatherErrorCategory][] = [
    [400, "transient"],
    [401, "auth"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
  ];
  for (const [status, category] of cases) {
    const streamed = trackedResponse([Buffer.from("private upstream error")], {
      status,
      headers: { "Retry-After": "30" },
    });
    let calls = 0;
    const adapter = createAdapter(
      () => {
        calls += 1;
        return Promise.resolve(streamed.response);
      },
      { maxRetries: 2, now: () => 1000 },
    );

    await assert.rejects(
      () => adapter.request("GET", "/error"),
      (error: unknown) =>
        error instanceof BrewfatherError &&
        error.category === category &&
        error.status === status &&
        (status !== 429 || error.retryAfterMs === 30_000),
    );
    assert.equal(streamed.state.reads, 0);
    assert.equal(streamed.state.cancellations, 1);
    assert.equal(calls, 1);
    if (status === 429) {
      await assert.rejects(() => adapter.getBatch("batch"), hasCategory("rate_limited"));
      assert.equal(calls, 1);
    }
  }
});

void test("nullable 404 record lookups cancel their unread bodies", async () => {
  for (const method of ["getBatch", "getRecipe"] as const) {
    const streamed = trackedResponse([Buffer.from("not found")], { status: 404 });
    const adapter = createAdapter(() => Promise.resolve(streamed.response));
    assert.equal(await adapter[method]("missing"), null);
    assert.equal(streamed.state.reads, 0);
    assert.equal(streamed.state.cancellations, 1);
  }
});

void test("5xx cancellation finishes before retry delay and the next attempt", async () => {
  const events: string[] = [];
  const failed = trackedResponse([Buffer.from("unread")], {
    status: 503,
    onCancel: async () => {
      events.push("cancel-start");
      await Promise.resolve();
      events.push("cancel-finished");
    },
  });
  let calls = 0;
  const adapter = createAdapter(
    () => {
      calls += 1;
      events.push(`fetch-${calls}`);
      return Promise.resolve(calls === 1 ? failed.response : new Response('{"_id":"batch"}'));
    },
    {
      maxRetries: 1,
      retryDelayMs: (attempt) => {
        assert.equal(attempt, 1);
        events.push("retry-delay");
        return 1;
      },
    },
  );

  assert.deepEqual(await adapter.getBatch("batch"), { _id: "batch" });
  assert.deepEqual(events, [
    "fetch-1",
    "cancel-start",
    "cancel-finished",
    "retry-delay",
    "fetch-2",
  ]);
  assert.equal(failed.state.reads, 0);
  assert.equal(failed.state.cancellations, 1);
});

void test("every failed 5xx attempt is disposed and retries consume the local request budget", async () => {
  const attempts = Array.from({ length: 2 }, () =>
    trackedResponse([Buffer.from("unread")], { status: 500 }),
  );
  let calls = 0;
  const adapter = createAdapter(() => Promise.resolve(attempts[calls++]!.response), {
    maxRetries: 1,
    requestBudget: 2,
  });

  await assert.rejects(() => adapter.getBatch("batch"), hasCategory("transient"));
  assert.equal(calls, 2);
  for (const attempt of attempts) {
    assert.equal(attempt.state.reads, 0);
    assert.equal(attempt.state.cancellations, 1);
  }
  await assert.rejects(() => adapter.getBatch("batch"), hasCategory("rate_limited"));
  assert.equal(calls, 2);
});

void test(
  "a stalled body read times out, cancels, and retries with a fresh deadline",
  { timeout: 2000 },
  async () => {
    const stalled = trackedResponse([Buffer.from('{"_id":')], { stallAfterChunks: true });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const adapter = createAdapter(
      (_url, init) => {
        assert.ok(init?.signal);
        signals.push(init.signal);
        calls += 1;
        if (calls === 2) assert.equal(stalled.state.cancellations, 1);
        return Promise.resolve(calls === 1 ? stalled.response : new Response('{"_id":"retried"}'));
      },
      { timeoutMs: 20, maxRetries: 1, retryDelayMs: 30 },
    );

    assert.deepEqual(await adapter.getBatch("batch"), { _id: "retried" });
    assert.equal(calls, 2);
    assert.equal(stalled.state.reads, 2);
    assert.equal(stalled.state.cancellations, 1);
    assert.equal(stalled.response.body?.locked, false);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
  },
);

void test(
  "stalled bodies stop at the configured retry bound and release all readers",
  { timeout: 2000 },
  async () => {
    const attempts = Array.from({ length: 3 }, () =>
      trackedResponse([], { stallAfterChunks: true }),
    );
    let calls = 0;
    const adapter = createAdapter(() => Promise.resolve(attempts[calls++]!.response), {
      timeoutMs: 15,
      maxRetries: 2,
    });

    await assert.rejects(() => adapter.getRecipe("recipe"), hasCategory("timeout"));
    assert.equal(calls, 3);
    for (const attempt of attempts) {
      assert.equal(attempt.state.cancellations, 1);
      assert.equal(attempt.response.body?.locked, false);
    }
  },
);

void test(
  "fetch timeout cancels a response that arrives after the transport ignored abort",
  { timeout: 2000 },
  async () => {
    const late = trackedResponse([Buffer.from("unread")]);
    let deliver: ((response: Response) => void) | undefined;
    const adapter = createAdapter(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
      { timeoutMs: 15 },
    );

    await assert.rejects(() => adapter.getBatch("batch"), hasCategory("timeout"));
    assert.ok(deliver);
    deliver(late.response);
    await Promise.resolve();
    assert.equal(late.state.reads, 0);
    assert.equal(late.state.cancellations, 1);
  },
);

void test(
  "stalled response cancellation is deadline-bounded before a 5xx retry",
  { timeout: 2000 },
  async () => {
    const failed = trackedResponse([Buffer.from("unread")], {
      status: 503,
      onCancel: () => new Promise<void>(() => undefined),
    });
    let calls = 0;
    const adapter = createAdapter(
      () => {
        calls += 1;
        return Promise.resolve(calls === 1 ? failed.response : new Response('{"_id":"retried"}'));
      },
      { timeoutMs: 15, maxRetries: 1 },
    );

    assert.deepEqual(await adapter.getBatch("batch"), { _id: "retried" });
    assert.equal(failed.state.cancellations, 1);
    assert.equal(calls, 2);
  },
);

void test("cleanup failures preserve typed auth errors without exposing exception text", async () => {
  const failed = trackedResponse([Buffer.from("unread")], {
    status: 401,
    onCancel: () => Promise.reject(new Error("private transport detail")),
  });
  const adapter = createAdapter(() => Promise.resolve(failed.response));
  await assert.rejects(
    () => adapter.getBatch("batch"),
    (error: unknown) =>
      error instanceof BrewfatherError &&
      error.category === "auth" &&
      !error.message.includes("private"),
  );
  assert.equal(failed.state.cancellations, 1);
});

void test("fetch and body read failures retry within bounds and expose only a fixed network error", async () => {
  for (const phase of ["fetch", "read"] as const) {
    let calls = 0;
    const responses: Response[] = [];
    const adapter = createAdapter(
      () => {
        calls += 1;
        const error = new Error("fake-key in a private upstream URL or body");
        if (phase === "fetch") return Promise.reject(error);
        const failed = trackedResponse([Buffer.from('{"_id":')], { readError: error });
        responses.push(failed.response);
        return Promise.resolve(failed.response);
      },
      { maxRetries: 1 },
    );

    await assert.rejects(
      () => adapter.getBatch("batch"),
      (error: unknown) =>
        error instanceof BrewfatherError &&
        error.category === "network" &&
        error.message === "Brewfather network request failed." &&
        error.cause === undefined,
    );
    assert.equal(calls, 2);
    for (const response of responses) assert.equal(response.body?.locked, false);
  }
});

void test("batch and recipe methods accept records and nullable responses but reject scalar and array JSON", async () => {
  for (const method of ["getBatch", "getRecipe"] as const) {
    for (const value of [{ _id: "value", nested: { detail: 1 } }, {}]) {
      const adapter = createAdapter(() => Promise.resolve(new Response(JSON.stringify(value))));
      assert.deepEqual(await adapter[method]("value"), value);
    }
    for (const body of [null, "", " \n ", "null"]) {
      const adapter = createAdapter(() =>
        Promise.resolve(new Response(body, { status: body === null ? 204 : 200 })),
      );
      assert.equal(await adapter[method]("value"), null);
    }
    for (const value of [[], [{ _id: "value" }], "value", 1, true, false]) {
      const adapter = createAdapter(() => Promise.resolve(new Response(JSON.stringify(value))));
      await assert.rejects(() => adapter[method]("value"), hasCategory("invalid_response"));
    }
    const adapter = createAdapter(() => Promise.resolve(new Response("malformed JSON")));
    await assert.rejects(() => adapter[method]("value"), hasCategory("invalid_response"));
  }
});

void test("batch lists accept only arrays of records, including empty lists", async () => {
  for (const value of [[], [{}], [{ _id: "batch", recipe: { _id: "recipe" } }]]) {
    const adapter = createAdapter(() => Promise.resolve(new Response(JSON.stringify(value))));
    assert.deepEqual(await adapter.listBatches({ status: "Fermenting" }), value);
  }
  for (const value of [
    null,
    {},
    1,
    "list",
    true,
    [null],
    [1],
    ["batch"],
    [true],
    [[]],
    [{}, null],
  ]) {
    const adapter = createAdapter(() => Promise.resolve(new Response(JSON.stringify(value))));
    await assert.rejects(
      () => adapter.listBatches({ status: "Fermenting" }),
      hasCategory("invalid_response"),
    );
  }
  const emptyAdapter = createAdapter(() => Promise.resolve(new Response(null, { status: 204 })));
  await assert.rejects(
    () => emptyAdapter.listBatches({ status: "Fermenting" }),
    hasCategory("invalid_response"),
  );
});

void test("completion PATCH preserves record, text, JSON string, null, and empty responses", async () => {
  const cases: readonly [string | null, unknown][] = [
    ['{"status":"Completed"}', { status: "Completed" }],
    ["Updated", "Updated"],
    ['"Completed"', "Completed"],
    ["null", null],
    ["", null],
    [null, null],
  ];
  for (const [body, expected] of cases) {
    const adapter = createAdapter((_url, init) => {
      assert.equal(init?.method, "PATCH");
      assert.equal(init.body, '{"status":"Completed"}');
      return Promise.resolve(new Response(body, { status: body === null ? 204 : 200 }));
    });
    assert.deepEqual(await adapter.updateBatchStatus("batch", "Completed"), expected);
  }
  for (const value of [[], [{}], 1, true, false]) {
    const adapter = createAdapter(() => Promise.resolve(new Response(JSON.stringify(value))));
    await assert.rejects(
      () => adapter.updateBatchStatus("batch", "Completed"),
      hasCategory("invalid_response"),
    );
  }
});
