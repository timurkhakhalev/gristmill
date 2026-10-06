// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("node:fs") as typeof import("node:fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { stripTypeScriptTypes } = require("node:module") as typeof import("node:module");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { build } = require("esbuild") as typeof import("esbuild");

const root = path.resolve(__dirname, "..");

// Strip exactly as Node does before bundling: type-only exports must not turn
// native CommonJS scripts into ESM modules in esbuild's dependency graph.
const nativeCommonJs: import("esbuild").Plugin = {
  name: "native-commonjs",
  setup(builder) {
    builder.onLoad({ filter: /\.cts$/ }, ({ path: file }) => ({
      contents: stripTypeScriptTypes(fs.readFileSync(file, "utf8")),
      loader: "js",
    }));
  },
};

async function main() {
  for (const name of [
    "download-whisper-cpp",
    "download-llama-server",
    "download-sherpa-onnx",
    "gristmill-cli",
  ]) {
    await build({
      entryPoints: [path.join(__dirname, `${name}.cts`)],
      outfile: path.join(
        root,
        "resources",
        name === "gristmill-cli" ? "cli" : "local-engine-installers",
        `${name}.cjs`
      ),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      plugins: [nativeCommonJs],
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export type {};
