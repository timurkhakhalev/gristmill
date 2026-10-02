import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

test("native CommonJS tooling has only syntax Node can erase", () => {
  for (const directory of ["scripts", "scripts/lib"]) {
    for (const file of fs.readdirSync(directory).filter((file) => file.endsWith(".cts"))) {
      assert.doesNotThrow(
        () => stripTypeScriptTypes(fs.readFileSync(path.join(directory, file), "utf8")),
        file
      );
    }
  }
});

test("standalone CJS CLI and engine installers run without TS loaders or provider access", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-tools-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guard = path.join(directory, "network-guard.cjs");
  fs.writeFileSync(
    guard,
    'require("https").get = () => { throw new Error("Network forbidden in this test"); };'
  );
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "",
    GRISTMILL_LOCAL_BIN_DIR: directory,
  };
  const cli = spawnSync(process.execPath, ["resources/cli/gristmill-cli.cjs", "--help"], {
    encoding: "utf8",
    env,
    timeout: 10000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Gristmill Notes CLI/);
  for (const name of ["whisper-cpp", "llama-server", "sherpa-onnx"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        guard,
        `resources/local-engine-installers/download-${name}.cjs`,
        "--current",
        "--platform",
        "unsupported",
      ],
      { encoding: "utf8", env, timeout: 10000 }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unsupported platform\/arch/);
    assert.doesNotMatch(result.stderr, /Network forbidden|MODULE_NOT_FOUND/);
  }
});
