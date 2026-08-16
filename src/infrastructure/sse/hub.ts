export interface SseResponse {
  setHeader?(name: string, value: string): void;
  writeHead?(status: number, headers?: Readonly<Record<string, string>>): void;
  write(chunk: string): boolean;
  end(): void;
  destroy?(error?: Error): void;
  on(event: "close" | "error" | "drain", listener: () => void): unknown;
  off?(event: "close" | "error" | "drain", listener: () => void): unknown;
}

export interface SseClientContext {
  readonly isAdmin?: boolean;
  readonly [key: string]: unknown;
}
export interface SseHubOptions<C extends SseClientContext = SseClientContext> {
  readonly heartbeatMs?: number;
  readonly maxClients?: number;
  readonly maxQueuedEvents?: number;
  readonly maxQueuedBytes?: number;
  readonly retryMs?: number;
  readonly authRevalidate?: (context: C) => boolean | Promise<boolean>;
  readonly authRevalidateMs?: number;
}
export interface SsePublishOptions {
  readonly dirtyKey?: string;
}
export interface SseHubStats {
  readonly clients: number;
  readonly blockedClients: number;
  readonly queuedEvents: number;
  readonly queuedBytes: number;
}

interface NormalizedOptions<C extends SseClientContext> {
  readonly heartbeatMs: number;
  readonly maxClients: number;
  readonly maxQueuedEvents: number;
  readonly maxQueuedBytes: number;
  readonly retryMs: number;
  readonly authRevalidateMs: number;
  readonly authRevalidate?: (context: C) => boolean | Promise<boolean>;
}

interface Queued {
  frame: string;
  bytes: number;
  dirtyKey?: string;
}
interface Client<C> {
  response: SseResponse;
  context: C;
  blocked: boolean;
  queue: Queued[];
  bytes: number;
  close: () => void;
  drain: () => void;
  error: () => void;
}

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

export class SseHub<C extends SseClientContext = SseClientContext> {
  readonly #clients = new Set<Client<C>>();
  readonly #options: NormalizedOptions<C>;
  readonly #heartbeat: ReturnType<typeof setInterval> | undefined;
  readonly #authTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #checkingAuth = false;

  constructor(options: SseHubOptions<C> = {}) {
    const defaults = {
      heartbeatMs: options.heartbeatMs ?? 15_000,
      maxClients: options.maxClients ?? 32,
      maxQueuedEvents: options.maxQueuedEvents ?? 64,
      maxQueuedBytes: options.maxQueuedBytes ?? 65_536,
      retryMs: options.retryMs ?? 3_000,
      authRevalidateMs: options.authRevalidateMs ?? 0,
    };
    this.#options =
      options.authRevalidate === undefined
        ? defaults
        : { ...defaults, authRevalidate: options.authRevalidate };
    for (const value of [
      this.#options.heartbeatMs,
      this.#options.maxClients,
      this.#options.maxQueuedEvents,
      this.#options.maxQueuedBytes,
      this.#options.retryMs,
      this.#options.authRevalidateMs,
    ])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("SSE options are invalid");
    if (this.#options.heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => this.#ping(), this.#options.heartbeatMs);
      this.#heartbeat.unref?.();
    }
    if (this.#options.authRevalidate && this.#options.authRevalidateMs > 0) {
      this.#authTimer = setInterval(() => void this.#revalidate(), this.#options.authRevalidateMs);
      this.#authTimer.unref?.();
    }
  }

  connect(response: SseResponse, context: C = {} as C): boolean {
    if (this.#stopped || this.#clients.size >= this.#options.maxClients) {
      response.writeHead?.(503, { "cache-control": "no-store" });
      response.end();
      return false;
    }
    response.setHeader?.("content-type", "text/event-stream; charset=utf-8");
    response.setHeader?.("cache-control", "no-store");
    response.setHeader?.("connection", "keep-alive");
    const client = {} as Client<C>;
    client.response = response;
    client.context = context;
    client.blocked = false;
    client.queue = [];
    client.bytes = 0;
    client.close = () => this.#remove(client);
    client.error = () => this.#remove(client);
    client.drain = () => this.#drain(client);
    response.on("close", client.close);
    response.on("error", client.error);
    response.on("drain", client.drain);
    this.#clients.add(client);
    try {
      if (!response.write(`retry: ${this.#options.retryMs}\n: connected\n\n`))
        client.blocked = true;
    } catch {
      this.#remove(client);
      return false;
    }
    return true;
  }

