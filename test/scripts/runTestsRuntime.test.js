const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

function runWithFakeCommands(platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-test-runtime-"));
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  fs.mkdirSync(bin);
  const commands = {
    uname: '#!/bin/sh\nprintf "%s\\n" "$FAKE_PLATFORM"\n',
    node: '#!/bin/sh\nif [ "$1" = -p ]; then printf "%s\\n" "$FAKE_ELECTRON"; else printf "node:%s\\n" "$*" >> "$FAKE_LOG"; fi\n',
    pnpm: '#!/bin/sh\nprintf "pnpm:%s\\n" "$*" >> "$FAKE_LOG"\n',
    electron: '#!/bin/sh\nprintf "electron:%s:runAsNode=%s\\n" "$*" "$ELECTRON_RUN_AS_NODE" >> "$FAKE_LOG"\n',
  };
  for (const [name, source] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 });
  }
  try {
    const result = spawnSync("/bin/sh", ["scripts/run-tests.sh", "--", "test/scripts/sqliteRuntime.test.js"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        OPENHERCULES_TEST_BACKGROUND: "1",
        FAKE_PLATFORM: platform,
        FAKE_ELECTRON: path.join(bin, "electron"),
        FAKE_LOG: log,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(log, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("macOS focused tests probe and run under Electron as Node", () => {
  const calls = runWithFakeCommands("Darwin");
  assert.match(calls, /node:scripts\/ensure-sqlite-runtime\.js electron/);
  assert.match(calls, /pnpm:run build:main/);
  assert.match(calls, /electron:--import tsx --test --test-concurrency=1 --test-timeout=30000 test\/scripts\/sqliteRuntime\.test\.js:runAsNode=1/);
});

test("Linux focused tests keep the Node runtime", () => {
  const calls = runWithFakeCommands("Linux");
  assert.match(calls, /node:scripts\/ensure-sqlite-runtime\.js node/);
  assert.match(calls, /pnpm:run build:main/);
  assert.match(calls, /node:--import tsx --test --test-concurrency=1 --test-timeout=30000 test\/scripts\/sqliteRuntime\.test\.js/);
  assert.doesNotMatch(calls, /electron:/);
});
