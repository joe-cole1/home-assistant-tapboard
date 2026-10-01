// Disposable production-container acceptance only. No application imports or live credentials.
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

const phase = process.argv[2];
const statePath = "/app/data/production-smoke-state.json";
const tokenPath = "/tmp/production-smoke-tokens.json";
const baseUrl = "http://127.0.0.1:3005";

function check(condition, code) {
  if (!condition) throw new Error("production-smoke:" + code);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sourceManifest(root) {
  const paths = ["package.json", "package-lock.json"];
  function visit(relative) {
    const stat = lstatSync(join(root, relative));
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, relative)).sort()) visit(relative + "/" + name);
    } else {
      check(stat.isFile() && !stat.isSymbolicLink(), "source-file-type");
      paths.push(relative);
    }
  }
  for (const directory of ["src", "views", "public"]) visit(directory);
  return paths.sort().map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  }));
}

function prepare(root, directory) {
  const packageMetadata = readJson(join(root, "package.json"));
  check(packageMetadata.version === "2.0.0", "release-version");
  const credentials = {
    pin: String(randomInt(9000, 10000)),
    rootKey: randomBytes(32).toString("base64url"),
    replacementRootKey: randomBytes(32).toString("base64url"),
    fakeIntegrationKey: "production-smoke-" + randomBytes(32).toString("hex"),
    expectedVersion: packageMetadata.version,
    expectedFiles: sourceManifest(root),
  };
  writeFileSync(join(directory, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
  writeFileSync(join(directory, "interpolation.env"), "", { mode: 0o600 });
  writeFileSync(
    join(directory, "runtime.env"),
    "TAPBOARD_SECRET_KEY=" + credentials.rootKey + "\n",
    {
      mode: 0o600,
    },
  );
}

function verifyContainer(directory, expectedImageId) {
  const [image] = readJson(join(directory, "image.json"));
  const [container] = readJson(join(directory, "container.json"));
  check(image.Id === expectedImageId && container.Image === expectedImageId, "fresh-image-id");
  check(image.Os === "linux" && image.Architecture === "amd64", "image-platform");
  check(image.Config.User === "node" && container.Config.User === "1000:1000", "configured-user");
  check(image.Config.Cmd.join(" ") === "node src/main.ts", "image-entrypoint");
  check(image.Config.StopSignal === "SIGTERM", "image-stop-signal");
  check(
    container.Config.StopSignal === "SIGTERM" && container.Config.StopTimeout === 15,
    "stop-timeout",
  );
  check(container.HostConfig.ReadonlyRootfs && !container.HostConfig.Privileged, "read-only-root");
  check(container.HostConfig.Init === true, "container-init");
  check(
    container.HostConfig.CapDrop.length === 1 && container.HostConfig.CapDrop[0] === "ALL",
    "cap-drop",
  );
  check(
    container.HostConfig.CapAdd === null || container.HostConfig.CapAdd.length === 0,
    "cap-add",
  );
  check(
    container.HostConfig.SecurityOpt.some(
      (option) => option === "no-new-privileges:true" || option === "no-new-privileges",
    ),
    "no-new-privileges",
  );
  const tmpfs = container.HostConfig.Tmpfs;
  check(Object.keys(tmpfs).length === 1 && typeof tmpfs["/tmp"] === "string", "only-tmpfs");
  for (const option of ["rw", "noexec", "nosuid", "size=16m", "mode=1777"]) {
    check(tmpfs["/tmp"].split(",").includes(option), "tmpfs-options");
  }
  const mounts = container.Mounts.filter((mount) => mount.Type !== "tmpfs");
  check(
    mounts.length === 1 &&
      mounts[0].Type === "volume" &&
      mounts[0].Destination === "/app/data" &&
      mounts[0].RW === true,
    "only-data-volume",
  );
  const bindings = container.NetworkSettings.Ports["3005/tcp"];
  check(
    Object.keys(container.NetworkSettings.Ports).length === 1 &&
      bindings?.length === 1 &&
      bindings[0].HostIp === "127.0.0.1" &&
      Number(bindings[0].HostPort) > 0,
    "loopback-publication",
  );
  const environment = Object.fromEntries(
    container.Config.Env.map((value) => {
      const separator = value.indexOf("=");
      return [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
  check(
    environment.NODE_ENV === "production" &&
      environment.TAPBOARD_HOST === "0.0.0.0" &&
      environment.TAPBOARD_PORT === "3005" &&
      environment.TAPBOARD_DATABASE_PATH === "/app/data/tapboard-v2.sqlite3" &&
      environment.TAPBOARD_EXTERNAL_ORIGIN === baseUrl &&
      environment.TAPBOARD_SHUTDOWN_GRACE_MS === "5000",
    "canonical-runtime-environment",
  );
  check(
    image.Config.Env.every(
      (value) =>
        !/^[^=]*(SECRET|TOKEN|PASSWORD|PIN|CREDENTIAL|API_KEY|PRIVATE_KEY)[^=]*=/i.test(value),
    ),
    "no-image-secret-defaults",
  );
}

function scanLogs(directory) {
  const credentials = readJson(join(directory, "credentials.json"));
  // A four-digit PIN can coincide with an unrelated SHA256 substring in build
  // output. Match it as a value; longer keys/tokens must be absent everywhere.
  const pinPattern = new RegExp("(^|[^A-Za-z0-9_-])" + credentials.pin + "(?=$|[^A-Za-z0-9_-])");
  const secrets = [
    credentials.pin,
    credentials.rootKey,
    credentials.replacementRootKey,
    credentials.fakeIntegrationKey,
  ];
  for (const name of readdirSync(directory)) {
    if (name.endsWith(".tokens.json")) secrets.push(...readJson(join(directory, name)));
  }
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".log")) continue;
    const contents = readFileSync(join(directory, name), "utf8");
    check(
      secrets.every(
        (secret) =>
          typeof secret === "string" &&
          (secret === credentials.pin ? !pinPattern.test(contents) : !contents.includes(secret)),
      ),
      "secret-in-logs",
    );
  }
}

async function request(path, options = {}, origin = baseUrl) {
  return globalThis.fetch(origin + path, {
    ...options,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(5000),
  });
}

async function verifyPublic(origin = baseUrl) {
  const health = await request("/healthz", {}, origin);
  check(health.status === 200, "get-health-status");
  const readiness = await health.json();
  check(readiness.status === "ok" && readiness.schemaVersion === 22, "schema-22-readiness");
  const head = await request("/healthz", { method: "HEAD" }, origin);
  check(head.status === 200 && (await head.text()) === "", "head-health");
  for (const path of ["/", "/admin/login"]) {
    const response = await request(path, {}, origin);
    check(
      response.status === 200 && response.headers.get("content-type")?.includes("text/html"),
      "ssr-status",
    );
    const html = await response.text();
    check(/<!doctype html>/i.test(html) && /<body\b/i.test(html), "ssr-document");
    if (path === "/admin/login") {
      check(/name="pin"/.test(html) && /type="password"/.test(html), "login-form");
    }
  }
}

function verifyRuntime(credentials) {
  check(process.platform === "linux" && process.arch === "x64", "runtime-platform");
  check(process.versions.node.startsWith("24."), "node-24");
  check(process.getuid() === 1000 && process.getgid() === 1000, "runtime-uid");
  const status = readFileSync("/proc/self/status", "utf8");
  check(/^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status), "runtime-privileges");
  const mounts = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .map((line) => line.split(" "));
  const tmp = mounts.find((mount) => mount[1] === "/tmp");
  check(tmp?.[2] === "tmpfs", "runtime-tmpfs");
  for (const option of ["rw", "noexec", "nosuid", "size=16384k"]) {
    check(tmp[3].split(",").includes(option), "runtime-tmpfs-options");
  }
  let rootWriteError;
  try {
    writeFileSync("/app/src/production-smoke-root-write", "must fail", { flag: "wx" });
  } catch (error) {
    rootWriteError = error.code;
  }
  check(rootWriteError === "EROFS", "root-write-fails");
  for (const directory of ["/tmp", "/app/data"]) {
    const path = directory + "/production-smoke-write";
    writeFileSync(path, "writable", { flag: "wx", mode: 0o600 });
    check(readFileSync(path, "utf8") === "writable", "writable-mount");
    unlinkSync(path);
  }
  const require = createRequire("/app/package.json");
  check(
    typeof require("better-sqlite3") === "function" && typeof require("eta").Eta === "function",
    "production-dependencies",
  );
  const packageMetadata = readJson("/app/package.json");
  check(packageMetadata.version === credentials.expectedVersion, "image-release-version");
  for (const name of Object.keys(packageMetadata.devDependencies)) {
    check(!existsSync("/app/node_modules/" + name), "no-development-dependencies");
  }
  for (const path of [
    "/app/.env",
    "/app/.git",
    "/app/test",
    "/app/docs",
    "/app/Dockerfile",
    "/app/compose.production.example.yaml",
    "/app/backups",
    "/usr/bin/python3",
    "/usr/bin/make",
    "/usr/bin/g++",
    "/usr/bin/gcc",
  ])
    check(!existsSync(path), "no-build-or-operator-files");
  check(
    JSON.stringify(sourceManifest("/app")) === JSON.stringify(credentials.expectedFiles),
    "exact-source-and-assets",
  );
}

async function login(credentials) {
  const response = await request("/admin/login", {
    method: "POST",
    headers: { origin: baseUrl, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pin: credentials.pin }),
  });
  check(
    response.status === 303 && response.headers.get("location") === "/admin/overview",
    "stdin-pin-login",
  );
  const setCookies = response.headers.getSetCookie();
  const session = setCookies.find((cookie) => cookie.startsWith("tapboard_admin_session="));
  const csrf = setCookies.find((cookie) => cookie.startsWith("tapboard_admin_csrf="));
  check(session && csrf, "session-cookies");
  check(
    /; HttpOnly(?:;|$)/.test(session) &&
      /; SameSite=Strict(?:;|$)/.test(session) &&
      !/; Secure(?:;|$)/.test(session) &&
      !/; Secure(?:;|$)/.test(csrf),
    "lan-cookie-policy",
  );
  const sessionPair = session.split(";")[0];
  const csrfPair = csrf.split(";")[0];
  const csrfToken = csrfPair.slice(csrfPair.indexOf("=") + 1);
  const sessionToken = sessionPair.slice(sessionPair.indexOf("=") + 1);
  const tokens = existsSync(tokenPath) ? readJson(tokenPath) : [];
  writeFileSync(tokenPath, JSON.stringify([...tokens, sessionToken, csrfToken]), { mode: 0o600 });
  return { cookie: sessionPair + "; " + csrfPair, "x-csrf-token": csrfToken, origin: baseUrl };
}

async function api(path, headers, method = "GET", body) {
  const response = await request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  check(
    response.status === (method === "POST" && path === "/api/admin/kegs" ? 201 : 200),
    "admin-api-status",
  );
  return response.json();
}

async function verifySavedKeg(headers) {
  const expected = readJson(statePath);
  const { kegs } = await api("/api/admin/kegs", headers);
  check(
    kegs.length === 1 && JSON.stringify(kegs[0]) === JSON.stringify(expected.keg),
    "persistent-domain-state",
  );
}

async function exercise(phase, credentials) {
  verifyRuntime(credentials);
  await verifyPublic();
  const headers = await login(credentials);
  if (phase === "create") {
    const { keg } = await api("/api/admin/kegs", headers, "POST", {
      kegNumber: 1,
      label: "Production smoke keg",
      capacityMl: 19000,
      currentTareG: 4000,
    });
    check(
      typeof keg.id === "string" &&
        keg.kegNumber === 1 &&
        keg.label === "Production smoke keg" &&
        keg.capacityMl === 19000 &&
        keg.currentTareG === 4000,
      "created-domain-state",
    );
    writeFileSync(statePath, JSON.stringify({ keg }), { mode: 0o600 });
    await api("/api/admin/beverages/brewfather/config", headers, "PUT", {
      accountId: "default",
      userId: "production-smoke-user",
      apiKey: credentials.fakeIntegrationKey,
      enabled: false,
      discoveryStatuses: [],
    });
    const { status } = await api("/api/admin/beverages/brewfather/status", headers);
    check(
      status.configured && status.apiKeyConfigured && status.connectionState === "disabled",
      "disabled-fake-integration",
    );
  }
  await verifySavedKeg(headers);
  if (phase === "degraded") {
    // Wrong generated root key prevents adapter creation and all external requests.
    await api("/api/admin/beverages/brewfather/config", headers, "PUT", {
      accountId: "default",
      userId: "production-smoke-user",
      enabled: true,
      discoveryStatuses: [],
    });
    const { results } = await api("/api/admin/beverages/brewfather/sync", headers, "POST");
    check(
      results.length === 1 &&
        results[0].accountId === "default" &&
        results[0].connectionVerified === false &&
        results[0].failures?.[0]?.code === "secrets.key_unusable" &&
        results[0].failures[0].category === "unavailable" &&
        results[0].error ===
          "Tapboard cannot decrypt the stored Brewfather API key. Restore the matching server secret key or rotate stored credentials using the operator tool.",
      "degraded-without-network",
    );
    const { status } = await api("/api/admin/beverages/brewfather/status", headers);
    check(
      status.configured &&
        status.account.enabled &&
        status.apiKeyConfigured &&
        status.connectionState === "disconnected",
      "degraded-integration-status",
    );
    await verifyPublic();
    await verifySavedKeg(headers);
  }
}

async function main() {
  if (phase === "prepare") {
    prepare(process.argv[3], process.argv[4]);
  } else if (phase === "inspect") {
    verifyContainer(process.argv[3], process.argv[4]);
  } else if (phase === "pin") {
    process.stdout.write(readJson(join(process.argv[3], "credentials.json")).pin + "\n");
  } else if (phase === "replace-key") {
    const directory = process.argv[3];
    const credentials = readJson(join(directory, "credentials.json"));
    writeFileSync(
      join(directory, "runtime.env"),
      "TAPBOARD_SECRET_KEY=" + credentials.replacementRootKey + "\n",
      { mode: 0o600 },
    );
  } else if (phase === "scan-logs") {
    scanLogs(process.argv[3]);
  } else if (phase === "published") {
    const origin = new URL(process.argv[3]);
    check(origin.protocol === "http:" && origin.hostname === "127.0.0.1", "published-loopback");
    await verifyPublic(origin.origin);
  } else {
    check(["create", "restart", "degraded", "preflight"].includes(phase), "unknown-phase");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const credentials = JSON.parse(input);
    if (phase === "preflight") {
      verifyRuntime(credentials);
      await verifyPublic();
      check((await request("/api/admin/kegs")).status === 401, "fresh-admin-auth-required");
    } else {
      await exercise(phase, credentials);
    }
  }
}

try {
  await main();
} catch (error) {
  // Never print assertion values, request bodies, cookies, input, or arbitrary errors.
  process.stderr.write(
    error instanceof Error && /^production-smoke:[a-z0-9-]+$/.test(error.message)
      ? error.message + "\n"
      : "production-smoke:failed\n",
  );
  process.exitCode = 1;
}
