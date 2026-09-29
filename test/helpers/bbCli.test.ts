const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { spawn, spawnSync }: typeof import("node:child_process") = require("node:child_process");
const http = require("node:http");
const { spawnBbThread, getBbThreadHistory, watchBbThread, assertBbVersion, clearBbCaches, listBbHarnesses, toBbLogo } = require("../../src/helpers/bbCli.ts");
const { generateBbSummary }: typeof import("../../src/helpers/bbSummary.ts") = require("../../src/helpers/bbSummary.ts");
const { ensureBbWorkspace, writeBbConnection }: typeof import("../../src/helpers/bbWorkspace.ts") = require("../../src/helpers/bbWorkspace.ts");

test("bb tool wrapper authenticates allowlisted routes and rejects external URLs", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-workspace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = ensureBbWorkspace(directory);
  const script = path.join(workspace, "gristmill-tools.mjs");
  assert.equal(spawnSync(process.execPath, ["--check", script]).status, 0);
  let seenAuthorization = "";
  const server = http.createServer((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    seenAuthorization = request.headers.authorization ?? "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"notes":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeBbConnection(directory, server.address().port, "test-token");
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "GET", "/v1/notes/list"]);
    let stdout = "";
    child.stdout.on("data", (chunk: string | Buffer) => { stdout += String(chunk); });
    child.on("error", reject);
    child.on("close", (code: number | null) => (code === 0 ? resolve(stdout) : reject(new Error(`tool exited ${code}`))));
  });
  assert.deepEqual(JSON.parse(output as string), { notes: [] });
  assert.equal(seenAuthorization, "Bearer test-token");
  const result = spawnSync(process.execPath, [script, "GET", "//example.com/v1/notes/list"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid Gristmill tool route/);
  assert.doesNotMatch(result.stderr, /test-token/);
});

