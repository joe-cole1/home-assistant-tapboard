import { pathToFileURL } from "node:url";

import { loadConfig, type ApplicationConfig } from "../config.ts";
import { createAuthService, type AuthService } from "../features/auth/service.ts";
import { openDatabase, type DatabaseConnection } from "../infrastructure/database/connection.ts";
import {
  readOperatorLines,
  rejectCommandArguments,
  safeFailure,
  type OperatorInputStream,
  type OperatorOutput,
} from "./input.ts";

export interface ResetPinCommandOptions {
  readonly argv?: readonly string[];
  readonly stdin?: OperatorInputStream;
  readonly stdout?: OperatorOutput;
  readonly stderr?: OperatorOutput;
  readonly config?: ApplicationConfig;
  readonly openDatabase?: (path: string) => DatabaseConnection;
  readonly database?: DatabaseConnection;
  readonly auth?: Pick<AuthService, "resetOperatorPin">;
}

const processInput = process.stdin as unknown as OperatorInputStream;
const processOutput = process.stdout as unknown as OperatorOutput;
const processError = process.stderr as unknown as OperatorOutput;

export async function runResetPin(options: ResetPinCommandOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv;
  const stdin = options.stdin ?? processInput;
  const stdout = options.stdout ?? processOutput;
  const stderr = options.stderr ?? processError;
  let database: DatabaseConnection | undefined = options.database;
  try {
    rejectCommandArguments(argv);
    const config = options.config ?? loadConfig();
    database ??= (options.openDatabase ?? openDatabase)(config.databasePath);
    const authOptions = {
      ...(config.canonicalExternalOrigin === undefined
        ? {}
        : { canonicalOrigin: config.canonicalExternalOrigin }),
      ...(config.sessionInactivityMs === undefined && config.sessionAbsoluteMs === undefined
        ? {}
        : {
            session: {
              ...(config.sessionInactivityMs === undefined
                ? {}
                : { inactivityMs: config.sessionInactivityMs }),
              ...(config.sessionAbsoluteMs === undefined
                ? {}
                : { absoluteMs: config.sessionAbsoluteMs }),
            },
          }),
    };
    const auth = options.auth ?? createAuthService(database, authOptions);
    const [pin] = await readOperatorLines(stdin, 1);
    if (pin === undefined) throw new Error("Operator PIN is missing");
    const status = await auth.resetOperatorPin(pin);
    stdout.write(`Operator PIN reset. Revision: ${status.revision ?? 0}.\n`);
    return 0;
  } catch {
    safeFailure(stderr);
    return 1;
  } finally {
    database?.close();
  }
}

export const resetOperatorPinCommand = runResetPin;
export const runResetPinCommand = runResetPin;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runResetPin().then((code) => {
    process.exitCode = code;
  });
}
