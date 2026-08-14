import assert from "node:assert/strict";
import test from "node:test";

import type { ApplicationConfig } from "../src/config.ts";
import { runResetPin } from "../src/operator/reset-pin.ts";
import { runRotateSecretKey } from "../src/operator/rotate-secret-key.ts";

const config: ApplicationConfig = {
  host: "127.0.0.1",
  port: 3000,
  databasePath: "/tmp/operator-test.sqlite3",
  shutdownGraceMs: 5000,
  sessionInactivityMs: 2_592_000_000,
  sessionAbsoluteMs: 31_536_000_000,
};

function stream(value: string, isTTY?: boolean): AsyncIterable<Uint8Array> & { isTTY?: boolean } {
  const source = {
    ...(isTTY === undefined ? {} : { isTTY }),
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from(value, "utf8");
    },
  };
  return source;
}

function fakeDatabase(): { readonly database: never; readonly closed: () => boolean } {
  let closed = false;
  const database = {
    close() {
      closed = true;
    },
  } as never;
  return { database, closed: () => closed };
}

void test("reset-pin command enforces stdin/argv and never echoes the PIN", async () => {
  const fake = fakeDatabase();
  let received: unknown;
  let output = "";
  let error = "";
  const code = await runResetPin({
    argv: ["node", "reset-pin.ts"],
    stdin: stream("0000\n"),
    stdout: { write: (value) => void (output += value) },
    stderr: { write: (value) => void (error += value) },
    config,
    database: fake.database,
    auth: {
      resetOperatorPin: (pin) => {
        received = pin;
        return Promise.resolve({ configured: true, revision: 2 });
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(received, "0000");
  assert.match(output, /Revision: 2/);
  assert.doesNotMatch(output, /0000/);
  assert.equal(error, "");
  assert.equal(fake.closed(), true);

  const rejected = await runResetPin({
    argv: ["node", "reset-pin.ts", "0000"],
    stdin: stream("1234\n"),
    stdout: { write: () => undefined },
    stderr: { write: (value) => void (error += value) },
    config,
    auth: { resetOperatorPin: () => Promise.resolve({ configured: true, revision: 1 }) },
  });
  assert.equal(rejected, 1);
});

void test("reset-pin rejects TTY and extra lines without normalization", async () => {
  let received: unknown;
  const ttyCode = await runResetPin({
    argv: ["node", "reset-pin.ts"],
    stdin: stream("1234\n", true),
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    config,
    auth: {
      resetOperatorPin: (pin) => {
        received = pin;
        return Promise.resolve({ configured: true, revision: 1 });
      },
    },
  });
  assert.equal(ttyCode, 1);
  assert.equal(received, undefined);

  const extraCode = await runResetPin({
    argv: ["node", "reset-pin.ts"],
    stdin: stream("1234\nextra\n"),
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    config,
    auth: { resetOperatorPin: () => Promise.resolve({ configured: true, revision: 1 }) },
  });
  assert.equal(extraCode, 1);
});

void test("secret rotation reads both keys from stdin and reports only safe metadata", async () => {
  const fake = fakeDatabase();
  const oldKey = Buffer.alloc(32, 1).toString("base64url");
  const newKey = Buffer.alloc(32, 2).toString("base64url");
  let received: readonly unknown[] = [];
  let output = "";
  const code = await runRotateSecretKey({
    argv: ["node", "rotate-secret-key.ts"],
    stdin: stream(`${oldKey}\n${newKey}\n`),
    stdout: { write: (value) => void (output += value) },
    stderr: { write: () => undefined },
    config: { ...config, secretKey: oldKey },
    database: fake.database,
    secrets: {
      rotateRootKey: (oldInput, newInput) => {
        received = [oldInput, newInput];
        return { rotated: 3, generation: 4 };
      },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, [oldKey, newKey]);
  assert.match(output, /Rotated: 3/);
  assert.doesNotMatch(output, new RegExp(`${oldKey}|${newKey}`));
  assert.equal(fake.closed(), true);
});
