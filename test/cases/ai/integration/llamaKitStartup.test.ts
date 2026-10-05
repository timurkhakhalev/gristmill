const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

for (const stamped of [false, true]) {
  test(`ordinary llama startup ${stamped ? "uses a complete offline kit" : "repairs an unstamped executable kit"}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-llama-kit-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, "llama-server-darwin-arm64");
    const model = path.join(dir, "model.gguf");
    fs.writeFileSync(bin, "partial", { mode: 0o755 });
    fs.writeFileSync(model, "model");
    fs.writeFileSync(path.join(dir, "libllama.dylib"), "lib");

    if (stamped) fs.writeFileSync(bin + ".complete", "test-build");
    let repairs = 0;
    const target = require.resolve("../../../../src/helpers/llamaServer.ts");
    const original = Module._load;
    delete require.cache[target];
    t.after(() => {
      delete require.cache[target];
    });
    Module._load = function (request: string, parent: { filename?: string }, main: boolean) {
      if (parent?.filename === target && request.includes("serverUtils"))
        return {
          resolveBinaryPath: () => {
            try {
              fs.accessSync(bin, fs.constants.X_OK);

              return bin;
            } catch {
              return null;
            }
          },
          isPortAvailable: async () => true,
        };

      if (parent?.filename === target && request.includes("localEngineInstaller"))
        return {
          ensureLocalEngine: async (engine: string) => {
            assert.equal(engine, "llama-server");
            repairs++;
            fs.writeFileSync(bin, "repaired");
            fs.writeFileSync(bin + ".complete", "test-build");
          },
        };

      return original.call(this, request, parent, main);
    };

    let Llama: typeof import("../../../../src/helpers/llamaServer").LlamaServerManager;

    try {
      Llama = require(target);
    } finally {
      Module._load = original;
    }

    const manager = new Llama();
    const spawned: string[] = [];
    manager._startWithBinary = async (binary) => {
      spawned.push(binary);
      manager.ready = true;
    };

    manager.startHealthCheck = () => {};

    manager.resetIdleTimer = () => {};

    t.after(() => manager.stop());
    assert.equal(manager.getServerBinaryPaths().default, stamped ? bin : "");
    await manager.start(model);
    assert.equal(repairs, stamped ? 0 : 1);
    assert.deepEqual(spawned, [bin]);
    assert.equal(manager.getServerBinaryPaths().default, bin);
    fs.rmSync(bin + ".complete");
    assert.equal(
      manager.getServerBinaryPaths().default,
      "",
      "discovery cannot retain a stale positive hit"
    );
  });
}
