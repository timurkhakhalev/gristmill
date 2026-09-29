const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const http: typeof import("node:http") = require("node:http");
const { spawnSync, spawn }: typeof import("node:child_process") = require("node:child_process");

const cli = path.resolve("scripts/gristmill-cli.cjs");

test("CLI help and argument errors have distinct output contracts", () => {
  const help = spawnSync(process.execPath, [cli, "notes", "transcript", "show", "--help"], { encoding: "utf8", cwd: os.tmpdir() });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--plain-text/);
  const invalid = spawnSync(process.execPath, [cli, "notes", "show", "bad"], { encoding: "utf8", cwd: os.tmpdir() });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(JSON.parse(invalid.stderr).error.code, "invalid_arguments");
});

test("CLI reads a profile-scoped connection and prints one JSON response", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    assert.equal(request.url, "/v1/notes/42/content");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ note_id: 42, content: "saved words" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address");
  fs.writeFileSync(path.join(directory, ".cli-read-connection.json"), JSON.stringify({ port: address.port, token: "test-token" }), { mode: 0o600 });
  const child = spawn(process.execPath, [cli, "--profile", directory, "notes", "content", "show", "42"], { stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { note_id: 42, content: "saved words" });
});
