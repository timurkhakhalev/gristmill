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

async function runInstaller(
  t: import("node:test").TestContext,
  { failLibraryCopy = false, seedOutputOnly = false }: RunOptions = {}
) {
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
          assets: [
            {
              name: "llama-b-test-bin-macos-arm64.tar.gz",
              url: "https://example.invalid/llama.tar.gz",
            },
          ],
        }),
        findBinaryInDir: () => null,
        findLibrariesInDir: (dir: string) =>
          fs.existsSync(dir)
            ? fs
                .readdirSync(dir)
                .filter((f: string) => f.endsWith(".dylib"))
                .map((f: string) => path.join(dir, f))
            : [],
        matchesPattern: () => true,
        parseArgs: () => ({
          isCurrent: true,
          platformArch: "darwin-arm64",
          isForce: false,
          shouldCleanup: false,
        }),
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
    console: {
      log: (line: string) => consoleLines.push(line),
      error: (line: string) => consoleLines.push(line),
    },
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
    outputContent: () =>
      fs.existsSync(path.join(binDir, OUTPUT_NAME))
        ? fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8")
        : null,
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

// R160-1/R160-2: the binary is the commit point (published LAST). A hard kill
// after the libraries were renamed but before the binary leaves orphaned
// libraries and NO executable — the skip check must report incomplete and the
// retry must repair. Staging content (subdirectories) never counts as kit
// content: the completeness check reads only the top level of BIN_DIR.
test("an interrupted publish (libs renamed, binary missing) is incomplete and the retry repairs it", async (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-hardkill-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  // State after a hard kill mid-publish: orphaned libraries, no binary, and a
  // leftover staging directory whose content must never count as kit content.
  fs.writeFileSync(path.join(binDir, "libggml.dylib"), "orphan-lib");
  const staging = path.join(binDir, "temp-llama-darwin-arm64");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "libggml.dylib"), "staged-lib");

  // Top-level completeness (maxDepth 1) must ignore the staging directory:
  // one orphaned lib at the top level, no binary → incomplete.
  const injectedRequire = (name: string) => {
    if (name === "./lib/download-utils.cts") {
      return {
        copyLibraries: (extractDir: string, destDir: string) => {
          fs.copyFileSync(
            path.join(extractDir, "libggml.dylib"),
            path.join(destDir, "libggml.dylib")
          );

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
          assets: [
            {
              name: "llama-b-test-bin-macos-arm64.tar.gz",
              url: "https://example.invalid/llama.tar.gz",
            },
          ],
        }),
        findBinaryInDir: () => null,
        findLibrariesInDir: (dir: string, pattern: string, options: { maxDepth?: number } = {}) => {
          // Real semantics: maxDepth 1 = only the top level of dir.
          if ((options.maxDepth ?? 5) <= 1) {
            return fs.existsSync(dir)
              ? fs
                  .readdirSync(dir)
                  .filter((f: string) => f.endsWith(".dylib"))
                  .map((f: string) => path.join(dir, f))
              : [];
          }

          return fs.existsSync(dir)
            ? fs
                .readdirSync(dir, { withFileTypes: true })
                .flatMap((entry: { isDirectory: () => boolean; name: string }) =>
                  entry.isDirectory()
                    ? fs
                        .readdirSync(path.join(dir, entry.name))
                        .filter((f: string) => f.endsWith(".dylib"))
                        .map((f: string) => path.join(dir, entry.name, f))
                    : []
                )
            : [];
        },
        matchesPattern: () => true,
        parseArgs: () => ({
          isCurrent: true,
          platformArch: "darwin-arm64",
          isForce: false,
          shouldCleanup: false,
        }),
        setExecutable: () => {},
        cleanupFiles: () => {},
      };
    }

    return require(name);
  };

  (injectedRequire as unknown as { main: unknown }).main = { exports: {} };
  const consoleLines: string[] = [];
  const vmModule: { exports: unknown } = { exports: {} };
  (injectedRequire as unknown as { main: unknown }).main = vmModule;
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(SCRIPT, "utf8")), {
    module: vmModule,
    require: injectedRequire,
    console: {
      log: (line: string) => consoleLines.push(line),
      error: (line: string) => consoleLines.push(line),
    },
    process: { ...process, env: { ...process.env, GRISTMILL_LOCAL_BIN_DIR: binDir }, exitCode: 0 },
    __dirname: path.dirname(SCRIPT),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log("DEBUGN lines:", JSON.stringify(consoleLines));

  // The hard-killed state was not mistaken for a complete install: the
  // installer ran (repaired), publishing the missing binary.
  assert.equal(
    consoleLines.some((line) => line.includes("Already exists")),
    false,
    "the interrupted install did not satisfy the skip check"
  );
  assert.equal(
    fs.existsSync(path.join(binDir, OUTPUT_NAME)),
    true,
    "the binary was published by the retry"
  );
  assert.equal(
    fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8"),
    "fresh-binary",
    "the repaired binary is the new one"
  );
  // The staging directory never satisfied the completeness check: without it
  // the top level held exactly one lib and no binary (incomplete), and the
  // skip did not fire — staging content was not read as kit content.
  assert.equal(fs.existsSync(staging), false, "the leftover staging directory was cleaned");
  assert.equal(
    fs.existsSync(path.join(binDir, "libggml.dylib")),
    true,
    "the orphaned lib was overwritten by the fresh one"
  );
});

