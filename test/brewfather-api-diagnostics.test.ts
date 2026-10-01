import assert from "node:assert/strict";
import test from "node:test";
import type { AuthService } from "../src/features/auth/service.ts";
import type { BeverageService } from "../src/features/beverages/service.ts";
import { registerBeverageRoutes } from "../src/features/beverages/routes.ts";
import { BrewfatherError } from "../src/features/beverages/brewfather/adapter.ts";
import { describeBrewfatherFailure } from "../src/features/beverages/brewfather/diagnostics.ts";
import { HttpServer } from "../src/infrastructure/http/server.ts";
import { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";

for (const scenario of ["failed", "successful", "unauthorized"] as const) {
  void test(`authenticated Brewfather API ${scenario} sync retains its response contract and safe logging`, async (context) => {
    const logs: string[] = [];
    const logger = createLogger({ sink: (line) => logs.push(line) });
    const router = new Router(logger);
    let calls = 0;
    const failure = describeBrewfatherFailure(
      new BrewfatherError("rate_limited", "PRIVATE_PROVIDER_BODY", {
        status: 429,
        retryAfterMs: 60_000,
      }),
    );
    const results = [
      {
        accountId: "default",
        linkedSynced: 0,
        linkedErrors: 0,
        candidatesFound: 0,
        durationMs: 0,
        connectionVerified: scenario === "successful",
        ...(scenario === "failed" ? { error: failure.message, failures: [failure] } : {}),
      },
    ];
    registerBeverageRoutes({
      router,
      logger,
      authService: {
        authorizeCookieMutation: () =>
          scenario === "unauthorized" ? undefined : { id: "test-session" },
      } as unknown as AuthService,
      beverageService: {
        syncBrewfather: () => {
          calls++;
          return Promise.resolve(results);
        },
      } as unknown as BeverageService,
    });
    const server = new HttpServer({ router, logger, shutdownGraceMs: 100 });
    context.after(() => server.stop());
    const address = await server.start("127.0.0.1", 0);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/beverages/brewfather/sync`,
      {
        method: "POST",
      },
    );
    const body = await response.text();
    assert.equal(response.status, scenario === "unauthorized" ? 401 : 200);
    assert.equal(calls, scenario === "unauthorized" ? 0 : 1);
    assert.equal(logs.length, scenario === "failed" ? 1 : 0);
    if (scenario !== "unauthorized") assert.deepEqual(JSON.parse(body), { results });
    if (scenario === "failed") {
      const entry = JSON.parse(logs[0]!) as {
        context: {
          operation: string;
          providerStatus: number;
          retryAfterMs: number;
          reference: string;
        };
      };
      assert.equal(entry.context.operation, "api.admin.brewfather.sync");
      assert.equal(entry.context.providerStatus, 429);
      assert.equal(entry.context.retryAfterMs, 60_000);
      assert.match(entry.context.reference, /^[0-9a-f-]{36}$/u);
    }
    assert.doesNotMatch(body + logs.join("\n"), /PRIVATE_PROVIDER_BODY/u);
  });
}
