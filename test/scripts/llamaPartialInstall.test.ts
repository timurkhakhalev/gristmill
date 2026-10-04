// Issue #160: a partial llama install (executable copied, libraries failed)
// used to stay on disk, and both the installer's skip check and the runtime
// treated the bare executable as a complete install — the loader error
// repeated on every retry. The installer now stages the full kit, cleans up
// any published output on failure, and its skip check requires binary +
// libraries; the runtime likewise refuses a bare executable.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { stripTypeScriptTypes }: typeof import("node:module") = require("node:module");

const SCRIPT = path.join(__dirname, "../../scripts/download-llama-server.cts");
const OUTPUT_NAME = "llama-server-darwin-arm64";

interface RunOptions {
  failLibraryCopy?: boolean;
  seedOutputOnly?: boolean;
}

async function runInstaller(t: import("node:test").TestContext, { failLibraryCopy = false, seedOutputOnly = false }: RunOptions = {}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-partial-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  if (seedOutputOnly) {
    // The partial install left behind by the old installer: executable, no libs.
    fs.writeFileSync(path.join(binDir, OUTPUT_NAME), "stale-binary");
  }

  let copyCalls = 0;
  const consoleLines: string[] = [];
  const module: { exports: unknown } = { exports: {} };
  const scriptSource = stripTypeScriptTypes(fs.readFileSync(SCRIPT, "utf8"));

  const injectedRequire = (name: string) => {
    if (name === "./lib/download-utils.cts") {
      return {
        copyLibraries: (extractDir: string, destDir: string, _pattern: string) => {
          copyCalls += 1;
          if (failLibraryCopy) throw new Error("injected: library copy failed (disk full)");
          // Real behavior: copy matching libs from the archive into destDir.
          const lib = path.join(extractDir, "libggml.dylib");
          fs.copyFileSync(lib, path.join(destDir, "libggml.dylib"));
          return ["libggml.dylib"];
        },
        downloadFile: async (url: string, file: string) => {
          fs.writeFileSync(file, "fake-archive");
        },
        extractArchive: async (zip: string, extractDir: string) => {
          fs.mkdirSync(path.join(extractDir, "build", "bin"), { recursive: true });
          fs.writeFileSync(path.join(extractDir, "build", "bin", "llama-server"), "fresh-binary");
          fs.writeFileSync(path.join(extractDir, "libggml.dylib"), "fresh-lib");
        },
        fetchLatestRelease: async () => ({
          tag: "b-test",
          assets: [{ name: "llama-b-test-bin-macos-arm64.tar.gz", url: "https://example.invalid/llama.tar.gz" }],
        }),
        findBinaryInDir: () => null,
        findLibrariesInDir: (dir: string) =>
          fs.existsSync(dir)
            ? fs.readdirSync(dir).filter((f: string) => f.endsWith(".dylib")).map((f: string) => path.join(dir, f))
            : [],
        matchesPattern: () => true,
        parseArgs: () => ({ isCurrent: true, platformArch: "darwin-arm64", isForce: false, shouldCleanup: false }),
        setExecutable: () => {},
        cleanupFiles: () => {},
      };
    }
    return require(name);
  };
  (injectedRequire as unknown as { main: unknown }).main = module;

  vm.runInNewContext(scriptSource, {
    module,
    require: injectedRequire,
    console: { log: (line: string) => consoleLines.push(line), error: (line: string) => consoleLines.push(line) },
    process: { ...process, env: { ...process.env, GRISTMILL_LOCAL_BIN_DIR: binDir }, exitCode: 0 },
    __dirname: path.dirname(SCRIPT),
  });

  // main() runs with awaits; let it settle before the caller inspects the FS.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    binDir,
    consoleLines,
    copyCalls: () => copyCalls,
    outputExists: () => fs.existsSync(path.join(binDir, OUTPUT_NAME)),
    libExists: () => fs.existsSync(path.join(binDir, "libggml.dylib")),
    outputContent: () => (fs.existsSync(path.join(binDir, OUTPUT_NAME)) ? fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8") : null),
  };
}

test("a library-copy failure leaves no executable behind (staged publish + cleanup)", async (t) => {
  const run = await runInstaller(t, { failLibraryCopy: true });
  assert.equal(run.outputExists(), false, "the failed install published no executable");
  assert.equal(run.libExists(), false, "no libraries were published");
  assert.equal(run.copyCalls(), 1);
});

test("a successful run installs the complete kit (binary + libraries)", async (t) => {
  const run = await runInstaller(t, {});
  assert.equal(run.outputExists(), true, "the executable is published");
  assert.equal(run.libExists(), true, "the libraries are published");
  assert.equal(run.outputContent(), "fresh-binary", "the published binary is the new one");
});

test("a partial install does not satisfy the skip check; the next run repairs it", async (t) => {
  const run = await runInstaller(t, { seedOutputOnly: true });
  assert.equal(run.copyCalls(), 1, "the partial install did not short-circuit the installer");
  assert.equal(run.outputContent(), "fresh-binary", "the stale executable was replaced");
  assert.equal(run.libExists(), true, "the missing libraries were installed");
});