// R160-1 discrimination: binary present, zero top-level libs, libraries only
// inside a leftover staging directory. The recursive count (pre-fix) called
// this complete and skipped; the top-level count must repair it.
test("staging-directory libraries never satisfy the skip check", async (t) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-staging-only-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(binDir, OUTPUT_NAME), "stale-binary");
  const staging = path.join(binDir, "temp-llama-darwin-arm64");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "libggml.dylib"), "staged-lib");

  let ran = false;

  const injectedRequire = (name: string) => {
    if (name === "./lib/download-utils.cts") {
      return {
        copyLibraries: (extractDir: string, destDir: string) => {
          fs.copyFileSync(
            path.join(extractDir, "libggml.dylib"),
            path.join(destDir, "libggml.dylib")
          );

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
          assets: [
            {
              name: "llama-b-test-bin-macos-arm64.tar.gz",
              url: "https://example.invalid/llama.tar.gz",
            },
          ],
        }),
        findBinaryInDir: () => null,
        findLibrariesInDir: (dir: string, pattern: string, options: { maxDepth?: number } = {}) => {
          if ((options.maxDepth ?? 5) <= 1) {
            return fs.existsSync(dir)
              ? fs
                  .readdirSync(dir)
                  .filter((f: string) => f.endsWith(".dylib"))
                  .map((f: string) => path.join(dir, f))
              : [];
          }

          // Recursive variant (pre-fix): would also see staging content.
          return fs.existsSync(dir)
            ? fs
                .readdirSync(dir, { withFileTypes: true })
                .flatMap((entry: { isDirectory: () => boolean; name: string }) =>
                  entry.isDirectory()
                    ? fs
                        .readdirSync(path.join(dir, entry.name))
                        .filter((f: string) => f.endsWith(".dylib"))
                        .map((f: string) => path.join(dir, entry.name, f))
                    : fs
                        .readdirSync(dir)
                        .filter((f: string) => f.endsWith(".dylib"))
                        .map((f: string) => path.join(dir, f))
                )
            : [];
        },
        matchesPattern: () => true,
        parseArgs: () => ({
          isCurrent: true,
          platformArch: "darwin-arm64",
          isForce: false,
          shouldCleanup: false,
        }),
        setExecutable: () => {},
        cleanupFiles: () => {},
      };
    }

    ran = true;

    return require(name);
  };

  (injectedRequire as unknown as { main: unknown }).main = { exports: {} };
  const vmModule: { exports: unknown } = { exports: {} };
  const lines: string[] = [];
  (injectedRequire as unknown as { main: unknown }).main = vmModule;
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(SCRIPT, "utf8")), {
    module: vmModule,
    require: injectedRequire,
    console: {
      log: (line: string) => {
        lines.push(line);
      },
      error: (line: string) => {
        lines.push(line);
      },
    },
    process: { ...process, env: { ...process.env, GRISTMILL_LOCAL_BIN_DIR: binDir }, exitCode: 0 },
    __dirname: path.dirname(SCRIPT),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(ran, true, "the installer ran instead of skipping");
  console.log("DEBUGO lines:", JSON.stringify(lines));
  assert.equal(
    fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8"),
    "fresh-binary",
    "the kit was repaired"
  );
  assert.equal(
    fs.existsSync(path.join(binDir, "libggml.dylib")),
    true,
    "the libraries were installed at the top level"
  );
});

