const ORIGIN = "https://api.brewfather.app";

const BATCH_SUMMARY_INCLUDE = [
  "recipe._id",
  "recipe.name",
  "recipe.type",
  "recipe.style",
  "recipe.description",
  "recipe.ibu",
  "recipe.color",
  "recipe.abv",
  "recipe.og",
  "recipe.fg",
  "estimatedOg",
  "estimatedFg",
  "estimatedAbv",
  "measuredOg",
  "measuredFg",
  "measuredAbv",
  "estimatedIbu",
  "estimatedColor",
  "startDate",
  "brewDate",
  "status",
  "brewer",
  "batchNo",
].join(",");

export type BrewfatherErrorCategory =
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "response_too_large"
  | "invalid_response"
  | "transient"
  | "configuration"
  | "disposed";

export class BrewfatherError extends Error {
  readonly category: BrewfatherErrorCategory;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    category: BrewfatherErrorCategory,
    message: string,
    options: { readonly status?: number | null; readonly retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "BrewfatherError";
    this.category = category;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface BrewfatherAdapterOptions {
  readonly userId: string;
  readonly apiKey: string;
  readonly origin?: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly requestBudget?: number;
  readonly budgetWindowMs?: number;
  readonly maxPages?: number;
  readonly maxItems?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number | ((attempt: number) => number);
}

interface BrewfatherRequestOptions {
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly notFoundAsNull?: boolean;
  readonly allowTextResponse?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason instanceof BrewfatherError
          ? signal.reason
          : new BrewfatherError("timeout", "Brewfather request timed out."),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    // Remove each read's listener when it settles so chunk count cannot grow the listener set.
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("Brewfather transport failed."));
      },
    );
  });
}

export const MIN_RETRY_AFTER_MS = 1_000; // 1 second
export const MAX_RETRY_AFTER_MS = 3_600_000; // 1 hour

export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const ms = seconds * 1000;
    return Math.max(MIN_RETRY_AFTER_MS, Math.min(MAX_RETRY_AFTER_MS, ms));
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const diffMs = parsed - now;
    return Math.max(MIN_RETRY_AFTER_MS, Math.min(MAX_RETRY_AFTER_MS, diffMs));
  }
  return null;
}

export class BrewfatherAdapter {
  readonly #userId: string;
  readonly #apiKey: string;
  readonly #origin: string;
  readonly #fetchFn: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #requestBudget: number;
  readonly #budgetWindowMs: number;
  readonly #maxPages: number;
  readonly #maxItems: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number | ((attempt: number) => number);

  #requestTimes: number[] = [];
  #blockedUntil: number = 0;
  #disposed = false;
  readonly #controllers = new Set<AbortController>();

  constructor(options: BrewfatherAdapterOptions) {
    if (!options.userId || !options.apiKey) {
      throw new BrewfatherError("configuration", "Brewfather userId and apiKey are required.");
    }
    this.#userId = options.userId;
    this.#apiKey = options.apiKey;
    this.#origin = options.origin ?? ORIGIN;
    this.#fetchFn = options.fetchFn ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 1_048_576; // 1MB
    this.#requestBudget = options.requestBudget ?? 100;
    this.#budgetWindowMs = options.budgetWindowMs ?? 3_600_000; // 1 hour
    this.#maxPages = options.maxPages ?? 5;
    this.#maxItems = options.maxItems ?? 250;
    this.#maxRetries = options.maxRetries ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
  }

