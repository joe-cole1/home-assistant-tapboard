const ORIGIN = 'https://api.brewfather.app';
const BATCH_SUMMARY_INCLUDE = [
  'recipe._id',
  'recipe.style',
  'recipe.description',
  'estimatedOg',
  'estimatedFg',
  'estimatedAbv',
  'measuredOg',
  'measuredFg',
  'measuredAbv',
  'recipe.ibu',
  'recipe.color',
  'carbonation',
  'carbonationTemp',
  'startDate',
  'fermentationStartDate',
  'conditioningDate',
  'bottlingDate',
  'completedDate',
  'image',
  'updatedAt'
].join(',');
export const BREWFATHER_STATUSES = Object.freeze(['Planning', 'Brewing', 'Fermenting', 'Conditioning', 'Completed']);

export class BrewfatherError extends Error {
  constructor(category, message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'BrewfatherError';
    this.category = category;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function configuredInteger(value, fallback, min, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new BrewfatherError('configuration', 'Invalid Brewfather client configuration');
  return number;
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new BrewfatherError('configuration', 'Invalid Brewfather resource ID');
  return value;
}

function retryAfter(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now()) : null;
}

async function boundedBody(response, limit) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel?.();
        throw new BrewfatherError('response_too_large', 'Brewfather response exceeded configured size limit');
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > limit)
    throw new BrewfatherError('response_too_large', 'Brewfather response exceeded configured size limit');
  return text;
}

export class BrewfatherClient {
  constructor({
    userId,
    apiKey,
    fetchFn = globalThis.fetch,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    timeoutMs = 10_000,
    maxResponseBytes = 1_048_576,
    requestBudget = 100,
    budgetWindowMs = 3_600_000,
    maxPages = 50,
    maxItems = 2_500
  } = {}) {
    if (typeof userId !== 'string' || !userId || typeof apiKey !== 'string' || !apiKey)
      throw new BrewfatherError('configuration', 'Brewfather credentials are required');
    if (typeof fetchFn !== 'function') throw new BrewfatherError('configuration', 'Fetch is required');
    this.userId = userId;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.timeoutMs = configuredInteger(timeoutMs, 10_000, 1, 120_000);
    this.maxResponseBytes = configuredInteger(maxResponseBytes, 1_048_576, 1, 10_485_760);
    this.requestBudget = configuredInteger(requestBudget, 100, 1, 200);
    this.budgetWindowMs = configuredInteger(budgetWindowMs, 3_600_000, 1_000, 86_400_000);
    this.maxPages = configuredInteger(maxPages, 50, 1, 50);
    this.maxItems = configuredInteger(maxItems, 2_500, 1, 10_000);
    this.requestTimes = [];
    this.blockedUntil = 0;
  }

  consumeBudget() {
    const current = this.now();
    if (current < this.blockedUntil) {
      throw new BrewfatherError('rate_limited', 'Brewfather requests are temporarily rate limited', {
        retryAfter: this.blockedUntil - current
      });
    }
    const cutoff = current - this.budgetWindowMs;
    this.requestTimes = this.requestTimes.filter((time) => time > cutoff);
    if (this.requestTimes.length >= this.requestBudget) {
      const retryIn = Math.max(1, this.requestTimes[0] + this.budgetWindowMs - current);
      throw new BrewfatherError('rate_limited', 'Brewfather request budget exceeded', { retryAfter: retryIn });
    }
    this.requestTimes.push(current);
  }

  getBudgetStatus() {
    const cutoff = this.now() - this.budgetWindowMs;
    this.requestTimes = this.requestTimes.filter((time) => time > cutoff);
    return Object.freeze({
      limit: this.requestBudget,
      used: this.requestTimes.length,
      remaining: Math.max(0, this.requestBudget - this.requestTimes.length),
      blockedUntil: this.blockedUntil || null
    });
  }

