import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BREWFATHER_STATUSES,
  BrewfatherClient,
  BrewfatherError,
  createBrewfatherClientFromEnv
} from '../src/brewfatherClient.js';

function response(body, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType, ...headers }
  });
}

function client(fetchFn, options = {}) {
  return new BrewfatherClient({
    userId: 'user',
    apiKey: 'super-secret-key',
    fetchFn,
    logger: { error() {} },
    ...options
  });
}

test('sends Basic authentication without including credentials in thrown errors', async () => {
  let authorization;
  const lines = [];
  const api = client(
    async (_url, init) => {
      authorization = init.headers.Authorization;
      return response(
        {
          error: {
            message: 'Invalid user user, key super-secret-key, Basic dXNlcjpzdXBlci1zZWNyZXQta2V5\nnext\u2028line'
          }
        },
        { status: 401, headers: { 'retry-after': '30' } }
      );
    },
    { logger: { error: (line) => lines.push(line) } }
  );
  await assert.rejects(api.getBatch('batch_1'), (error) => {
    assert.equal(error.category, 'auth');
    assert.doesNotMatch(`${error.message} ${error.stack}`, /super-secret-key|user:/);
    return true;
  });
  assert.match(authorization, /^Basic /);
  assert.doesNotMatch(authorization, /super-secret-key/);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split('\n').length, 1);
  const log = JSON.parse(lines[0]);
  assert.deepEqual(log, {
    event: 'brewfather.transport_failure',
    operation: '/v2/batches/:batchId',
    method: 'GET',
    category: 'auth',
    status: 401,
    contentType: 'application/json',
    retryAfterMs: 30_000
  });
  assert.doesNotMatch(lines[0], /\u2028|\u2029/);
  assert.doesNotMatch(lines[0], /super-secret-key|dXNlcjpzdXBlci1zZWNyZXQta2V5|batch_1/);
});

test('does not read failure bodies or log response text and resource IDs', async () => {
  const lines = [];
  let bodyRead = false;
  const api = client(
    async () => ({
      status: 403,
      statusText: 'private response text and query ?secret=yes',
      headers: new Headers({ 'content-type': 'text/plain' }),
      get clone() {
        bodyRead = true;
        throw new Error('response body must not be read');
      }
    }),
    { logger: { error: (line) => lines.push(line) } }
  );

  await assert.rejects(api.getBatch('private-batch-id'), (error) => error.category === 'forbidden');
  assert.equal(bodyRead, false);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'brewfather.transport_failure',
    operation: '/v2/batches/:batchId',
    method: 'GET',
    category: 'forbidden',
    status: 403,
    contentType: 'text/plain'
  });
  assert.doesNotMatch(lines[0], /private response text|secret=yes|private-batch-id/);
});

test('treats a missing latest reading as absent without logging a transport failure', async () => {
  const lines = [];
  const api = client(async () => response({ private: 'response body' }, { status: 404 }), {
    logger: { error: (line) => lines.push(line) }
  });

  assert.equal(await api.getLatestReading('private-batch-id'), null);
  assert.deepEqual(lines, []);
});

test('keeps 404s from required endpoints observable and masks their resource IDs', async () => {
  const lines = [];
  const api = client(async () => response({}, { status: 404 }), { logger: { error: (line) => lines.push(line) } });

  await assert.rejects(api.getBatch('private-batch-id'), (error) => {
    assert.equal(error.category, 'not_found');
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'brewfather.transport_failure',
    operation: '/v2/batches/:batchId',
    method: 'GET',
    category: 'not_found',
    status: 404,
    contentType: 'application/json'
  });
  assert.doesNotMatch(lines[0], /private-batch-id/);
});

test('paginates all supported statuses using start_after', async () => {
  const calls = [];
  const api = client(async (url) => {
    calls.push(url);
    const status = url.searchParams.get('status');
    if (status === 'Planning' && !url.searchParams.has('start_after'))
      return response(Array.from({ length: 50 }, (_, index) => ({ _id: `p${index}` })));
    return response([{ _id: `${status}-last` }]);
  });
  const result = await api.listBatchesByStatuses();
  assert.equal(result.failures.length, 0);
  assert.equal(result.batches.length, 55);
  assert.equal(calls.length, 6);
  assert.equal(calls[1].searchParams.get('start_after'), 'p49');
  assert.deepEqual(BREWFATHER_STATUSES, ['Planning', 'Brewing', 'Fermenting', 'Conditioning', 'Completed']);
});

test('enforces a rolling request budget for every method', async () => {
  let now = 10_000;
  const api = client(async () => response({}), { requestBudget: 2, now: () => now });
  await api.getBatch('one');
  await api.getRecipe('two');
  await assert.rejects(api.completeBatch('three'), (error) => error.category === 'rate_limited');
  now += 3_600_001;
  await api.getReadings('three');
});

