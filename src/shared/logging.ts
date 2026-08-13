import { isApplicationError, isObviousSecretKey } from "./errors.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const MAX_DEPTH = 8;
const MAX_COLLECTION_SIZE = 100;

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sanitizeError(error: Error): Record<string, string> {
  if (isApplicationError(error)) {
    return { name: error.name, category: error.category, code: error.code };
  }

  return { name: error.name || "Error" };
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number, key?: string): unknown {
  if (key !== undefined && isObviousSecretKey(key)) {
    return "[REDACTED]";
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "[Undefined]";
  }
  if (typeof value === "symbol") {
    return value.description === undefined ? "[Symbol]" : `[Symbol:${value.description}]`;
  }
  if (typeof value === "function") {
    return `[Function:${value.name || "anonymous"}]`;
  }
  if (value instanceof Error) {
    return sanitizeError(value);
  }
  if (depth >= MAX_DEPTH) {
    return "[MaxDepth]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_COLLECTION_SIZE).map((entry) => sanitize(entry, seen, depth + 1));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_COLLECTION_SIZE)) {
      sanitized[entryKey] = sanitize(entryValue, seen, depth + 1, entryKey);
    }
    return sanitized;
  } catch {
    return "[Unserializable]";
  } finally {
    seen.delete(value);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  function write(level: LogLevel, message: string, context?: LogContext): void {
    try {
      const record: Record<string, unknown> = {
        timestamp: now().toISOString(),
        level,
        message,
      };
      if (context !== undefined) {
        record.context = sanitize(context, new WeakSet<object>(), 0);
      }
      sink(JSON.stringify(record));
    } catch {
      // Logging must never change application control flow.
    }
  }

  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}
