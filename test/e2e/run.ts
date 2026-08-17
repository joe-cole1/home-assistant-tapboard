import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";

const e2ePort = process.env.TAPBOARD_E2E_PORT ?? "4176";
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

const server = spawn(process.execPath, ["test/e2e/server.ts"], {
  stdio: ["ignore", "inherit", "inherit"],
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ready(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(`${e2eOrigin}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(1_000, () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("The Playwright fixture server exited early.");
    if (await ready()) return;
    await delay(100);
  }
  throw new Error("The Playwright fixture server did not become ready.");
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

let exitCode = 1;
try {
  await waitForServer();
  const playwright = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], {
    stdio: "inherit",
    env: { ...process.env, TAPBOARD_E2E_EXTERNAL_SERVER: "1" },
  });
  exitCode = await new Promise<number>((resolve) => {
    playwright.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await terminate(server);
}
process.exitCode = exitCode;
