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
  | "configuration";

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
}

function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
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

  #requestTimes: number[] = [];
  #blockedUntil: number = 0;

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
  }

  #consumeBudget(): void {
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

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: {
      readonly query?: Record<string, string | number | undefined>;
      readonly body?: unknown;
      readonly notFoundAsNull?: boolean;
    } = {},
  ): Promise<T | null> {
    this.#consumeBudget();

    const url = new URL(path, this.#origin);
    if (options.query !== undefined) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    const authHeader = `Basic ${Buffer.from(`${this.#userId}:${this.#apiKey}`).toString("base64")}`;

    try {
      let response: Response;
      try {
        response = await this.#fetchFn(url.toString(), {
          method,
          signal: controller.signal,
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error: unknown) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new BrewfatherError("timeout", "Brewfather request timed out.");
        }
        throw new BrewfatherError(
          "network",
          `Brewfather network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }

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
        const retryAfterHeader = response.headers.get("retry-after");
        const retryMs = parseRetryAfter(retryAfterHeader, this.#now());
        if (retryMs !== null) {
          this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + retryMs);
        }
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

      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > this.#maxResponseBytes) {
        throw new BrewfatherError(
          "response_too_large",
          `Brewfather response exceeded maximum size of ${this.#maxResponseBytes} bytes.`,
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BrewfatherError("invalid_response", "Brewfather returned malformed JSON.");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async listBatches(options: {
    readonly status: string;
    readonly startAfter?: string;
  }): Promise<readonly Record<string, unknown>[]> {
    const result = await this.request<unknown>("GET", "/v2/batches", {
      query: {
        status: options.status,
        limit: 50,
        include: BATCH_SUMMARY_INCLUDE,
        ...(options.startAfter ? { start_after: options.startAfter } : {}),
      },
    });

    if (!Array.isArray(result)) {
      throw new BrewfatherError("invalid_response", "Brewfather batch list was not an array.");
    }
    return result as readonly Record<string, unknown>[];
  }

  async listBatchesByStatuses(statuses: readonly string[]): Promise<{
    readonly batches: readonly Record<string, unknown>[];
    readonly failures: readonly { readonly status: string; readonly error: BrewfatherError }[];
  }> {
    const batches: Record<string, unknown>[] = [];
    const failures: { readonly status: string; readonly error: BrewfatherError }[] = [];
    let totalPages = 0;

    for (const status of statuses) {
      let startAfter: string | undefined;
      try {
        while (true) {
          if (++totalPages > this.#maxPages) {
            break;
          }
          const page = await this.listBatches({
            status,
            ...(startAfter !== undefined ? { startAfter } : {}),
          });
          for (const item of page) {
            batches.push({ ...item, status: item.status ?? status });
          }
          if (batches.length >= this.#maxItems || page.length < 50) {
            break;
          }
          const lastItem = page[page.length - 1];
          const nextId = lastItem?._id ?? lastItem?.id;
          if (typeof nextId !== "string" || nextId.length === 0) {
            break;
          }
          startAfter = nextId;
        }
      } catch (error: unknown) {
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

    return { batches, failures };
  }

  async getBatch(batchId: string): Promise<Record<string, unknown> | null> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/v2/batches/${encodeURIComponent(batchId)}`,
      {
        notFoundAsNull: true,
      },
    );
  }

  async getRecipe(recipeId: string): Promise<Record<string, unknown> | null> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/v2/recipes/${encodeURIComponent(recipeId)}`,
      {
        notFoundAsNull: true,
      },
    );
  }
}
