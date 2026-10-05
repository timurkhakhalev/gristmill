const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

test("installing CLI refreshes owned launchers without overriding an explicit profile", (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli's-home-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => directory);
  const electronPath = require.resolve("electron");
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    exports: { app: { isPackaged: false, getAppPath: () => directory } },
  } as NonNullable<(typeof require.cache)[string]>;
  t.after(() => {
    if (previousElectron) require.cache[electronPath] = previousElectron;
    else delete require.cache[electronPath];
  });

  const {
    installAgentCli,
    getAgentCliStatus,
  }: typeof import("../../../../src/helpers/installAgentCli.ts") = require("../../../../src/helpers/installAgentCli.ts");

  fs.mkdirSync(path.join(directory, "resources", "cli"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "resources", "cli", "gristmill-cli.cjs"),
    "console.log(JSON.stringify({ defaultProfile: process.env.GRISTMILL_CLI_DEFAULT_PROFILE, profile: process.env.GRISTMILL_PROFILE, args: process.argv.slice(2) }));"
  );
  const channel = process.env.GRISTMILL_CHANNEL;
  t.after(() => {
    if (channel === undefined) delete process.env.GRISTMILL_CHANNEL;
    else process.env.GRISTMILL_CHANNEL = channel;
  });
  assert.equal(getAgentCliStatus().installed, false);

  for (const value of ["development", "production"]) {
    process.env.GRISTMILL_CHANNEL = value;
    const target = installAgentCli();
    assert.deepEqual(getAgentCliStatus(), { installed: true, path: target });

    const result = spawnSync(target, ["notes", "search", "two words"], {
      encoding: "utf8",
      env: { ...process.env, GRISTMILL_PROFILE: directory },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      defaultProfile: value,
      profile: directory,
      args: ["notes", "search", "two words"],
    });
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  }

  const target = path.join(directory, ".local", "bin", "gristmill");
  fs.chmodSync(target, 0o600);
  assert.equal(getAgentCliStatus().installed, false, "a non-executable launcher is not installed");
  fs.chmodSync(target, 0o755);
  fs.writeFileSync(target, "#!/bin/sh\n# User command\n");
  assert.equal(getAgentCliStatus().installed, false, "another command is not the Gristmill CLI");
  assert.throws(() => installAgentCli(), /not a Gristmill launcher/);
  assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\n# User command\n");
});