  async request(method, path, { query, body, responseMode = 'json' } = {}) {
    this.consumeBudget();
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(query || {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = this.setTimeoutFn(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchFn(url, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.userId}:${this.apiKey}`).toString('base64')}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError')
          throw new BrewfatherError('timeout', 'Brewfather request timed out');
        throw new BrewfatherError('network', 'Brewfather request failed');
      }
      if (response.status === 401)
        throw new BrewfatherError('auth', 'Brewfather authentication failed', { status: 401 });
      if (response.status === 403)
        throw new BrewfatherError('forbidden', 'Brewfather access forbidden', { status: 403 });
      if (response.status === 404)
        throw new BrewfatherError('not_found', 'Brewfather resource not found', { status: 404 });
      if (response.status === 429) {
        const retryDelay = retryAfter(response.headers.get('retry-after'), this.now);
        if (retryDelay !== null) this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryDelay);
        throw new BrewfatherError('rate_limited', 'Brewfather rate limited request', {
          status: 429,
          retryAfter: retryDelay
        });
      }
      if (!response.ok)
        throw new BrewfatherError('transient', 'Brewfather returned an unsuccessful response', {
          status: response.status
        });
      const contentType = response.headers.get('content-type');
      const isJson = Boolean(contentType && /^application\/json(?:\s*;|$)/i.test(contentType));
      const isText = Boolean(contentType && /^text\/plain(?:\s*;|$)/i.test(contentType));
      if (!isJson && !(responseMode === 'completion' && isText))
        throw new BrewfatherError('invalid_response', 'Brewfather response was not JSON', { status: response.status });
      let text;
      try {
        text = await boundedBody(response, this.maxResponseBytes);
      } catch (error) {
        if (error instanceof BrewfatherError) throw error;
        if (controller.signal.aborted || error?.name === 'AbortError') {
          throw new BrewfatherError('timeout', 'Brewfather request timed out');
        }
        throw new BrewfatherError('network', 'Brewfather response could not be read');
      }
      if (responseMode === 'completion' && !isJson) return Object.freeze({ completed: true });
      try {
        return JSON.parse(text);
      } catch {
        throw new BrewfatherError('invalid_response', 'Brewfather response contained invalid JSON', {
          status: response.status
        });
      }
    } finally {
      this.clearTimeoutFn(timer);
    }
  }

  listBatches({ status, startAfter } = {}) {
    if (!BREWFATHER_STATUSES.includes(status))
      throw new BrewfatherError('configuration', 'Invalid Brewfather batch status');
    return this.request('GET', '/v2/batches', {
      query: {
        status,
        limit: 50,
        include: BATCH_SUMMARY_INCLUDE,
        ...(startAfter ? { start_after: safeId(startAfter) } : {})
      }
    });
  }

  async listBatchesByStatuses(statuses = BREWFATHER_STATUSES) {
    if (!Array.isArray(statuses) || statuses.some((status) => !BREWFATHER_STATUSES.includes(status)))
      throw new BrewfatherError('configuration', 'Invalid Brewfather batch statuses');
    const batches = [];
    const failures = [];
    let totalPages = 0;
    for (const status of statuses) {
      let startAfter;
      try {
        while (true) {
          if (++totalPages > this.maxPages)
            throw new BrewfatherError('invalid_response', 'Brewfather pagination exceeded page limit');
          const page = await this.listBatches({ status, startAfter });
          if (!Array.isArray(page))
            throw new BrewfatherError('invalid_response', 'Brewfather batch list was not an array');
          const normalizedPage = page.map((batch) => {
            const id = batch?._id ?? batch?.id;
            if (
              !batch ||
              typeof batch !== 'object' ||
              Array.isArray(batch) ||
              typeof id !== 'string' ||
              !/^[A-Za-z0-9_-]{1,256}$/.test(id)
            ) {
              throw new BrewfatherError('invalid_response', 'Brewfather batch list contained an invalid item');
            }
            return batch.status ? batch : { ...batch, status };
          });
          batches.push(...normalizedPage);
          if (batches.length > this.maxItems)
            throw new BrewfatherError('invalid_response', 'Brewfather pagination exceeded item limit');
          if (page.length < 50) break;
          const last = page.at(-1);
          const next = last?._id ?? last?.id;
          if (typeof next !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(next))
            throw new BrewfatherError('invalid_response', 'Brewfather pagination cursor was invalid');
          startAfter = next;
        }
      } catch (error) {
        const failure =
          error instanceof BrewfatherError ? error : new BrewfatherError('transient', 'Brewfather request failed');
        failures.push({ status, error: failure });
        if (['configuration', 'auth', 'forbidden', 'rate_limited'].includes(failure.category)) break;
      }
    }
    return { batches, failures };
  }

  getBatch(id) {
    return this.request('GET', `/v2/batches/${safeId(id)}`);
  }
  getRecipe(id) {
    return this.request('GET', `/v2/recipes/${safeId(id)}`);
  }
  getLatestReading(id) {
    return this.request('GET', `/v2/batches/${safeId(id)}/readings/last`);
  }
  getReadings(id) {
    return this.request('GET', `/v2/batches/${safeId(id)}/readings`);
  }
  completeBatch(id) {
    return this.request('PATCH', `/v2/batches/${safeId(id)}`, {
      body: { status: 'Completed' },
      responseMode: 'completion'
    });
  }
}

export function createBrewfatherClientFromEnv(env = process.env, options = {}) {
  if (!env.BREWFATHER_USER_ID || !env.BREWFATHER_API_KEY) return null;
  return new BrewfatherClient({
    userId: env.BREWFATHER_USER_ID,
    apiKey: env.BREWFATHER_API_KEY,
    timeoutMs: env.BREWFATHER_TIMEOUT_MS === undefined ? undefined : Number(env.BREWFATHER_TIMEOUT_MS),
    maxResponseBytes:
      env.BREWFATHER_MAX_RESPONSE_BYTES === undefined ? undefined : Number(env.BREWFATHER_MAX_RESPONSE_BYTES),
    requestBudget: env.BREWFATHER_REQUEST_BUDGET === undefined ? undefined : Number(env.BREWFATHER_REQUEST_BUDGET),
    ...options
  });
}
