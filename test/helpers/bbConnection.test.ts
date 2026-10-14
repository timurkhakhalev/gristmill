const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const http: typeof import("node:http") = require("node:http");

const net: typeof import("node:net") = require("node:net");

const {
  resolveBbCliEnvironment,
  closeBbConnection,
}: typeof import("../../src/helpers/bbConnection.ts") = require("../../src/helpers/bbConnection.ts");

const {
  listBbProviders,
  listBbHarnesses,
  clearBbCaches,
}: typeof import("../../src/helpers/bbCli.ts") = require("../../src/helpers/bbCli.ts");

const CREDENTIAL = "bbcm_test-credential";

type Seen = { url?: string; host?: string; credential?: string | string[]; origin?: string };

/** Isolated bb data dir and environment; restores both after the test. */
function useBbDataDir(t: import("node:test").TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-connection-"));
  const previous = {
    BB_DATA_DIR: process.env.BB_DATA_DIR,
    BB_SERVER_URL: process.env.BB_SERVER_URL,
    BB_HOST_DAEMON_PORT: process.env.BB_HOST_DAEMON_PORT,
  };
  process.env.BB_DATA_DIR = directory;
  delete process.env.BB_SERVER_URL;
  delete process.env.BB_HOST_DAEMON_PORT;
  t.after(() => {
    closeBbConnection();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function writeConfig(directory: string, config: object): void {
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
}

async function startUpstream(t: import("node:test").TestContext): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    seen.push({
      url: request.url,
      host: request.headers.host,
      credential: request.headers["x-bb-connect-machine"],
      origin: request.headers.origin,
    });
    if (request.url?.startsWith("/api/v1/system/providers/")) {
      response.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg></svg>");
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    }
  });
  server.on("upgrade", (request, socket: import("node:net").Socket) => {
    seen.push({ url: request.url, credential: request.headers["x-bb-connect-machine"] });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as import("node:net").AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

async function get(url: string, headers: Record<string, string> = {}): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    http
      .get({ host: target.hostname, port: target.port, path: target.pathname + target.search, headers }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

test("bb connection keeps the local default without a bb config", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  assert.deepEqual(await resolveBbCliEnvironment(), {});

  fs.writeFileSync(path.join(directory, "host-daemon-port"), "38888\n");
  assert.deepEqual(await resolveBbCliEnvironment(), { BB_HOST_DAEMON_PORT: "38888" });
});

test("bb connection keeps an explicit BB_SERVER_URL and ignores the config", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  fs.writeFileSync(path.join(directory, "config.json"), "not JSON");
  process.env.BB_SERVER_URL = "http://127.0.0.1:1";
  assert.deepEqual(await resolveBbCliEnvironment(), {});
});

test("bb connection uses a remote server without credentials directly", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  writeConfig(directory, { serverUrl: "https://bb.example.test" });
  assert.deepEqual(await resolveBbCliEnvironment(), { BB_SERVER_URL: "https://bb.example.test" });
});

test("bb connection rejects an invalid config", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  writeConfig(directory, { serverUrl: "file:///etc/passwd" });
  await assert.rejects(resolveBbCliEnvironment(), /bb config .* is invalid/);
});

test("bb connection proxy adds the machine credential only for local CLI requests", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const upstream = await startUpstream(t);
  writeConfig(directory, {
    serverUrl: upstream.url,
    serverHeaders: { "x-bb-connect-machine": CREDENTIAL },
  });

  const { BB_SERVER_URL: proxy } = await resolveBbCliEnvironment();
  assert.match(proxy ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await resolveBbCliEnvironment()).BB_SERVER_URL, proxy, "proxy is reused");

  assert.equal(await get(`${proxy}/api/v1/projects?x=1`), 200);
  assert.deepEqual(upstream.seen, [
    { url: "/api/v1/projects?x=1", host: new URL(upstream.url).host, credential: CREDENTIAL, origin: undefined },
  ]);

  // A browser page or a DNS-rebound host name must not borrow the credential.
  assert.equal(await get(`${proxy}/api/v1/projects`, { origin: "https://evil.test" }), 403);
  assert.equal(await get(`${proxy}/api/v1/projects`, { host: "evil.test" }), 403);
  assert.equal(upstream.seen.length, 1);
});

test("bb connection proxy relays WebSocket upgrades with the credential", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const upstream = await startUpstream(t);
  writeConfig(directory, {
    serverUrl: upstream.url,
    serverHeaders: { "x-bb-connect-machine": CREDENTIAL },
  });
  const proxy = new URL((await resolveBbCliEnvironment()).BB_SERVER_URL ?? "");

  const socket = net.connect(Number(proxy.port), proxy.hostname);
  t.after(() => socket.destroy());
  socket.write(
    `GET /api/v1/realtime HTTP/1.1\r\nHost: ${proxy.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`
  );

  let received = "";
  await new Promise<void>((resolve) => {
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n\r\n") && !received.includes("ping")) socket.write("ping");
      if (received.endsWith("ping")) resolve();
    });
  });

  assert.match(received, /^HTTP\/1\.1 101/);
  assert.deepEqual(upstream.seen, [{ url: "/api/v1/realtime", credential: CREDENTIAL }]);
});

