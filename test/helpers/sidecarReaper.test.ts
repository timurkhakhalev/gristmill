const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { spawn } = require("child_process");

const fs = require("fs");

const os = require("os");

const path = require("path");

import type { ChildProcessWithoutNullStreams } from "node:child_process";

let userDataDir: unknown;

const electronPath = require.resolve("electron");

const originalElectronCache = require.cache[electronPath];

require.cache[electronPath] = {
  exports: {
    app: {
      getPath: () => userDataDir,
      isReady: () => false,
    },
  },
} as NonNullable<(typeof require.cache)[string]>;

test.after(() => {
  if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
  else delete require.cache[electronPath];
});

const sidecarPidFile: typeof import("../../src/helpers/sidecarPidFile") = require("../../src/helpers/sidecarPidFile");

const {
  reapStaleSidecars,
  waitForExit,
}: typeof import("../../src/helpers/sidecarReaper") = require("../../src/helpers/sidecarReaper");

// Short graces keep the escalation path fast; the poll interval is 200ms so
// anything comfortably above that works.
const GRACES = { sigtermGraceMs: 1000, sigkillGraceMs: 1000 };

// The reaper matches processes by command line, which tasklist on Windows
// reports as the bare image name — these process-identity tests are POSIX-only.
const posixOnly = { skip: process.platform === "win32" };

function createUserDataDir(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-sidecar-reaper-"));
  const dir = userDataDir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

// The script filename must contain "whisper-server" so processCommand() matches
// the expected binary fragment for the preserved whisper sidecar.
function spawnFakeSidecar(
  t: import("node:test").TestContext,
  {
    scriptName,
    ignoreSigterm,
  }: {
    scriptName: string;
    ignoreSigterm: boolean;
  }
): Promise<ChildProcessWithoutNullStreams & { pid: number }> {
  const handler = ignoreSigterm ? 'process.on("SIGTERM", () => {});' : "";
  const scriptPath = path.join(userDataDir, scriptName);
  fs.writeFileSync(scriptPath, `${handler}console.log("ready");setInterval(() => {}, 1000);`);

  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["ignore", "pipe", "ignore"],
  }) as ChildProcessWithoutNullStreams;

  if (child.pid === undefined) throw new Error("Failed to start fake sidecar");
  const runningChild = child as ChildProcessWithoutNullStreams & { pid: number };
  t.after(() => {
    try {
      process.kill(runningChild.pid, "SIGKILL");
    } catch {
      // Already dead.
    }
  });

  return new Promise((resolve) => {
    runningChild.stdout.once("data", () => resolve(runningChild));
  });
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;

  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return !isAlive(pid);
}

test(
  "kills a responsive stale sidecar and clears its entry",
  posixOnly,
  async (t: import("node:test").TestContext) => {
    createUserDataDir(t);

    const child = await spawnFakeSidecar(t, {
      scriptName: "whisper-server-fake.js",
      ignoreSigterm: false,
    });

    sidecarPidFile.write("whisper", child.pid);

    await reapStaleSidecars(GRACES);

    assert.equal(await waitUntilDead(child.pid), true);
    assert.deepEqual(sidecarPidFile.readAll(), []);
  }
);

test(
  "escalates to SIGKILL when a stale sidecar ignores SIGTERM",
  posixOnly,
  async (t: import("node:test").TestContext) => {
    createUserDataDir(t);

    const child = await spawnFakeSidecar(t, {
      scriptName: "whisper-server-stuck.js",
      ignoreSigterm: true,
    });

    sidecarPidFile.write("whisper", child.pid);

    await reapStaleSidecars(GRACES);

    assert.equal(await waitUntilDead(child.pid), true);
    assert.deepEqual(sidecarPidFile.readAll(), []);
  }
);

test(
  "does not kill a reused PID that is no longer the sidecar binary",
  posixOnly,
  async (t: import("node:test").TestContext) => {
    createUserDataDir(t);
    const child = await spawnFakeSidecar(t, { scriptName: "other-app.js", ignoreSigterm: false });
    sidecarPidFile.write("whisper", child.pid);

    await reapStaleSidecars(GRACES);

    assert.equal(isAlive(child.pid), true);
    assert.deepEqual(sidecarPidFile.readAll(), []);
  }
);

// Preserved sidecar restart paths use waitForExit to verify the old process is
// gone before spawning a replacement.
test("waitForExit distinguishes a live process from a dead one", async (t: import("node:test").TestContext) => {
  createUserDataDir(t);

  const child = await spawnFakeSidecar(t, {
    scriptName: "whisper-server-wait.js",
    ignoreSigterm: false,
  });

  assert.equal(await waitForExit(child.pid, 400), false);

  process.kill(child.pid, "SIGKILL");
  assert.equal(await waitForExit(child.pid, 2000), true);
});

test("clears entries for processes that already exited", async (t: import("node:test").TestContext) => {
  createUserDataDir(t);

  const child = await spawnFakeSidecar(t, {
    scriptName: "whisper-server-gone.js",
    ignoreSigterm: false,
  });

  sidecarPidFile.write("whisper", child.pid);
  process.kill(child.pid, "SIGKILL");
  assert.equal(await waitUntilDead(child.pid), true);

  await reapStaleSidecars(GRACES);

  assert.deepEqual(sidecarPidFile.readAll(), []);
});
