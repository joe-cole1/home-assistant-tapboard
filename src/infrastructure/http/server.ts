import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "../../shared/logging.ts";
import type { Router } from "./router.ts";

export interface HttpServerAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

export interface HttpServerOptions {
  readonly router: Router;
  readonly logger: Logger;
  readonly shutdownGraceMs: number;
  readonly createNodeServer?: typeof createServer;
}

export class HttpServer {
  readonly #server: Server;
  readonly #logger: Logger;
  readonly #shutdownGraceMs: number;
  #started = false;
  #starting: Promise<HttpServerAddress> | undefined;
  #stopping: Promise<void> | undefined;

  constructor(options: HttpServerOptions) {
    this.#logger = options.logger;
    this.#shutdownGraceMs = options.shutdownGraceMs;
    const serverFactory = options.createNodeServer ?? createServer;
    this.#server = serverFactory((request, response) => {
      void options.router.handle(request, response).catch((error: unknown) => {
        this.#logger.error("HTTP router failed outside centralized error handling", { error });
        response.destroy();
      });
    });
  }

  start(host: string, port: number): Promise<HttpServerAddress> {
    if (this.#stopping !== undefined) {
      return Promise.reject(new Error("HTTP server is stopping"));
    }
    if (this.#started) {
      return Promise.resolve(this.address());
    }
    if (this.#starting !== undefined) {
      return this.#starting;
    }

    this.#starting = new Promise<HttpServerAddress>((resolve, reject) => {
      const cleanup = (): void => {
        this.#server.off("error", onError);
        this.#server.off("listening", onListening);
      };
      const onError = (error: Error): void => {
        cleanup();
        this.#starting = undefined;
        reject(error);
      };
      const onListening = (): void => {
        cleanup();
        this.#started = true;
        this.#starting = undefined;
        resolve(this.address());
      };

      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      try {
        this.#server.listen(port, host);
      } catch (error) {
        cleanup();
        this.#starting = undefined;
        reject(error instanceof Error ? error : new Error("HTTP server listen failed"));
      }
    });

    return this.#starting;
  }

  address(): HttpServerAddress {
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("HTTP server does not have a TCP address");
    }

    const tcpAddress: AddressInfo = address;
    return {
      address: tcpAddress.address,
      family: tcpAddress.family,
      port: tcpAddress.port,
    };
  }

  stop(): Promise<void> {
    if (this.#stopping !== undefined) {
      return this.#stopping;
    }
    if (!this.#started) {
      return Promise.resolve();
    }

    this.#stopping = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        this.#logger.warn("HTTP shutdown grace period elapsed");
        this.#server.closeAllConnections();
      }, this.#shutdownGraceMs);
      timer.unref();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#started = false;
        this.#starting = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };

      try {
        this.#server.close(finish);
        this.#server.closeIdleConnections();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("HTTP server close failed"));
      }
    });

    return this.#stopping;
  }
}