  /** Permanently cancel current work; a disposed adapter cannot issue another request. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#controllers) {
      controller.abort(new BrewfatherError("disposed", "Brewfather integration is shut down."));
    }
    this.#controllers.clear();
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new BrewfatherError("disposed", "Brewfather integration is shut down.");
    }
  }

  #waitForRetry(delay: number): Promise<void> {
    this.#assertActive();
    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        this.#controllers.delete(controller);
        if (error === undefined) resolve();
        else reject(error);
      };
      const abort = () =>
        finish(new BrewfatherError("disposed", "Brewfather integration is shut down."));
      const timer = setTimeout(() => finish(), delay);
      controller.signal.addEventListener("abort", abort, { once: true });
      this.#controllers.add(controller);
    });
  }

  #consumeBudget(): void {
    this.#assertActive();
    const current = this.#now();
    if (current < this.#blockedUntil) {
      throw new BrewfatherError(
        "rate_limited",
        `Brewfather requests are temporarily rate limited. Retry in ${Math.ceil((this.#blockedUntil - current) / 1000)}s.`,
        { retryAfterMs: this.#blockedUntil - current },
      );
    }
    const cutoff = current - this.#budgetWindowMs;
    this.#requestTimes = this.#requestTimes.filter((time) => time > cutoff);
    if (this.#requestTimes.length >= this.#requestBudget) {
      const earliest = this.#requestTimes[0] ?? current;
      const retryIn = Math.max(1, earliest + this.#budgetWindowMs - current);
      throw new BrewfatherError(
        "rate_limited",
        "Brewfather request budget exceeded for the current window.",
        { retryAfterMs: retryIn },
      );
    }
    this.#requestTimes.push(current);
  }

  async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: BrewfatherRequestOptions = {},
  ): Promise<unknown> {
    let attempt = 0;
    while (true) {
      this.#consumeBudget();
      try {
        const result = await this.#requestAttempt(method, path, options);
        this.#assertActive();
        return result;
      } catch (error: unknown) {
        this.#assertActive();
        const retryable =
          error instanceof BrewfatherError &&
          (error.category === "timeout" ||
            error.category === "network" ||
            (error.category === "transient" && error.status !== null && error.status >= 500));
        if (!retryable || attempt >= this.#maxRetries) {
          throw error;
        }
        attempt += 1;
        const delay =
          typeof this.#retryDelayMs === "function"
            ? this.#retryDelayMs(attempt)
            : this.#retryDelayMs;
        if (delay > 0) await this.#waitForRetry(delay);
      }
    }
  }

  async #requestAttempt(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: BrewfatherRequestOptions,
  ): Promise<unknown> {
    this.#assertActive();
    const url = new URL(path, this.#origin);
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const clearDeadline = () => clearTimeout(timer);
    controller.signal.addEventListener("abort", clearDeadline, { once: true });
    this.#controllers.add(controller);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyComplete = false;

    try {
      const fetching = this.#fetchFn(url.toString(), {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.#userId}:${this.#apiKey}`).toString("base64")}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      }).then((result) => {
        // A custom transport may resolve after it has been aborted. Dispose its late body too.
        if (controller.signal.aborted) {
          void result.body?.cancel().catch(() => undefined);
        }
        return result;
      });
      response = await withinDeadline(fetching, controller.signal);
      this.#assertActive();

      if (response.status === 404 && options.notFoundAsNull) {
        return null;
      }

      if (response.status === 401) {
        throw new BrewfatherError("auth", "Brewfather authentication failed (401).", {
          status: 401,
        });
      }

      if (response.status === 403) {
        throw new BrewfatherError("forbidden", "Brewfather access forbidden (403).", {
          status: 403,
        });
      }

      if (response.status === 404) {
        throw new BrewfatherError("not_found", "Brewfather resource not found (404).", {
          status: 404,
        });
      }

      if (response.status === 429) {
        const parsedRetryMs = parseRetryAfter(response.headers.get("retry-after"), this.#now());
        const retryMs = parsedRetryMs ?? 60_000;
        this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + retryMs);
        throw new BrewfatherError("rate_limited", "Brewfather rate limit exceeded (429).", {
          status: 429,
          retryAfterMs: retryMs,
        });
      }

      if (!response.ok) {
        throw new BrewfatherError(
          "transient",
          `Brewfather returned unsuccessful status ${response.status}.`,
          { status: response.status },
        );
      }

      const oversized = () =>
        new BrewfatherError(
          "response_too_large",
          `Brewfather response exceeded maximum size of ${this.#maxResponseBytes} bytes.`,
        );
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        /^\d+$/.test(contentLength.trim()) &&
        Number(contentLength) > this.#maxResponseBytes
      ) {
        throw oversized();
      }

      let text = "";
      if (response.body !== null) {
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let receivedBytes = 0;
        while (true) {
          const chunk = await withinDeadline(reader.read(), controller.signal);
          this.#assertActive();
          if (chunk.done) break;
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > this.#maxResponseBytes) {
            throw oversized();
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      }
      bodyComplete = true;

      if (text.trim().length === 0) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        if (options.allowTextResponse) return text;
        throw new BrewfatherError(
          "invalid_response",
          `Brewfather response for ${method} ${path} was not valid JSON.`,
        );
      }
    } catch (error: unknown) {
      if (error instanceof BrewfatherError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new BrewfatherError("timeout", "Brewfather request timed out.");
      }
      throw new BrewfatherError("network", "Brewfather network request failed.");
    } finally {
      try {
        if (!bodyComplete) {
          // Keep cleanup within this attempt's deadline, including an uncooperative stream.
          const cancellation = reader ? reader.cancel() : response?.body?.cancel();
          if (cancellation) await withinDeadline(cancellation, controller.signal);
        }
      } catch {
        // Preserve the request's typed error when transport cleanup fails.
      } finally {
        if (!bodyComplete) controller.abort();
        reader?.releaseLock();
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", clearDeadline);
        this.#controllers.delete(controller);
      }
    }
  }

  async listBatches(options: {
    readonly status: string;
    readonly startAfter?: string;
  }): Promise<readonly Record<string, unknown>[]> {
    const result = await this.request("GET", "/v2/batches", {
      query: {
        status: options.status,
        limit: 50,
        include: BATCH_SUMMARY_INCLUDE,
        ...(options.startAfter ? { start_after: options.startAfter } : {}),
      },
    });
    this.#assertActive();

    if (!Array.isArray(result)) {
      throw new BrewfatherError("invalid_response", "Brewfather batch list was not an array.");
    }
    if (!result.every(isRecord)) {
      throw new BrewfatherError(
        "invalid_response",
        "Brewfather batch list contained a non-record.",
      );
    }
    return result;
  }

  async listBatchesByStatuses(statuses: readonly string[]): Promise<{
    readonly batches: readonly Record<string, unknown>[];
    readonly failures: readonly { readonly status: string; readonly error: BrewfatherError }[];
    readonly complete: boolean;
  }> {
    this.#assertActive();
    const batches: Record<string, unknown>[] = [];
    const failures: { readonly status: string; readonly error: BrewfatherError }[] = [];
    let complete = true;

    for (const status of statuses) {
      let startAfter: string | undefined;
      let statusPages = 0;
      try {
        while (true) {
          if (statusPages >= this.#maxPages) {
            complete = false;
            break;
          }
          statusPages += 1;
          const page = await this.listBatches({
            status,
            ...(startAfter !== undefined ? { startAfter } : {}),
          });
          this.#assertActive();
          for (const item of page) {
            batches.push({ ...item, status: item.status ?? status });
            if (batches.length >= this.#maxItems) {
              complete = false;
              break;
            }
          }
          if (batches.length >= this.#maxItems) {
            complete = false;
            break;
          }
          if (page.length < 50) {
            break;
          }
          const lastItem = page[page.length - 1];
          const nextId = lastItem?._id ?? lastItem?.id;
          if (typeof nextId !== "string" || nextId.length === 0) {
            complete = false;
            break;
          }
          startAfter = nextId;
        }
      } catch (error: unknown) {
        this.#assertActive();
        complete = false;
        const brewError =
          error instanceof BrewfatherError
            ? error
            : new BrewfatherError("transient", "Failed to list batches for status.");
        failures.push({ status, error: brewError });
        if (["auth", "forbidden", "rate_limited"].includes(brewError.category)) {
          break;
        }
      }
    }

    if (failures.length > 0) {
      complete = false;
    }

    return { batches, failures, complete };
  }

  async getBatch(batchId: string): Promise<Record<string, unknown> | null> {
    const result = await this.request("GET", `/v2/batches/${encodeURIComponent(batchId)}`, {
      notFoundAsNull: true,
    });
    this.#assertActive();
    if (result === null || isRecord(result)) return result;
    throw new BrewfatherError("invalid_response", "Brewfather batch was not a record.");
  }

  async getRecipe(recipeId: string): Promise<Record<string, unknown> | null> {
    const result = await this.request("GET", `/v2/recipes/${encodeURIComponent(recipeId)}`, {
      notFoundAsNull: true,
    });
    this.#assertActive();
    if (result === null || isRecord(result)) return result;
    throw new BrewfatherError("invalid_response", "Brewfather recipe was not a record.");
  }

  async updateBatchStatus(
    batchId: string,
    status: string,
  ): Promise<Record<string, unknown> | string | null> {
    const result = await this.request("PATCH", `/v2/batches/${encodeURIComponent(batchId)}`, {
      body: { status },
      allowTextResponse: true,
    });
    this.#assertActive();
    if (result === null || typeof result === "string" || isRecord(result)) return result;
    throw new BrewfatherError(
      "invalid_response",
      "Brewfather PATCH response had an invalid shape.",
    );
  }
}