test("bb CLI creates a profile project and resumes an in-flight summary from its last event", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-test-"));
  const binary = path.join(directory, "bb-fake");
  const capture = path.join(directory, "prompt.txt");
  const previousBinary = process.env.BB_CLI;
  const previousCapture = process.env.BB_FAKE_CAPTURE;
  const previousVersion = process.env.BB_FAKE_VERSION;
  const previousPath = process.env.PATH;
  process.env.BB_CLI = binary;
  process.env.BB_FAKE_CAPTURE = capture;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    if (previousCapture === undefined) delete process.env.BB_FAKE_CAPTURE;
    else process.env.BB_FAKE_CAPTURE = previousCapture;
    if (previousVersion === undefined) delete process.env.BB_FAKE_VERSION;
    else process.env.BB_FAKE_VERSION = previousVersion;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") process.stdout.write(process.env.BB_FAKE_VERSION || "0.44.0");
else if (args[0] === "project" && args[1] === "create") out({ id: "proj_test" });
else if (args[0] === "project" && args[1] === "show") out({ id: "proj_test", sources: [{ path: process.env.BB_FAKE_WORKSPACE }] });
else if (args[0] === "thread" && args[1] === "spawn") {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => { fs.writeFileSync(process.env.BB_FAKE_CAPTURE, prompt); out({ id: "thr_test" }); });
} else if (args[0] === "thread" && args[1] === "tell") {
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => { fs.appendFileSync(process.env.BB_FAKE_CAPTURE, "\\n" + prompt); out({ ok: true }); });
} else if (args[0] === "thread" && args[1] === "log") {
  const after = Number(args[args.indexOf("--after-seq") + 1]);
  out(after === 0 ? [
    { seq: 1, type: "turn/completed", data: { status: "completed" } },
    { seq: 2, type: "client/turn/requested" },
    { seq: 3, type: "turn/started" },
  ] : [
    { seq: 4, type: "item/agentMessage/delta", data: { delta: "Final" } },
    { seq: 5, type: "turn/completed", data: { status: "completed" } },
  ]);
} else if (args[0] === "thread" && args[1] === "output") out({ output: "Final summary" });
else throw new Error("Unexpected bb command: " + args.join(" "));
`, { mode: 0o700 });
  process.env.BB_FAKE_WORKSPACE = directory;
  t.after(() => { delete process.env.BB_FAKE_WORKSPACE; });

  clearBbCaches();
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  await assertBbVersion();
  process.env.BB_FAKE_VERSION = "0.44.1";
  clearBbCaches();
  await assert.rejects(assertBbVersion(), (error: unknown) => (error as { code?: string }).code === "bb-version-unsupported");
  delete process.env.BB_FAKE_VERSION;
  const id = await spawnBbThread("Private prompt from stdin", {
    provider: "codex", model: "gpt-6-luna", reasoningLevel: "low",
  }, directory);
  assert.equal(id, "thr_test");
  assert.equal(fs.readFileSync(capture, "utf8"), "Private prompt from stdin");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "project.json"), "utf8")), { id: "proj_test" });

  assert.deepEqual(await getBbThreadHistory(id), { sequence: 3, completed: false, failed: false });
  const chunks = [];
  for await (const chunk of watchBbThread(id, undefined, 3)) chunks.push(chunk);
  assert.deepEqual(chunks, ["Final"]);
  const result = await generateBbSummary({
    prompt: "Summarize", selection: { provider: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
    environment: directory, threadId: id, saveThreadId: () => { throw new Error("Must reuse saved thread"); },
    signal: new AbortController().signal,
  });
  assert.equal(result, "Final summary");
});

test("bb harness logos are fetched only from bb's loopback logo route and must be bounded SVG", async (t: import("node:test").TestContext) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M0 0h24v24H0z"/></svg>';
  assert.equal(toBbLogo("image/svg+xml", svg).monochrome, true);
  assert.equal(toBbLogo("image/svg+xml", '<svg viewBox="0 0 1 1"><path fill="#d97757"/></svg>').monochrome, false);
  assert.equal(toBbLogo("text/html", svg), null);
  assert.equal(toBbLogo("image/svg+xml", "<html><svg/></html>"), null);
  assert.equal(toBbLogo("image/svg+xml", `<svg>${"x".repeat(70_000)}</svg>`), null);

  const requested: unknown[] = [];
  const server = http.createServer((request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
    requested.push(request.url);
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end(svg);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-bb-logo-"));
  const binary = path.join(directory, "bb-fake");
  const previousBinary = process.env.BB_CLI;
  process.env.BB_CLI = binary;
  t.after(() => {
    if (previousBinary === undefined) delete process.env.BB_CLI;
    else process.env.BB_CLI = previousBinary;
    fs.rmSync(directory, { recursive: true, force: true });
    clearBbCaches();
  });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--version") process.stdout.write("0.44.0");
else if (args[0] === "provider" && args[1] === "list") out([
  { id: "codex", displayName: "Codex", available: true, logoUrl: "/api/v1/system/providers/codex/logo?h=1" },
  { id: "evil", displayName: "Evil", available: true, logoUrl: "http://example.com/api/v1/system/providers/evil/logo" },
  { id: "pi", displayName: "Pi", available: true },
]);
else if (args[0] === "settings" && args[1] === "show") out({ serverUrl: ${JSON.stringify(serverUrl)}, generalSettings: {} });
else throw new Error("Unexpected bb command: " + args.join(" "));
`, { mode: 0o700 });
  clearBbCaches();

  const harnesses = await listBbHarnesses();
  assert.deepEqual(harnesses.map((item: { id: string; logo?: { monochrome?: boolean } }) => [item.id, item.logo?.monochrome ?? null]), [["codex", true], ["evil", null], ["pi", null]]);
  assert.ok(harnesses[0]!.logo.dataUrl.startsWith("data:image/svg+xml;base64,"));
  assert.deepEqual(requested, ["/api/v1/system/providers/codex/logo?h=1"], "a cross-origin logo URL is never fetched");
  await listBbHarnesses();
  assert.equal(requested.length, 1, "logos are cached by their hashed URL");
});