// R160-3: executability is part of completeness. A truncated binary with full
// libraries (killed mid non-atomic copy) and a non-executable binary with full
// libraries (missed chmod from an older revision) both used to read as
// complete; the skip check must report them incomplete and the retry must
// repair them.
async function seedAndRepair(
  t: import("node:test").TestContext,
  seedBinary: (outputPath: string) => void
) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-execheck-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  seedBinary(path.join(binDir, OUTPUT_NAME));
  fs.writeFileSync(path.join(binDir, "libggml.dylib"), "lib");

  const vmModule: { exports: unknown } = { exports: {} };
  const lines: string[] = [];

  const injectedRequire = (name: string) => {
    if (name === "./lib/download-utils.cts") {
      return {
        copyLibraries: (extractDir: string, destDir: string) => {
          fs.copyFileSync(
            path.join(extractDir, "libggml.dylib"),
            path.join(destDir, "libggml.dylib")
          );

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
          assets: [
            {
              name: "llama-b-test-bin-macos-arm64.tar.gz",
              url: "https://example.invalid/llama.tar.gz",
            },
          ],
        }),
        findBinaryInDir: () => null,
        findLibrariesInDir: (dir: string) =>
          fs.existsSync(dir)
            ? fs
                .readdirSync(dir)
                .filter((f: string) => f.endsWith(".dylib"))
                .map((f: string) => path.join(dir, f))
            : [],
        matchesPattern: () => true,
        parseArgs: () => ({
          isCurrent: true,
          platformArch: "darwin-arm64",
          isForce: false,
          shouldCleanup: false,
        }),
        setExecutable: () => {},
        cleanupFiles: () => {},
      };
    }

    return require(name);
  };

  (injectedRequire as unknown as { main: unknown }).main = vmModule;
  vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(SCRIPT, "utf8")), {
    module: vmModule,
    require: injectedRequire,
    console: {
      log: (line: string) => {
        lines.push(line);
      },
      error: (line: string) => {
        lines.push(line);
      },
    },
    process: { ...process, env: { ...process.env, GRISTMILL_LOCAL_BIN_DIR: binDir }, exitCode: 0 },
    __dirname: path.dirname(SCRIPT),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  return {
    repaired: () =>
      fs.existsSync(path.join(binDir, OUTPUT_NAME)) &&
      fs.existsSync(path.join(binDir, `${OUTPUT_NAME}.complete`)) &&
      fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8") === "fresh-binary",
    skipped: () => lines.some((line) => line.includes("Already exists")),
    content: () => fs.readFileSync(path.join(binDir, OUTPUT_NAME), "utf8"),
  };
}

test("a truncated binary with full libraries is incomplete; the retry repairs it", async (t) => {
  const run = await seedAndRepair(t, (outputPath) => {
    // A 0755 partial: copyFileSync keeps the source's mode, so a SIGKILL mid
    // non-atomic copy leaves an executable-bit truncated file that X_OK alone
    // cannot detect (issue #160, review round 3).
    fs.writeFileSync(outputPath, "trunc");
    fs.chmodSync(outputPath, 0o755);
  });

  assert.equal(run.skipped(), false, "the truncated kit did not satisfy the skip check");
  assert.equal(run.repaired(), true, "the retry republished the binary");
  assert.equal(run.content(), "fresh-binary");
});

test("a non-executable binary with full libraries is incomplete; the retry repairs it", async (t) => {
  const run = await seedAndRepair(t, (outputPath) => {
    fs.writeFileSync(outputPath, "stale-binary"); // chmod missed: defaults non-executable
  });

  assert.equal(run.skipped(), false, "the non-executable kit did not satisfy the skip check");
  assert.equal(run.repaired(), true, "the retry republished the binary");
  assert.equal(run.content(), "fresh-binary");
});
