import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApplication } from "../src/application.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/infrastructure/database/connection.ts";
import { createSecretsService } from "../src/features/secrets/service.ts";
import { createLogger } from "../src/shared/logging.ts";

for (const scenario of ["missing", "invalid", "unreadable", "available"] as const) {
  void test(`startup reports ${scenario} credential storage without exposing secrets or preventing readiness`, async (context) => {
    const root = mkdtempSync(join(tmpdir(), "tapboard-diagnostics-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const databasePath = join(root, "tapboard.sqlite3");
    const key = Buffer.alloc(32, 7).toString("base64url");
    const config = loadConfig({
      baseDirectory: root,
      env: {
        TAPBOARD_DATABASE_PATH: databasePath,
        ...(scenario === "missing"
          ? {}
          : {
              TAPBOARD_SECRET_KEY: scenario === "invalid" ? "PRIVATE_INVALID_ROOT_KEY" : key,
            }),
      },
    });
    if (scenario === "unreadable") {
      const database = openDatabase(databasePath);
      createSecretsService(database, { rootKey: Buffer.alloc(32, 8).toString("base64url") }).upsert(
        "ha",
        "example",
        "token",
        "PRIVATE_STORED_CREDENTIAL",
      );
      database.close();
    }
    const logs: string[] = [];
    const app = createApplication({
      config,
      logger: createLogger({ sink: (line) => logs.push(line) }),
      createHttpServer: () => ({
        start: () => Promise.resolve({ address: "127.0.0.1", family: "IPv4", port: 12345 }),
        stop: () => Promise.resolve(),
      }),
    });
    try {
      await app.start();
      assert.equal(app.isReady(), true);
      const reports = logs
        .map(
          (line) =>
            JSON.parse(line) as {
              level: string;
              context?: { operation: string; code: string; reference: string };
            },
        )
        .filter((entry) => entry.context?.operation === "application.credential_storage");
      assert.equal(reports.length, scenario === "available" ? 0 : 1);
      if (scenario !== "available") {
        const report = reports[0];
        assert.ok(report);
        assert.ok(report.context);
        assert.equal(report.level, "warn");
        assert.equal(
          report.context.code,
          {
            missing: "secrets.key_missing",
            invalid: "secrets.key_invalid",
            unreadable: "secrets.key_unusable",
          }[scenario],
        );
        assert.match(report.context.reference, /^[0-9a-f-]{36}$/u);
      }
      assert.doesNotMatch(logs.join("\n"), /PRIVATE_|nonce|ciphertext|authTag/u);
      assert.equal(logs.join("\n").includes(key), false);
    } finally {
      await app.stop();
    }
  });
}
