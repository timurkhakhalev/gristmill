const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

let userDataDir: unknown;
const electronPath = require.resolve("electron");
require.cache[electronPath] = Object.assign(new (require("node:module").Module)(electronPath), {
  exports: {
    app: {
      getPath: () => userDataDir,
    },
  },
});

const { write, clear, readAll }: typeof import("../../src/helpers/sidecarPidFile") = require("../../src/helpers/sidecarPidFile");

function createUserDataDir(t: import("node:test").TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sidecar-pids-"));
  userDataDir = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "sidecar-pids");
}

test("an unreadable PID entry does not hide valid sidecar entries", (t: import("node:test").TestContext) => {
  const pidDir = createUserDataDir(t);
  fs.mkdirSync(pidDir);
  fs.writeFileSync(path.join(pidDir, "qdrant.pid"), "1234");
  fs.mkdirSync(path.join(pidDir, "broken.pid"));

  assert.deepEqual(readAll(), [{ name: "qdrant", pid: 1234 }]);
});

test("an unreadable PID registry is treated as empty", (t: import("node:test").TestContext) => {
  const pidDir = createUserDataDir(t);
  fs.writeFileSync(pidDir, "not a directory");

  assert.deepEqual(readAll(), []);
});

test("missing, malformed, and unrelated entries are ignored", (t: import("node:test").TestContext) => {
  const pidDir = createUserDataDir(t);
  assert.deepEqual(readAll(), []);

  fs.mkdirSync(pidDir);
  fs.writeFileSync(path.join(pidDir, "zero.pid"), "0");
  fs.writeFileSync(path.join(pidDir, "fraction.pid"), "12.5");
  fs.writeFileSync(path.join(pidDir, "text.pid"), "not-a-pid");
  fs.writeFileSync(path.join(pidDir, "notes.txt"), "5678");

  assert.deepEqual(readAll(), []);
});

test("valid PID entries still round-trip through write, read, and clear", (t: import("node:test").TestContext) => {
  createUserDataDir(t);

  write("whisper", 4321);
  assert.deepEqual(readAll(), [{ name: "whisper", pid: 4321 }]);

  clear("whisper");
  assert.deepEqual(readAll(), []);
});
