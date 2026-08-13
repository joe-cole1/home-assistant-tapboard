import { resolve } from "node:path";

import { requireBoundedNonemptyString, requireIntegerInRange } from "./shared/validation.ts";

export interface ApplicationConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  readonly shutdownGraceMs: number;
}

export interface LoadConfigOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly baseDirectory?: string;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: string,
): string {
  return env[key] ?? fallback;
}

export function loadConfig(options: LoadConfigOptions = {}): ApplicationConfig {
  const env = options.env ?? process.env;
  const baseDirectory = resolve(options.baseDirectory ?? process.cwd());
  const host = requireBoundedNonemptyString(
    envValue(env, "TAPBOARD_HOST", "127.0.0.1"),
    "TAPBOARD_HOST",
    { maxLength: 255 },
  );
  const port = requireIntegerInRange(
    envValue(env, "TAPBOARD_PORT", "3000"),
    "TAPBOARD_PORT",
    0,
    65_535,
  );
  const databasePathValue = requireBoundedNonemptyString(
    envValue(env, "TAPBOARD_DATABASE_PATH", "data/tapboard-v2.sqlite3"),
    "TAPBOARD_DATABASE_PATH",
    { maxLength: 4096 },
  );
  const shutdownGraceMs = requireIntegerInRange(
    envValue(env, "TAPBOARD_SHUTDOWN_GRACE_MS", "5000"),
    "TAPBOARD_SHUTDOWN_GRACE_MS",
    1,
    300_000,
  );

  return {
    host,
    port,
    databasePath: resolve(baseDirectory, databasePathValue),
    shutdownGraceMs,
  };
}
