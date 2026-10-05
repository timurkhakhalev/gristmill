const { stripTypeScriptTypes }: typeof import("node:module") = require("node:module");

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const vm: typeof import("node:vm") = require("node:vm");

test("packaging rebuilds native modules even after Node tests replaced the binary", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const module: { exports: unknown } = { exports: {} };
  vm.runInNewContext(
    stripTypeScriptTypes(
      fs.readFileSync(path.join(__dirname, "../../scripts/beforeBuild.cts"), "utf8")
    ),
    {
      module,
      require(name: string) {
        if (name === "@electron/rebuild")
          return { rebuild: async (options: Record<string, unknown>) => calls.push(options) };

        if (name === "electron/package.json") return { version: "41.10.5" };
        throw new Error(name);
      },
    }
  );

  const beforeBuild = module.exports as (context: {
    appDir: string;
    platform: { nodeName: string };
    arch: string;
  }) => Promise<boolean>;

  const result = await beforeBuild({
    appDir: "/app",
    platform: { nodeName: "darwin" },
    arch: "arm64",
  });

  assert.equal(result, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      buildPath: "/app",
      electronVersion: "41.10.5",
      platform: "darwin",
      arch: "arm64",
      force: true,
      useCache: false,
      mode: "sequential",
    },
  ]);
});
