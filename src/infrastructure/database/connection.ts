import BetterSqlite3 from "better-sqlite3";

import { FOUNDATION_MIGRATIONS, initializeSchema, type MigrationDefinition } from "./migrations.ts";

export interface StatementResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface DatabaseStatement<Bindings extends unknown[] = unknown[], Row = unknown> {
  run(...bindings: Bindings): StatementResult;
  get(...bindings: Bindings): Row | undefined;
  all(...bindings: Bindings): Row[];
}

export interface DatabaseExecutor {
  execute(sql: string): void;
  prepare<Bindings extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): DatabaseStatement<Bindings, Row>;
  pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }): Result;
  withTransaction<Result>(work: () => Synchronous<Result>): Result;
}

type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result;

export interface DatabaseConnection extends DatabaseExecutor {
  readonly isOpen: boolean;
  close(): void;
}

export interface OpenDatabaseOptions {
  readonly migrations?: readonly MigrationDefinition[];
}

class ControlledDatabaseConnection implements DatabaseConnection {
  readonly #database: BetterSqlite3.Database;

  constructor(database: BetterSqlite3.Database) {
    this.#database = database;
  }

  get isOpen(): boolean {
    return this.#database.open;
  }

  execute(sql: string): void {
    this.#assertOpen();
    this.#database.exec(sql);
  }

  prepare<Bindings extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): DatabaseStatement<Bindings, Row> {
    this.#assertOpen();
    const statement = this.#database.prepare<Bindings, Row>(sql);

    return {
      run: (...bindings) => statement.run(...bindings),
      get: (...bindings) => statement.get(...bindings),
      all: (...bindings) => statement.all(...bindings),
    };
  }

  pragma<Result = unknown>(statement: string, options?: { readonly simple?: boolean }): Result {
    this.#assertOpen();
    return this.#database.pragma(statement, options) as Result;
  }

  withTransaction<Result>(work: () => Synchronous<Result>): Result {
    this.#assertOpen();

    const transaction = this.#database.transaction(() => {
      const result: Result = work();

      if (isPromiseLike(result)) {
        throw new TypeError("Database transactions must complete synchronously");
      }

      return result;
    });

    return transaction.immediate();
  }

  close(): void {
    if (this.#database.open) {
      this.#database.close();
    }
  }

  #assertOpen(): void {
    if (!this.#database.open) {
      throw new Error("Database connection is closed");
    }
  }
}

function isPromiseLike(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }

  return "then" in value && typeof value.then === "function";
}

function verifyForeignKeys(database: DatabaseExecutor): void {
  database.pragma("foreign_keys = ON");
  const enabled = database.pragma<number>("foreign_keys", { simple: true });

  if (enabled !== 1) {
    throw new Error("SQLite foreign-key enforcement could not be enabled");
  }
}

function verifyDatabaseIntegrity(database: DatabaseExecutor): void {
  const quickCheck = database.pragma<Array<{ readonly quick_check: string }>>("quick_check");
  if (
    quickCheck.length !== 1 ||
    quickCheck[0] === undefined ||
    quickCheck[0].quick_check !== "ok"
  ) {
    throw new Error("SQLite integrity check failed");
  }

  const foreignKeyViolations = database.pragma<unknown[]>("foreign_key_check");
  if (foreignKeyViolations.length !== 0) {
    throw new Error("SQLite foreign-key integrity check failed");
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseConnection {
  let connection: ControlledDatabaseConnection | undefined;

  try {
    connection = new ControlledDatabaseConnection(new BetterSqlite3(path));
    verifyForeignKeys(connection);
    verifyDatabaseIntegrity(connection);
    initializeSchema(connection, options.migrations ?? FOUNDATION_MIGRATIONS);
    verifyDatabaseIntegrity(connection);
    return connection;
  } catch (error) {
    connection?.close();
    throw error;
  }
}
