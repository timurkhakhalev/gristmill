import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const {
  updateLocal,
}: import("../../../../scripts/update-local.cts").API = require("../../../../scripts/update-local.cts");

test("local update checks the installed process, builds, installs and launches the permanent path", () => {
  const calls: string[] = [];
  const target = path.resolve("/tmp/gristmill-update-test/Gristmill.app");

  const dependencies = {
    checkStopped: (bundle: string) => {
      calls.push(`check:${bundle}`);
    },
    build: () => {
      calls.push("build");
    },
    install: (source: string, bundle: string) => {
      assert.equal(source, path.resolve("dist/mac-arm64/Gristmill.app"));
      calls.push(`install:${bundle}`);

      return "backup.zip";
    },
    launch: (bundle: string, profile?: string) => {
      calls.push(`launch:${bundle}:${profile}`);
    },
  };

  assert.deepEqual(
    updateLocal({ target, userDataDir: "/tmp/gristmill-update-profile" }, dependencies),
    { target, backup: "backup.zip" }
  );
  assert.deepEqual(calls, [
    `check:${target}`,
    "build",
    `install:${target}`,
    `launch:${target}:/tmp/gristmill-update-profile`,
  ]);

  for (const phase of ["checkStopped", "build", "install"] as const) {
    calls.length = 0;
    assert.throws(
      () =>
        updateLocal(
          { target, userDataDir: "/tmp/gristmill-update-profile" },
          {
            ...dependencies,
            [phase]: () => {
              throw new Error(phase);
            },
          }
        ),
      new RegExp(phase)
    );
    assert.equal(
      calls.some((call) => call.startsWith("launch:")),
      false
    );

    if (phase !== "install")
      assert.equal(
        calls.some((call) => call.startsWith("install:")),
        false
      );
  }

  assert.throws(() => updateLocal({ target }, dependencies), /requires --user-data-dir/);
  calls.length = 0;
  updateLocal({}, dependencies);
  assert.equal(calls[0], "check:/Applications/Gristmill.app");
  assert.equal(calls.at(-1), "launch:/Applications/Gristmill.app:undefined");
});
