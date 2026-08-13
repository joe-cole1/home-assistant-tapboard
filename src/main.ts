import { pathToFileURL } from "node:url";

import { createApplication, type Application } from "./application.ts";
import { createLogger, type Logger } from "./shared/logging.ts";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface RuntimeProcess {
  exitCode: number | undefined;
  once(event: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
  off(event: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
}

export interface RunApplicationOptions {
  readonly application: Application;
  readonly logger: Logger;
  readonly runtimeProcess?: RuntimeProcess;
}

export async function runApplication(options: RunApplicationOptions): Promise<void> {
  const { application, logger, runtimeProcess = process } = options;
  let shutdown: Promise<void> | undefined;
  let stopRequested = false;

  function removeSignalHandlers(): void {
    runtimeProcess.off("SIGINT", onSignal);
    runtimeProcess.off("SIGTERM", onSignal);
  }

  function onSignal(signal: ShutdownSignal): void {
    if (shutdown !== undefined) return;

    stopRequested = true;
    removeSignalHandlers();
    logger.info("Application shutdown requested", { signal });
    shutdown = (async () => {
      try {
        await application.stop();
        logger.info("Application stopped");
      } catch (error) {
        logger.error("Application shutdown failed", { error });
        runtimeProcess.exitCode = 1;
      }
    })();
  }

  runtimeProcess.once("SIGINT", onSignal);
  runtimeProcess.once("SIGTERM", onSignal);

  try {
    const address = await application.start();
    if (stopRequested) {
      await shutdown;
      return;
    }
    logger.info("Application started", { host: address.address, port: address.port });
  } catch (error) {
    if (stopRequested) {
      await shutdown;
      return;
    }

    removeSignalHandlers();
    logger.error("Application startup failed", { error });
    runtimeProcess.exitCode = 1;
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isDirectExecution()) {
  const logger = createLogger();
  try {
    const application = createApplication({ logger });
    void runApplication({ application, logger });
  } catch (error) {
    logger.error("Application startup failed", { error });
    process.exitCode = 1;
  }
}
