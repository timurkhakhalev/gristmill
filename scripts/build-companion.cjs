const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const identity = require("../extension/identity.json");
const output = path.join(root, "build", "companion-dev");
execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "extension/tsconfig.json"], { cwd: root, stdio: "inherit" });
fs.mkdirSync(output, { recursive: true });
for (const entry of ["worker", "popup"]) {
  execFileSync(path.join(root, "node_modules", ".bin", "esbuild"), [path.join(root, "extension", "src", `${entry}.ts`),
    `--outfile=${path.join(output, `${entry}.js`)}`, "--bundle", "--platform=browser", "--target=chrome121", "--format=iife"], { cwd: root, stdio: "inherit" });
}
fs.copyFileSync(path.join(root, "extension", "popup.html"), path.join(output, "popup.html"));
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "Gristmill for Google Meet (Dev)", version: "0.1.0", minimum_chrome_version: "121",
  description: "Link a Google Meet call to a local Gristmill recording.", key: identity.publicKey,
  permissions: ["nativeMessaging", "storage", "alarms"], host_permissions: ["https://meet.google.com/*"],
  background: { service_worker: "worker.js" }, action: { default_popup: "popup.html" },
}, null, 2) + "\n");