  publish(name: string, value: unknown, options: SsePublishOptions = {}): void {
    if (!EVENT_NAME.test(name)) throw new TypeError("Invalid SSE event name");
    let json: string;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError("undefined JSON value");
      json = serialized;
    } catch {
      throw new TypeError("SSE event value must be JSON serializable");
    }
    const frame = `event: ${name}\ndata: ${json}\n\n`;
    for (const client of [...this.#clients]) this.#send(client, frame, options.dirtyKey);
  }
  broadcast(name: string, value: unknown, options: SsePublishOptions = {}): void {
    this.publish(name, value, options);
  }
  stats(): SseHubStats {
    let queuedEvents = 0;
    let queuedBytes = 0;
    let blockedClients = 0;
    for (const c of this.#clients) {
      queuedEvents += c.queue.length;
      queuedBytes += c.bytes;
      if (c.blocked) blockedClients += 1;
    }
    return { clients: this.#clients.size, blockedClients, queuedEvents, queuedBytes };
  }
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#authTimer) clearInterval(this.#authTimer);
    for (const client of [...this.#clients]) {
      try {
        client.response.end();
      } finally {
        this.#remove(client);
      }
    }
  }

  #send(client: Client<C>, frame: string, dirtyKey: string | undefined): void {
    if (client.blocked) {
      this.#queue(client, frame, dirtyKey);
      return;
    }
    try {
      if (!client.response.write(frame)) client.blocked = true;
    } catch {
      this.#remove(client);
    }
  }
  #queue(client: Client<C>, frame: string, dirtyKey: string | undefined): void {
    const bytes = Buffer.byteLength(frame);
    if (dirtyKey !== undefined) {
      const index = client.queue.findIndex((item) => item.dirtyKey === dirtyKey);
      if (index >= 0) {
        const old = client.queue[index]!;
        client.bytes -= old.bytes;
        client.queue[index] = { frame, bytes, dirtyKey };
        client.bytes += bytes;
        this.#overflow(client);
        return;
      }
    }
    client.queue.push(dirtyKey === undefined ? { frame, bytes } : { frame, bytes, dirtyKey });
    client.bytes += bytes;
    this.#overflow(client);
  }
  #overflow(client: Client<C>): void {
    if (
      client.queue.length > this.#options.maxQueuedEvents ||
      client.bytes > this.#options.maxQueuedBytes
    ) {
      try {
        client.response.destroy?.();
      } finally {
        this.#remove(client);
      }
    }
  }
  #drain(client: Client<C>): void {
    if (!this.#clients.has(client)) return;
    client.blocked = false;
    while (!client.blocked && client.queue.length > 0) {
      const item = client.queue.shift()!;
      client.bytes -= item.bytes;
      try {
        if (!client.response.write(item.frame)) client.blocked = true;
      } catch {
        this.#remove(client);
        return;
      }
    }
  }
  #ping(): void {
    if (this.#stopped) return;
    for (const client of [...this.#clients])
      if (!client.blocked) {
        try {
          if (!client.response.write(": ping\n\n")) client.blocked = true;
        } catch {
          this.#remove(client);
        }
      }
  }
  async #revalidate(): Promise<void> {
    if (this.#checkingAuth || !this.#options.authRevalidate) return;
    this.#checkingAuth = true;
    try {
      for (const client of [...this.#clients])
        if (client.context.isAdmin) {
          let valid = false;
          try {
            valid = await this.#options.authRevalidate(client.context);
          } catch {
            valid = false;
          }
          if (!valid) {
            try {
              client.response.end();
            } finally {
              this.#remove(client);
            }
          }
        }
    } finally {
      this.#checkingAuth = false;
    }
  }
  #remove(client: Client<C>): void {
    if (!this.#clients.delete(client)) return;
    client.response.off?.("close", client.close);
    client.response.off?.("error", client.error);
    client.response.off?.("drain", client.drain);
    client.queue.length = 0;
    client.bytes = 0;
  }
}