test("bb connection replaces the proxy after a bb server move", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const first = await startUpstream(t);
  const second = await startUpstream(t);
  const credential = { "x-bb-connect-machine": CREDENTIAL };

  writeConfig(directory, { serverUrl: first.url, serverHeaders: credential });
  const before = (await resolveBbCliEnvironment()).BB_SERVER_URL ?? "";
  writeConfig(directory, { serverUrl: second.url, serverHeaders: credential });
  const after = (await resolveBbCliEnvironment()).BB_SERVER_URL ?? "";

  assert.notEqual(after, before);
  await assert.rejects(get(`${before}/api/v1/projects`), { code: "ECONNREFUSED" });
  assert.equal(await get(`${after}/api/v1/projects`), 200);
  assert.equal(first.seen.length, 0);
  assert.equal(second.seen.length, 1);
});

test("bb CLI calls receive the resolved bb server", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const binary = path.join(directory, "bb-fake");
  const previousBinary = process.env.BB_CLI;
  process.env.BB_CLI = binary;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    clearBbCaches();
  });
  writeConfig(directory, { serverUrl: "https://bb.example.test" });
  fs.writeFileSync(
    binary,
    'process.stdout.write(JSON.stringify([{id:"codex",displayName:process.env.BB_SERVER_URL,available:true}]));'
  );

  const [provider] = await listBbProviders();
  assert.equal(provider.displayName, "https://bb.example.test");

  writeConfig(directory, { serverUrl: 42 });
  await assert.rejects(listBbProviders(), { code: "bb-connection-error" });
});

test("bb harness logos load through the CLI server, not the URL that a moved server reports", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const upstream = await startUpstream(t);
  const binary = path.join(directory, "bb-fake");
  const previousBinary = process.env.BB_CLI;
  process.env.BB_CLI = binary;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    clearBbCaches();
  });
  writeConfig(directory, {
    serverUrl: upstream.url,
    serverHeaders: { "x-bb-connect-machine": CREDENTIAL },
  });
  // The moved server reports its own loopback URL, which is not reachable from this machine.
  fs.writeFileSync(
    binary,
    `const settings = process.argv.includes("settings");
process.stdout.write(JSON.stringify(settings
  ? { serverUrl: "http://127.0.0.1:1", generalSettings: {} }
  : [
      { id: "codex", displayName: "Codex", available: true, logoUrl: "/api/v1/system/providers/codex/logo" },
      { id: "acp-antigravity", displayName: "Antigravity", available: true, logoUrl: null },
    ]));`
  );

  const harnesses = await listBbHarnesses();
  assert.deepEqual(
    harnesses.map((harness: { id: string; logo: unknown }) => [harness.id, harness.logo !== null]),
    [
      ["codex", true],
      ["acp-antigravity", false],
    ]
  );
  assert.deepEqual(
    upstream.seen.map((request) => [request.url, request.credential]),
    [["/api/v1/system/providers/codex/logo", CREDENTIAL]]
  );
});

/** Sends one raw request so the test controls the exact request target. */
async function rawStatus(proxy: URL, target: string, upgrade: boolean): Promise<string> {
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  const upgradeHeaders = upgrade ? "Upgrade: websocket\r\nConnection: Upgrade\r\n" : "Connection: close\r\n";
  socket.write(`GET ${target} HTTP/1.1\r\nHost: ${proxy.host}\r\n${upgradeHeaders}\r\n`);

  return new Promise((resolve, reject) => {
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.includes("\r\n")) {
        socket.destroy();
        resolve(received.slice(0, received.indexOf("\r\n")));
      }
    });
    socket.on("error", reject);
  });
}

test("bb connection proxy never sends the credential to a server that is not configured", async (t: import("node:test").TestContext) => {
  const directory = useBbDataDir(t);
  const configured = await startUpstream(t);
  const other = await startUpstream(t);
  const otherHost = new URL(other.url).host;
  writeConfig(directory, {
    serverUrl: configured.url,
    serverHeaders: { "x-bb-connect-machine": CREDENTIAL },
  });
  const proxy = new URL((await resolveBbCliEnvironment()).BB_SERVER_URL ?? "");

  for (const upgrade of [false, true]) {
    for (const target of [`${other.url}/capture`, `//${otherHost}/capture`, `/\\${otherHost}/capture`, "*"]) {
      assert.match(await rawStatus(proxy, target, upgrade), /^HTTP\/1\.1 400/, `${target} upgrade=${upgrade}`);
    }
  }

  assert.deepEqual(other.seen, []);
  assert.deepEqual(configured.seen, []);
  assert.equal(await get(`${proxy.origin}/api/v1/projects`), 200, "proxy still serves valid requests");
});
