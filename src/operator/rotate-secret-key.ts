import { pathToFileURL } from "node:url";

import { loadConfig, type ApplicationConfig } from "../config.ts";
import { createSecretsService, type SecretsService } from "../features/secrets/service.ts";
import { openDatabase, type DatabaseConnection } from "../infrastructure/database/connection.ts";
import {
  readOperatorLines,
  rejectCommandArguments,
  safeFailure,
  type OperatorInputStream,
  type OperatorOutput,
} from "./input.ts";

export interface RotateSecretKeyCommandOptions {
  readonly argv?: readonly string[];
  readonly stdin?: OperatorInputStream;
  readonly stdout?: OperatorOutput;
  readonly stderr?: OperatorOutput;
  readonly config?: ApplicationConfig;
  readonly openDatabase?: (path: string) => DatabaseConnection;
  readonly database?: DatabaseConnection;
  readonly secrets?: Pick<SecretsService, "rotateRootKey">;
}

const processInput = process.stdin as unknown as OperatorInputStream;
const processOutput = process.stdout as unknown as OperatorOutput;
const processError = process.stderr as unknown as OperatorOutput;

export async function runRotateSecretKey(
  options: RotateSecretKeyCommandOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv;
  const stdin = options.stdin ?? processInput;
  const stdout = options.stdout ?? processOutput;
  const stderr = options.stderr ?? processError;
  let database: DatabaseConnection | undefined = options.database;
  try {
    rejectCommandArguments(argv);
    const config = options.config ?? loadConfig();
    database ??= (options.openDatabase ?? openDatabase)(config.databasePath);
    // The configured environment key is never used as either rotation input.
    const secrets = options.secrets ?? createSecretsService(database);
    const lines = await readOperatorLines(stdin, 2);
    const oldKey = lines[0];
    const newKey = lines[1];
    if (oldKey === undefined || newKey === undefined) throw new Error("Secret keys are missing");
    const result = secrets.rotateRootKey(oldKey, newKey);
    stdout.write(
      `Secret key rotation completed. Rotated: ${result.rotated}. Generation: ${result.generation}.\n`,
    );
    return 0;
  } catch {
    safeFailure(stderr);
    return 1;
  } finally {
    database?.close();
  }
}

export const rotateSecretKeyCommand = runRotateSecretKey;
export const runRotateSecretKeyCommand = runRotateSecretKey;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runRotateSecretKey().then((code) => {
    process.exitCode = code;
  });
}