test('classifies timeouts and aborts the request signal', async () => {
  let aborted = false;
  const api = client(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    { timeoutMs: 1 }
  );
  await assert.rejects(api.getBatch('one'), (error) => error.category === 'timeout');
  assert.equal(aborted, true);
});

test('rejects oversized, non-json, and malformed JSON responses', async () => {
  await assert.rejects(
    client(async () => response('12345'), { maxResponseBytes: 4 }).getBatch('one'),
    (error) => error.category === 'response_too_large'
  );
  const logs = [];
  await assert.rejects(
    client(async () => response('private successful response body', { contentType: 'text/plain' }), {
      logger: { error: (line) => logs.push(line) }
    }).getBatch('one'),
    (error) => error.category === 'invalid_response'
  );
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /private successful response body/);
  await assert.rejects(
    client(async () => response('{')).getBatch('one'),
    (error) => error.category === 'invalid_response'
  );
});

test('classifies Retry-After, retains earlier successes, and blocks a follow-up storm', async () => {
  let now = 1_000;
  const api = client(
    async (url) => {
      if (url.searchParams.get('status') === 'Brewing')
        return response({}, { status: 429, headers: { 'retry-after': '30' } });
      return response([{ _id: url.searchParams.get('status') }]);
    },
    { now: () => now }
  );
  const result = await api.listBatchesByStatuses(['Planning', 'Brewing', 'Fermenting']);
  assert.deepEqual(
    result.batches.map((batch) => batch._id),
    ['Planning']
  );
  assert.equal(result.failures[0].status, 'Brewing');
  assert.equal(result.failures[0].error.category, 'rate_limited');
  assert.equal(result.failures[0].error.retryAfter, 30_000);
  await assert.rejects(api.getBatch('one'), (error) => error.category === 'rate_limited');
  now += 30_001;
  await api.getBatch('one');
});

test('malformed status pages become partial failures and cannot make the aggregate authoritative', async () => {
  const api = client(async (url) => {
    const status = url.searchParams.get('status');
    return response(status === 'Brewing' ? [{ name: 'missing identity' }] : [{ _id: status }]);
  });
  const result = await api.listBatchesByStatuses(['Planning', 'Brewing', 'Fermenting']);
  assert.deepEqual(
    result.batches.map((batch) => ({ id: batch._id, status: batch.status })),
    [
      { id: 'Planning', status: 'Planning' },
      { id: 'Fermenting', status: 'Fermenting' }
    ]
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].status, 'Brewing');
  assert.equal(result.failures[0].error.category, 'invalid_response');
});

test('completeBatch uses only the exact completed-status patch body and IDs are safe', async () => {
  let init;
  const api = client(async (_url, request) => {
    init = request;
    return response({ ok: true });
  });
  await api.completeBatch('valid_id-1');
  assert.equal(init.method, 'PATCH');
  assert.equal(init.body, '{"status":"Completed"}');
  assert.throws(
    () => api.getBatch('../unsafe'),
    (error) => error instanceof BrewfatherError && error.category === 'configuration'
  );
});

test('accepts Brewfather text completion responses without broadening PATCH semantics', async () => {
  const api = client(async () => response('Updated', { contentType: 'text/plain' }));
  assert.deepEqual(await api.completeBatch('batch-one'), { completed: true });
});

test('environment factory is inert without credentials and applies the conservative budget cap', () => {
  assert.equal(createBrewfatherClientFromEnv({}), null);
  const api = createBrewfatherClientFromEnv(
    { BREWFATHER_USER_ID: 'user', BREWFATHER_API_KEY: 'key', BREWFATHER_REQUEST_BUDGET: '125' },
    { fetchFn: async () => response({}) }
  );
  assert.equal(api.getBudgetStatus().limit, 125);
  assert.throws(
    () =>
      createBrewfatherClientFromEnv({
        BREWFATHER_USER_ID: 'user',
        BREWFATHER_API_KEY: 'key',
        BREWFATHER_REQUEST_BUDGET: '500'
      }),
    /Invalid Brewfather client configuration/
  );
});

test('uses the exact v2 batch, recipe, latest-reading, and history read endpoints', async () => {
  const calls = [];
  const api = client(async (url, init) => {
    calls.push(`${init.method} ${url.pathname}`);
    return response(url.pathname.endsWith('/readings') ? [] : {});
  });
  await api.getBatch('batch-one');
  await api.getRecipe('recipe-one');
  await api.getLatestReading('batch-one');
  await api.getReadings('batch-one');
  assert.deepEqual(calls, [
    'GET /v2/batches/batch-one',
    'GET /v2/recipes/recipe-one',
    'GET /v2/batches/batch-one/readings/last',
    'GET /v2/batches/batch-one/readings'
  ]);
});
