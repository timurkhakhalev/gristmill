const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outputDir = path.join(root, "resources", "local-engine-installers");
fs.mkdirSync(outputDir, { recursive: true });

for (const name of ["download-whisper-cpp", "download-llama-server", "download-sherpa-onnx"]) {
  buildSync({
    entryPoints: [path.join(__dirname, `${name}.js`)],
    outfile: path.join(outputDir, `${name}.cjs`),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
  });
}
