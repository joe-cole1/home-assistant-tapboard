import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { Router } from "../src/infrastructure/http/router.ts";
import { createLogger } from "../src/shared/logging.ts";
import { registerWebRoutes } from "../src/features/web/routes.ts";

class Response {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  end(body = ""): void {
    this.body = body;
  }
}

const visible = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "active",
  startedAt: "2026-08-17T12:00:00.000Z",
  completedAt: null,
  side1: {
    side: 1,
    tapId: "00000000-0000-4000-8000-000000000002",
    tapNumber: 1,
    title: "Mystery Tap",
    voteCount: 0,
    percentage: null,
    meterLabel: "No votes yet",
  },
  side2: {
    side: 2,
    tapId: "00000000-0000-4000-8000-000000000003",
    tapNumber: 2,
    title: "Mystery Tap",
    voteCount: 0,
    percentage: null,
    meterLabel: "No votes yet",
  },
  totalVotes: 0,
  result: null,
  winnerSide: null,
  leaderSide: null,
  isTie: false,
  canVote: true,
  votePath: "/api/public/tap-wars/00000000-0000-4000-8000-000000000001/votes",
  statusLabel: "No votes yet",
} as const;

function routes(): { readonly router: Router; readonly votes: number[] } {
  const router = new Router(createLogger({ sink: () => undefined }));
  const votes: number[] = [];
  registerWebRoutes({
    router,
    canonicalOrigin: "https://tapboard.example",
    publicTapWarsService: { getVisible: () => visible },
    tapWarsService: { vote: (_id: string, side: number) => votes.push(side) },
    liveUpdates: { publish: () => undefined },
  } as never);
  return { router, votes };
}

async function request(
  router: Router,
  path: string,
  options: { readonly origin?: string; readonly accept?: string; readonly body?: string } = {},
): Promise<Response> {
  const input = new PassThrough() as PassThrough & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  input.method = options.body === undefined ? "GET" : "POST";
  input.url = path;
  input.headers = {
    ...(options.body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.accept === undefined ? {} : { accept: options.accept }),
  };
  const response = new Response();
  const pending = router.handle(input as never, response as never);
  input.end(options.body);
  await pending;
  return response;
}

void test("public Tap Wars vote route accepts exactly one safe side and returns safe projection", async () => {
  const { router, votes } = routes();
  const get = await request(router, "/api/public/tap-wars");
  assert.equal(get.status, 200);
  const body = JSON.parse(get.body) as { readonly tapWars: Record<string, unknown> };
  assert.equal(body.tapWars.side1 !== undefined, true);
  for (const forbidden of ["assignmentId", "fillId", "beverageId", "adminBeverageTitle"])
    assert.equal(JSON.stringify(body).includes(forbidden), false, forbidden);

  const noJs = await request(router, `${visible.votePath}`, {
    origin: "https://tapboard.example",
    body: "side=1",
  });
  assert.equal(noJs.status, 303);
  assert.equal(noJs.headers.location, "/#tap-wars");

  for (const side of ["2", "1", "2"])
    assert.equal(
      (
        await request(router, visible.votePath, {
          origin: "https://tapboard.example",
          accept: "application/json",
          body: `side=${side}`,
        })
      ).status,
      200,
    );
  assert.deepEqual(votes, [1, 2, 1, 2]);

  for (const bodyText of ["delta=1", "side=1&x=2", "side=1&side=2"])
    assert.equal(
      (
        await request(router, visible.votePath, {
          origin: "https://tapboard.example",
          accept: "application/json",
          body: bodyText,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(router, visible.votePath, {
        accept: "application/json",
        body: "side=1",
      })
    ).status,
    400,
  );
});
